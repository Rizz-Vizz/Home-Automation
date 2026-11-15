#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef int BaseType_t; typedef uint32_t TickType_t;
#define pdTRUE 1
#define pdFALSE 0
#define portMAX_DELAY 0xFFFFFFFFu
#define portTICK_PERIOD_MS 1
#define pdMS_TO_TICKS(x) ((TickType_t)(x))
typedef void *TaskHandle_t; typedef void *QueueHandle_t; typedef void *SemaphoreHandle_t;
