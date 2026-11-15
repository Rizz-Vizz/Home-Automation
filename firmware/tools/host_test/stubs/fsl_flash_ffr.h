#pragma once
#include "fsl_flash.h"
int FFR_Init(flash_config_t *c);
int FFR_GetUUID(flash_config_t *c, uint8_t *uuid);
