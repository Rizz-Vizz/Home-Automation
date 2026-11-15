#include "flash_log.h"
#include "app.h"
#include "crypto_auth.h"
#include "fsl_gpio.h"
#include "fsl_lpspi.h"
#include "FreeRTOS.h"
#include "semphr.h"
#include "task.h"
#include <stddef.h>
#include <string.h>

/*
 * Bounded wear-safe layout inside W25Q64 (8 MiB):
 *   Audit Log Ring       : 0x100000 .. 0x11FFFF (32 sectors = 128 KiB, 2048 slots x 64B)
 *   Offline Telemetry Ring: 0x120000 .. 0x13FFFF (32 sectors = 128 KiB, 4096 slots x 32B)
 * Only wrapped circular sector erases are ever issued, throttled by min interval.
 */
#define W25Q_SECTOR_SIZE        4096U
#define W25Q_PAGE_SIZE          256U

#define AUDIT_BASE_ADDR         0x100000U
#define AUDIT_SECTOR_COUNT      32U
#define AUDIT_SLOTS_PER_SECTOR  (W25Q_SECTOR_SIZE / sizeof(flash_audit_rec_t))
#define AUDIT_TOTAL_SLOTS       (AUDIT_SECTOR_COUNT * AUDIT_SLOTS_PER_SECTOR)
#define AUDIT_MAGIC             0x454C4155U /* 'ELAU' */

#define TELEM_BASE_ADDR         0x120000U
#define TELEM_SECTOR_COUNT      32U
#define TELEM_SLOTS_PER_SECTOR  (W25Q_SECTOR_SIZE / sizeof(flash_telem_rec_t))
#define TELEM_TOTAL_SLOTS       (TELEM_SECTOR_COUNT * TELEM_SLOTS_PER_SECTOR)
#define TELEM_MAGIC             0x454C544DU /* 'ELTM' */

#define CMD_JEDEC_ID            0x9FU
#define CMD_MFR_DEV_ID          0x90U
#define CMD_READ_SR1            0x05U
#define CMD_WRITE_ENABLE        0x06U
#define CMD_READ_DATA           0x03U
#define CMD_PAGE_PROGRAM        0x02U
#define CMD_SECTOR_ERASE_4K     0x20U

static SemaphoreHandle_t s_flashMutex = NULL;
static flash_status_t s_status;
static uint32_t s_auditWriteIdx = 0U;
static uint32_t s_auditSeq      = 0U;
static uint8_t s_chainTip[8]    = {0};

static uint32_t s_telemWriteIdx = 0U;
static uint32_t s_telemReadIdx  = 0U;
static uint32_t s_telemSeq      = 0U;
static uint32_t s_lastTelemTick = 0U;

static inline void cs_low(void)
{
    GPIO_PinWrite(ELLY_FLASH_CS_GPIO, ELLY_FLASH_CS_PIN, 0U);
}

static inline void cs_high(void)
{
    GPIO_PinWrite(ELLY_FLASH_CS_GPIO, ELLY_FLASH_CS_PIN, 1U);
}

static bool spi_xfer(const uint8_t *tx, uint8_t *rx, size_t len)
{
    lpspi_transfer_t xfer;
    xfer.txData      = tx;
    xfer.rxData      = rx;
    xfer.dataSize    = len;
    xfer.configFlags = kLPSPI_MasterPcs0;
    return LPSPI_MasterTransferBlocking(ELLY_FLASH_LPSPI, &xfer) == kStatus_Success;
}

static void w25q_read_bytes(uint32_t addr, uint8_t *out, size_t len)
{
    uint8_t hdr[4] = {
        CMD_READ_DATA,
        (uint8_t)((addr >> 16) & 0xFFU),
        (uint8_t)((addr >> 8) & 0xFFU),
        (uint8_t)(addr & 0xFFU),
    };
    cs_low();
    (void)spi_xfer(hdr, NULL, sizeof(hdr));
    if (len > 0U) {
        (void)spi_xfer(NULL, out, len);
    }
    cs_high();
}

static uint8_t w25q_read_sr1(void)
{
    uint8_t tx[2] = { CMD_READ_SR1, 0xFFU };
    uint8_t rx[2] = { 0U, 0xFFU };
    cs_low();
    (void)spi_xfer(tx, rx, sizeof(tx));
    cs_high();
    return rx[1];
}

static bool w25q_wait_ready(uint32_t timeoutMs)
{
    uint32_t spins = timeoutMs * 200U;
    while ((w25q_read_sr1() & 0x01U) != 0U) {
        if (spins-- == 0U) {
            return false;
        }
        if (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING) {
            vTaskDelay(pdMS_TO_TICKS(1U));
        }
    }
    return true;
}

static void w25q_write_enable(void)
{
    uint8_t cmd = CMD_WRITE_ENABLE;
    cs_low();
    (void)spi_xfer(&cmd, NULL, 1U);
    cs_high();
}

static bool w25q_erase_sector(uint32_t addr)
{
    uint32_t aligned = addr & ~(W25Q_SECTOR_SIZE - 1U);
    bool inAudit     = (aligned >= AUDIT_BASE_ADDR) &&
                       (aligned < (AUDIT_BASE_ADDR + AUDIT_SECTOR_COUNT * W25Q_SECTOR_SIZE));
    bool inTelem     = (aligned >= TELEM_BASE_ADDR) &&
                       (aligned < (TELEM_BASE_ADDR + TELEM_SECTOR_COUNT * W25Q_SECTOR_SIZE));
    if (!inAudit && !inTelem) {
        return false;
    }

    w25q_write_enable();
    uint8_t cmd[4] = {
        CMD_SECTOR_ERASE_4K,
        (uint8_t)((aligned >> 16) & 0xFFU),
        (uint8_t)((aligned >> 8) & 0xFFU),
        (uint8_t)(aligned & 0xFFU),
    };
    cs_low();
    (void)spi_xfer(cmd, NULL, sizeof(cmd));
    cs_high();

    if (!w25q_wait_ready(400U)) {
        return false;
    }
    s_status.erase_count++;
    return true;
}

static bool w25q_program_page_chunk(uint32_t addr, const uint8_t *data, size_t len)
{
    if ((len == 0U) || (len > W25Q_PAGE_SIZE)) {
        return false;
    }
    w25q_write_enable();
    uint8_t hdr[4] = {
        CMD_PAGE_PROGRAM,
        (uint8_t)((addr >> 16) & 0xFFU),
        (uint8_t)((addr >> 8) & 0xFFU),
        (uint8_t)(addr & 0xFFU),
    };
    cs_low();
    (void)spi_xfer(hdr, NULL, sizeof(hdr));
    (void)spi_xfer(data, NULL, len);
    cs_high();

    return w25q_wait_ready(50U);
}

static uint32_t crc32_compute(const uint8_t *buf, size_t len)
{
    uint32_t crc = 0xFFFFFFFFU;
    for (size_t i = 0U; i < len; i++) {
        crc ^= buf[i];
        for (uint32_t b = 0U; b < 8U; b++) {
            crc = (crc & 1U) ? ((crc >> 1) ^ 0xEDB88320U) : (crc >> 1);
        }
    }
    return ~crc;
}

static void probe_jedec(void)
{
    uint8_t tx4[4] = { CMD_JEDEC_ID, 0xFFU, 0xFFU, 0xFFU };
    uint8_t rx4[4] = { 0 };
    cs_low();
    (void)spi_xfer(tx4, rx4, sizeof(tx4));
    cs_high();
    s_status.jedec_mfr  = rx4[1];
    s_status.jedec_type = rx4[2];
    s_status.jedec_cap  = rx4[3];

    uint8_t tx6[6] = { CMD_MFR_DEV_ID, 0x00U, 0x00U, 0x00U, 0xFFU, 0xFFU };
    uint8_t rx6[6] = { 0 };
    cs_low();
    (void)spi_xfer(tx6, rx6, sizeof(tx6));
    cs_high();
    s_status.dev_mfr = rx6[4];
    s_status.dev_id  = rx6[5];

    s_status.flash_ok = (s_status.jedec_mfr == 0xEFU) && (s_status.dev_id == 0x16U);
}

static void scan_existing_rings(void)
{
    flash_audit_rec_t rec;
    uint32_t bestSeq = 0U;
    uint32_t bestIdx = 0U;
    bool foundAny    = false;

    for (uint32_t s = 0U; s < AUDIT_SECTOR_COUNT; s++) {
        for (uint32_t slot = 0U; slot < AUDIT_SLOTS_PER_SECTOR; slot++) {
            uint32_t idx  = s * AUDIT_SLOTS_PER_SECTOR + slot;
            uint32_t addr = AUDIT_BASE_ADDR + idx * sizeof(flash_audit_rec_t);
            w25q_read_bytes(addr, (uint8_t *)&rec, 12U);
            if (rec.magic == 0xFFFFFFFFU) {
                break;
            }
            if ((rec.magic == AUDIT_MAGIC) && (rec.seq >= bestSeq)) {
                w25q_read_bytes(addr, (uint8_t *)&rec, sizeof(rec));
                bestSeq  = rec.seq;
                bestIdx  = idx;
                foundAny = true;
                memcpy(s_chainTip, rec.entry_hash, 8U);
            }
        }
    }

    if (foundAny) {
        s_auditSeq      = bestSeq;
        s_auditWriteIdx = (bestIdx + 1U) % AUDIT_TOTAL_SLOTS;
        s_status.audit_count = bestSeq;
    } else {
        s_auditSeq      = 0U;
        s_auditWriteIdx = 0U;
        memset(s_chainTip, 0, sizeof(s_chainTip));
        s_status.audit_count = 0U;
    }

    s_telemSeq      = 0U;
    s_telemWriteIdx = 0U;
    s_telemReadIdx  = 0U;
    s_status.telem_buffered = 0U;

    flash_telem_rec_t trec;
    uint32_t tBestSeq = 0U;
    uint32_t tBestIdx = 0U;
    bool tFound       = false;
    for (uint32_t s = 0U; s < TELEM_SECTOR_COUNT; s++) {
        uint32_t addr = TELEM_BASE_ADDR + s * W25Q_SECTOR_SIZE;
        w25q_read_bytes(addr, (uint8_t *)&trec, 8U);
        if (trec.magic != TELEM_MAGIC) {
            continue;
        }
        for (uint32_t slot = 0U; slot < TELEM_SLOTS_PER_SECTOR; slot++) {
            uint32_t idx = s * TELEM_SLOTS_PER_SECTOR + slot;
            w25q_read_bytes(TELEM_BASE_ADDR + idx * sizeof(flash_telem_rec_t), (uint8_t *)&trec, 8U);
            if (trec.magic == 0xFFFFFFFFU) {
                break;
            }
            if ((trec.magic == TELEM_MAGIC) && (trec.seq >= tBestSeq)) {
                tBestSeq = trec.seq;
                tBestIdx = idx;
                tFound   = true;
            }
        }
    }
    if (tFound) {
        s_telemSeq      = tBestSeq;
        s_telemWriteIdx = (tBestIdx + 1U) % TELEM_TOTAL_SLOTS;
        s_telemReadIdx  = s_telemWriteIdx;
    }
}

void FlashLog_Init(void)
{
    lpspi_master_config_t cfg;
    if (s_flashMutex == NULL) {
        s_flashMutex = xSemaphoreCreateMutex();
    }
    memset(&s_status, 0, sizeof(s_status));

    LPSPI_MasterGetDefaultConfig(&cfg);
    cfg.baudRate                      = ELLY_FLASH_BAUD_HZ;
    cfg.bitsPerFrame                  = 8U;
    cfg.cpol                          = kLPSPI_ClockPolarityActiveHigh;
    cfg.cpha                          = kLPSPI_ClockPhaseFirstEdge;
    cfg.direction                     = kLPSPI_MsbFirst;
    cfg.pinCfg                        = kLPSPI_SdiInSdoOut;
    cfg.whichPcs                      = kLPSPI_Pcs0;
    cfg.pcsActiveHighOrLow            = kLPSPI_PcsActiveLow;
    cfg.pcsToSckDelayInNanoSec        = 50U;
    cfg.lastSckToPcsDelayInNanoSec    = 50U;
    cfg.betweenTransferDelayInNanoSec = 50U;

    LPSPI_MasterInit(ELLY_FLASH_LPSPI, &cfg, ELLY_FLASH_CLK_FREQ);
    cs_high();

    probe_jedec();
    if (s_status.flash_ok) {
        scan_existing_rings();
    }
}

void FlashLog_GetStatus(flash_status_t *out)
{
    if (out == NULL) {
        return;
    }
    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreTake(s_flashMutex, portMAX_DELAY);
    }
    *out = s_status;
    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreGive(s_flashMutex);
    }
}

uint32_t FlashLog_GetLastAuditSeq(void)
{
    return s_auditSeq;
}

bool FlashLog_AppendAudit(audit_event_t evt, elly_role_t role, const char *detail)
{
    if (!s_status.flash_ok) {
        return false;
    }

    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreTake(s_flashMutex, portMAX_DELAY);
    }

    uint32_t slotInSector = s_auditWriteIdx % AUDIT_SLOTS_PER_SECTOR;
    uint32_t addr         = AUDIT_BASE_ADDR + s_auditWriteIdx * sizeof(flash_audit_rec_t);

    /* Check if target slot is erased; erase the 4KB sector only at boundary or if dirty */
    uint32_t probeWord = 0U;
    w25q_read_bytes(addr, (uint8_t *)&probeWord, sizeof(probeWord));
    if ((slotInSector == 0U && probeWord != 0xFFFFFFFFU) || (probeWord != 0xFFFFFFFFU)) {
        uint32_t sectorBase = addr & ~(W25Q_SECTOR_SIZE - 1U);
        if (!w25q_erase_sector(sectorBase)) {
            if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
                (void)xSemaphoreGive(s_flashMutex);
            }
            return false;
        }
        s_auditWriteIdx = ((sectorBase - AUDIT_BASE_ADDR) / sizeof(flash_audit_rec_t));
        addr            = sectorBase;
    }

    flash_audit_rec_t rec;
    memset(&rec, 0, sizeof(rec));
    rec.magic      = AUDIT_MAGIC;
    rec.seq        = ++s_auditSeq;
    rec.uptime_ms  = (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)
                         ? (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS)
                         : 0U;
    rec.event_type = (uint8_t)evt;
    rec.role       = (uint8_t)role;
    rec.flags      = 0U;
    if (detail != NULL) {
        size_t n = strlen(detail);
        if (n >= sizeof(rec.detail)) {
            n = sizeof(rec.detail) - 1U;
        }
        memcpy(rec.detail, detail, n);
    }
    memcpy(rec.prev_hash, s_chainTip, 8U);

    uint8_t fullHash[32];
    CryptoAuth_Sha256((const uint8_t *)&rec, offsetof(flash_audit_rec_t, entry_hash), fullHash);
    memcpy(rec.entry_hash, fullHash, 16U);

    bool ok = w25q_program_page_chunk(addr, (const uint8_t *)&rec, sizeof(rec));
    if (ok) {
        memcpy(s_chainTip, rec.entry_hash, 8U);
        s_auditWriteIdx = (s_auditWriteIdx + 1U) % AUDIT_TOTAL_SLOTS;
        s_status.audit_count++;
    }

    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreGive(s_flashMutex);
    }
    return ok;
}

bool FlashLog_PushOfflineTelemetry(const elly_sensor_data_t *s, const elly_state_t *st)
{
    if (!s_status.flash_ok || (s == NULL) || (st == NULL)) {
        return false;
    }

    /* Rate-limit offline flash writes to at most 1 Hz to avoid unnecessary flash wear */
    uint32_t nowMs = st->uptime_ms;
    if ((s_lastTelemTick != 0U) && ((nowMs - s_lastTelemTick) < 950U)) {
        return false;
    }
    s_lastTelemTick = nowMs;

    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreTake(s_flashMutex, portMAX_DELAY);
    }

    uint32_t addr = TELEM_BASE_ADDR + s_telemWriteIdx * sizeof(flash_telem_rec_t);
    uint32_t probeWord = 0U;
    w25q_read_bytes(addr, (uint8_t *)&probeWord, sizeof(probeWord));
    if (probeWord != 0xFFFFFFFFU) {
        uint32_t sectorBase = addr & ~(W25Q_SECTOR_SIZE - 1U);
        if (!w25q_erase_sector(sectorBase)) {
            if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
                (void)xSemaphoreGive(s_flashMutex);
            }
            return false;
        }
        uint32_t baseSlot = (sectorBase - TELEM_BASE_ADDR) / sizeof(flash_telem_rec_t);
        uint32_t endSlot  = baseSlot + TELEM_SLOTS_PER_SECTOR;
        /* Advance read cursor if this sector still held old unread slots */
        if ((s_status.telem_buffered > 0U) &&
            (s_telemReadIdx >= baseSlot) && (s_telemReadIdx < endSlot)) {
            uint32_t dropped = endSlot - s_telemReadIdx;
            s_status.telem_buffered = (s_status.telem_buffered > dropped)
                                          ? (s_status.telem_buffered - dropped)
                                          : 0U;
            s_telemReadIdx = endSlot % TELEM_TOTAL_SLOTS;
        }
        s_telemWriteIdx = baseSlot;
        addr            = sectorBase;
    }

    flash_telem_rec_t rec;
    memset(&rec, 0, sizeof(rec));
    rec.magic       = TELEM_MAGIC;
    rec.seq         = ++s_telemSeq;
    rec.uptime_ms   = st->uptime_ms;
    rec.accel_x_mg  = s->accel_x_mg;
    rec.accel_y_mg  = s->accel_y_mg;
    rec.accel_z_mg  = s->accel_z_mg;
    rec.vib_rms_mg  = s->vib_rms_mg;
    rec.lux_x10     = (uint16_t)((s->lux >= 0.0f) ? (s->lux * 10.0f) : 0.0f);
    rec.temp_c_x100 = (int16_t)(s->temp_c * 100.0f);
    rec.mic_db_x10  = (uint16_t)((s->mic_db >= 0.0f) ? (s->mic_db * 10.0f) : 0.0f);
    rec.flags       = (uint8_t)((st->light_on ? 1U : 0U) |
                                (st->fan_on ? 2U : 0U) |
                                (st->away_armed ? 4U : 0U) |
                                (st->edge_mode ? 8U : 0U) |
                                (st->safety_latched ? 16U : 0U) |
                                (s->dock_attached ? 32U : 0U));
    rec.crc32       = crc32_compute((const uint8_t *)&rec, offsetof(flash_telem_rec_t, crc32));

    bool ok = w25q_program_page_chunk(addr, (const uint8_t *)&rec, sizeof(rec));
    if (ok) {
        s_telemWriteIdx = (s_telemWriteIdx + 1U) % TELEM_TOTAL_SLOTS;
        if (s_status.telem_buffered < TELEM_TOTAL_SLOTS) {
            s_status.telem_buffered++;
        }
    }

    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreGive(s_flashMutex);
    }
    return ok;
}

uint32_t FlashLog_DumpRecentAudit(flash_audit_rec_t *outArr, uint32_t maxItems)
{
    if (!s_status.flash_ok || (outArr == NULL) || (maxItems == 0U)) {
        return 0U;
    }

    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreTake(s_flashMutex, portMAX_DELAY);
    }

    uint32_t maxScan    = AUDIT_SLOTS_PER_SECTOR * 4U;
    uint32_t validCount = 0U;
    uint32_t emptyRun   = 0U;

    /* Walk backwards from the most recent slot so sector erases leave no blind spot. */
    for (uint32_t step = 1U; (step <= maxScan) && (validCount < maxItems); step++) {
        uint32_t idx = (s_auditWriteIdx + AUDIT_TOTAL_SLOTS - step) % AUDIT_TOTAL_SLOTS;
        flash_audit_rec_t rec;
        w25q_read_bytes(AUDIT_BASE_ADDR + idx * sizeof(flash_audit_rec_t), (uint8_t *)&rec, sizeof(rec));
        if (rec.magic == AUDIT_MAGIC) {
            outArr[validCount++] = rec;
            emptyRun             = 0U;
        } else {
            emptyRun++;
            if ((validCount > 0U) && (emptyRun >= AUDIT_SLOTS_PER_SECTOR)) {
                break;
            }
        }
    }

    for (uint32_t i = 0U; i < (validCount / 2U); i++) {
        flash_audit_rec_t tmp        = outArr[i];
        outArr[i]                    = outArr[validCount - 1U - i];
        outArr[validCount - 1U - i]  = tmp;
    }

    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreGive(s_flashMutex);
    }
    return validCount;
}

uint32_t FlashLog_PopOfflineBatch(flash_telem_rec_t *outArr, uint32_t maxItems)
{
    if (!s_status.flash_ok || (outArr == NULL) || (maxItems == 0U)) {
        return 0U;
    }

    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreTake(s_flashMutex, portMAX_DELAY);
    }

    uint32_t popped = 0U;
    while ((s_status.telem_buffered > 0U) && (popped < maxItems)) {
        flash_telem_rec_t rec;
        w25q_read_bytes(TELEM_BASE_ADDR + s_telemReadIdx * sizeof(flash_telem_rec_t),
                        (uint8_t *)&rec, sizeof(rec));
        s_telemReadIdx = (s_telemReadIdx + 1U) % TELEM_TOTAL_SLOTS;
        s_status.telem_buffered--;

        if (rec.magic == TELEM_MAGIC) {
            uint32_t expectedCrc = crc32_compute((const uint8_t *)&rec, offsetof(flash_telem_rec_t, crc32));
            if (expectedCrc == rec.crc32) {
                outArr[popped++] = rec;
            }
        }
    }

    if ((s_flashMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreGive(s_flashMutex);
    }
    return popped;
}
