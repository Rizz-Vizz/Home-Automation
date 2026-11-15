# Contributing

Small project, simple rules.

1. Keep the three test suites green: `cd gateway && npm test`, `cd dashboard && npm test`, `sh firmware/tools/host_test/run.sh`.
2. If you change a role or command, change it in both places and run the host test. The firmware table is in `firmware/src/crypto_auth.c` and the gateway table is in `gateway/src/hmac.js`. The host test fails if they differ.
3. Never commit `gateway/.env` or `firmware/src/elly_secret.h`. Run `python firmware/tools/gen_secrets.py` to create them.
4. Label anything simulated as simulated in the UI and in the docs.
