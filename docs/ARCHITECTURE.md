# Home Automation System Architecture

## 1. System Overview

Home Automation is a local-first smart home ecosystem built around the NXP FRDM-MCXN236 microcontroller, a local Node.js gateway service, and a responsive web dashboard.

```
+-------------------------------------------------------------------+
|                        Host Browser (React UI)                    |
|  - Home Command Center   - Energy & Rules   - Vision & Security   |
|  - Hardware Lab (Owner)  - HTML5 WebRTC Pixel Diff Motion Engine  |
+---------------------------------+---------------------------------+
                                  |
            HTTP/1.1 REST + WebSockets (localhost:8080)
                                  |
+---------------------------------v---------------------------------+
|                    Local Gateway (Node.js Service)                |
|  - Timing-safe PIN authentication & session token manager         |
|  - Server-side RBAC validation & role snapshot filtering          |
|  - SQLite storage (telemetry, energy, vision events, audit log)   |
|  - MQTT Broker (:1883) with per-role topic access control         |
|  - Optional Cloud Mirror sync & optional OpenAI LLM endpoint      |
+---------------------------------+---------------------------------+
                                  |
             USB CDC Virtual COM Port (115,200 baud, 8N1)
             Framed JSON with HMAC-SHA256 Command Signatures
                                  |
+---------------------------------v---------------------------------+
|              NXP FRDM-MCXN236 Microcontroller (Firmware)          |
|  - Dual ARM Cortex-M33 running FreeRTOS kernel                    |
|  - CryptoAuth engine: 128-bit factory UID + HMAC-SHA256 verifier  |
|  - Flash logger: 128 KiB circular buffer (4,096 snapshots)        |
|  - Tamper-evident SHA-256 hash-chained audit ring                 |
|  - FreeRTOS safety task (continuous interlock monitoring)         |
|  - Peripherals: CTIMER3 RGB PWM, ADC phototransistor, PDM audio   |
+-------------------------------------------------------------------+
```

---

## 2. Microcontroller Hardware and Firmware

1. **Hardware Platform:** Built on the NXP FRDM-MCXN236 development board featuring the dual ARM Cortex-M33 core running at 150 MHz with 2 MB internal dual-bank flash memory.
2. **Real-Time Operating System:** FreeRTOS manages four concurrent preemptive tasks:
   1. `vSafetyTask` (Priority 4): Runs every 50 ms to evaluate sensor thresholds, emergency cutoff conditions, and hardware safety trips.
   2. `vTelemetryTask` (Priority 2): Gathers ADC sensor readings, decodes microphone acoustics, computes power metrics, and streams live 1 Hz JSON telemetry frames.
   3. `vUartRxTask` (Priority 3): Ingests serial bytes, parses command packets, and dispatches authenticated requests to the cryptographic verification module.
   4. `vFlashTask` (Priority 1): Manages SPI communication with the external Winbond W25Q64 flash memory for telemetry buffering and tamper-evident audit logging.
3. **Hardware Sensors and Peripherals:**
   1. Ambient Light: Phototransistor connected to ADC0 channel 0, providing an uncalibrated relative illumination index (computed as volts x 600 against 1.8V reference, roughly between 0 and 1000).
   2. Acoustics: On-board PDM digital microphone decoded by a hardware decimation filter, outputting an uncalibrated relative sound level indicator on a 30 to 80 dB scale.
   3. RGB Actuator: CTIMER3 driving pins PIO4_17, PIO4_18, and PIO4_19 with three independent PWM channels for ambient and scene lighting.
   4. Motion and Orientation: InvenSense 6-axis I2C IMU reporting accelerometer vectors for tamper detection and vibration monitoring.
   5. External Flash Memory: Winbond W25Q64 64-megabit NOR flash accessed via SPI.
   6. CAN Bus Interface: On-board CAN-FD transceiver initialized for auxiliary sensor networks and diagnostic loopback testing.

---

## 3. Local Gateway Service

1. **Zero External Dependencies:** Built with native Node.js libraries, requiring no external database servers or cloud daemons.
2. **Local Persistence:** Uses native SQLite (`sqlite3` / `node:sqlite`) with WAL mode enabled to record telemetry history, device energy profiles, automation rules, vision events, and audit logs.
3. **Session Management:** Provides timing-safe PIN verification with an exponential backoff lockout mechanism triggering after five consecutive failed attempts.
4. **WebSocket Push Server:** Maintains live duplex connections with active web sessions, distributing filtered telemetry updates, state changes, and alerts in real time.
5. **MQTT Broker:** Embedded broker running on TCP port 1883 allowing local smart devices or Matter bridges to subscribe to authenticated appliance states.
6. **Optional Extensibility:**
   1. Cloud Mirror: An optional outbound HTTPS ingest worker (`CLOUD_SYNC_URL`) to push anonymized energy snapshots to a remote database when explicitly configured.
   2. Natural Language LLM: An optional OpenAI-compatible server-side parser (`LLM_API_KEY`) to translate conversational voice phrases into validated home automation commands.

---

## 4. Web Dashboard Interface

1. **Framework:** Built with React, Vite, and Lucide icons, styled with a modern dark-mode responsive glassmorphism theme.
2. **Local Vision Engine:** Captures frames from the host laptop or PC webcam via HTML5 WebRTC. Performs pixel-difference motion detection entirely within browser memory on an HTML5 `<canvas>` element without uploading camera streams.
3. **Browser Audio Pipeline:** Utilizes the HTML5 Web Speech API for voice command recognition and spoken system status feedback locally on the client machine.
4. **Role-Driven UI Rendering:** The navigation bar, room control cards, diagnostic labs, and security triggers dynamically adjust according to the active authenticated session role.

---

## 5. Naming Conventions and Internal Artifacts

1. **Brand and Interface Naming:** The project is named **Home Automation** across all public interfaces, documentation, web dashboard views, and MQTT channels.
2. **Internal Build Artifacts:** For backward build compatibility with established compiler linker scripts, CMake build targets, and hardware flash tools, internal firmware source filenames retain the historical development prefix `elly` (such as `elly_secret.h`, `elly_edge_fw.elf`, and the SQLite database `elly.db`).
