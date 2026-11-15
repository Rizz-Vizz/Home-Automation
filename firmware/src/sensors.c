#include "sensors.h"
#include "app.h"
#include "fsl_flexcan.h"
#include "fsl_gpio.h"
#include "fsl_lpadc.h"
#include "fsl_lpi2c.h"
#include "fsl_pdm.h"
#include "FreeRTOS.h"
#include "task.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

/* FXLS8974CFR3 registers */
#define FXLS_REG_OUT_X_LSB      0x04U
#define FXLS_REG_WHO_AM_I       0x13U
#define FXLS_WHO_AM_I_VAL       0x86U
#define FXLS_REG_SENS_CONFIG1   0x15U
#define FXLS_REG_SENS_CONFIG3   0x17U

#define PDM_FRAME_SAMPLES       128U
#define CAN_LOOPBACK_ID         0x123U
#define CAN_TX_MB               9U
#define CAN_RX_MB               8U

static volatile bool s_sw2Flag    = false;
static volatile bool s_sw3Flag    = false;
static volatile bool s_dockFlag   = false;
static volatile uint32_t s_sw2Ms  = 0U;
static volatile uint32_t s_sw3Ms  = 0U;

static bool s_accelOk             = false;
static bool s_canOk               = false;
static int16_t s_prevMagMg        = 1000;
static uint32_t s_vibAccum        = 0U;
static uint32_t s_vibSamples      = 0U;
static uint16_t s_lowGStreak      = 0U;
static bool s_accelCal            = false;
static int32_t s_scaleNum         = 1;
static int32_t s_scaleDen         = 1;
static bool s_freefallArmed       = false;
static uint32_t s_freefallMs      = 0U;
static float s_noiseFloorDb       = 40.0f;
static bool s_adcOk               = false;

/* Strictly RAM-only PDM circular energy accumulator; raw audio never persists */
static volatile uint32_t s_pdmSampleIdx   = 0U;
static volatile uint32_t s_pdmFrameCount  = 0U;
static int32_t s_pdmDcEst                 = 0;
static uint64_t s_pdmAccSq                = 0ULL;
static volatile uint64_t s_pdmLatestMeanSq = 0ULL;
static volatile uint64_t s_pdmBurstMeanSq  = 0ULL;
static volatile float s_latestDb          = 40.0f;
static volatile float s_peakDb            = 40.0f;
static volatile uint32_t s_pdmHoldTicks   = 0U;
static volatile bool s_pdmActive          = false;

static float s_cachedLux          = 0.0f;
static float s_cachedTempC        = 25.0f;

static uint32_t get_uptime_ms(void)
{
    if (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING) {
        return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    }
    return 0U;
}

void ELLY_BUTTONS_IRQHandler(void)
{
    uint32_t flags = GPIO_GpioGetInterruptFlags(GPIO0);
    uint32_t now   = (uint32_t)(xTaskGetTickCountFromISR() * portTICK_PERIOD_MS);

    if ((flags & (1UL << ELLY_SW2_PIN)) != 0U) {
        GPIO_GpioClearInterruptFlags(GPIO0, 1UL << ELLY_SW2_PIN);
        if ((now - s_sw2Ms) >= 150U) {
            s_sw2Ms   = now;
            s_sw2Flag = true;
        }
    }
    if ((flags & (1UL << ELLY_SW3_PIN)) != 0U) {
        GPIO_GpioClearInterruptFlags(GPIO0, 1UL << ELLY_SW3_PIN);
        if ((now - s_sw3Ms) >= 150U) {
            s_sw3Ms   = now;
            s_sw3Flag = true;
        }
    }
    SDK_ISR_EXIT_BARRIER;
}

void ELLY_DOCK_IRQHandler(void)
{
    uint32_t flags = GPIO_GpioGetInterruptFlags(ELLY_DOCK_GPIO);
    if ((flags & (1UL << ELLY_DOCK_PIN)) != 0U) {
        GPIO_GpioClearInterruptFlags(ELLY_DOCK_GPIO, 1UL << ELLY_DOCK_PIN);
        s_dockFlag = true;
    }
    SDK_ISR_EXIT_BARRIER;
}

void ELLY_PDM_IRQHandler(void)
{
    uint32_t status      = PDM_GetStatus(ELLY_PDM_BASE);
    uint32_t fifoStatus  = PDM_GetFifoStatus(ELLY_PDM_BASE);
#if defined(FSL_FEATURE_PDM_HAS_RANGE_CTRL) && FSL_FEATURE_PDM_HAS_RANGE_CTRL
    uint32_t rangeStatus = PDM_GetRangeStatus(ELLY_PDM_BASE);
#else
    uint32_t outStatus   = PDM_GetOutputStatus(ELLY_PDM_BASE);
#endif

    if ((status & (1UL << ELLY_PDM_CHANNEL)) != 0U) {
        for (uint32_t i = 0U; i < ELLY_PDM_FIFO_WATERMARK; i++) {
            uint32_t raw = PDM_ReadData(ELLY_PDM_BASE, ELLY_PDM_CHANNEL);
            /* MCXN236 MICFIL DATACH is MSB-left-aligned in [31:8] (see fsl_pdm.c PDM_ReadFifo) */
            int32_t s24  = ((int32_t)raw) >> 8;

            /* Fast integer high-pass / DC tracker so wind or mic offset doesn't skew RMS */
            s_pdmDcEst += (s24 - s_pdmDcEst) >> 8;
            int32_t ac  = s24 - s_pdmDcEst;

            s_pdmAccSq += (uint64_t)((int64_t)ac * (int64_t)ac);
            s_pdmSampleIdx++;

            if (s_pdmSampleIdx >= PDM_FRAME_SAMPLES) {
                uint64_t meanSq   = s_pdmAccSq / PDM_FRAME_SAMPLES;
                s_pdmLatestMeanSq = meanSq;
                if (meanSq > s_pdmBurstMeanSq) {
                    s_pdmBurstMeanSq = meanSq;
                }
                s_pdmAccSq     = 0ULL;
                s_pdmSampleIdx = 0U;
                s_pdmFrameCount++;
                s_pdmActive = true;
            }
        }
        PDM_ClearStatus(ELLY_PDM_BASE, (1UL << ELLY_PDM_CHANNEL));
    }

    if (fifoStatus != 0U) {
        PDM_ClearFIFOStatus(ELLY_PDM_BASE, fifoStatus);
    }
#if defined(FSL_FEATURE_PDM_HAS_RANGE_CTRL) && FSL_FEATURE_PDM_HAS_RANGE_CTRL
    if (rangeStatus != 0U) {
        PDM_ClearRangeStatus(ELLY_PDM_BASE, rangeStatus);
    }
#else
    if (outStatus != 0U) {
        PDM_ClearOutputStatus(ELLY_PDM_BASE, outStatus);
    }
#endif
#if defined(FSL_FEATURE_PDM_HAS_STATUS_LOW_FREQ) && (FSL_FEATURE_PDM_HAS_STATUS_LOW_FREQ != 0U)
    if ((status & PDM_STAT_LOWFREQF_MASK) != 0U) {
        PDM_ClearStatus(ELLY_PDM_BASE, PDM_STAT_LOWFREQF_MASK);
    }
#endif
    SDK_ISR_EXIT_BARRIER;
}

static bool i2c_write_reg(uint8_t addr, uint8_t reg, uint8_t val)
{
    lpi2c_master_transfer_t xfer;
    memset(&xfer, 0, sizeof(xfer));
    xfer.slaveAddress   = addr;
    xfer.direction      = kLPI2C_Write;
    xfer.subaddress     = reg;
    xfer.subaddressSize = 1U;
    xfer.data           = &val;
    xfer.dataSize       = 1U;
    xfer.flags          = kLPI2C_TransferDefaultFlag;
    return LPI2C_MasterTransferBlocking(ELLY_ACCEL_I2C, &xfer) == kStatus_Success;
}

static bool i2c_read_regs(uint8_t addr, uint8_t reg, uint8_t *buf, size_t len)
{
    lpi2c_master_transfer_t xfer;
    memset(&xfer, 0, sizeof(xfer));
    xfer.slaveAddress   = addr;
    xfer.direction      = kLPI2C_Read;
    xfer.subaddress     = reg;
    xfer.subaddressSize = 1U;
    xfer.data           = buf;
    xfer.dataSize       = len;
    xfer.flags          = kLPI2C_TransferDefaultFlag;
    return LPI2C_MasterTransferBlocking(ELLY_ACCEL_I2C, &xfer) == kStatus_Success;
}

static void init_accel(void)
{
    lpi2c_master_config_t cfg;
    uint8_t whoami = 0U;

    LPI2C_MasterGetDefaultConfig(&cfg);
    cfg.baudRate_Hz = 100000U;
    LPI2C_MasterInit(ELLY_ACCEL_I2C, &cfg, ELLY_ACCEL_CLK_FREQ);

    if (!i2c_read_regs(ELLY_ACCEL_I2C_ADDR, FXLS_REG_WHO_AM_I, &whoami, 1U) ||
        (whoami != FXLS_WHO_AM_I_VAL)) {
        s_accelOk = false;
        return;
    }

    /* Standby, +/-4g FSR, 100 Hz wake/sleep ODR, then Active */
    (void)i2c_write_reg(ELLY_ACCEL_I2C_ADDR, FXLS_REG_SENS_CONFIG1, 0x02U);
    (void)i2c_write_reg(ELLY_ACCEL_I2C_ADDR, FXLS_REG_SENS_CONFIG3, 0x22U);
    s_accelOk = i2c_write_reg(ELLY_ACCEL_I2C_ADDR, FXLS_REG_SENS_CONFIG1, 0x03U);
}

static bool read_accel_raw_mg(int32_t *x, int32_t *y, int32_t *z)
{
    uint8_t raw[6] = { 0 };
    if (!i2c_read_regs(ELLY_ACCEL_I2C_ADDR, FXLS_REG_OUT_X_LSB, raw, sizeof(raw))) {
        return false;
    }
    int16_t rx = (int16_t)(((int16_t)((uint16_t)raw[1] << 12) | ((uint16_t)raw[0] << 4))) >> 4;
    int16_t ry = (int16_t)(((int16_t)((uint16_t)raw[3] << 12) | ((uint16_t)raw[2] << 4))) >> 4;
    int16_t rz = (int16_t)(((int16_t)((uint16_t)raw[5] << 12) | ((uint16_t)raw[4] << 4))) >> 4;
    /* +/-4g range -> 1.953 mg/LSB */
    *x = ((int32_t)rx * 1953) / 1000;
    *y = ((int32_t)ry * 1953) / 1000;
    *z = ((int32_t)rz * 1953) / 1000;
    return true;
}

static int32_t mag_of(int32_t x, int32_t y, int32_t z)
{
    return (int32_t)sqrtf((float)((x * x) + (y * y) + (z * z)));
}

/* One-point gain calibration: at rest |a| must be 1000 mg. Skipped if the board is moving. */
static void calibrate_accel(void)
{
    int32_t sum = 0;
    int32_t mn  = 100000;
    int32_t mx  = 0;
    uint32_t n  = 0U;

    s_accelCal = false;
    s_scaleNum = 1;
    s_scaleDen = 1;
    if (!s_accelOk) {
        return;
    }
    SDK_DelayAtLeastUs(60000U, SystemCoreClock);
    for (uint32_t i = 0U; i < 32U; i++) {
        int32_t x, y, z;
        if (read_accel_raw_mg(&x, &y, &z)) {
            int32_t m = mag_of(x, y, z);
            sum += m;
            if (m < mn) mn = m;
            if (m > mx) mx = m;
            n++;
        }
        SDK_DelayAtLeastUs(10000U, SystemCoreClock);
    }
    if (n < 24U) {
        return;
    }
    int32_t mean = sum / (int32_t)n;
    if (((mx - mn) < 120) && (mean > 850) && (mean < 1250)) {
        s_scaleNum = 1000;
        s_scaleDen = mean;
        s_accelCal = true;
    }
}

static void init_lpadc(void)
{
    lpadc_config_t adcCfg;
    LPADC_GetDefaultConfig(&adcCfg);
    adcCfg.enableAnalogPreliminary = true;
    adcCfg.referenceVoltageSource  = kLPADC_ReferenceVoltageAlt2;
    adcCfg.conversionAverageMode   = kLPADC_ConversionAverage128;
    LPADC_Init(ELLY_ADC_BASE, &adcCfg);

    LPADC_DoOffsetCalibration(ELLY_ADC_BASE);
    LPADC_DoAutoCalibration(ELLY_ADC_BASE);

    /* CMD 1: ALS-PT19 phototransistor Q2 on ADC0_B17 */
    lpadc_conv_command_config_t lightCmd;
    LPADC_GetDefaultConvCommandConfig(&lightCmd);
    lightCmd.channelNumber            = ELLY_ADC_LIGHT_CH;
    lightCmd.sampleChannelMode        = kLPADC_SampleChannelSingleEndSideB;
    lightCmd.conversionResolutionMode = kLPADC_ConversionResolutionHigh;
    lightCmd.hardwareAverageMode      = kLPADC_HardwareAverageCount16;
    lightCmd.sampleTimeMode           = kLPADC_SampleTimeADCK35;
    LPADC_SetConvCommandConfig(ELLY_ADC_BASE, ELLY_ADC_LIGHT_CMD, &lightCmd);

    lpadc_conv_trigger_config_t lightTrig;
    LPADC_GetDefaultConvTriggerConfig(&lightTrig);
    lightTrig.targetCommandId       = ELLY_ADC_LIGHT_CMD;
    lightTrig.channelBFIFOSelect    = 0U;
    LPADC_SetConvTriggerConfig(ELLY_ADC_BASE, 0U, &lightTrig);

    /* CMD 2: On-chip temperature sensor ch 26 (requires loopCount = 1) */
    lpadc_conv_command_config_t tempCmd;
    LPADC_GetDefaultConvCommandConfig(&tempCmd);
    tempCmd.channelNumber            = ELLY_ADC_TEMP_CH;
    tempCmd.sampleChannelMode        = kLPADC_SampleChannelDiffBothSide;
    tempCmd.conversionResolutionMode = kLPADC_ConversionResolutionHigh;
    tempCmd.hardwareAverageMode      = kLPADC_HardwareAverageCount128;
    tempCmd.sampleTimeMode           = kLPADC_SampleTimeADCK131;
    tempCmd.loopCount                = 1U;
    LPADC_SetConvCommandConfig(ELLY_ADC_BASE, ELLY_ADC_TEMP_CMD, &tempCmd);

    lpadc_conv_trigger_config_t tempTrig;
    LPADC_GetDefaultConvTriggerConfig(&tempTrig);
    tempTrig.targetCommandId       = ELLY_ADC_TEMP_CMD;
    tempTrig.channelAFIFOSelect    = 1U;
    LPADC_SetConvTriggerConfig(ELLY_ADC_BASE, 1U, &tempTrig);
}

static float pdm_mean_sq_to_db(uint64_t meanSq)
{
    if (meanSq < 2ULL) {
        return 30.0f;
    }
    /* 10*log10(RMS^2) == 20*log10(RMS), calibrated against 24-bit MICFIL DF gain 2 */
    float db = 10.0f * log10f((float)meanSq) - 40.0f;
    if (db < 30.0f) {
        db = 30.0f;
    }
    if (db > 115.0f) {
        db = 115.0f;
    }
    return db;
}

static void init_pdm(void)
{
    const pdm_config_t pdmCfg = {
#if defined(FSL_FEATURE_PDM_HAS_DECIMATION_FILTER_BYPASS) && FSL_FEATURE_PDM_HAS_DECIMATION_FILTER_BYPASS
        .enableFilterBypass = false,
#endif
        .enableDoze        = false,
        .fifoWatermark     = ELLY_PDM_FIFO_WATERMARK,
        .qualityMode       = kPDM_QualityModeHigh,
        .cicOverSampleRate = 0U,
    };

    PDM_Init(ELLY_PDM_BASE, &pdmCfg);

    pdm_channel_config_t chCfg = {
#if (defined(FSL_FEATURE_PDM_HAS_DC_OUT_CTRL) && (FSL_FEATURE_PDM_HAS_DC_OUT_CTRL))
        .outputCutOffFreq = kPDM_DcRemoverCutOff20Hz,
#endif
#if !(defined(FSL_FEATURE_PDM_DC_CTRL_VALUE_FIXED) && (FSL_FEATURE_PDM_DC_CTRL_VALUE_FIXED))
        .cutOffFreq = kPDM_DcRemoverCutOff152Hz,
#endif
        .gain = kPDM_DfOutputGain2,
    };

    /* U7 SPK0641HT4H-1 has SEL strapped to VDD_AUDIO (Right channel = 1) */
    PDM_SetChannelConfig(ELLY_PDM_BASE, ELLY_PDM_CHANNEL, &chCfg);

    uint32_t micClk = CLOCK_GetMicfilClkFreq();
    if (micClk == 0U) {
        micClk = 12288000U;
    }
    (void)PDM_SetSampleRateConfig(ELLY_PDM_BASE, micClk, 16000U);

    PDM_Reset(ELLY_PDM_BASE);
    PDM_EnableInterrupts(ELLY_PDM_BASE,
                         (uint32_t)kPDM_ErrorInterruptEnable | (uint32_t)kPDM_FIFOInterruptEnable);
    NVIC_SetPriority(ELLY_PDM_IRQn, ELLY_ISR_PRIORITY);
    EnableIRQ(ELLY_PDM_IRQn);
    PDM_Enable(ELLY_PDM_BASE, true);
}

static void init_gpio_irqs(void)
{
    GPIO_SetPinInterruptConfig(ELLY_SW2_GPIO, ELLY_SW2_PIN, kGPIO_InterruptFallingEdge);
    GPIO_SetPinInterruptConfig(ELLY_SW3_GPIO, ELLY_SW3_PIN, kGPIO_InterruptFallingEdge);
    GPIO_GpioClearInterruptFlags(GPIO0, (1UL << ELLY_SW2_PIN) | (1UL << ELLY_SW3_PIN));
    NVIC_SetPriority(ELLY_BUTTONS_IRQn, ELLY_ISR_PRIORITY);
    EnableIRQ(ELLY_BUTTONS_IRQn);

    GPIO_SetPinInterruptConfig(ELLY_DOCK_GPIO, ELLY_DOCK_PIN, kGPIO_InterruptEitherEdge);
    GPIO_GpioClearInterruptFlags(ELLY_DOCK_GPIO, 1UL << ELLY_DOCK_PIN);
    NVIC_SetPriority(ELLY_DOCK_IRQn, ELLY_ISR_PRIORITY);
    EnableIRQ(ELLY_DOCK_IRQn);
}

bool Sensors_RunCanLoopback(void)
{
    flexcan_config_t canCfg;
    flexcan_rx_mb_config_t rxMbCfg;
    flexcan_frame_t txFrame;
    flexcan_frame_t rxFrame;

    FLEXCAN_GetDefaultConfig(&canCfg);
    canCfg.clkSrc         = kFLEXCAN_ClkSrc0;
    canCfg.bitRate        = 500000U;
    canCfg.enableLoopBack = true;

    FLEXCAN_Init(ELLY_CAN_BASE, &canCfg, ELLY_CAN_CLK_FREQ);

    rxMbCfg.format = kFLEXCAN_FrameFormatStandard;
    rxMbCfg.type   = kFLEXCAN_FrameTypeData;
    rxMbCfg.id     = FLEXCAN_ID_STD(CAN_LOOPBACK_ID);
    FLEXCAN_SetRxMbConfig(ELLY_CAN_BASE, CAN_RX_MB, &rxMbCfg, true);
    FLEXCAN_SetTxMbConfig(ELLY_CAN_BASE, CAN_TX_MB, true);

    memset(&txFrame, 0, sizeof(txFrame));
    txFrame.id        = FLEXCAN_ID_STD(CAN_LOOPBACK_ID);
    txFrame.format    = (uint8_t)kFLEXCAN_FrameFormatStandard;
    txFrame.type      = (uint8_t)kFLEXCAN_FrameTypeData;
    txFrame.length    = 8U;
    txFrame.dataWord0 = 0x594C4C45U; /* 'ELLY' */
    txFrame.dataWord1 = 0x314E4143U; /* 'CAN1' */

    if (FLEXCAN_TransferSendBlocking(ELLY_CAN_BASE, CAN_TX_MB, &txFrame) != kStatus_Success) {
        s_canOk = false;
        return false;
    }

    uint32_t spins = 20000U;
    while ((FLEXCAN_GetMbStatusFlags(ELLY_CAN_BASE, (1ULL << CAN_RX_MB)) == 0U) && (spins > 0U)) {
        spins--;
    }

    if (spins == 0U) {
        s_canOk = false;
        return false;
    }

    memset(&rxFrame, 0, sizeof(rxFrame));
    if (FLEXCAN_ReadRxMb(ELLY_CAN_BASE, CAN_RX_MB, &rxFrame) != kStatus_Success) {
        s_canOk = false;
        return false;
    }
    FLEXCAN_ClearMbStatusFlags(ELLY_CAN_BASE, (1ULL << CAN_RX_MB));

    s_canOk = (rxFrame.dataWord0 == txFrame.dataWord0) &&
              (rxFrame.dataWord1 == txFrame.dataWord1);
    return s_canOk;
}

void Sensors_Init(void)
{
    init_accel();
    calibrate_accel();
    init_lpadc();
    init_pdm();
    init_gpio_irqs();
    (void)Sensors_RunCanLoopback();
}

void Sensors_PollFast(elly_sensor_data_t *data, bool *sw2Edge, bool *sw3Edge, bool *dockEdge)
{
    if (data == NULL) {
        return;
    }

    if (sw2Edge != NULL) {
        *sw2Edge  = s_sw2Flag;
        s_sw2Flag = false;
    }
    if (sw3Edge != NULL) {
        *sw3Edge  = s_sw3Flag;
        s_sw3Flag = false;
    }
    if (dockEdge != NULL) {
        *dockEdge  = s_dockFlag;
        s_dockFlag = false;
    }

    data->sw2_pressed     = (GPIO_PinRead(ELLY_SW2_GPIO, ELLY_SW2_PIN) == 0U);
    data->sw3_pressed     = (GPIO_PinRead(ELLY_SW3_GPIO, ELLY_SW3_PIN) == 0U);
    data->dock_attached   = (GPIO_PinRead(ELLY_DOCK_GPIO, ELLY_DOCK_PIN) == 0U);
    data->accel_ok        = s_accelOk;
    data->can_loopback_ok = s_canOk;

    data->fall_detected = false;
    uint32_t nowAccelMs = get_uptime_ms();

    if (s_accelOk) {
        int32_t rx, ry, rz;
        if (read_accel_raw_mg(&rx, &ry, &rz)) {
            data->accel_x_mg = (int16_t)((rx * s_scaleNum) / s_scaleDen);
            data->accel_y_mg = (int16_t)((ry * s_scaleNum) / s_scaleDen);
            data->accel_z_mg = (int16_t)((rz * s_scaleNum) / s_scaleDen);

            int16_t magMg = (int16_t)mag_of(data->accel_x_mg, data->accel_y_mg, data->accel_z_mg);
            int16_t delta = (int16_t)abs((int)magMg - (int)s_prevMagMg);
            s_prevMagMg   = magMg;

            s_vibAccum += (uint32_t)delta;
            s_vibSamples++;
            if (s_vibSamples >= 25U) {
                data->vib_rms_mg = (uint16_t)(s_vibAccum / s_vibSamples);
                s_vibAccum       = 0U;
                s_vibSamples     = 0U;
            }

            /* Fall: sustained free-fall, then an impact spike inside the window */
            if (magMg < ELLY_FALL_FREEFALL_MG) {
                if (s_lowGStreak < 250U) {
                    s_lowGStreak++;
                }
                if (s_lowGStreak >= ELLY_FALL_FREEFALL_SAMPLES) {
                    s_freefallArmed = true;
                    s_freefallMs    = nowAccelMs;
                }
            } else {
                s_lowGStreak = 0U;
                if (s_freefallArmed) {
                    if (magMg > ELLY_FALL_IMPACT_MG) {
                        data->fall_detected = true;
                        s_freefallArmed     = false;
                    } else if ((nowAccelMs - s_freefallMs) > ELLY_FALL_WINDOW_MS) {
                        s_freefallArmed = false;
                    }
                }
            }
        }
    }
    data->accel_cal = s_accelCal;

    uint32_t nowMs = get_uptime_ms();
    if (s_pdmActive) {
        uint32_t primask      = DisableGlobalIRQ();
        uint64_t latestMeanSq = s_pdmLatestMeanSq;
        uint64_t burstMeanSq  = s_pdmBurstMeanSq;
        s_pdmBurstMeanSq      = 0ULL;
        EnableGlobalIRQ(primask);

        float instDb  = pdm_mean_sq_to_db(latestMeanSq);
        float burstDb = (burstMeanSq > 0ULL) ? pdm_mean_sq_to_db(burstMeanSq) : instDb;

        s_latestDb = instDb;
        if (burstDb >= s_peakDb) {
            s_peakDb       = burstDb;
            s_pdmHoldTicks = nowMs;
        } else if ((nowMs - s_pdmHoldTicks) >= 1050U) {
            /* Release 1 Hz peak-hold after one telemetry window so spikes remain visible in UI */
            s_peakDb = instDb;
        }

        /* Noise floor follows the room: fast down, slow up, so a loud hall becomes the new baseline */
        bool loud = (burstDb >= (s_noiseFloorDb + ELLY_CLAP_RISE_DB)) && (burstDb >= ELLY_CLAP_MIN_DB);
        bool warmup = (nowMs < 30000U);
        float rate = (loud && !warmup) ? 0.0004f : 0.005f;
        s_noiseFloorDb += (instDb - s_noiseFloorDb) * rate;
        if (s_noiseFloorDb < 30.0f) {
            s_noiseFloorDb = 30.0f;
        }
        /* 30 s warm-up while the floor adapts to wherever the board was powered on */
        if (warmup) {
            loud = false;
        }
        data->clap_detected = loud;
    } else {
        data->clap_detected = false;
    }
    data->mic_floor_db = s_noiseFloorDb;

    data->mic_db      = ((nowMs - s_pdmHoldTicks) < 1050U && (s_peakDb > s_latestDb)) ? s_peakDb : s_latestDb;
    data->mic_peak_db = s_peakDb;

    data->lux    = s_cachedLux;
    data->temp_c = s_cachedTempC;
}

void Sensors_PollSlow(elly_sensor_data_t *data)
{
    lpadc_conv_result_t res;
    bool lightOk = false;
    bool tempOk  = false;

    /* 1. Sample Q2 ALS-PT19 phototransistor */
    LPADC_DoSoftwareTrigger(ELLY_ADC_BASE, 1U << 0U);
    uint32_t spins = 10000U;
    while (!LPADC_GetConvResult(ELLY_ADC_BASE, &res, 0U) && (spins > 0U)) {
        spins--;
    }
    if (spins > 0U) {
        /* 16-bit result against 1.8V VREF; scale linearly to indoor lux estimate */
        float volts   = ((float)res.convValue / 65535.0f) * 1.8f;
        s_cachedLux   = volts * 600.0f;
        if (s_cachedLux < 0.0f) s_cachedLux = 0.0f;
        lightOk = true;
    }

    /* 2. Sample internal temperature sensor (2 results in FIFO 1) */
    LPADC_DoSoftwareTrigger(ELLY_ADC_BASE, 1UL << 1U);
    spins = 20000U;
    uint16_t vbe1 = 0U;
    uint16_t vbe8 = 0U;
    while (!LPADC_GetConvResult(ELLY_ADC_BASE, &res, 1U) && (spins > 0U)) {
        spins--;
    }
    if (spins > 0U) {
        vbe1  = res.convValue;
        spins = 10000U;
        while (!LPADC_GetConvResult(ELLY_ADC_BASE, &res, 1U) && (spins > 0U)) {
            spins--;
        }
        if (spins > 0U) {
            vbe8 = res.convValue;
            float num   = FSL_FEATURE_LPADC_TEMP_PARAMETER_ALPHA * ((float)vbe8 - (float)vbe1);
            float denom = (float)vbe8 + num;
            if (denom > 1.0f) {
                float t = (float)FSL_FEATURE_LPADC_TEMP_PARAMETER_A * (num / denom) -
                          (float)FSL_FEATURE_LPADC_TEMP_PARAMETER_B;
                if ((t > -40.0f) && (t < 125.0f)) {
                    s_cachedTempC = t;
                    tempOk        = true;
                }
            }
        }
    }

    s_adcOk = lightOk && tempOk;
    if (data != NULL) {
        data->lux    = s_cachedLux;
        data->temp_c = s_cachedTempC;
        data->adc_ok = s_adcOk;
    }
}
