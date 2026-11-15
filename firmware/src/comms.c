#include "comms.h"
#include "app.h"
#include "fsl_lpuart.h"
#include "FreeRTOS.h"
#include "queue.h"
#include "semphr.h"
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#define RX_QUEUE_DEPTH 8U

typedef struct {
    char text[ELLY_RX_LINE_MAX];
} comms_line_t;

static SemaphoreHandle_t s_txMutex = NULL;
static QueueHandle_t s_rxQueue   = NULL;

static char s_isrLineBuf[ELLY_RX_LINE_MAX];
static size_t s_isrLineLen = 0U;
static bool s_isrOverflow = false;

void ELLY_UART_IRQHandler(void)
{
    BaseType_t higherWoken = pdFALSE;
    uint32_t status = LPUART_GetStatusFlags(ELLY_UART_BASE);

    if ((status & (uint32_t)kLPUART_RxOverrunFlag) != 0U) {
        LPUART_ClearStatusFlags(ELLY_UART_BASE, (uint32_t)kLPUART_RxOverrunFlag);
    }

    while ((LPUART_GetStatusFlags(ELLY_UART_BASE) & (uint32_t)kLPUART_RxDataRegFullFlag) != 0U) {
        uint8_t ch = LPUART_ReadByte(ELLY_UART_BASE);
        if (ch == (uint8_t)'\r') {
            continue;
        }
        if (ch == (uint8_t)'\n') {
            if ((s_isrLineLen > 0U) && !s_isrOverflow && (s_rxQueue != NULL)) {
                comms_line_t msg;
                memcpy(msg.text, s_isrLineBuf, s_isrLineLen);
                msg.text[s_isrLineLen] = '\0';
                (void)xQueueSendFromISR(s_rxQueue, &msg, &higherWoken);
            }
            s_isrLineLen  = 0U;
            s_isrOverflow = false;
        } else if (s_isrOverflow) {
            /* discard the rest of an oversized line up to the next newline */
        } else if (s_isrLineLen < (ELLY_RX_LINE_MAX - 1U)) {
            s_isrLineBuf[s_isrLineLen++] = (char)ch;
        } else {
            s_isrOverflow = true;
        }
    }

    portYIELD_FROM_ISR(higherWoken);
}

void Comms_Init(void)
{
    lpuart_config_t cfg;

    if (s_txMutex == NULL) {
        s_txMutex = xSemaphoreCreateMutex();
    }
    if (s_rxQueue == NULL) {
        s_rxQueue = xQueueCreate(RX_QUEUE_DEPTH, sizeof(comms_line_t));
    }

    LPUART_GetDefaultConfig(&cfg);
    cfg.baudRate_Bps = ELLY_UART_BAUDRATE;
    cfg.enableTx     = true;
    cfg.enableRx     = true;

    LPUART_Init(ELLY_UART_BASE, &cfg, ELLY_UART_CLK_FREQ);
    LPUART_EnableInterrupts(ELLY_UART_BASE,
                            (uint32_t)kLPUART_RxDataRegFullInterruptEnable |
                            (uint32_t)kLPUART_RxOverrunInterruptEnable);
    NVIC_SetPriority(ELLY_UART_IRQn, ELLY_ISR_PRIORITY);
    EnableIRQ(ELLY_UART_IRQn);
}

void Comms_SendLine(const char *jsonLine)
{
    static const uint8_t crlf[2] = { '\r', '\n' };
    if (jsonLine == NULL) {
        return;
    }

    if ((s_txMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreTake(s_txMutex, portMAX_DELAY);
    }

    (void)LPUART_WriteBlocking(ELLY_UART_BASE, (const uint8_t *)jsonLine, strlen(jsonLine));
    (void)LPUART_WriteBlocking(ELLY_UART_BASE, crlf, sizeof(crlf));

    if ((s_txMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING)) {
        (void)xSemaphoreGive(s_txMutex);
    }
}

bool Comms_ReceiveLine(char *outBuf, size_t maxLen, uint32_t waitMs)
{
    comms_line_t msg;
    TickType_t ticks = (waitMs == portMAX_DELAY) ? portMAX_DELAY : pdMS_TO_TICKS(waitMs);

    if ((s_rxQueue == NULL) || (outBuf == NULL) || (maxLen == 0U)) {
        return false;
    }

    if (xQueueReceive(s_rxQueue, &msg, ticks) != pdTRUE) {
        return false;
    }

    size_t len = strlen(msg.text);
    if (len >= maxLen) {
        len = maxLen - 1U;
    }
    memcpy(outBuf, msg.text, len);
    outBuf[len] = '\0';
    return true;
}

static const char *find_json_key(const char *json, const char *key)
{
    char pattern[48];
    size_t klen = strlen(key);
    if ((json == NULL) || (klen + 3U >= sizeof(pattern))) {
        return NULL;
    }
    pattern[0] = '"';
    memcpy(&pattern[1], key, klen);
    pattern[klen + 1U] = '"';
    pattern[klen + 2U] = '\0';

    const char *p = json;
    while ((p = strstr(p, pattern)) != NULL) {
        const char *after = p + klen + 2U;
        while ((*after != '\0') && isspace((unsigned char)*after)) {
            after++;
        }
        if (*after == ':') {
            after++;
            while ((*after != '\0') && isspace((unsigned char)*after)) {
                after++;
            }
            return after;
        }
        p += klen + 2U;
    }
    return NULL;
}

bool Comms_JsonGetString(const char *json, const char *key, char *out, size_t maxLen)
{
    const char *val = find_json_key(json, key);
    if ((val == NULL) || (*val != '"') || (out == NULL) || (maxLen == 0U)) {
        return false;
    }
    val++;
    size_t idx = 0U;
    while ((*val != '\0') && (*val != '"')) {
        if ((*val == '\\') && (val[1] != '\0')) {
            val++;
        }
        if (idx + 1U < maxLen) {
            out[idx++] = *val;
        }
        val++;
    }
    out[idx] = '\0';
    return (*val == '"');
}

bool Comms_JsonGetUint(const char *json, const char *key, uint32_t *outVal)
{
    const char *val = find_json_key(json, key);
    if ((val == NULL) || (outVal == NULL) || !isdigit((unsigned char)*val)) {
        return false;
    }
    char *endp = NULL;
    unsigned long parsed = strtoul(val, &endp, 10);
    if (endp == val) {
        return false;
    }
    *outVal = (uint32_t)parsed;
    return true;
}
