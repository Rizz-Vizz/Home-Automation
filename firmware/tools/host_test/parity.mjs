// Compares the real firmware C code (host build) with the gateway: HMAC bytes and the RBAC matrix.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { deriveDeviceKey, signMcuCommand, isFirmwareRoleAllowed } from "../../../gateway/src/hmac.js";

const [harness, rbacFile, secretFile] = process.argv.slice(2);
let master = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("hex");
const candidateHdr = secretFile || fileURLToPath(new URL("../../src/elly_secret.h", import.meta.url));
if (fs.existsSync(candidateHdr)) {
  const txt = fs.readFileSync(candidateHdr, "utf8");
  const m = /\{([^}]+)\}/.exec(txt);
  if (m) {
    const bytes = m[1].split(",").map((x) => parseInt(x.trim(), 16)).filter(Number.isFinite);
    if (bytes.length === 32) master = Buffer.from(bytes).toString("hex");
  }
}
const uid = Array.from({ length: 16 }, (_, i) => (0x10 + i).toString(16).padStart(2, "0")).join("");
const key = deriveDeviceKey(master, uid);

// 1. RBAC matrix parity
let checked = 0;
for (const line of fs.readFileSync(rbacFile, "utf8").replace(/\r/g, "").trim().split("\n")) {
  const [role, cmdArg, allowed] = line.split(" ");
  const [cmd, arg = ""] = cmdArg.split(":");
  assert.equal(isFirmwareRoleAllowed(role, cmd, arg), allowed === "1", `RBAC mismatch ${line}`);
  checked++;
}

// 2. HMAC parity + replay/nonce behaviour, using the real firmware verifier
const nonce = 777;
const good = signMcuCommand("light", "50", "family", 5, nonce, key);
const reqs = [
  [good, "0"],                                                        // ok
  [signMcuCommand("light", "50", "family", 5, nonce, key), "3"],      // replay (seq not greater)
  [signMcuCommand("light", "50", "family", 6, nonce + 1, key), "2"],  // wrong boot nonce
  [signMcuCommand("light", "50", "family", 7, nonce, deriveDeviceKey(master, "00".repeat(16))), "2"], // other device key
  [signMcuCommand("away_arm", "", "guest", 8, nonce, key), "4"],      // rbac denied
  [signMcuCommand("emergency", "", "guest", 9, nonce, key), "0"],     // guest emergency allowed
  [signMcuCommand("privacy", "off", "guest", 10, nonce, key), "4"],   // guest cannot turn privacy off
  [signMcuCommand("heartbeat", "", "system", 11, nonce, key), "0"],   // system heartbeat
];
const input = reqs.map(([p]) => `${p.cmd}|${p.arg}|${p.role}|${p.seq}|${p.sig}`).join("\n") + "\n";
const out = execFileSync(harness, { input }).toString().replace(/\r/g, "").trim().split("\n");
assert.equal(out[0], `uid ${uid}`);
reqs.forEach(([, expect], i) => assert.equal(out[i + 1], expect, `verify case ${i}: got ${out[i + 1]} expected ${expect}`));

console.log(`host parity OK: ${checked} RBAC cells and ${reqs.length} HMAC/replay cases match the firmware code`);
