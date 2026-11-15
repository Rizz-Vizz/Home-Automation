#pragma once
#include <stdint.h>
typedef struct { volatile uint32_t VAL; } SysTick_Type;
extern SysTick_Type *SysTick_p;
#define SysTick SysTick_p
