#include "pin_mux.h"
#include "clock_config.h"
#include "board.h"
#include "app.h"
#include "fsl_clock.h"
#include "fsl_vref.h"
#include "fsl_spc.h"

void BOARD_InitHardware(void)
{
    BOARD_InitBootPins();
    BOARD_BootClockPLL150M();

    /* Keep FRO_HF (48 MHz) active for CTIMER3, ADC0, CAN1, and LPSPI6 */
    CLOCK_SetupFROHFClocking(48000000U);
    CLOCK_SetClkDiv(kCLOCK_DivFrohfClk, 1U);

    /* Flexcomm 4 (LPUART4 VCOM) on 12 MHz FRO12M */
    CLOCK_AttachClk(kFRO12M_to_FLEXCOMM4);
    CLOCK_SetClkDiv(kCLOCK_DivFlexcom4Clk, 1U);

    /* Flexcomm 2 (LPI2C2 FXLS8974CFR3) on 12 MHz FRO12M */
    CLOCK_AttachClk(kFRO12M_to_FLEXCOMM2);
    CLOCK_SetClkDiv(kCLOCK_DivFlexcom2Clk, 1U);

    /* Flexcomm 6 (LPSPI6 W25Q64) on 48 MHz FRO_HF_DIV */
    CLOCK_AttachClk(kFRO_HF_DIV_to_FLEXCOMM6);
    CLOCK_SetClkDiv(kCLOCK_DivFlexcom6Clk, 1U);

    /* CTIMER3 RGB PWM on 48 MHz FRO_HF */
    CLOCK_AttachClk(kFRO_HF_to_CTIMER3);
    CLOCK_SetClkDiv(kCLOCK_DivCtimer3Clk, 1U);

    /* ADC0 + VREF0 (1.8V reference used by temp sensor and Q2 phototransistor) */
    CLOCK_AttachClk(kFRO_HF_to_ADC0);
    CLOCK_SetClkDiv(kCLOCK_DivAdc0Clk, 1U);
    SPC0->ACTIVE_CFG1 |= 0x1U;
    vref_config_t vrefConfig;
    VREF_GetDefaultConfig(&vrefConfig);
    VREF_Init(ELLY_VREF_BASE, &vrefConfig);
    VREF_SetTrim21Val(ELLY_VREF_BASE, 8U);

    /* FlexCAN1 on 48 MHz FRO_HF */
    CLOCK_AttachClk(kFRO_HF_to_FLEXCAN1);
    CLOCK_SetClkDiv(kCLOCK_DivFlexcan1Clk, 1U);

    /*
     * PLL1 at 122.88 MHz from 24 MHz external crystal feeds PDM0 MICFIL at 12.288 MHz
     * so digital audio frames are cleanly clocked in RAM for RMS dB calculation.
     */
    CLOCK_SetupExtClocking(24000000U);
    const pll_setup_t pll1AudioSetup = {
        .pllctrl = SCG_SPLLCTRL_SOURCE(0U) | SCG_SPLLCTRL_SELI(15U) | SCG_SPLLCTRL_SELP(31U),
        .pllndiv = SCG_SPLLNDIV_NDIV(25U),
        .pllpdiv = SCG_SPLLPDIV_PDIV(2U),
        .pllmdiv = SCG_SPLLMDIV_MDIV(512U),
        .pllRate = 122880000U,
    };
    CLOCK_SetPLL1Freq(&pll1AudioSetup);
    CLOCK_SetClkDiv(kCLOCK_DivPLL1Clk0, 10U);
    CLOCK_AttachClk(kPLL1_CLK0_to_MICFILF);
    CLOCK_SetClkDiv(kCLOCK_DivMicfilFClk, 1U);
}
