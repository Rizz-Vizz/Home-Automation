# Home Automation Serial Communication Protocol

## 1. Physical Layer and Framing

1. **Physical Interface:** USB CDC Virtual Serial COM Port exposed by the NXP MCU-Link probe or on-board USB peripheral.
2. **Baud Rate:** 115,200 baud, 8 data bits, no parity, 1 stop bit (8N1).
3. **Packet Framing:** Line-delimited ASCII JSON strings terminated by standard newline characters (`\n` or `\r\n`).
4. **Buffer Limit:** Maximum packet payload length is 256 bytes per line.

---

## 2. Command Authentication Structure

Every command sent from the gateway to the microcontroller includes an HMAC-SHA256 signature to guarantee authenticity, prevent spoofing, and thwart replay attacks:

```json
{
  "cmd": "light",
  "arg": "75",
  "role": "owner",
  "seq": 42,
  "sig": "b5a7c2d1..."
}
```

### Signature Generation Parameters

1. **Per-Device Key Derivation:**
   ```
   DeviceKey = HMAC-SHA256(MasterKey, "HOME-DEV1|" + 128BitSiliconUIDHex)
   ```
2. **Canonical String Construction:**
   ```
   Canonical = cmd + "|" + arg + "|" + role + "|" + seq + "|" + bootNonce
   ```
3. **HMAC Calculation:**
   ```
   sig = HMAC-SHA256(DeviceKey, Canonical)
   ```
4. **Anti-Replay Mechanism:**
   1. The microcontroller maintains a volatile 32-bit `bootNonce` derived on startup from the flash audit log sequence counter, which increments on every boot (falling back to SysTick hardware timer jitter only if flash is uninitialized). The critical security property is per-session uniqueness.
   2. The microcontroller tracks a strictly monotonic `last_seq` counter.
   3. Any incoming frame with `seq <= last_seq` is immediately dropped with error code `AUTH_ERR_REPLAY`.
   4. If the microcontroller reboots, its new `bootNonce` invalidates all previously signed frames.

---

## 3. Microcontroller Command Opcodes

| Opcode | Argument | Minimum Role | Functional Description |
| :--- | :--- | :--- | :--- |
| `light` | `0` to `100` / `on` / `off` | Guest | Controls the main living room CTIMER3 RGB PWM illumination level. |
| `rgb` | Hex color code `RRGGBB` | Guest | Sets custom RGB PWM tint across the physical tri-color LED channels. |
| `fan` | `0` to `100` / `on` / `off` | Family | Controls bedroom ceiling fan speed across discrete power steps. |
| `emergency` | *(none)* | Guest | Triggers emergency shutdown of non-essential loads. Available to all roles. |
| `ac` | `16` to `30` / `cool` / `heat` | Family | Configures bedroom inverter air conditioning temperature and operating mode. |
| `eco` | `on` / `off` | Family | Toggles eco mode preset, capping peak load draw across major appliances. |
| `all_off` | *(none)* | Family | Deactivates all non-critical lights and household loads simultaneously. |
| `night` | `on` / `off` | Family | Activates Night Mode preset (dims lighting, sets bedroom climate to 23°C). |
| `alert_test`| *(none)* | Family | Injects a simulated test spike to verify gateway warning channels. |
| `privacy` | `on` | Guest | Immediately disables camera motion detection. |
| `privacy` | `off` | Family | Restores camera motion processing. |
| `away_arm` | *(none)* | Owner | Arms the perimeter security system. |
| `away_disarm`| *(none)* | Owner | Disarms security and clears perimeter breach trip states. |
| `safety_clear`| *(none)* | Owner | Clears latched hardware safety trips and restores normal power sequencing. |
| `vacancy` | `20` to `3600` | Owner | Sets room occupancy auto-off timeout window in seconds. |
| `ping` | *(none)* | Owner | Diagnostic handshake querying current microcontroller firmware status. |
| `audit_dump` | *(none)* | Owner | Streams the circular flash audit log records sequentially over serial. |
| `backfill_sync`| *(none)* | Owner | Requests transmission of buffered offline telemetry snapshots from flash. |
| `can_diag` | *(none)* | Owner | Executes hardware loopback and status verification of CAN-FD transceiver. |
| `flash_id` | *(none)* | Owner | Queries Winbond W25Q64 JEDEC ID (`0xEF4017`) and SPI flash health metrics. |
| `heartbeat` | *(none)* | System | Periodic gateway watchdog pulse. Microcontroller enters Edge Mode if missed. |
| `trip` | Reason string | System | Internal hardware interlock trigger sent when safety boundaries are crossed. |

---

## 4. Telemetry Frame Specification

The microcontroller outputs a continuous 1 Hz telemetry frame over serial:

```json
{
  "type": "telem",
  "uid": "0123456789abcdef0123456789abcdef",
  "nonce": 4242,
  "uptime_ms": 128450,
  "edge": false,
  "safety": false,
  "safety_reason": "normal",
  "away": false,
  "eco": true,
  "privacy": false,
  "light": true,
  "light_pct": 75,
  "fan": false,
  "ac": false,
  "lux": 142.0,
  "temp_c": 28.6,
  "db": 42.1,
  "floor": 40.0,
  "vib": 12,
  "ax": 10,
  "ay": -5,
  "az": 998,
  "dock": true,
  "sw2": false,
  "sw3": false,
  "can_ok": true,
  "accel_ok": true,
  "cal": true,
  "adc_ok": true,
  "vac_s": 1200,
  "audit_n": 14,
  "telem_q": 0,
  "last_seq": 42
}
```

### Telemetry Field Definitions

1. `uid`: 128-bit unique factory serial number read from NXP flash information registers.
2. `nonce`: 32-bit random session boot nonce.
3. `uptime_ms`: Continuous millisecond counter since microcontroller power-on.
4. `edge`: Boolean indicating whether board is currently in offline Amber Edge Mode.
5. `safety`: Boolean indicating if a safety trip is currently latched.
6. `safety_reason`: Human-readable identifier describing the trip trigger condition.
7. `lux`: Relative ambient light index (computed as volts x 600 against 1.8V reference, producing an index roughly between 0 and 1000) from the on-board phototransistor.
8. `temp_c`: Internal silicon die temperature in degrees Celsius from the ADC temperature sensor.
9. `db`: Relative sound level indicator on a 30 to 80 dB scale from the PDM microphone decimation filter.
10. `ax`, `ay`, `az`: Raw milli-g acceleration vectors from the InvenSense 6-axis IMU.
11. `audit_n`: Total count of tamper-evident audit records written to external SPI flash.
12. `telem_q`: Number of buffered offline snapshots currently queued in SPI flash memory.
