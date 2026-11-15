#include "app.h"
#include "comms.h"
#include "crypto_auth.h"
#include "rgb_led.h"
#include "tasks_ctrl.h"
#include "FreeRTOS.h"
#include "task.h"

void vApplicationStackOverflowHook(TaskHandle_t xTask, char *pcTaskName)
{
    (void)xTask;
    (void)pcTaskName;
    RgbLed_Set(100U, 0U, 0U);
    taskDISABLE_INTERRUPTS();
    for (;;) {
    }
}

void vApplicationMallocFailedHook(void)
{
    RgbLed_Set(100U, 0U, 50U);
    taskDISABLE_INTERRUPTS();
    for (;;) {
    }
}

int main(void)
{
    BOARD_InitHardware();
    Comms_Init();
    RgbLed_Init();
    CryptoAuth_Init();

    TasksCtrl_Start();
    vTaskStartScheduler();

    for (;;) {
    }
}
