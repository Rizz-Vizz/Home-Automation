#pragma once
#include "FreeRTOS.h"
TickType_t xTaskGetTickCount(void);
void vTaskDelay(TickType_t t);
BaseType_t xTaskCreate(void (*fn)(void *), const char *name, uint32_t depth, void *arg, unsigned prio, TaskHandle_t *h);
unsigned uxTaskGetStackHighWaterMark(TaskHandle_t h);
