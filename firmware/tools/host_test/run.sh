#!/bin/sh
# Builds the real firmware crypto/RBAC code on the host and checks it against the gateway.
set -e
cd "$(dirname "$0")"
OUT=$(mktemp -d)
printf '#define ELLY_MASTER_KEY_BYTES { 0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0x0c,0x0d,0x0e,0x0f,0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1a,0x1b,0x1c,0x1d,0x1e,0x1f }\n' > "$OUT/elly_secret.h"
gcc -Wall -Wextra -Werror -I"$OUT" -Istubs -I../../src -o "$OUT/harness" harness.c ../../src/crypto_auth.c
"$OUT/harness" rbac > "$OUT/rbac_c.txt"
node parity.mjs "$OUT/harness" "$OUT/rbac_c.txt"
rm -rf "$OUT"

gcc -fsyntax-only -Wall -Wextra -Istubs2 -Istubs -I../../src ../../src/tasks_ctrl.c
