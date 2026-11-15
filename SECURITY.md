# Security

This is an educational smart home edge system that controls simulated appliances and physical on-board LED hardware. It is not certified for direct control of high-voltage mains-powered household devices. Do not connect it to unisolated AC mains without certified industrial protection hardware.

## Protected Mechanisms

1. Unified Authentication: Every HTTP API route, WebSocket connection, and MQTT client requires authentication. The user role is derived directly from the verified PIN, never from client requests.
2. Cryptographic Command Signing: Commands sent to the microcontroller board are signed with HMAC-SHA256 using a per-device key derived from the silicon unique identifier, a per-boot nonce, and an incrementing sequence counter. Commands are verified against the firmware role access table.
3. Web Origin Allowlist and Lockout: Browser cross-origin requests from external websites are blocked by an origin allowlist. Five consecutive incorrect PIN attempts result in an automatic temporary lockout.
4. Privacy First Audio and Video: The digital microphone is sampled exclusively for sound pressure level estimation; raw audio is never recorded, stored, or transmitted. Camera video is processed locally inside the browser and never leaves your computer.

## Known Security Limits

1. Master Secret in Firmware: The master cryptographic secret is embedded in the firmware image. On unsecured silicon, reading flash memory could expose the key. Production deployments should enable on-chip flash read-out protection and utilize the EdgeLock Secure Enclave.
2. Serial Channel: The USB serial connection is cryptographically authenticated but not encrypted at the transport layer. Transport Layer Security (TLS) for the API is optional via TLS_CERT and TLS_KEY environment variables.
3. Shared PINs: Roles are currently mapped to three shared household PINs rather than individual per-user accounts. Session tokens are held in server memory.

## Reporting a Security Issue

Open an issue on GitHub or reach out directly to the maintainers for responsible disclosure.
