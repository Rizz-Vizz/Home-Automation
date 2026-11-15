#pragma once
#include "elly_types.h"
void Sensors_Init(void);
void Sensors_PollFast(elly_sensor_data_t *d, bool *a, bool *b, bool *c);
void Sensors_PollSlow(elly_sensor_data_t *d);
bool Sensors_RunCanLoopback(void);
