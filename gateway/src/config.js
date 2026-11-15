import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env") });

function need(name, value) {
  if (!value) {
    throw new Error(`Missing ${name}. Run: python firmware/tools/gen_secrets.py (creates gateway/.env)`);
  }
  return value;
}

export function loadConfig(overrides = {}) {
  const rawDb = overrides.dbPath ?? process.env.DB_PATH ?? "./data/elly.db";
  const masterKeyHex = need("ELLY_MASTER_KEY", overrides.masterKeyHex ?? process.env.ELLY_MASTER_KEY);
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    throw new Error("ELLY_MASTER_KEY must be 64 hex characters (32 bytes)");
  }
  const pins = {
    owner: need("OWNER_PIN", overrides.pins?.owner ?? process.env.OWNER_PIN),
    family: need("FAMILY_PIN", overrides.pins?.family ?? process.env.FAMILY_PIN),
    guest: need("GUEST_PIN", overrides.pins?.guest ?? process.env.GUEST_PIN),
  };
  if (new Set(Object.values(pins)).size !== 3) {
    throw new Error("OWNER_PIN, FAMILY_PIN and GUEST_PIN must all be different");
  }
  const origins = String(
    overrides.dashboardOrigins ?? process.env.DASHBOARD_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173"
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    rootDir,
    serialPort: overrides.serialPort ?? process.env.SERIAL_PORT ?? "COM6",
    serialBaud: Number(overrides.serialBaud ?? process.env.SERIAL_BAUD ?? 115200),
    mqttPort: Number(overrides.mqttPort ?? process.env.MQTT_PORT ?? 1883),
    httpPort: Number(overrides.httpPort ?? process.env.HTTP_PORT ?? 8080),
    masterKeyHex: masterKeyHex.toLowerCase(),
    pins,
    mqttGatewaySecret: need("MQTT_GATEWAY_SECRET", overrides.mqttGatewaySecret ?? process.env.MQTT_GATEWAY_SECRET),
    dashboardOrigins: origins,
    tlsCert: overrides.tlsCert ?? process.env.TLS_CERT ?? "",
    tlsKey: overrides.tlsKey ?? process.env.TLS_KEY ?? "",
    cloudUrl: overrides.cloudUrl ?? process.env.CLOUD_SYNC_URL ?? "",
    cloudToken: overrides.cloudToken ?? process.env.CLOUD_SYNC_TOKEN ?? "",
    cloudIntervalMs: Number(overrides.cloudIntervalMs ?? process.env.CLOUD_SYNC_MS ?? 30000),
    llmEndpoint: overrides.llmEndpoint ?? process.env.LLM_ENDPOINT ?? "",
    llmKey: overrides.llmKey ?? process.env.LLM_API_KEY ?? "",
    llmModel: overrides.llmModel ?? process.env.LLM_MODEL ?? "gpt-4o-mini",
    dbPath: rawDb === ":memory:" ? ":memory:" : path.resolve(rootDir, rawDb),
    heartbeatMs: Number(overrides.heartbeatMs ?? process.env.HEARTBEAT_MS ?? 1000),
  };
}
