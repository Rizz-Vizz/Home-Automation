/* Host build of the real crypto_auth.c: HMAC parity with Node + RBAC matrix dump */
#include "fsl_flash.h"
#include "fsl_flash_ffr.h"
#include "crypto_auth.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int FLASH_Init(flash_config_t *c) { (void)c; return 0; }
int FFR_Init(flash_config_t *c) { (void)c; return 0; }
int FFR_GetUUID(flash_config_t *c, uint8_t *uuid)
{
    (void)c;
    for (int i = 0; i < 16; i++) uuid[i] = (uint8_t)(0x10 + i);
    return 0;
}

int main(int argc, char **argv)
{
    CryptoAuth_Init();
    if (argc > 1 && strcmp(argv[1], "rbac") == 0) {
        const char *roles[] = { "guest", "family", "owner", "system" };
        const char *cmds[] = { "light", "rgb", "fan", "ac", "eco", "all_off", "night", "alert_test", "emergency",
                               "privacy:on", "privacy:off", "away_arm", "away_disarm", "safety_clear", "vacancy",
                               "trip", "heartbeat", "ping", "audit_dump", "backfill_sync", "can_diag", "flash_id" };
        for (size_t r = 0; r < 4; r++) {
            elly_role_t role; CryptoAuth_ParseRole(roles[r], &role);
            for (size_t c = 0; c < sizeof(cmds) / sizeof(cmds[0]); c++) {
                char cmd[32]; const char *arg = "";
                strcpy(cmd, cmds[c]);
                char *colon = strchr(cmd, ':');
                if (colon) { *colon = 0; arg = colon + 1; }
                printf("%s %s %d\n", roles[r], cmds[c], CryptoAuth_IsAllowed(role, cmd, arg) ? 1 : 0);
            }
        }
        return 0;
    }
    char uid[33];
    CryptoAuth_GetUidHex(uid);
    CryptoAuth_SetBootNonce(777U);
    char cmd[32], arg[48], role[16], sig[80];
    unsigned long seq;
    /* stdin lines: cmd|arg|role|seq|sig */
    char line[256];
    printf("uid %s\n", uid);
    while (fgets(line, sizeof(line), stdin)) {
        line[strcspn(line, "\r\n")] = 0;
        char *f[5]; int n = 0; char *p = line;
        f[n++] = p;
        while (*p && n < 5) { if (*p == '|') { *p = 0; f[n++] = p + 1; } p++; }
        if (n != 5) { printf("fmt\n"); continue; }
        strncpy(cmd, f[0], 31); cmd[31] = 0; strncpy(arg, f[1], 47); arg[47] = 0;
        strncpy(role, f[2], 15); role[15] = 0; seq = strtoul(f[3], NULL, 10); strncpy(sig, f[4], 79); sig[79] = 0;
        elly_role_t out;
        printf("%d\n", (int)CryptoAuth_VerifyCommand(cmd, arg, role, (uint32_t)seq, sig, &out));
    }
    return 0;
}
