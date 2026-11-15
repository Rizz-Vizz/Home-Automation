#ifndef ELLY_APP_H_
#define ELLY_APP_H_

#include "fsl_common.h"

/* LPUART4 USB VCOM link to Gateway */
#define ELLY_UART_BASE              LPUART4
#define ELLY_UART_IRQn              LP_FLEXCOMM4_IRQn
#define ELLY_UART_IRQHandler        LP_FLEXCOMM4_IRQHandler
#define ELLY_UART_BAUDRATE          115200U
#define ELLY_UART_CLK_FREQ          12000000U

/* CTIMER3 active-LOW RGB LED PWM (PIO4_17=Blue, PIO4_18=Red, PIO4_19=Green) */
#define ELLY_RGB_CTIMER             CTIMER3
#define ELLY_RGB_PERIOD_CH          kCTIMER_Match_0
#define ELLY_RGB_BLUE_CH            kCTIMER_Match_1
#define ELLY_RGB_RED_CH             kCTIMER_Match_2
#define ELLY_RGB_GREEN_CH           kCTIMER_Match_3
#define ELLY_RGB_PWM_FREQ_HZ        1000U

/* On-board user buttons (active-LOW, external pull-ups) */
#define ELLY_SW2_GPIO               GPIO0
#define ELLY_SW2_PIN                20U
#define ELLY_SW3_GPIO               GPIO0
#define ELLY_SW3_PIN                6U
#define ELLY_BUTTONS_IRQn           GPIO00_IRQn
#define ELLY_BUTTONS_IRQHandler     GPIO00_IRQHandler

/* USB-C J11 Type-C attach/PD interrupt input from U41 INTB/OUT3 (PIO5_7) */
#define ELLY_DOCK_GPIO              GPIO5
#define ELLY_DOCK_PIN               7U
#define ELLY_DOCK_IRQn              GPIO50_IRQn
#define ELLY_DOCK_IRQHandler        GPIO50_IRQHandler

/* FXLS8974CFR3 3-axis accelerometer on LPI2C2 */
#define ELLY_ACCEL_I2C              LPI2C2
#define ELLY_ACCEL_I2C_ADDR         0x18U
#define ELLY_ACCEL_CLK_FREQ         12000000U

/* LPADC0 light sensor Q2 (ALS-PT19 on PIO0_25 = ADC0_B17) and on-chip temp ch 26 */
#define ELLY_ADC_BASE               ADC0
#define ELLY_ADC_LIGHT_CH           17U
#define ELLY_ADC_TEMP_CH            26U
#define ELLY_ADC_LIGHT_CMD          1U
#define ELLY_ADC_TEMP_CMD           2U
#define ELLY_VREF_BASE              VREF0

/* PDM0 MICFIL digital mic U7 (SPK0641HT4H-1, SEL=VDD_AUDIO via R203 -> Right Ch1) */
#define ELLY_PDM_BASE               PDM
#define ELLY_PDM_CHANNEL            1U
#define ELLY_PDM_IRQn               PDM_EVENT_IRQn
#define ELLY_PDM_IRQHandler         PDM_EVENT_IRQHandler
#define ELLY_PDM_FIFO_WATERMARK     4U

/* W25Q64JVSSIQ NOR flash on LPSPI6 (FC6 + GPIO3_23 manual CS#) */
#define ELLY_FLASH_LPSPI            LPSPI6
#define ELLY_FLASH_CS_GPIO          GPIO3
#define ELLY_FLASH_CS_PIN           23U
#define ELLY_FLASH_CLK_FREQ         48000000U
#define ELLY_FLASH_BAUD_HZ          12000000U

/* FlexCAN1 internal loopback diagnostic */
#define ELLY_CAN_BASE               CAN1
#define ELLY_CAN_CLK_FREQ           48000000U

/*
 * FreeRTOS configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY is 2.
 * All peripheral ISRs calling *FromISR() must keep numeric priority >= 3.
 */
#define ELLY_ISR_PRIORITY           4U

void BOARD_InitHardware(void);

#endif /* ELLY_APP_H_ */
