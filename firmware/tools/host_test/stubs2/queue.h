#pragma once
#include "FreeRTOS.h"
QueueHandle_t xQueueCreate(unsigned n, unsigned sz);
BaseType_t xQueueSend(QueueHandle_t q, const void *i, TickType_t t);
BaseType_t xQueueReceive(QueueHandle_t q, void *i, TickType_t t);
