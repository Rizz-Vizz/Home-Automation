import assert from "node:assert/strict";
import EventEmitter from "node:events";
import http from "node:http";
import test from "node:test";
import mqtt from "mqtt";
import WebSocket from "ws";
import { computeHmacHex, deriveDeviceKey, isFirmwareRoleAllowed, isRoleAllowed } from "../src/hmac.js";
import { createGateway } from "../src/index.js";

const MASTER = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const UID = "0123456789abcdef0123456789abcdef";
const PINS = { owner: "111111", family: "222222", guest: "333333" };
const DEV_KEY = deriveDeviceKey(MASTER, UID);

class MockSerialTransport extends EventEmitter {
  constructor() {
    super();
    this.isOpen = true;
    this.writable = true;
    this.written = [];
  }
  write(chunk, cb) {
    this.written.push(JSON.parse(chunk.toString("utf8").trim()));
    cb?.(null);
  }
  pushLine(obj) {
    this.emit("data", Buffer.from(JSON.stringify(obj) + "\n", "utf8"));
  }
  close() {
    this.isOpen = false;
  }
}

const telem = (extra = {}) => ({
  type: "telem", uid: UID, nonce: 4242, uptime_ms: 5000, edge: false, safety: false, safety_reason: "normal",
  away: false, eco: true, privacy: false, light: true, light_pct: 80, fan: false, ac: false,
  lux: 310.5, temp_c: 29.4, db: 44.2, floor: 40.1, vib: 14, ax: 12, ay: -8, az: 996, dock: true,
  sw2: false, sw3: false, can_ok: true, accel_ok: true, cal: true, adc_ok: true, vac_s: 1200,
  audit_n: 2, telem_q: 0, last_seq: 0, ...extra,
});

test("RBAC: safety stays open to everyone, risky controls do not, internals are never reachable", () => {
  assert.equal(isRoleAllowed("guest", "emergency_stop"), true);
  assert.equal(isRoleAllowed("guest", "emergency"), true);
  assert.equal(isRoleAllowed("guest", "privacy", "on"), true);
  assert.equal(isRoleAllowed("guest", "privacy", "off"), false);
  assert.equal(isRoleAllowed("family", "privacy", "off"), true);
  assert.equal(isRoleAllowed("guest", "light"), true);
  assert.equal(isRoleAllowed("guest", "lights_off"), true);
  assert.equal(isRoleAllowed("guest", "away_disarm"), false);
  assert.equal(isRoleAllowed("guest", "pad_tx"), false);
  assert.equal(isRoleAllowed("guest", "audit_dump"), false);
  assert.equal(isRoleAllowed("family", "energy_saver"), true);
  assert.equal(isRoleAllowed("family", "safety_clear"), false);
  assert.equal(isRoleAllowed("owner", "safety_clear"), true);
  assert.equal(isRoleAllowed("owner", "trip"), false);
  assert.equal(isRoleAllowed("owner", "heartbeat"), false);
  assert.equal(isFirmwareRoleAllowed("system", "trip"), true);
  assert.equal(isFirmwareRoleAllowed("owner", "trip"), false);
});

test("Per-device key and canonical string include the boot nonce", () => {
  const a = computeHmacHex("light", "50", "owner", 1, 10, DEV_KEY);
  assert.equal(a.length, 64);
  assert.notEqual(a, computeHmacHex("light", "50", "owner", 1, 11, DEV_KEY));
  assert.notEqual(a, computeHmacHex("light", "50", "owner", 1, 10, deriveDeviceKey(MASTER, "00".repeat(16))));
});

test("Gateway: login, server-side roles, origin checks, signed commands, safety paths, MQTT auth, WS auth, cloud outbox", async () => {
  const transport = new MockSerialTransport();
  const cloudHits = [];
  let cloudUp = false;
  const cloudSrv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!cloudUp) return res.writeHead(503).end();
      cloudHits.push(...JSON.parse(raw).items);
      res.writeHead(200).end("{}");
    });
  });
  await new Promise((r) => cloudSrv.listen(19090, "127.0.0.1", r));

  const gw = createGateway({
    dbPath: ":memory:", mqttPort: 18883, httpPort: 18080, heartbeatMs: 60000,
    masterKeyHex: MASTER, pins: PINS, mqttGatewaySecret: "gw-secret",
    cloudUrl: "http://127.0.0.1:19090/ingest", cloudToken: "t", cloudIntervalMs: 3600000,
    transportFactory: () => transport,
  });
  await gw.start();
  const base = "http://127.0.0.1:18080";
  const post = (path, body, token, extra = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      body: JSON.stringify(body ?? {}),
    });
  const login = async (pin) => (await (await post("/api/login", { pin })).json());

  try {
    // board identifies itself, then streams telemetry and one backfill row
    transport.pushLine({ type: "boot", fw: "1.1.0", uid: UID, nonce: 4242, flash_ok: true, jedec: "ef4017", accel_ok: true, can_ok: true, audit_n: 1 });
    transport.pushLine(telem());
    transport.pushLine({ type: "backfill", seq: 1, uptime_ms: 4200, lux: 280, temp_c: 29.1, db: 41, vib: 10, flags: 9 });
    await new Promise((r) => setTimeout(r, 120));
    const rows = gw.db.getRecentTelemetry(10);
    assert.deepEqual(rows.map((r) => r.source).sort(), ["backfill", "live"]);

    // ---- authentication ----
    assert.equal((await fetch(base + "/api/snapshot")).status, 401);
    assert.equal((await post("/api/cmd", { cmd: "light", arg: "on" })).status, 401);
    assert.equal((await post("/api/login", { pin: "000000" })).status, 401);
    const owner = await login(PINS.owner);
    const family = await login(PINS.family);
    const guest = await login(PINS.guest);
    assert.equal(owner.role, "owner");
    assert.equal(guest.role, "guest");
    assert.equal((await fetch(base + "/api/snapshot", { headers: { Authorization: `Bearer ${guest.token}` } })).status, 200);

    // browser from another website: refused even with a valid token
    const evil = await post("/api/cmd", { cmd: "light", arg: "on" }, owner.token, { Origin: "http://evil.example" });
    assert.equal(evil.status, 403);
    const okOrigin = await post("/api/cmd", { cmd: "light", arg: "70" }, owner.token, { Origin: "http://localhost:5173" });
    assert.equal(okOrigin.status, 200);

    // role in the body is ignored: a guest session claiming owner is still a guest
    const spoof = await post("/api/cmd", { cmd: "safety_clear", role: "owner" }, guest.token);
    assert.equal(spoof.status, 403);
    assert.ok(gw.db.getAuditLogs(20).some((a) => a.event_type === "rbac_deny" && a.role === "guest"));

    // ---- signed command on the wire ----
    transport.written.length = 0;
    const res = await post("/api/cmd", { cmd: "light", arg: "65" }, family.token);
    assert.equal(res.status, 200);
    const w = transport.written.at(-1);
    assert.equal(w.cmd, "light");
    assert.equal(w.role, "family");
    assert.equal(w.sig, computeHmacHex(w.cmd, w.arg, w.role, w.seq, 4242, DEV_KEY));

    // new boot nonce restarts the sequence (board reset), and old signatures no longer match
    transport.pushLine(telem({ nonce: 9999, last_seq: 0 }));
    await new Promise((r) => setTimeout(r, 30));
    transport.written.length = 0;
    await post("/api/cmd", { cmd: "light", arg: "20" }, family.token);
    const w2 = transport.written.at(-1);
    assert.equal(w2.seq, 1);
    assert.equal(w2.sig, computeHmacHex("light", "20", "family", 1, 9999, DEV_KEY));
    assert.notEqual(w2.sig, computeHmacHex("light", "20", "family", 1, 4242, DEV_KEY));

    // ---- safety paths ----
    transport.written.length = 0;
    assert.equal((await post("/api/cmd", { cmd: "emergency_stop" }, guest.token)).status, 200);
    assert.ok(transport.written.some((x) => x.cmd === "emergency" && x.role === "guest"));
    assert.equal(gw.home.appliances.get("plug_tv").on, false);

    transport.written.length = 0;
    for (let i = 0; i < 6; i++) await post("/api/cmd", { cmd: "pad_fault", arg: "on" }, owner.token);
    assert.ok(gw.db.getAlerts(10).some((a) => a.category === "thermal_pad"));
    assert.ok(transport.written.some((x) => x.cmd === "trip" && x.arg === "pad_thermal" && x.role === "system"));
    assert.equal((await post("/api/cmd", { cmd: "pad_fault", arg: "on" }, family.token)).status, 403);
    assert.equal((await post("/api/cmd", { cmd: "trip", arg: "pad_thermal" }, owner.token)).status, 403);

    // ---- PDF scenes ----
    transport.written.length = 0;
    assert.equal((await post("/api/cmd", { cmd: "energy_saver" }, family.token)).status, 200);
    assert.ok(transport.written.some((x) => x.cmd === "eco" && x.arg === "on"));
    assert.equal(gw.home.appliances.get("ac_living").acMode, "eco");
    assert.equal((await post("/api/cmd", { cmd: "energy_saver" }, guest.token)).status, 403);

    gw.home.setAppliance("lamp_living", true);
    transport.written.length = 0;
    assert.equal((await post("/api/cmd", { cmd: "lights_off" }, guest.token)).status, 200);
    assert.equal(gw.home.appliances.get("lamp_living").on, false);
    assert.ok(transport.written.some((x) => x.cmd === "light" && x.arg === "off"));

    transport.written.length = 0;
    assert.equal((await post("/api/cmd", { cmd: "demo_timing", arg: "on" }, owner.token)).status, 200);
    assert.ok(transport.written.some((x) => x.cmd === "vacancy" && x.arg === "20"));
    assert.equal(gw.db.getRules().find((r) => r.id === "rule_vacancy").threshold, 20);
    assert.equal((await post("/api/cmd", { cmd: "demo_timing", arg: "on" }, family.token)).status, 403);

    assert.equal((await post("/api/cmd", { cmd: "privacy", arg: "off" }, guest.token)).status, 403);
    assert.equal((await post("/api/cmd", { cmd: "privacy", arg: "on" }, guest.token)).status, 200);

    // guests cannot read the audit trail or push camera events
    assert.equal((await fetch(base + "/api/audit", { headers: { Authorization: `Bearer ${guest.token}` } })).status, 403);
    assert.equal((await post("/api/vision/event", { summary: "x" }, guest.token)).status, 403);
    const vis = await post("/api/vision/event", { summary: "Person near foyer", motionScore: 24.5, armed: true }, owner.token);
    assert.equal(vis.status, 200);
    assert.equal((await post("/api/vision/prune", { retentionMin: 30 }, family.token)).status, 200);

    // guests may not edit automation
    assert.equal((await post("/api/rules/toggle", { id: "rule_night", enabled: true }, guest.token)).status, 403);
    assert.equal((await post("/api/rules/toggle", { id: "rule_night", enabled: true }, family.token)).status, 200);

    // ---- energy model ----
    gw.home.setAppliance("ac_living", true, { acMode: "cool" });
    gw.home.setAppliance("plug_kettle", true);
    const snap = gw.home.step({ temp_c: 29, eco: false });
    assert.ok(snap.totalWatts > 2500);
    assert.ok(snap.events.some((e) => e.type === "energy_spike"));

    // ---- websocket needs auth before it says anything ----
    const wsBad = new WebSocket("ws://127.0.0.1:18080/ws");
    const badMsgs = [];
    wsBad.on("message", (b) => badMsgs.push(b.toString()));
    await new Promise((r) => wsBad.on("close", r));
    assert.equal(badMsgs.length, 0);

    const ws = new WebSocket("ws://127.0.0.1:18080/ws");
    const first = await new Promise((resolve) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: guest.token })));
      ws.once("message", (b) => resolve(JSON.parse(b.toString())));
    });
    assert.equal(first.type, "snapshot");
    assert.equal(first.data.role, "guest");
    const wsResult = new Promise((resolve) => ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "cmd_result") resolve(m); }));
    ws.send(JSON.stringify({ type: "cmd", cmd: "safety_clear", role: "owner" }));
    assert.equal((await wsResult).data.err, "rbac_denied");
    ws.close();

    // ---- MQTT: anonymous refused, role forced from the login ----
    const anon = mqtt.connect("mqtt://127.0.0.1:18883", { reconnectPeriod: 0 });
    const anonErr = await new Promise((resolve) => { anon.once("error", resolve); anon.once("connect", () => resolve(null)); });
    assert.ok(anonErr, "anonymous MQTT client must be refused");
    anon.end(true);

    const mg = mqtt.connect("mqtt://127.0.0.1:18883", { username: "guest", password: PINS.guest, reconnectPeriod: 0 });
    await new Promise((r) => mg.once("connect", r));
    await mg.publishAsync("elly/cmd/hub", JSON.stringify({ cmd: "safety_clear", role: "owner" }));
    await mg.publishAsync("elly/telemetry", JSON.stringify({ fake: true }));
    await new Promise((r) => setTimeout(r, 150));
    const denies = gw.db.getAuditLogs(60).filter((a) => a.event_type === "rbac_deny" && a.detail.startsWith("safety_clear"));
    assert.ok(denies.length >= 2, "MQTT guest claiming owner must still be denied");
    await new Promise((r) => mg.end(true, r));

    // ---- cloud mirror: offline queue then ordered flush ----
    assert.equal(gw.cloud.status().configured, true);
    await gw.cloud.tick();
    assert.equal(gw.cloud.status().online, false);
    assert.ok(gw.cloud.status().queued >= 1);
    cloudUp = true;
    await gw.cloud.tick();
    assert.equal(gw.cloud.status().online, true);
    assert.equal(gw.cloud.status().queued, 0);
    assert.ok(cloudHits.length >= 2);
    assert.equal((await post("/api/cmd", { cmd: "cloud_toggle", arg: "off" }, family.token)).status, 403);
    assert.equal((await post("/api/cmd", { cmd: "cloud_toggle", arg: "off" }, owner.token)).status, 200);
    assert.equal(gw.cloud.status().online, false);

    // logout kills the session
    await post("/api/logout", {}, owner.token);
    assert.equal((await post("/api/cmd", { cmd: "light", arg: "on" }, owner.token)).status, 401);
  } finally {
    await gw.stop();
    await new Promise((r) => cloudSrv.close(r));
  }
});

test("Login lockout after repeated bad PINs", async () => {
  const gw = createGateway({
    dbPath: ":memory:", mqttPort: 18884, httpPort: 18081, heartbeatMs: 60000,
    masterKeyHex: MASTER, pins: PINS, mqttGatewaySecret: "gw-secret",
    transportFactory: () => new MockSerialTransport(),
  });
  await gw.start();
  try {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await fetch("http://127.0.0.1:18081/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "999999" }) })).status;
    }
    assert.equal(last, 429);
    const good = await fetch("http://127.0.0.1:18081/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: PINS.owner }) });
    assert.equal(good.status, 429, "lockout applies even to the right PIN until it expires");
  } finally {
    await gw.stop();
  }
});
