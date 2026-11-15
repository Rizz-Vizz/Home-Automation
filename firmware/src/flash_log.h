#ifndef ELLY_FLASH_LOG_H_
#define ELLY_FLASH_LOG_H_

#include "elly_types.h"
#include <stdbool.h>
#include <stdint.h>

typedef enum {
    AUDIT_EVT_BOOT       = 1,
    AUDIT_EVT_SAFETY     = 2,
    AUDIT_EVT_AUTH_FAIL  = 3,
    AUDIT_EVT_RBAC_DENY  = 4,
    AUDIT_EVT_EDGE_ENTER = 5,
    AUDIT_EVT_EDGE_EXIT  = 6,
    AUDIT_EVT_CMD        = 7,
    AUDIT_EVT_BUTTON     = 8,
    AUDIT_EVT_DOCK       = 9,
} audit_event_t;

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t seq;
    uint32_t uptime_ms;
    uint8_t event_type;
    uint8_t role;
    uint16_t flags;
    char detail[24];
    uint8_t prev_hash[8];
    uint8_t entry_hash[16];
} flash_audit_rec_t;

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t seq;
    uint32_t uptime_ms;
    int16_t accel_x_mg;
    int16_t accel_y_mg;
    int16_t accel_z_mg;
    uint16_t vib_rms_mg;
    uint16_t lux_x10;
    int16_t temp_c_x100;
    uint16_t mic_db_x10;
    uint8_t flags;
    uint8_t reserved;
    uint32_t crc32;
} flash_telem_rec_t;

typedef struct {
    bool flash_ok;
    uint8_t jedec_mfr;
    uint8_t jedec_type;
    uint8_t jedec_cap;
    uint8_t dev_mfr;
    uint8_t dev_id;
    uint32_t audit_count;
    uint32_t telem_buffered;
    uint32_t erase_count;
} flash_status_t;

void FlashLog_Init(void);
void FlashLog_GetStatus(flash_status_t *out);
uint32_t FlashLog_GetLastAuditSeq(void);

bool FlashLog_AppendAudit(audit_event_t evt, elly_role_t role, const char *detail);
bool FlashLog_PushOfflineTelemetry(const elly_sensor_data_t *s, const elly_state_t *st);

uint32_t FlashLog_DumpRecentAudit(flash_audit_rec_t *outArr, uint32_t maxItems);
uint32_t FlashLog_PopOfflineBatch(flash_telem_rec_t *outArr, uint32_t maxItems);

#endif /* ELLY_FLASH_LOG_H_ */
