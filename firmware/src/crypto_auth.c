#include "crypto_auth.h"
#include "fsl_flash.h"
#include "fsl_flash_ffr.h"
#include <stdio.h>
#include <string.h>

#if __has_include("elly_secret.h")
#include "elly_secret.h"
#else
#error "elly_secret.h is missing. Run: python firmware/tools/gen_secrets.py"
#endif

/*
 * Each board derives its own key: devKey = HMAC-SHA256(master, "ELLY-DEV1|" + chipUid).
 * The master secret lives only in the gitignored elly_secret.h and gateway/.env.
 * Commands are signed over cmd|arg|role|seq|bootNonce, so a capture from an earlier
 * boot can never be replayed after a reset (the nonce changes on every boot).
 */
static const uint8_t s_masterKey[32] = ELLY_MASTER_KEY_BYTES;
static uint8_t s_deviceKey[32];
static bool s_uidValid = false;

static uint8_t s_chipUid[16];
static char s_chipUidHex[33] = "00000000000000000000000000000000";
static uint32_t s_lastSeq = 0U;
static uint32_t s_bootNonce = 0U;

static inline uint32_t rotr32(uint32_t x, uint32_t n)
{
    return (x >> n) | (x << (32U - n));
}

static void sha256_transform(uint32_t state[8], const uint8_t block[64])
{
    static const uint32_t k[64] = {
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
        0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
        0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
        0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
        0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
        0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
        0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
        0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U
    };
    uint32_t w[64];
    for (uint32_t i = 0U; i < 16U; i++) {
        w[i] = ((uint32_t)block[i * 4U] << 24) |
               ((uint32_t)block[i * 4U + 1U] << 16) |
               ((uint32_t)block[i * 4U + 2U] << 8) |
               (uint32_t)block[i * 4U + 3U];
    }
    for (uint32_t i = 16U; i < 64U; i++) {
        uint32_t s0 = rotr32(w[i - 15U], 7U) ^ rotr32(w[i - 15U], 18U) ^ (w[i - 15U] >> 3);
        uint32_t s1 = rotr32(w[i - 2U], 17U) ^ rotr32(w[i - 2U], 19U) ^ (w[i - 2U] >> 10);
        w[i] = w[i - 16U] + s0 + w[i - 7U] + s1;
    }

    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
    for (uint32_t i = 0U; i < 64U; i++) {
        uint32_t S1    = rotr32(e, 6U) ^ rotr32(e, 11U) ^ rotr32(e, 25U);
        uint32_t ch    = (e & f) ^ ((~e) & g);
        uint32_t temp1 = h + S1 + ch + k[i] + w[i];
        uint32_t S0    = rotr32(a, 2U) ^ rotr32(a, 13U) ^ rotr32(a, 22U);
        uint32_t maj   = (a & b) ^ (a & c) ^ (b & c);
        uint32_t temp2 = S0 + maj;

        h = g; g = f; f = e; e = d + temp1;
        d = c; c = b; b = a; a = temp1 + temp2;
    }

    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

typedef struct {
    uint32_t state[8];
    uint64_t bitCount;
    uint8_t buffer[64];
    size_t bufferLen;
} sha256_ctx_t;

static void sha256_init(sha256_ctx_t *ctx)
{
    ctx->state[0] = 0x6a09e667U; ctx->state[1] = 0xbb67ae85U;
    ctx->state[2] = 0x3c6ef372U; ctx->state[3] = 0xa54ff53aU;
    ctx->state[4] = 0x510e527fU; ctx->state[5] = 0x9b05688cU;
    ctx->state[6] = 0x1f83d9abU; ctx->state[7] = 0x5be0cd19U;
    ctx->bitCount = 0U;
    ctx->bufferLen = 0U;
}

static void sha256_update(sha256_ctx_t *ctx, const uint8_t *data, size_t len)
{
    for (size_t i = 0U; i < len; i++) {
        ctx->buffer[ctx->bufferLen++] = data[i];
        ctx->bitCount += 8U;
        if (ctx->bufferLen == 64U) {
            sha256_transform(ctx->state, ctx->buffer);
            ctx->bufferLen = 0U;
        }
    }
}

static void sha256_final(sha256_ctx_t *ctx, uint8_t out32[32])
{
    uint64_t totalBits = ctx->bitCount;
    ctx->buffer[ctx->bufferLen++] = 0x80U;
    if (ctx->bufferLen > 56U) {
        while (ctx->bufferLen < 64U) {
            ctx->buffer[ctx->bufferLen++] = 0x00U;
        }
        sha256_transform(ctx->state, ctx->buffer);
        ctx->bufferLen = 0U;
    }
    while (ctx->bufferLen < 56U) {
        ctx->buffer[ctx->bufferLen++] = 0x00U;
    }
    for (int i = 7; i >= 0; i--) {
        ctx->buffer[ctx->bufferLen++] = (uint8_t)((totalBits >> (i * 8)) & 0xFFU);
    }
    sha256_transform(ctx->state, ctx->buffer);

    for (uint32_t i = 0U; i < 8U; i++) {
        out32[i * 4U]      = (uint8_t)((ctx->state[i] >> 24) & 0xFFU);
        out32[i * 4U + 1U] = (uint8_t)((ctx->state[i] >> 16) & 0xFFU);
        out32[i * 4U + 2U] = (uint8_t)((ctx->state[i] >> 8) & 0xFFU);
        out32[i * 4U + 3U] = (uint8_t)(ctx->state[i] & 0xFFU);
    }
}

void CryptoAuth_Sha256(const uint8_t *data, size_t len, uint8_t out32[32])
{
    sha256_ctx_t ctx;
    sha256_init(&ctx);
    sha256_update(&ctx, data, len);
    sha256_final(&ctx, out32);
}

void CryptoAuth_HmacSha256(const uint8_t *key, size_t keyLen,
                           const uint8_t *msg, size_t msgLen,
                           uint8_t out32[32])
{
    uint8_t kPad[64];
    uint8_t innerHash[32];
    sha256_ctx_t ctx;

    memset(kPad, 0, sizeof(kPad));
    if (keyLen > 64U) {
        CryptoAuth_Sha256(key, keyLen, kPad);
    } else {
        memcpy(kPad, key, keyLen);
    }

    for (size_t i = 0U; i < 64U; i++) {
        kPad[i] ^= 0x36U;
    }
    sha256_init(&ctx);
    sha256_update(&ctx, kPad, 64U);
    sha256_update(&ctx, msg, msgLen);
    sha256_final(&ctx, innerHash);

    for (size_t i = 0U; i < 64U; i++) {
        kPad[i] ^= (0x36U ^ 0x5cU);
    }
    sha256_init(&ctx);
    sha256_update(&ctx, kPad, 64U);
    sha256_update(&ctx, innerHash, 32U);
    sha256_final(&ctx, out32);
}

void CryptoAuth_HexEncode(const uint8_t *in, size_t len, char *outHex)
{
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0U; i < len; i++) {
        outHex[i * 2U]      = hex[(in[i] >> 4) & 0x0FU];
        outHex[i * 2U + 1U] = hex[in[i] & 0x0FU];
    }
    outHex[len * 2U] = '\0';
}

static int hex_nibble(char c)
{
    if ((c >= '0') && (c <= '9')) return c - '0';
    if ((c >= 'a') && (c <= 'f')) return c - 'a' + 10;
    if ((c >= 'A') && (c <= 'F')) return c - 'A' + 10;
    return -1;
}

static bool hex_decode_32(const char *hexStr, uint8_t out32[32])
{
    if ((hexStr == NULL) || (strlen(hexStr) != 64U)) {
        return false;
    }
    for (size_t i = 0U; i < 32U; i++) {
        int hi = hex_nibble(hexStr[i * 2U]);
        int lo = hex_nibble(hexStr[i * 2U + 1U]);
        if ((hi < 0) || (lo < 0)) {
            return false;
        }
        out32[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}

void CryptoAuth_Init(void)
{
    flash_config_t flashCfg;
    memset(&flashCfg, 0, sizeof(flashCfg));
    memset(s_chipUid, 0, sizeof(s_chipUid));
    s_uidValid = false;

    if ((FLASH_Init(&flashCfg) == kStatus_FLASH_Success) &&
        (FFR_Init(&flashCfg) == kStatus_FLASH_Success)) {
        if (FFR_GetUUID(&flashCfg, s_chipUid) == kStatus_FLASH_Success) {
            uint8_t acc = 0U;
            for (size_t i = 0U; i < sizeof(s_chipUid); i++) {
                acc |= s_chipUid[i];
            }
            s_uidValid = (acc != 0U);
        }
    }
    CryptoAuth_HexEncode(s_chipUid, sizeof(s_chipUid), s_chipUidHex);

    char label[48];
    int n = snprintf(label, sizeof(label), "ELLY-DEV1|%s", s_chipUidHex);
    CryptoAuth_HmacSha256(s_masterKey, sizeof(s_masterKey), (const uint8_t *)label, (size_t)n, s_deviceKey);

    s_lastSeq   = 0U;
    s_bootNonce = 0U;
}

void CryptoAuth_SetBootNonce(uint32_t nonce)
{
    s_bootNonce = nonce;
    s_lastSeq   = 0U;
}

uint32_t CryptoAuth_GetBootNonce(void)
{
    return s_bootNonce;
}

bool CryptoAuth_UidValid(void)
{
    return s_uidValid;
}

void CryptoAuth_GetUidHex(char *out33Chars)
{
    memcpy(out33Chars, s_chipUidHex, 33U);
}

uint32_t CryptoAuth_GetLastSeq(void)
{
    return s_lastSeq;
}

bool CryptoAuth_ParseRole(const char *roleStr, elly_role_t *outRole)
{
    if ((roleStr == NULL) || (outRole == NULL)) {
        return false;
    }
    if (strcmp(roleStr, "owner") == 0) {
        *outRole = ELLY_ROLE_OWNER;
        return true;
    }
    if (strcmp(roleStr, "family") == 0) {
        *outRole = ELLY_ROLE_FAMILY;
        return true;
    }
    if (strcmp(roleStr, "guest") == 0) {
        *outRole = ELLY_ROLE_GUEST;
        return true;
    }
    if (strcmp(roleStr, "system") == 0) {
        *outRole = ELLY_ROLE_SYSTEM;
        return true;
    }
    return false;
}

static bool cmd_in(const char *cmd, const char *const *list, size_t n)
{
    for (size_t i = 0U; i < n; i++) {
        if (strcmp(cmd, list[i]) == 0) {
            return true;
        }
    }
    return false;
}

/* Keep in sync with gateway/src/hmac.js (checked by firmware/tools/host_test) */
bool CryptoAuth_IsAllowed(elly_role_t role, const char *cmd, const char *arg)
{
    static const char *const kDiag[]   = { "ping", "audit_dump", "backfill_sync", "can_diag", "flash_id" };
    static const char *const kGuest[]  = { "light", "rgb", "fan", "emergency" };
    static const char *const kFamily[] = { "ac", "eco", "all_off", "night", "alert_test" };
    static const char *const kSystem[] = { "heartbeat", "trip" };

    if ((cmd == NULL) || (arg == NULL)) {
        return false;
    }

    if (role == ELLY_ROLE_SYSTEM) {
        return cmd_in(cmd, kSystem, sizeof(kSystem) / sizeof(kSystem[0])) ||
               cmd_in(cmd, kDiag, sizeof(kDiag) / sizeof(kDiag[0]));
    }
    if (strcmp(cmd, "heartbeat") == 0) {
        return role == ELLY_ROLE_OWNER;
    }
    if (role == ELLY_ROLE_OWNER) {
        return strcmp(cmd, "trip") != 0;
    }

    /* Safety first: anyone in the house can hit Emergency, and anyone can turn privacy ON */
    if (cmd_in(cmd, kGuest, sizeof(kGuest) / sizeof(kGuest[0]))) {
        return true;
    }
    if (strcmp(cmd, "privacy") == 0) {
        return (strcmp(arg, "on") == 0) || (role == ELLY_ROLE_FAMILY);
    }
    if (role == ELLY_ROLE_FAMILY) {
        return cmd_in(cmd, kFamily, sizeof(kFamily) / sizeof(kFamily[0]));
    }
    return false;
}

auth_result_t CryptoAuth_VerifyCommand(const char *cmd, const char *arg,
                                       const char *roleStr, uint32_t seq,
                                       const char *sigHex, elly_role_t *outRole)
{
    elly_role_t role;
    uint8_t providedSig[32];
    uint8_t expectedSig[32];
    char canonical[176];

    if ((cmd == NULL) || (roleStr == NULL) || (sigHex == NULL) || (outRole == NULL)) {
        return AUTH_ERR_FORMAT;
    }
    if (!s_uidValid) {
        return AUTH_ERR_NO_UID;
    }
    if (!CryptoAuth_ParseRole(roleStr, &role)) {
        return AUTH_ERR_FORMAT;
    }
    if (!hex_decode_32(sigHex, providedSig)) {
        return AUTH_ERR_BAD_HMAC;
    }

    int len = snprintf(canonical, sizeof(canonical), "%s|%s|%s|%lu|%lu",
                       cmd, (arg != NULL) ? arg : "", roleStr,
                       (unsigned long)seq, (unsigned long)s_bootNonce);
    if ((len <= 0) || ((size_t)len >= sizeof(canonical))) {
        return AUTH_ERR_FORMAT;
    }

    CryptoAuth_HmacSha256(s_deviceKey, sizeof(s_deviceKey),
                          (const uint8_t *)canonical, (size_t)len, expectedSig);

    uint8_t diff = 0U;
    for (size_t i = 0U; i < 32U; i++) {
        diff |= (uint8_t)(providedSig[i] ^ expectedSig[i]);
    }
    if (diff != 0U) {
        return AUTH_ERR_BAD_HMAC;
    }

    if ((seq == 0U) || (seq <= s_lastSeq)) {
        return AUTH_ERR_REPLAY;
    }
    /* A valid signature burns its sequence number even when the role check then fails */
    s_lastSeq = seq;

    if (!CryptoAuth_IsAllowed(role, cmd, (arg != NULL) ? arg : "")) {
        *outRole = role;
        return AUTH_ERR_RBAC_DENIED;
    }

    *outRole = role;
    return AUTH_OK;
}
