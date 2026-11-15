#ifndef ELLY_RGB_LED_H_
#define ELLY_RGB_LED_H_

#include <stdint.h>

void RgbLed_Init(void);
void RgbLed_Set(uint8_t rPct, uint8_t gPct, uint8_t bPct);

#endif /* ELLY_RGB_LED_H_ */
