# Contributing to Home Automation

Thank you for your interest in helping improve this project. Whether you are fixing a bug, adding a new sensor driver, improving the web interface, or writing documentation, contributions are welcome.

---

## Core Guidelines

1. Honesty First: Never present simulated virtual appliances as real physical hardware. If you add a new appliance or sensor model, clearly document whether it runs on the physical microcontroller or as a software digital twin in the gateway.
2. Keep Tests Green: Both the gateway backend and dashboard frontend have automated test suites. Always make sure existing tests pass before submitting changes.
3. Protect Secrets: Never commit personal `.env` configuration files or generated cryptographic keys to GitHub. Keep `.gitignore` rules active.
4. Synchronize Command Tables: If you add or modify a user command or role permission, update both the firmware access table in `firmware/src/crypto_auth.c` and the gateway authentication table in `gateway/src/hmac.js`.

---

## Step by Step Contribution Workflow

1. Fork the repository on GitHub to your personal account.
2. Clone your fork to your computer:
   `git clone https://github.com/<YOUR-USERNAME>/Home-Automation.git`
3. Create a new branch for your work:
   `git checkout -b feature/your-feature-name`
4. Make your code improvements cleanly in the relevant directory:
   1. `firmware/` for C embedded drivers and FreeRTOS tasks
   2. `gateway/` for the Node.js serial bridge, SQLite database, and digital twin models
   3. `dashboard/` for the React web user interface and CSS styling
5. Run the automated test suites locally:
   1. Test the Gateway: Open `gateway` directory and run `npm test`
   2. Test the Dashboard: Open `dashboard` directory and run `npm test`
6. Commit your changes with a clear and descriptive commit message.
7. Push your branch to GitHub:
   `git push origin feature/your-feature-name`
8. Open a Pull Request on GitHub describing what your changes do and how they were tested.

---

## Code Quality Standards

1. Firmware Code: Keep FreeRTOS tasks modular, never block the high priority safety task, and maintain clean driver interfaces.
2. Gateway Code: Use modern ES modules, handle asynchronous errors cleanly, and validate all inputs from serial and web clients.
3. Dashboard Code: Build accessible, responsive React components with clean CSS, ensuring the dashboard works smoothly on both desktop and mobile screens.
