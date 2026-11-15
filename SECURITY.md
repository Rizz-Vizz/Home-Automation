# Security Policy

Security and privacy are core to the Home Automation project. This document explains how user data is protected, the educational scope of the project, and how to report any security vulnerabilities.

---

## Safety and Electrical Scope

1. Educational System: This project is designed for learning, testing, and edge computing experiments using the [NXP FRDM-MCXN236](https://www.nxp.com/design/design-center/development-boards-and-designs/FRDM-MCXN236) development board.
2. Low Voltage Only: The system directly controls low voltage 3.3V LEDs and runs software simulation models for household appliances. It is not rated or certified for direct connection to unisolated 110V or 230V household electrical mains without certified industrial relay modules.

---

## How the System Protects Your Home

1. Local First Privacy: All sensor readings, camera vision processing, and automation rules run completely inside your local home network. No private household data is ever uploaded to external cloud servers.
2. Role Based Authentication: Access requires a valid household PIN code (Owner PIN 1, Family PIN 2, Guest PIN 3). Permissions are verified strictly by the backend server and firmware, never trusted from client requests.
3. Brute Force Protection: The login API uses constant time string comparisons to prevent timing analysis and temporarily locks authentication after five consecutive incorrect attempts.
4. Cryptographic Command Signing: Commands sent to the microcontroller are signed with HMAC-SHA256 using a per-device key derived from the silicon unique chip ID, a per-boot nonce, and an incrementing sequence counter to prevent replay attacks.
5. Tamper Proof Audit Chain: System events and state changes are recorded on the physical Winbond W25Q64 external SPI flash chip in an append-only ring linked by cryptographic SHA-256 hashes.
6. Local Browser Vision: Camera motion detection processes video frames directly inside the browser using HTML5 Canvas pixel differences. Images and video feeds are never saved to disk or transmitted over the network.
7. Microphone Decibel Sampling: The onboard digital PDM microphone is read by hardware audio filters exclusively to calculate room decibel levels. Spoken conversations are never recorded, saved, or streamed.

---

## Known Development Limits

1. Embedded Master Key: In this prototype build, the master secret key is compiled directly into the firmware image. Commercial hardware should utilize on-chip flash read-out protection and the EdgeLock Secure Enclave.
2. Unencrypted Serial Link: The USB serial connection between the host computer and the development board is cryptographically signed and authenticated, but data travels over the physical wire in plaintext.
3. Shared Household PINs: Access roles currently map to three shared household PIN codes rather than individual personal accounts.

---

## How to Report a Security Vulnerability

1. If you discover a security concern, please do not open a public issue on GitHub.
2. Report the vulnerability directly to the project author by email at ritviz.aggarwal@gmail.com with a description and steps to reproduce.
3. Valid security reports will be acknowledged and reviewed promptly.
