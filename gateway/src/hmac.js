import crypto from "node:crypto";

export const VALID_ROLES = new Set(["owner", "family", "guest"]);

/* Commands the firmware understands. Must match firmware/src/crypto_auth.c (see firmware/tools/host_test). */
export const MCU_CMDS = new Set([
  "light", "rgb", "fan", "ac", "eco", "all_off", "night", "alert_test", "emergency",
  "privacy", "away_arm", "away_disarm", "safety_clear", "vacancy",
  "ping", "audit_dump", "backfill_sync", "can_diag", "flash_id",
]);

const FW_DIAG = new Set(["ping", "audit_dump", "backfill_sync", "can_diag", "flash_id"]);
const FW_GUEST = new Set(["light", "rgb", "fan", "emergency"]);
const FW_FAMILY = new Set(["ac", "eco", "all_off", "night", "alert_test"]);
const FW_SYSTEM = new Set(["heartbeat", "trip"]);

/* Only the gateway itself may send these, never an HTTP or MQTT client */
const INTERNAL_ONLY = new Set(["heartbeat", "trip"]);

const GATEWAY_GUEST = new Set(["plug_tv", "lamp_living", "lamp_bed", "lights_off", "emergency_stop"]);
const GATEWAY_FAMILY = new Set([
  "ac_config", "plug_kettle", "plug_desk", "pad_tx", "fridge_door", "peak_demo",
  "night_mode", "room_toggle", "suggestion_approve", "suggestion_dismiss", "energy_saver",
]);

export function normalizeRole(role) {
  const r = String(role || "guest").toLowerCase();
  return VALID_ROLES.has(r) ? r : "guest";
}

/* Exact mirror of CryptoAuth_IsAllowed() in firmware, including the "system" role. */
export function isFirmwareRoleAllowed(role, cmd, arg = "") {
  if (role === "system") return FW_SYSTEM.has(cmd) || FW_DIAG.has(cmd);
  if (cmd === "heartbeat") return role === "owner";
  if (role === "owner") return cmd !== "trip";
  if (FW_GUEST.has(cmd)) return true;
  if (cmd === "privacy") return arg === "on" || role === "family";
  if (role === "family") return FW_FAMILY.has(cmd) || FW_DIAG.has(cmd);
  return false;
}

/* Gateway-level decision for a human role. Safety actions stay open to everyone. */
export function isRoleAllowed(role, cmd, arg = "") {
  const r = normalizeRole(role);
  if (INTERNAL_ONLY.has(cmd)) return false;
  if (MCU_CMDS.has(cmd)) return isFirmwareRoleAllowed(r, cmd, arg);
  if (r === "owner") return true;
  if (GATEWAY_GUEST.has(cmd)) return true;
  if (r === "family") return GATEWAY_FAMILY.has(cmd);
  return false;
}

/* devKey = HMAC-SHA256(master, "ELLY-DEV1|" + chipUid), same derivation as the firmware. */
export function deriveDeviceKey(masterKeyHex, uidHex) {
  return crypto.createHmac("sha256", Buffer.from(masterKeyHex, "hex")).update(`ELLY-DEV1|${uidHex}`, "utf8").digest();
}

export function computeHmacHex(cmd, arg, role, seq, nonce, deviceKey) {
  const canonical = `${cmd}|${arg ?? ""}|${role}|${seq}|${nonce}`;
  return crypto.createHmac("sha256", deviceKey).update(canonical, "utf8").digest("hex");
}

export function signMcuCommand(cmd, arg, role, seq, nonce, deviceKey) {
  const cleanArg = String(arg ?? "");
  return {
    cmd,
    arg: cleanArg,
    role,
    seq,
    sig: computeHmacHex(cmd, cleanArg, role, seq, nonce, deviceKey),
  };
}
