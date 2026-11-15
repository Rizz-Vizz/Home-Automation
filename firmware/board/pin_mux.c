#include "fsl_common.h"
#include "fsl_port.h"
#include "fsl_gpio.h"
#include "pin_mux.h"

void BOARD_InitBootPins(void)
{
    BOARD_InitPins();
}

/*
 * Pin directions strictly match SCH-90828 Rev C.
 * Shared/input lines (PIO0_17, PIO0_20, PIO0_6, PIO3_22, PIO4_15, PIO5_7)
 * remain inputs or peripheral RX only so we never contend with on-board ICs.
 */
void BOARD_InitPins(void)
{
    CLOCK_EnableClock(kCLOCK_Port0);
    CLOCK_EnableClock(kCLOCK_Port1);
    CLOCK_EnableClock(kCLOCK_Port3);
    CLOCK_EnableClock(kCLOCK_Port4);
    CLOCK_EnableClock(kCLOCK_Gpio0);
    CLOCK_EnableClock(kCLOCK_Gpio3);

    const port_pin_config_t uartPinCfg = {
        .pullSelect          = kPORT_PullDisable,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_LowDriveStrength,
        .mux                 = kPORT_MuxAlt2,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT1, 8U, &uartPinCfg);  /* FC4_P0 LPUART4_RX */
    PORT_SetPinConfig(PORT1, 9U, &uartPinCfg);  /* FC4_P1 LPUART4_TX */

    const port_pin_config_t pwmPinCfg = {
        .pullSelect          = kPORT_PullDisable,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_LowDriveStrength,
        .mux                 = kPORT_MuxAlt4,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT4, 17U, &pwmPinCfg);  /* CT3_MAT1 Blue LED (active-LOW) */
    PORT_SetPinConfig(PORT4, 18U, &pwmPinCfg);  /* CT3_MAT2 Red LED (active-LOW) */
    PORT_SetPinConfig(PORT4, 19U, &pwmPinCfg);  /* CT3_MAT3 Green LED (active-LOW) */

    const port_pin_config_t gpioInputCfg = {
        .pullSelect          = kPORT_PullDisable,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_LowDriveStrength,
        .mux                 = kPORT_MuxAlt0,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT0, 6U, &gpioInputCfg);   /* SW3 */
    PORT_SetPinConfig(PORT0, 20U, &gpioInputCfg);  /* SW2 */
    PORT_SetPinConfig(PORT5, 7U, &gpioInputCfg);   /* J11 U41 INTB/OUT3 dock detect */

    const gpio_pin_config_t inGpio = { kGPIO_DigitalInput, 0U };
    GPIO_PinInit(GPIO0, 6U, &inGpio);
    GPIO_PinInit(GPIO0, 20U, &inGpio);
    GPIO_PinInit(GPIO5, 7U, &inGpio);

    /* LPI2C2 SDA (PIO4_0) and SCL (PIO4_1) with open-drain and pull-up */
    const port_pin_config_t i2cPinCfg = {
        .pullSelect          = kPORT_PullUp,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainEnable,
        .driveStrength       = kPORT_LowDriveStrength,
        .mux                 = kPORT_MuxAlt2,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT4, 0U, &i2cPinCfg);
    PORT_SetPinConfig(PORT4, 1U, &i2cPinCfg);

    /* Analog ALS-PT19 phototransistor Q2 on PIO0_25 (ADC0_B17) */
    const port_pin_config_t adcPinCfg = {
        .pullSelect          = kPORT_PullDisable,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_LowDriveStrength,
        .mux                 = kPORT_MuxAlt0,
        .inputBuffer         = kPORT_InputBufferDisable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT0, 25U, &adcPinCfg);

    /* PDM0 MICFIL on PIO0_16 (CLK) and PIO0_17 (DATA0 RX) */
    const port_pin_config_t pdmPinCfg = {
        .pullSelect          = kPORT_PullDisable,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_LowDriveStrength,
        .mux                 = kPORT_MuxAlt9,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT0, 16U, &pdmPinCfg);
    PORT_SetPinConfig(PORT0, 17U, &pdmPinCfg);

    /* W25Q64 NOR flash on LPSPI6 (1-bit SPI mode; WP# and RESET# stay pulled high inputs) */
    const port_pin_config_t spiPinCfg = {
        .pullSelect          = kPORT_PullDisable,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_HighDriveStrength,
        .mux                 = kPORT_MuxAlt3,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT3, 20U, &spiPinCfg); /* FC6_P0 MOSI / DI */
    PORT_SetPinConfig(PORT3, 21U, &spiPinCfg); /* FC6_P1 SCK */
    PORT_SetPinConfig(PORT3, 22U, &spiPinCfg); /* FC6_P2 MISO / DO (RX only) */

    const port_pin_config_t spiHoldWpCfg = {
        .pullSelect          = kPORT_PullUp,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_LowDriveStrength,
        .mux                 = kPORT_MuxAlt0,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT3, 12U, &spiHoldWpCfg); /* RESET#/IO3 pulled high by R186 */
    PORT_SetPinConfig(PORT3, 13U, &spiHoldWpCfg); /* WP#/IO2 pulled high by R188 */
    GPIO_PinInit(GPIO3, 12U, &inGpio);
    GPIO_PinInit(GPIO3, 13U, &inGpio);

    const port_pin_config_t spiCsPinCfg = {
        .pullSelect          = kPORT_PullDisable,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_HighDriveStrength,
        .mux                 = kPORT_MuxAlt0,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT3, 23U, &spiCsPinCfg); /* CS# active-LOW, idle HIGH */
    const gpio_pin_config_t csOutGpio = { kGPIO_DigitalOutput, 1U };
    GPIO_PinInit(GPIO3, 23U, &csOutGpio);

    /* CAN1 RX (PIO4_15) and TX (PIO4_16) */
    const port_pin_config_t canPinCfg = {
        .pullSelect          = kPORT_PullDisable,
        .pullValueSelect     = kPORT_LowPullResistor,
        .slewRate            = kPORT_FastSlewRate,
        .passiveFilterEnable = kPORT_PassiveFilterDisable,
        .openDrainEnable     = kPORT_OpenDrainDisable,
        .driveStrength       = kPORT_LowDriveStrength,
        .mux                 = kPORT_MuxAlt11,
        .inputBuffer         = kPORT_InputBufferEnable,
        .invertInput         = kPORT_InputNormal,
        .lockRegister        = kPORT_UnlockRegister,
    };
    PORT_SetPinConfig(PORT4, 15U, &canPinCfg); /* CAN1_RXD */
    PORT_SetPinConfig(PORT4, 16U, &canPinCfg); /* CAN1_TXD */
}
