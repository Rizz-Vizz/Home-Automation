#ifndef ELLY_COMMS_H_
#define ELLY_COMMS_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ELLY_RX_LINE_MAX 256U

void Comms_Init(void);
void Comms_SendLine(const char *jsonLine);
bool Comms_ReceiveLine(char *outBuf, size_t maxLen, uint32_t waitMs);

/* Minimal zero-alloc JSON field extractors for flat command objects */
bool Comms_JsonGetString(const char *json, const char *key, char *out, size_t maxLen);
bool Comms_JsonGetUint(const char *json, const char *key, uint32_t *outVal);

#endif /* ELLY_COMMS_H_ */
