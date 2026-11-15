#ifndef ELLY_TYPES_H_
#define ELLY_TYPES_H_

#include <stdbool.h>
#include <stdint.h>

#define ELLY_FW_VERSION            "1.1.0"
#define ELLY_HEARTBEAT_TIMEOUT_MS  4000U
#define ELLY_TELEMETRY_PERIOD_MS   1000U

/* Vacancy auto-off: 20 min by default (spec), 20 s in demo timing (set from gateway) */
#define ELLY_VACANCY_DEFAULT_MS    1200000U
#define ELLY_VACANCY_MIN_S         10U
#define ELLY_VACANCY_MAX_S         86400U

/* On-die temperature is MCU self-protection only: normal room use sits at 30..45 C */
#define ELLY_TEMP_WARN_C           60.0f
#define ELLY_TEMP_CRIT_C           75.0f
#define ELLY_TEMP_CONFIRM_TICKS    10U

/* Sound level is relative, so claps are detected as a rise over a slow noise floor */
#define ELLY_CLAP_MIN_DB           60.0f
#define ELLY_CLAP_RISE_DB          18.0f
#define ELLY_ACOUSTIC_CLAPS        2U
#define ELLY_ACOUSTIC_WINDOW_MS    3000U

/* Fall = free-fall followed by an impact spike, in calibrated mg */
#define ELLY_FALL_FREEFALL_MG      400
#define ELLY_FALL_FREEFALL_SAMPLES 3U
#define ELLY_FALL_IMPACT_MG        1800
#define ELLY_FALL_WINDOW_MS        600U

typedef enum {
    ELLY_ROLE_GUEST  = 0,
    ELLY_ROLE_FAMILY = 1,
    ELLY_ROLE_OWNER  = 2,
    ELLY_ROLE_SYSTEM = 3, /* gateway automation and firmware self-events, never a human */
} elly_role_t;

typedef enum {
    ELLY_SAFETY_NORMAL    = 0,
    ELLY_SAFETY_THERMAL   = 1,
    ELLY_SAFETY_FALL      = 2,
    ELLY_SAFETY_TAMPER    = 3,
    ELLY_SAFETY_ACOUSTIC  = 4,
    ELLY_SAFETY_EDGE_LOST = 5,
    ELLY_SAFETY_EMERGENCY = 6,
} elly_safety_t;

typedef struct {
    int16_t accel_x_mg;
    int16_t accel_y_mg;
    int16_t accel_z_mg;
    uint16_t vib_rms_mg; /* mean absolute change of |a| over 0.5 s, not a true RMS */
    float lux;           /* relative light index, not calibrated lux */
    float temp_c;        /* on-die temperature */
    float mic_db;        /* relative sound level, not SPL */
    float mic_peak_db;
    float mic_floor_db;
    bool clap_detected;
    bool fall_detected;  /* sticky until the safety task consumes it */
    bool dock_attached;
    bool sw2_pressed;
    bool sw3_pressed;
    bool can_loopback_ok;
    bool accel_ok;
    bool accel_cal;
    bool adc_ok;
} elly_sensor_data_t;

typedef struct {
    bool light_on;
    uint8_t light_pct;
    bool fan_on;
    bool ac_on;
    bool away_armed;
    bool auto_eco;
    bool edge_mode;
    bool privacy_mode;
    bool safety_latched;
    elly_safety_t safety_reason;
    uint8_t led_r;
    uint8_t led_g;
    uint8_t led_b;
    uint32_t last_heartbeat_ms;
    uint32_t last_motion_ms;
    uint32_t uptime_ms;
    uint32_t vacancy_ms;
} elly_state_t;

#endif /* ELLY_TYPES_H_ */
