#pragma once
#include <stdint.h>
typedef struct { int dummy; } flash_config_t;
#define kStatus_FLASH_Success 0
int FLASH_Init(flash_config_t *c);
