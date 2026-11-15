# Home Automation Security Model and Technical Limitations

## 1. Security Architecture and Guarantees

1. **Cryptographic Identity:**
   Every microcontroller board possesses a factory-programmed 128-bit unique serial number. A per-device key is derived using HMAC-SHA256 from a 256-bit master secret, ensuring commands are bound to a specific physical board.

2. **Command Authentication and Integrity:**
   All commands sent from the gateway to the microcontroller over the serial link are authenticated with an HMAC-SHA256 signature calculated over the opcode, arguments, role, sequence counter, and session boot nonce.

3. **Replay and Re-order Protection:**
   Replay attacks are defeated via two distinct layers:
   1. Monotonic Sequence Counter: The microcontroller drops any packet with an equal or lower sequence number than the previously accepted command.
   2. Ephemeral Boot Nonce: When power cycled or rebooted, the microcontroller initializes a new session boot nonce derived from the flash audit log sequence counter, which increments on every boot (falling back to SysTick hardware timer jitter only if flash is uninitialized). The critical security property is per-session uniqueness, immediately invalidating any command signatures created in prior sessions.

4. **Timing-Safe Authentication:**
   PIN codes entered on the web dashboard are verified using constant-time string comparisons (`crypto.timingSafeEqual`) on the gateway service to prevent timing-based side-channel attacks.

5. **Automatic Rate Limiting and Lockout:**
   The gateway enforces a lockout policy where five consecutive failed PIN verification attempts trigger an automatic temporary lockout to prevent brute-force attacks. Because the gateway listens exclusively on `localhost` (`127.0.0.1`), all local browser clients share this single IP rate-limiting counter.

6. **Tamper-Evident Audit Logging:**
   Every system event, button trigger, and safety trip is recorded into external Winbond W25Q64 SPI flash memory. Each record contains an unkeyed SHA-256 hash that links to the hash of the preceding record, forming an append-only hash chain. Any retroactive modification or deletion breaks the hash chain continuity and is detected during synchronization.

---

## 2. Technical Limitations and Threat Model

To maintain complete engineering honesty and transparency, the following architectural boundaries and limitations are explicitly noted:

1. **Shared Master Key in Firmware:**
   The 256-bit master secret is compiled into the microcontroller firmware image (`elly_secret.h`). An attacker with physical access to the board and an SWD debugger probe could read the flash memory contents to extract this master secret unless NXP chip-level code readout protection is permanently locked.

2. **Plaintext Serial Link with Authenticated Signatures:**
   The USB CDC serial bus between the host gateway and the microcontroller is authenticated with HMAC-SHA256, but payloads are transmitted as plaintext JSON. An attacker with a hardware logic analyzer or USB packet sniffer attached to the physical bus can observe telemetry and command parameters, although they cannot forge valid command packets without the secret key.

3. **Tamper-Evident vs. Tamper-Proof Audit Chain:**
   The SPI flash audit log uses an unkeyed SHA-256 hash chain. This makes the log **tamper-evident** (modifications to existing records are immediately detectable), but not mathematically tamper-proof against an adversary who gains write access to the flash chip and recalculates the entire hash chain from the point of modification forward.

4. **Sensor Calibration Boundaries:**
   1. Ambient Light: The on-board phototransistor circuit produces an uncalibrated relative illumination index (computed as volts x 600 against the 1.8V reference, producing a reading roughly between 0 and 1000). It is not an instrument-grade photometric lux meter.
   2. Acoustic Noise: The PDM microphone outputs decimation filter levels mapped to a relative 30 to 80 dB scale. It serves as an acoustic activity indicator, not a calibrated sound pressure level (SPL) meter.
   3. Power Readings: Active wattage and energy totals for virtual appliances are calculated using mathematical load models and firmware state synchronization rather than individual physical inline CT current transformers.

5. **Cloud and External Connectivity Scope:**
   While Home Automation operates in a strictly local-first mode by default without requiring external cloud accounts or internet access, the gateway includes optional outbound hooks:
   1. Optional Cloud Mirror: If `CLOUD_SYNC_URL` is defined in `gateway/.env`, periodic energy snapshots are pushed via HTTPS to a remote ingest endpoint.
   2. Optional LLM Integration: If `LLM_API_KEY` is provided, natural language queries may be forwarded to an external OpenAI-compatible API to parse complex conversational phrasing into validated system actions.
