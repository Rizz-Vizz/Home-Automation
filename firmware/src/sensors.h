#ifndef ELLY_SENSORS_H_
#define ELLY_SENSORS_H_

#include "elly_types.h"
#include <stdbool.h>
#include <stdint.h>

void Sensors_Init(void);
void Sensors_PollFast(elly_sensor_data_t *data, bool *sw2Edge, bool *sw3Edge, bool *dockEdge);
void Sensors_PollSlow(elly_sensor_data_t *data);
bool Sensors_RunCanLoopback(void);

#endif /* ELLY_SENSORS_H_ */
