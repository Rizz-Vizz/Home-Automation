#ifndef ELLY_CRYPTO_AUTH_H_
#define ELLY_CRYPTO_AUTH_H_

#include "elly_types.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    AUTH_OK = 0,
    AUTH_ERR_FORMAT,
    AUTH_ERR_BAD_HMAC,
    AUTH_ERR_REPLAY,
    AUTH_ERR_RBAC_DENIED,
    AUTH_ERR_NO_UID,
} auth_result_t;

void CryptoAuth_Init(void);
void CryptoAuth_SetBootNonce(uint32_t nonce);
uint32_t CryptoAuth_GetBootNonce(void);
bool CryptoAuth_UidValid(void);
void CryptoAuth_GetUidHex(char *out33Chars);
uint32_t CryptoAuth_GetLastSeq(void);

void CryptoAuth_Sha256(const uint8_t *data, size_t len, uint8_t out32[32]);
void CryptoAuth_HmacSha256(const uint8_t *key, size_t keyLen,
                           const uint8_t *msg, size_t msgLen,
                           uint8_t out32[32]);
void CryptoAuth_HexEncode(const uint8_t *in, size_t len, char *outHex);

bool CryptoAuth_ParseRole(const char *roleStr, elly_role_t *outRole);
bool CryptoAuth_IsAllowed(elly_role_t role, const char *cmd, const char *arg);
auth_result_t CryptoAuth_VerifyCommand(const char *cmd, const char *arg,
                                       const char *roleStr, uint32_t seq,
                                       const char *sigHex, elly_role_t *outRole);

#endif /* ELLY_CRYPTO_AUTH_H_ */
