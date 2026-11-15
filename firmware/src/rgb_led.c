#include "rgb_led.h"
#include "app.h"
#include "fsl_ctimer.h"

/*
 * FRDM-MCXN236 RGB LED is common-anode (active-LOW).
 * CTIMER_UpdatePwmDutycycle(duty) sets HIGH pulse proportion for duty%:
 *   duty = 100 -> 100% HIGH (LED OFF)
 *   duty = 0   -> 0% HIGH / always LOW (LED 100% ON)
 */
static inline uint8_t clamp_pct(uint8_t v)
{
    return (v > 100U) ? 100U : v;
}

static inline uint8_t to_active_low_duty(uint8_t brightnessPct)
{
    return (uint8_t)(100U - clamp_pct(brightnessPct));
}

void RgbLed_Init(void)
{
    ctimer_config_t cfg;
    uint32_t timerClkHz = CLOCK_GetCTimerClkFreq(3U);
    if (timerClkHz == 0U) {
        timerClkHz = 48000000U;
    }

    CTIMER_GetDefaultConfig(&cfg);
    CTIMER_Init(ELLY_RGB_CTIMER, &cfg);

    (void)CTIMER_SetupPwm(ELLY_RGB_CTIMER, ELLY_RGB_PERIOD_CH, ELLY_RGB_RED_CH,
                          100U, ELLY_RGB_PWM_FREQ_HZ, timerClkHz, false);
    (void)CTIMER_SetupPwm(ELLY_RGB_CTIMER, ELLY_RGB_PERIOD_CH, ELLY_RGB_GREEN_CH,
                          100U, ELLY_RGB_PWM_FREQ_HZ, timerClkHz, false);
    (void)CTIMER_SetupPwm(ELLY_RGB_CTIMER, ELLY_RGB_PERIOD_CH, ELLY_RGB_BLUE_CH,
                          100U, ELLY_RGB_PWM_FREQ_HZ, timerClkHz, false);

    CTIMER_StartTimer(ELLY_RGB_CTIMER);
}

void RgbLed_Set(uint8_t rPct, uint8_t gPct, uint8_t bPct)
{
    (void)CTIMER_UpdatePwmDutycycle(ELLY_RGB_CTIMER, ELLY_RGB_PERIOD_CH, ELLY_RGB_RED_CH,
                                    to_active_low_duty(rPct));
    (void)CTIMER_UpdatePwmDutycycle(ELLY_RGB_CTIMER, ELLY_RGB_PERIOD_CH, ELLY_RGB_GREEN_CH,
                                    to_active_low_duty(gPct));
    (void)CTIMER_UpdatePwmDutycycle(ELLY_RGB_CTIMER, ELLY_RGB_PERIOD_CH, ELLY_RGB_BLUE_CH,
                                    to_active_low_duty(bPct));
}
