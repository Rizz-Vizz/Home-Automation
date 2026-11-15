#include "tasks_ctrl.h"
#include "fsl_common.h"
#include "elly_types.h"
#include "comms.h"
#include "crypto_auth.h"
#include "flash_log.h"
#include "rgb_led.h"
#include "sensors.h"
#include "FreeRTOS.h"
#include "queue.h"
#include "semphr.h"
#include "task.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define AUDIT_QUEUE_DEPTH 24U

typedef struct {
    audit_event_t evt;
    elly_role_t role;
    char detail[24];
} audit_msg_t;

static SemaphoreHandle_t s_stateMutex = NULL;
static QueueHandle_t s_auditQ         = NULL;
static TaskHandle_t s_hSensor, s_hSafety, s_hAuto, s_hComms, s_hLog;
static volatile uint32_t s_auditDropped = 0U;

static elly_sensor_data_t s_sensors;
static elly_state_t s_state;

static volatile bool s_backfillPending = false;
static uint32_t s_lastClapMs           = 0U;
static uint32_t s_clapWinStartMs       = 0U;
static uint32_t s_clapCount            = 0U;
static uint32_t s_lastAwayVibMs        = 0U;
static uint32_t s_lastManualLightMs    = 0U;
static uint32_t s_hotTicks             = 0U;

static uint32_t uptime_ms(void)
{
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

/* Never touches flash: a LogTask drains the queue, so safety and comms never wait on SPI erases */
static void audit_post(audit_event_t evt, elly_role_t role, const char *detail)
{
    audit_msg_t m;
    m.evt  = evt;
    m.role = role;
    strncpy(m.detail, (detail != NULL) ? detail : "", sizeof(m.detail) - 1U);
    m.detail[sizeof(m.detail) - 1U] = '\0';
    if ((s_auditQ == NULL) || (xQueueSend(s_auditQ, &m, 0) != pdTRUE)) {
        s_auditDropped++;
    }
}

static const char *safety_name(elly_safety_t r)
{
    switch (r) {
    case ELLY_SAFETY_THERMAL:   return "thermal";
    case ELLY_SAFETY_FALL:      return "fall";
    case ELLY_SAFETY_TAMPER:    return "tamper";
    case ELLY_SAFETY_ACOUSTIC:  return "acoustic";
    case ELLY_SAFETY_EDGE_LOST: return "edge_timeout";
    case ELLY_SAFETY_EMERGENCY: return "emergency";
    default:                    return "normal";
    }
}

static const char *auth_err_name(auth_result_t res)
{
    switch (res) {
    case AUTH_ERR_FORMAT:      return "bad_format";
    case AUTH_ERR_BAD_HMAC:    return "bad_hmac";
    case AUTH_ERR_REPLAY:      return "replay_rejected";
    case AUTH_ERR_RBAC_DENIED: return "rbac_denied";
    case AUTH_ERR_NO_UID:      return "no_chip_uid";
    default:                   return "ok";
    }
}

/* Caller holds s_stateMutex */
static void latch_safety_locked(elly_safety_t reason, const char *detail, elly_role_t actor)
{
    bool newlyLatched = (!s_state.safety_latched) || (s_state.safety_reason != reason);
    s_state.safety_latched = true;
    s_state.safety_reason  = reason;
    /* Deterministic safety override cuts powered actuators */
    s_state.ac_on          = false;
    s_state.fan_on         = false;
    s_state.light_on       = false;
    if (newlyLatched) {
        audit_post(AUDIT_EVT_SAFETY, actor, detail);
    }
}

static void SensorTask(void *pvParameters)
{
    (void)pvParameters;
    uint32_t slowDiv = 0U;

    for (;;) {
        elly_sensor_data_t local;
        bool sw2Edge  = false;
        bool sw3Edge  = false;
        bool dockEdge = false;

        (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);
        local = s_sensors;
        (void)xSemaphoreGive(s_stateMutex);

        Sensors_PollFast(&local, &sw2Edge, &sw3Edge, &dockEdge);
        if ((slowDiv++ % 10U) == 0U) {
            Sensors_PollSlow(&local);
        }

        uint32_t now = uptime_ms();
        (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);
        /* fall_detected is sticky until SafetyTask consumes it, so never overwrite a pending one */
        bool pendingFall = s_sensors.fall_detected;
        s_sensors               = local;
        s_sensors.fall_detected = pendingFall || local.fall_detected;
        s_state.uptime_ms       = now;

        if ((local.vib_rms_mg > 45U) || local.clap_detected || sw2Edge) {
            s_state.last_motion_ms = now;
        }

        if (sw2Edge) {
            if (!s_state.safety_latched) {
                s_state.light_on  = !s_state.light_on;
                s_state.light_pct = s_state.light_on ? 80U : 0U;
            }
            audit_post(AUDIT_EVT_BUTTON, ELLY_ROLE_SYSTEM, "sw2_toggle");
        }

        if (sw3Edge) {
            latch_safety_locked(ELLY_SAFETY_TAMPER, "sw3_panic", ELLY_ROLE_SYSTEM);
        }

        if (dockEdge) {
            audit_post(AUDIT_EVT_DOCK, ELLY_ROLE_SYSTEM, local.dock_attached ? "j11_attach" : "j11_detach");
            if (s_state.away_armed) {
                latch_safety_locked(ELLY_SAFETY_TAMPER, "dock_tamper", ELLY_ROLE_SYSTEM);
            }
        }

        if (local.clap_detected && ((now - s_lastClapMs) >= 900U)) {
            s_lastClapMs = now;
            if (s_state.away_armed) {
                /* One loud noise is not an intrusion: need a second one inside the window */
                if ((now - s_clapWinStartMs) > ELLY_ACOUSTIC_WINDOW_MS) {
                    s_clapWinStartMs = now;
                    s_clapCount      = 1U;
                } else {
                    s_clapCount++;
                }
                if (s_clapCount >= ELLY_ACOUSTIC_CLAPS) {
                    s_clapCount = 0U;
                    latch_safety_locked(ELLY_SAFETY_ACOUSTIC, "away_acoustic", ELLY_ROLE_SYSTEM);
                }
            } else if (!s_state.safety_latched) {
                s_state.light_on  = !s_state.light_on;
                s_state.light_pct = s_state.light_on ? 85U : 0U;
                audit_post(AUDIT_EVT_CMD, ELLY_ROLE_SYSTEM, "clap_toggle");
            }
        }
        (void)xSemaphoreGive(s_stateMutex);

        vTaskDelay(pdMS_TO_TICKS(20U));
    }
}

static void SafetyTask(void *pvParameters)
{
    (void)pvParameters;

    for (;;) {
        uint32_t now = uptime_ms();

        (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);
        s_state.uptime_ms = now;

        /* 1. MCU self-protection: die temperature must stay high for about 1 s */
        if (s_sensors.temp_c >= ELLY_TEMP_CRIT_C) {
            if (++s_hotTicks >= ELLY_TEMP_CONFIRM_TICKS) {
                latch_safety_locked(ELLY_SAFETY_THERMAL, "mcu_temp_crit", ELLY_ROLE_SYSTEM);
            }
        } else {
            s_hotTicks = 0U;
        }

        /* 2. Fall: free-fall then impact (consume the sticky flag) */
        if (s_sensors.fall_detected) {
            s_sensors.fall_detected = false;
            latch_safety_locked(ELLY_SAFETY_FALL, "fall_impact", ELLY_ROLE_SYSTEM);
        }

        /* 3. Away tamper vibration alert */
        if (s_state.away_armed && (s_sensors.vib_rms_mg > 180U) &&
            ((now - s_lastAwayVibMs) > 2000U)) {
            s_lastAwayVibMs = now;
            latch_safety_locked(ELLY_SAFETY_TAMPER, "vib_tamper", ELLY_ROLE_SYSTEM);
        }

        /* 4. 4-second gateway heartbeat watchdog -> autonomous Amber Edge Mode */
        if ((now - s_state.last_heartbeat_ms) > ELLY_HEARTBEAT_TIMEOUT_MS) {
            if (!s_state.edge_mode) {
                s_state.edge_mode = true;
                audit_post(AUDIT_EVT_EDGE_ENTER, ELLY_ROLE_SYSTEM, "hb_timeout");
            }
        }
        (void)xSemaphoreGive(s_stateMutex);

        vTaskDelay(pdMS_TO_TICKS(100U));
    }
}

/* Only task that touches flash for logging: audit queue drain + 1 Hz offline telemetry in Edge Mode */
static void LogTask(void *pvParameters)
{
    (void)pvParameters;
    uint32_t lastPushMs = 0U;

    for (;;) {
        audit_msg_t m;
        if (xQueueReceive(s_auditQ, &m, pdMS_TO_TICKS(250U)) == pdTRUE) {
            (void)FlashLog_AppendAudit(m.evt, m.role, m.detail);
        }

        uint32_t now = uptime_ms();
        if ((now - lastPushMs) >= 1000U) {
            lastPushMs = now;
            elly_sensor_data_t sc;
            elly_state_t stc;
            (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);
            sc  = s_sensors;
            stc = s_state;
            (void)xSemaphoreGive(s_stateMutex);
            if (stc.edge_mode) {
                (void)FlashLog_PushOfflineTelemetry(&sc, &stc);
            }
        }
    }
}

static void AutomationTask(void *pvParameters)
{
    (void)pvParameters;
    uint8_t blinkPhase = 0U;

    for (;;) {
        uint32_t now = uptime_ms();
        uint8_t r = 0U, g = 0U, b = 0U;

        (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);

        if (s_state.safety_latched) {
            /* Safety overrides all comfort/automation RGB outputs */
            blinkPhase ^= 1U;
            r = blinkPhase ? 100U : 25U;
            g = 0U;
            b = 0U;
        } else if (s_state.edge_mode) {
            /* Autonomous Amber Edge Mode indicator */
            r = 95U;
            g = 35U;
            b = 0U;
            if ((now - s_state.last_motion_ms) > s_state.vacancy_ms) {
                s_state.light_on = false;
                s_state.fan_on   = false;
            }
        } else {
            /* Normal gateway-connected comfort and proportional daylight harvesting */
            if (s_state.auto_eco && !s_state.away_armed) {
                if ((now - s_state.last_motion_ms) > s_state.vacancy_ms) {
                    s_state.light_on = false;
                    s_state.fan_on   = false;
                } else if (s_state.light_on && ((now - s_lastManualLightMs) >= 10000U)) {
                    if ((s_sensors.lux > 180.0f) && (s_state.light_pct > 15U)) {
                        s_state.light_pct = 15U;
                    } else if ((s_sensors.lux > 75.0f) && (s_state.light_pct > 45U)) {
                        s_state.light_pct = 45U;
                    } else if ((s_sensors.lux > 30.0f) && (s_state.light_pct > 70U)) {
                        s_state.light_pct = 70U;
                    }
                }
            }

            if ((s_state.led_r != 0U) || (s_state.led_g != 0U) || (s_state.led_b != 0U)) {
                r = s_state.led_r;
                g = s_state.led_g;
                b = s_state.led_b;
            } else if (s_state.away_armed) {
                r = 0U; g = 0U; b = 30U;
            } else if (s_state.light_on) {
                uint8_t lvl = (s_state.light_pct > 100U) ? 100U : s_state.light_pct;
                r = lvl; g = (uint8_t)((lvl * 85U) / 100U); b = (uint8_t)(lvl / 2U);
            } else {
                r = 0U; g = 15U; b = 5U;
            }
        }
        (void)xSemaphoreGive(s_stateMutex);

        RgbLed_Set(r, g, b);
        vTaskDelay(pdMS_TO_TICKS(200U));
    }
}

/* Format fixed-point scaled integers so newlib-nano works without _printf_float. */
static void fmt_scaled(int32_t scaled, uint32_t scale, uint8_t decimals, char *out, size_t maxLen)
{
    uint32_t mag   = (scaled < 0) ? (uint32_t)(-(int64_t)scaled) : (uint32_t)scaled;
    uint32_t whole = mag / scale;
    uint32_t frac  = mag % scale;
    const char *neg = (scaled < 0) ? "-" : "";

    if (decimals == 2U) {
        (void)snprintf(out, maxLen, "%s%lu.%02lu", neg, (unsigned long)whole, (unsigned long)frac);
    } else {
        (void)snprintf(out, maxLen, "%s%lu.%lu", neg, (unsigned long)whole, (unsigned long)frac);
    }
}

static int32_t scale_round(float val, float scale)
{
    return (val >= 0.0f) ? (int32_t)(val * scale + 0.5f) : (int32_t)(val * scale - 0.5f);
}

static void stream_backfill_records(void)
{
    flash_telem_rec_t batch[8];
    char line[256];
    char luxStr[16];
    char tempStr[16];
    char dbStr[16];
    uint32_t n;

    while ((n = FlashLog_PopOfflineBatch(batch, 8U)) > 0U) {
        for (uint32_t i = 0U; i < n; i++) {
            const flash_telem_rec_t *r = &batch[i];
            fmt_scaled((int32_t)r->lux_x10, 10U, 1U, luxStr, sizeof(luxStr));
            fmt_scaled((int32_t)r->temp_c_x100, 100U, 2U, tempStr, sizeof(tempStr));
            fmt_scaled((int32_t)r->mic_db_x10, 10U, 1U, dbStr, sizeof(dbStr));
            (void)snprintf(line, sizeof(line),
                           "{\"type\":\"backfill\",\"seq\":%lu,\"uptime_ms\":%lu,"
                           "\"lux\":%s,\"temp_c\":%s,\"db\":%s,"
                           "\"vib\":%u,\"flags\":%u}",
                           (unsigned long)r->seq,
                           (unsigned long)r->uptime_ms,
                           luxStr,
                           tempStr,
                           dbStr,
                           (unsigned)r->vib_rms_mg,
                           (unsigned)r->flags);
            Comms_SendLine(line);
        }
    }
}

static void send_audit_dump(uint32_t maxItems)
{
    flash_audit_rec_t recs[16];
    char line[256];
    char prevHex[17];
    char hashHex[33];

    uint32_t want = (maxItems == 0U || maxItems > 16U) ? 16U : maxItems;
    uint32_t got  = FlashLog_DumpRecentAudit(recs, want);

    (void)snprintf(line, sizeof(line), "{\"type\":\"audit_begin\",\"count\":%lu}", (unsigned long)got);
    Comms_SendLine(line);

    for (uint32_t i = 0U; i < got; i++) {
        CryptoAuth_HexEncode(recs[i].prev_hash, 8U, prevHex);
        CryptoAuth_HexEncode(recs[i].entry_hash, 16U, hashHex);
        (void)snprintf(line, sizeof(line),
                       "{\"type\":\"audit\",\"seq\":%lu,\"uptime_ms\":%lu,\"evt\":%u,"
                       "\"role\":%u,\"detail\":\"%s\",\"prev\":\"%s\",\"hash\":\"%s\"}",
                       (unsigned long)recs[i].seq,
                       (unsigned long)recs[i].uptime_ms,
                       (unsigned)recs[i].event_type,
                       (unsigned)recs[i].role,
                       recs[i].detail,
                       prevHex,
                       hashHex);
        Comms_SendLine(line);
    }
    Comms_SendLine("{\"type\":\"audit_end\"}");
}

static bool parse_rgb_arg(const char *arg, uint8_t *r, uint8_t *g, uint8_t *b)
{
    unsigned rv = 0U, gv = 0U, bv = 0U;
    if (arg == NULL) {
        return false;
    }
    if (sscanf(arg, "%u,%u,%u", &rv, &gv, &bv) != 3) {
        return false;
    }
    *r = (rv > 100U) ? 100U : (uint8_t)rv;
    *g = (gv > 100U) ? 100U : (uint8_t)gv;
    *b = (bv > 100U) ? 100U : (uint8_t)bv;
    return true;
}

static void handle_command_line(const char *line)
{
    char cmd[32]  = {0};
    char arg[48]  = {0};
    char role[16] = {0};
    char sig[80]  = {0};
    uint32_t seq  = 0U;
    char resp[320];

    if (!Comms_JsonGetString(line, "cmd", cmd, sizeof(cmd)) ||
        !Comms_JsonGetString(line, "role", role, sizeof(role)) ||
        !Comms_JsonGetUint(line, "seq", &seq) ||
        !Comms_JsonGetString(line, "sig", sig, sizeof(sig))) {
        Comms_SendLine("{\"type\":\"ack\",\"ok\":false,\"err\":\"bad_format\"}");
        return;
    }
    (void)Comms_JsonGetString(line, "arg", arg, sizeof(arg));

    elly_role_t parsedRole = ELLY_ROLE_GUEST;
    auth_result_t authRes  = CryptoAuth_VerifyCommand(cmd, arg, role, seq, sig, &parsedRole);
    if (authRes != AUTH_OK) {
        if (authRes == AUTH_ERR_RBAC_DENIED) {
            audit_post(AUDIT_EVT_RBAC_DENY, parsedRole, cmd);
        } else {
            audit_post(AUDIT_EVT_AUTH_FAIL, ELLY_ROLE_SYSTEM, auth_err_name(authRes));
        }
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"ack\",\"cmd\":\"%s\",\"ok\":false,\"err\":\"%s\",\"seq\":%lu}",
                       cmd, auth_err_name(authRes), (unsigned long)seq);
        Comms_SendLine(resp);
        return;
    }

    if (strcmp(cmd, "heartbeat") == 0) {
        bool exitedEdge = false;
        (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);
        s_state.last_heartbeat_ms = uptime_ms();
        if (s_state.edge_mode) {
            s_state.edge_mode = false;
            exitedEdge        = true;
        }
        (void)xSemaphoreGive(s_stateMutex);

        if (exitedEdge) {
            audit_post(AUDIT_EVT_EDGE_EXIT, ELLY_ROLE_SYSTEM, "hb_restored");
            s_backfillPending = true;
        }
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"ack\",\"cmd\":\"heartbeat\",\"ok\":true,\"seq\":%lu,\"edge\":false}",
                       (unsigned long)seq);
        Comms_SendLine(resp);
        if (s_backfillPending) {
            s_backfillPending = false;
            stream_backfill_records();
        }
        return;
    }

    if (strcmp(cmd, "ping") == 0) {
        char uidHex[33];
        flash_status_t fst;
        CryptoAuth_GetUidHex(uidHex);
        FlashLog_GetStatus(&fst);
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"ack\",\"cmd\":\"ping\",\"ok\":true,\"uid\":\"%s\","
                       "\"last_seq\":%lu,\"flash_ok\":%s,\"jedec\":\"%02x%02x%02x\","
                       "\"can_ok\":%s,\"edge\":%s,\"safety\":%s,"
                       "\"stk\":[%u,%u,%u,%u,%u],\"audit_drop\":%lu}",
                       uidHex, (unsigned long)CryptoAuth_GetLastSeq(),
                       fst.flash_ok ? "true" : "false",
                       fst.jedec_mfr, fst.jedec_type, fst.jedec_cap,
                       s_sensors.can_loopback_ok ? "true" : "false",
                       s_state.edge_mode ? "true" : "false",
                       s_state.safety_latched ? "true" : "false",
                       (unsigned)uxTaskGetStackHighWaterMark(s_hSensor),
                       (unsigned)uxTaskGetStackHighWaterMark(s_hSafety),
                       (unsigned)uxTaskGetStackHighWaterMark(s_hAuto),
                       (unsigned)uxTaskGetStackHighWaterMark(s_hComms),
                       (unsigned)uxTaskGetStackHighWaterMark(s_hLog),
                       (unsigned long)s_auditDropped);
        Comms_SendLine(resp);
        return;
    }

    if (strcmp(cmd, "flash_id") == 0) {
        flash_status_t fst;
        FlashLog_GetStatus(&fst);
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"flash_id\",\"ok\":%s,\"jedec\":\"%02x%02x%02x\","
                       "\"dev\":\"%02x%02x\",\"audit_n\":%lu,\"telem_q\":%lu,\"erases\":%lu}",
                       fst.flash_ok ? "true" : "false",
                       fst.jedec_mfr, fst.jedec_type, fst.jedec_cap,
                       fst.dev_mfr, fst.dev_id,
                       (unsigned long)fst.audit_count,
                       (unsigned long)fst.telem_buffered,
                       (unsigned long)fst.erase_count);
        Comms_SendLine(resp);
        return;
    }

    if (strcmp(cmd, "can_diag") == 0) {
        bool ok = Sensors_RunCanLoopback();
        (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);
        s_sensors.can_loopback_ok = ok;
        (void)xSemaphoreGive(s_stateMutex);
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"can\",\"ok\":%s,\"id\":\"0x123\",\"payload\":\"ELLYCAN1\",\"mode\":\"internal_loopback\"}",
                       ok ? "true" : "false");
        Comms_SendLine(resp);
        return;
    }

    if (strcmp(cmd, "audit_dump") == 0) {
        uint32_t maxItems = (uint32_t)strtoul(arg, NULL, 10);
        send_audit_dump(maxItems);
        return;
    }

    if (strcmp(cmd, "backfill_sync") == 0) {
        stream_backfill_records();
        Comms_SendLine("{\"type\":\"ack\",\"cmd\":\"backfill_sync\",\"ok\":true}");
        return;
    }

    bool rejectedBySafety = false;
    bool rejectedByAway   = false;
    bool badArg           = false;
    (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);

    if (strcmp(cmd, "emergency") == 0) {
        /* Real emergency path: available to every role, works in any mode */
        s_state.led_r = 0U; s_state.led_g = 0U; s_state.led_b = 0U;
        s_state.light_pct = 0U;
        latch_safety_locked(ELLY_SAFETY_EMERGENCY, "emergency_stop", parsedRole);
    } else if (strcmp(cmd, "trip") == 0) {
        /* Gateway-originated safety trips (virtual transmitter overheat, camera intrusion) */
        if (strcmp(arg, "pad_thermal") == 0) {
            latch_safety_locked(ELLY_SAFETY_THERMAL, "pad_thermal", parsedRole);
        } else if (strcmp(arg, "intrusion") == 0) {
            latch_safety_locked(ELLY_SAFETY_TAMPER, "vision_intrusion", parsedRole);
        } else {
            badArg = true;
        }
    } else if (strcmp(cmd, "safety_clear") == 0) {
        s_hotTicks = 0U;
        s_state.safety_latched = false;
        s_state.safety_reason  = ELLY_SAFETY_NORMAL;
        audit_post(AUDIT_EVT_CMD, parsedRole, "safety_clear");
    } else if (strcmp(cmd, "alert_test") == 0) {
        if (strcmp(arg, "thermal") == 0) {
            latch_safety_locked(ELLY_SAFETY_THERMAL, "test_thermal", parsedRole);
        } else if (strcmp(arg, "fall") == 0) {
            latch_safety_locked(ELLY_SAFETY_FALL, "test_fall", parsedRole);
        } else {
            latch_safety_locked(ELLY_SAFETY_TAMPER, "test_tamper", parsedRole);
        }
    } else if (strcmp(cmd, "vacancy") == 0) {
        uint32_t secs = (uint32_t)strtoul(arg, NULL, 10);
        if ((secs < ELLY_VACANCY_MIN_S) || (secs > ELLY_VACANCY_MAX_S)) {
            badArg = true;
        } else {
            s_state.vacancy_ms = secs * 1000U;
            audit_post(AUDIT_EVT_CMD, parsedRole, "vacancy_set");
        }
    } else if (strcmp(cmd, "away_arm") == 0) {
        s_state.away_armed = true;
        s_state.light_on   = false;
        s_state.fan_on     = false;
        s_state.ac_on      = false;
        s_state.led_r = 0U; s_state.led_g = 0U; s_state.led_b = 0U;
        audit_post(AUDIT_EVT_CMD, parsedRole, "away_arm");
    } else if (strcmp(cmd, "away_disarm") == 0) {
        s_state.away_armed = false;
        audit_post(AUDIT_EVT_CMD, parsedRole, "away_disarm");
    } else if (strcmp(cmd, "privacy") == 0) {
        s_state.privacy_mode = (strcmp(arg, "on") == 0);
        audit_post(AUDIT_EVT_CMD, parsedRole, s_state.privacy_mode ? "priv_on" : "priv_off");
    } else if (strcmp(cmd, "eco") == 0) {
        s_state.auto_eco = (strcmp(arg, "off") != 0);
    } else if (strcmp(cmd, "all_off") == 0) {
        s_state.light_on  = false;
        s_state.light_pct = 0U;
        s_state.fan_on    = false;
        s_state.ac_on     = false;
        s_state.led_r = 0U; s_state.led_g = 0U; s_state.led_b = 0U;
        audit_post(AUDIT_EVT_CMD, parsedRole, "all_off");
    } else if (s_state.safety_latched) {
        rejectedBySafety = true;
    } else if (s_state.away_armed) {
        rejectedByAway = true;
    } else if (strcmp(cmd, "night") == 0) {
        s_state.last_motion_ms = uptime_ms();
        s_lastManualLightMs    = s_state.last_motion_ms;
        s_state.auto_eco       = true;
        s_state.light_on       = true;
        s_state.light_pct      = 15U;
        s_state.fan_on         = false;
        s_state.ac_on          = true;
        s_state.led_r = 28U; s_state.led_g = 12U; s_state.led_b = 2U;
        audit_post(AUDIT_EVT_CMD, parsedRole, "night_mode");
    } else if (strcmp(cmd, "rgb") == 0) {
        uint8_t rr = 0U, gg = 0U, bb = 0U;
        if (parse_rgb_arg(arg, &rr, &gg, &bb)) {
            s_state.last_motion_ms = uptime_ms();
            s_lastManualLightMs    = s_state.last_motion_ms;
            s_state.led_r          = rr;
            s_state.led_g          = gg;
            s_state.led_b          = bb;
        } else {
            badArg = true;
        }
    } else if (strcmp(cmd, "light") == 0) {
        s_state.last_motion_ms = uptime_ms();
        s_lastManualLightMs    = s_state.last_motion_ms;
        s_state.led_r = 0U; s_state.led_g = 0U; s_state.led_b = 0U;
        if (strcmp(arg, "off") == 0) {
            s_state.light_on  = false;
            s_state.light_pct = 0U;
        } else if (strcmp(arg, "on") == 0) {
            s_state.light_on  = true;
            s_state.light_pct = 85U;
        } else if (strcmp(arg, "toggle") == 0) {
            s_state.light_on  = !s_state.light_on;
            s_state.light_pct = s_state.light_on ? 85U : 0U;
        } else {
            uint32_t pct      = (uint32_t)strtoul(arg, NULL, 10);
            s_state.light_pct = (pct > 100U) ? 100U : (uint8_t)pct;
            s_state.light_on  = (s_state.light_pct > 0U);
        }
    } else if (strcmp(cmd, "fan") == 0) {
        s_state.last_motion_ms = uptime_ms();
        s_state.fan_on         = (strcmp(arg, "toggle") == 0) ? !s_state.fan_on : (strcmp(arg, "off") != 0);
    } else if (strcmp(cmd, "ac") == 0) {
        s_state.last_motion_ms = uptime_ms();
        s_state.ac_on          = (strcmp(arg, "toggle") == 0) ? !s_state.ac_on : (strcmp(arg, "off") != 0);
    } else {
        badArg = true;
    }

    bool safetyNow = s_state.safety_latched;
    (void)xSemaphoreGive(s_stateMutex);

    if (rejectedBySafety) {
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"ack\",\"cmd\":\"%s\",\"ok\":false,\"err\":\"safety_override\",\"seq\":%lu}",
                       cmd, (unsigned long)seq);
    } else if (rejectedByAway) {
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"ack\",\"cmd\":\"%s\",\"ok\":false,\"err\":\"away_armed\",\"seq\":%lu}",
                       cmd, (unsigned long)seq);
    } else if (badArg) {
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"ack\",\"cmd\":\"%s\",\"ok\":false,\"err\":\"bad_arg\",\"seq\":%lu}",
                       cmd, (unsigned long)seq);
    } else {
        (void)snprintf(resp, sizeof(resp),
                       "{\"type\":\"ack\",\"cmd\":\"%s\",\"ok\":true,\"seq\":%lu,\"safety\":%s}",
                       cmd, (unsigned long)seq, safetyNow ? "true" : "false");
    }
    Comms_SendLine(resp);
}

static void emit_telemetry_line(void)
{
    elly_sensor_data_t s;
    elly_state_t st;
    flash_status_t fst;
    char line[704];
    char luxStr[16];
    char tempStr[16];
    char dbStr[16];
    char floorStr[16];
    char uidHex[33];

    (void)xSemaphoreTake(s_stateMutex, portMAX_DELAY);
    s  = s_sensors;
    st = s_state;
    (void)xSemaphoreGive(s_stateMutex);

    FlashLog_GetStatus(&fst);
    CryptoAuth_GetUidHex(uidHex);
    fmt_scaled(scale_round(s.lux, 10.0f), 10U, 1U, luxStr, sizeof(luxStr));
    fmt_scaled(scale_round(s.temp_c, 100.0f), 100U, 2U, tempStr, sizeof(tempStr));
    fmt_scaled(scale_round(s.mic_db, 10.0f), 10U, 1U, dbStr, sizeof(dbStr));
    fmt_scaled(scale_round(s.mic_floor_db, 10.0f), 10U, 1U, floorStr, sizeof(floorStr));

    (void)snprintf(line, sizeof(line),
                   "{\"type\":\"telem\",\"uid\":\"%s\",\"nonce\":%lu,\"uptime_ms\":%lu,\"edge\":%s,\"safety\":%s,"
                   "\"safety_reason\":\"%s\",\"away\":%s,\"eco\":%s,\"privacy\":%s,"
                   "\"light\":%s,\"light_pct\":%u,\"fan\":%s,\"ac\":%s,"
                   "\"lux\":%s,\"temp_c\":%s,\"db\":%s,\"floor\":%s,\"vib\":%u,"
                   "\"ax\":%d,\"ay\":%d,\"az\":%d,\"dock\":%s,\"sw2\":%s,\"sw3\":%s,"
                   "\"can_ok\":%s,\"accel_ok\":%s,\"cal\":%s,\"adc_ok\":%s,\"vac_s\":%lu,"
                   "\"audit_n\":%lu,\"telem_q\":%lu,\"last_seq\":%lu}",
                   uidHex,
                   (unsigned long)CryptoAuth_GetBootNonce(),
                   (unsigned long)st.uptime_ms,
                   st.edge_mode ? "true" : "false",
                   st.safety_latched ? "true" : "false",
                   safety_name(st.safety_reason),
                   st.away_armed ? "true" : "false",
                   st.auto_eco ? "true" : "false",
                   st.privacy_mode ? "true" : "false",
                   st.light_on ? "true" : "false",
                   (unsigned)st.light_pct,
                   st.fan_on ? "true" : "false",
                   st.ac_on ? "true" : "false",
                   luxStr,
                   tempStr,
                   dbStr,
                   floorStr,
                   (unsigned)s.vib_rms_mg,
                   (int)s.accel_x_mg,
                   (int)s.accel_y_mg,
                   (int)s.accel_z_mg,
                   s.dock_attached ? "true" : "false",
                   s.sw2_pressed ? "true" : "false",
                   s.sw3_pressed ? "true" : "false",
                   s.can_loopback_ok ? "true" : "false",
                   s.accel_ok ? "true" : "false",
                   s.accel_cal ? "true" : "false",
                   s.adc_ok ? "true" : "false",
                   (unsigned long)(st.vacancy_ms / 1000U),
                   (unsigned long)fst.audit_count,
                   (unsigned long)fst.telem_buffered,
                   (unsigned long)CryptoAuth_GetLastSeq());
    Comms_SendLine(line);
}

static void CommsSecurityTask(void *pvParameters)
{
    (void)pvParameters;
    char uidHex[33];
    char line[ELLY_RX_LINE_MAX];
    char bootLine[320];
    flash_status_t fst;

    CryptoAuth_GetUidHex(uidHex);
    FlashLog_GetStatus(&fst);

    (void)snprintf(bootLine, sizeof(bootLine),
                   "{\"type\":\"boot\",\"fw\":\"%s\",\"uid\":\"%s\",\"nonce\":%lu,\"flash_ok\":%s,"
                   "\"jedec\":\"%02x%02x%02x\",\"accel_ok\":%s,\"can_ok\":%s,\"audit_n\":%lu}",
                   ELLY_FW_VERSION, uidHex, (unsigned long)CryptoAuth_GetBootNonce(),
                   fst.flash_ok ? "true" : "false",
                   fst.jedec_mfr, fst.jedec_type, fst.jedec_cap,
                   s_sensors.accel_ok ? "true" : "false",
                   s_sensors.can_loopback_ok ? "true" : "false",
                   (unsigned long)fst.audit_count);
    Comms_SendLine(bootLine);

    uint32_t lastTelemMs = uptime_ms();
    for (;;) {
        if (Comms_ReceiveLine(line, sizeof(line), 50U)) {
            handle_command_line(line);
        }

        uint32_t now = uptime_ms();
        if ((now - lastTelemMs) >= ELLY_TELEMETRY_PERIOD_MS) {
            lastTelemMs = now;
            emit_telemetry_line();
        }
    }
}

void TasksCtrl_Start(void)
{
    s_stateMutex = xSemaphoreCreateMutex();
    s_auditQ     = xQueueCreate(AUDIT_QUEUE_DEPTH, sizeof(audit_msg_t));
    memset(&s_sensors, 0, sizeof(s_sensors));
    memset(&s_state, 0, sizeof(s_state));

    s_state.light_on          = true;
    s_state.light_pct         = 80U;
    s_state.auto_eco          = true;
    s_state.last_heartbeat_ms = 0U;
    s_state.last_motion_ms    = 0U;
    s_state.vacancy_ms        = ELLY_VACANCY_DEFAULT_MS;

    Sensors_Init();
    Sensors_PollFast(&s_sensors, NULL, NULL, NULL);
    Sensors_PollSlow(&s_sensors);

    FlashLog_Init();
    (void)FlashLog_AppendAudit(AUDIT_EVT_BOOT, ELLY_ROLE_SYSTEM, "elly_boot");

    /* The audit sequence only ever grows, so it is a fresh nonce on every boot */
    uint32_t nonce = FlashLog_GetLastAuditSeq();
    if (nonce == 0U) {
        nonce = (uint32_t)SysTick->VAL ^ 0xA5C3E1B7U; /* flash unavailable: weaker fallback */
    }
    CryptoAuth_SetBootNonce(nonce);

    (void)xTaskCreate(SensorTask, "sensor_task", 640U, NULL, 3U, &s_hSensor);
    (void)xTaskCreate(SafetyTask, "safety_task", 512U, NULL, 5U, &s_hSafety);
    (void)xTaskCreate(AutomationTask, "auto_task", 384U, NULL, 2U, &s_hAuto);
    (void)xTaskCreate(CommsSecurityTask, "comms_sec", 1536U, NULL, 4U, &s_hComms);
    (void)xTaskCreate(LogTask, "log_task", 640U, NULL, 1U, &s_hLog);
}
