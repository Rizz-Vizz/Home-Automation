import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { EllyDatabase } from "./db.js";
import { AuthService } from "./auth.js";
import { CloudSync } from "./cloud.js";
import { MCU_CMDS, isRoleAllowed, normalizeRole } from "./hmac.js";
import { MqttHub } from "./mqtt_broker.js";
import { SerialBridge } from "./serial_bridge.js";
import { VirtualHome } from "./virtual_home.js";
import { WsApiServer } from "./ws_api.js";

const MCU_COMMANDS = MCU_CMDS;

const LLM_ALLOWED = new Set([
  ...MCU_CMDS, "ac_config", "plug_tv", "lamp_living", "plug_kettle", "lamp_bed", "plug_desk", "pad_tx",
  "night_mode", "energy_saver", "lights_off", "emergency_stop", "room_toggle",
]);

const VIRTUAL_APPLIANCE_CMDS = new Set([
  "plug_tv",
  "lamp_living",
  "plug_kettle",
  "lamp_bed",
  "pad_tx",
  "plug_desk",
]);

export function createGateway(overrides = {}) {
  const cfg = loadConfig(overrides);
  const db = new EllyDatabase(cfg.dbPath);
  const home = new VirtualHome();
  home.restoreState(db.getJson("virtual_state", null));
  const serial = new SerialBridge({ ...cfg, db, transportFactory: overrides.transportFactory });

  let lastTelem = null;
  let lastVirtual = home.step({}, Date.now(), db.getRules());
  let mcuInfo = { fw: null, uid: null, flash_ok: false, jedec: null, can_ok: false, accel_ok: false };
  let lastAutoPingAt = 0;
  let virtualTimer = null;
  let startedAt = Date.now();
  let backfillTotal = 0;
  const auth = new AuthService(cfg.pins);
  let lastVacSyncAt = 0;
  let cloud = null;
  const cloudOnline = () => cloud?.status().online ?? false;

  let mqttHub = null;
  let wsApi = null;

  cloud = new CloudSync({
    url: cfg.cloudUrl,
    token: cfg.cloudToken,
    intervalMs: cfg.cloudIntervalMs,
    db,
    getSummary: () => ({
      uid: mcuInfo.uid,
      totalWatts: lastVirtual?.totalWatts ?? null,
      savedWatts: lastVirtual?.savedWatts ?? null,
      devicesActive: lastVirtual?.appliances?.filter((a) => a.on).length ?? null,
      safety: Boolean(lastTelem?.safety),
      edge: Boolean(lastTelem?.edge),
      away: Boolean(lastTelem?.away),
    }),
    onChange: (st) => wsApi?.broadcast({ type: "cloud_status", cloud: st, cloudOnline: st.online }),
  });
  cloud.setEnabled(db.getJson("cloud_enabled", true));

  function persistHome() {
    db.setJson("virtual_state", home.exportState());
  }

  function recordHomeEvents(events) {
    for (const evt of events) {
      if (evt.ruleId) {
        db.touchRuleTrigger(evt.ruleId);
      }
      db.insertAlert({
        category: evt.type,
        severity: evt.severity,
        room: evt.room,
        title: evt.title,
        detail: evt.detail,
      });
      mqttHub?.publish("elly/alerts", evt);
      wsApi?.broadcast({ type: "alert", data: evt, alerts: db.getAlerts(30), rules: db.getRules() });

      if (evt.triggerMcuSafety && serial.status === "connected" && serial.lastFirmwareType === "elly_edge_fw") {
        serial.sendSignedCommand("trip", "pad_thermal", "system").catch(() => {});
      }
    }
  }

  serial.on("status", (st) => {
    wsApi?.broadcast({ type: "serial_status", data: st });
  });

  serial.on("frame", (msg) => {
    if (msg.type === "boot") {
      mcuInfo = {
        fw: msg.fw ?? null,
        uid: msg.uid ?? null,
        flash_ok: Boolean(msg.flash_ok),
        jedec: msg.jedec ?? null,
        can_ok: Boolean(msg.can_ok),
        accel_ok: Boolean(msg.accel_ok),
      };
      db.insertAudit({ origin: "mcu", event_type: "boot", role: "system", detail: `fw=${msg.fw} jedec=${msg.jedec}` });
      wsApi?.broadcast({ type: "boot", data: msg, mcuInfo });
      mqttHub?.publish("elly/events", msg);
      return;
    }

    if (msg.type === "flash_id") {
      mcuInfo.flash_ok = Boolean(msg.ok);
      mcuInfo.jedec = msg.jedec ?? mcuInfo.jedec;
      wsApi?.broadcast({ type: "flash_id", data: msg, mcuInfo });
      return;
    }

    if (msg.type === "can") {
      mcuInfo.can_ok = Boolean(msg.ok);
      wsApi?.broadcast({ type: "can", data: msg, mcuInfo });
      return;
    }

    if (msg.type === "ack") {
      if (msg.uid) mcuInfo.uid = msg.uid;
      if (msg.jedec) mcuInfo.jedec = msg.jedec;
      if (typeof msg.flash_ok === "boolean") mcuInfo.flash_ok = msg.flash_ok;
      if (typeof msg.can_ok === "boolean") mcuInfo.can_ok = msg.can_ok;
      wsApi?.broadcast({ type: "ack", data: msg });
      mqttHub?.publish("elly/events", msg);
      return;
    }

    if (msg.type === "audit") {
      db.insertAudit({
        origin: "mcu_flash",
        seq: msg.seq,
        event_type: `evt_${msg.evt}`,
        role: msg.role === 3 ? "system" : msg.role === 2 ? "owner" : msg.role === 1 ? "family" : "guest",
        detail: msg.detail,
        prev_hash: msg.prev,
        entry_hash: msg.hash,
      });
      wsApi?.broadcast({ type: "audit", data: msg, audit: db.getAuditLogs(50) });
      return;
    }

    if (msg.type === "backfill") {
      backfillTotal += 1;
      db.insertTelemetry({
        source: "backfill",
        uptime_ms: msg.uptime_ms,
        lux: msg.lux,
        temp_c: msg.temp_c,
        db: msg.db,
        vib_mg: msg.vib,
        power_w: lastVirtual.totalWatts,
        pad_temp_c: lastVirtual.padTempC,
        pad_eff_pct: lastVirtual.padEfficiencyPct,
        edge_mode: (msg.flags & 8) !== 0,
        safety_latched: (msg.flags & 16) !== 0,
        away_armed: (msg.flags & 4) !== 0,
        raw_json: JSON.stringify(msg),
      });
      wsApi?.broadcast({ type: "backfill", data: msg, backfillTotal });
      mqttHub?.publish("elly/events", { ...msg, backfillTotal });
      return;
    }

    if (msg.type === "telem") {
      lastTelem = { ...msg, receivedAt: Date.now() };
      mcuInfo.can_ok = Boolean(msg.can_ok);
      mcuInfo.accel_ok = Boolean(msg.accel_ok);
      if (!mcuInfo.uid && Date.now() - lastAutoPingAt > 5000) {
        lastAutoPingAt = Date.now();
        serial.sendSignedCommand("ping", "", "system").catch(() => {});
      }
      const vacRule = db.getRules().find((r) => r.id === "rule_vacancy");
      if (vacRule && typeof msg.vac_s === "number" && msg.vac_s !== vacRule.threshold && serial.getStatus().identified && Date.now() - lastVacSyncAt > 5000) {
        lastVacSyncAt = Date.now();
        serial.sendSignedCommand("vacancy", String(vacRule.threshold), "system").catch(() => {});
      }
      home.syncWithHardwareState(msg);
      lastVirtual = home.step(msg, Date.now(), db.getRules());
      recordHomeEvents(lastVirtual.events);
      if (home.tickCount % 10 === 0) {
        persistHome();
      }

      db.insertTelemetry({
        source: "live",
        uptime_ms: msg.uptime_ms,
        lux: msg.lux,
        temp_c: msg.temp_c,
        db: msg.db,
        vib_mg: msg.vib,
        power_w: lastVirtual.totalWatts,
        pad_temp_c: lastVirtual.padTempC,
        pad_eff_pct: lastVirtual.padEfficiencyPct,
        edge_mode: msg.edge,
        safety_latched: msg.safety,
        safety_reason: msg.safety_reason,
        away_armed: msg.away,
        auto_eco: msg.eco,
        saved_watts: lastVirtual.savedWatts,
        deviceWatts: lastVirtual.deviceWatts,
        raw_json: JSON.stringify(msg),
      });

      const payload = {
        telem: lastTelem,
        virtual: lastVirtual,
        mcuInfo,
        deviceEnergy: db.getDeviceDailyEnergy(),
        rules: db.getRules(),
        cloudOnline: cloudOnline(),
        cloud: cloud.status(),
        mqttPublished: mqttHub?.publishedCount ?? 0,
      };
      mqttHub?.publish("elly/telemetry", payload);
      wsApi?.broadcast({ type: "telem", data: payload });
    }
  });

  async function dispatchCommand(input = {}) {
    const cmd = String(input.cmd || "").trim();
    const arg = String(input.arg ?? "").trim();
    const role = normalizeRole(input.role);

    if (!cmd) {
      return { ok: false, httpStatus: 400, err: "missing_cmd" };
    }

    if (!isRoleAllowed(role, cmd, arg)) {
      db.insertAudit({ origin: "gateway", event_type: "rbac_deny", role, detail: `${cmd} ${arg}`.trim() });
      wsApi?.broadcast({ type: "audit", audit: db.getAuditLogs(50) });
      return { ok: false, httpStatus: 403, err: "rbac_denied", cmd, role };
    }

    if (cmd === "pad_fault") {
      const curFault = Boolean(home.appliances.get("pad_tx")?.faultInjected);
      const enabled = arg === "toggle" ? !curFault : (arg !== "off" && arg !== "false");
      home.setAppliance("pad_tx", enabled || home.appliances.get("pad_tx")?.on, { faultInjected: enabled });
      if (enabled) home.setAppliance("pad_tx", true);
      persistHome();
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      recordHomeEvents(lastVirtual.events);
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: `pad_fault=${enabled}` });
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "virtual", cmd, arg: enabled ? "on" : "off", virtual: lastVirtual };
    }

    if (cmd === "fridge_door") {
      const open = arg !== "off" && arg !== "false";
      home.setAppliance("fridge", true, { doorOpen: open });
      persistHome();
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      recordHomeEvents(lastVirtual.events);
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: `fridge_door=${open}` });
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "virtual", cmd, arg: open ? "on" : "off", virtual: lastVirtual };
    }

    if (cmd === "peak_demo") {
      home.peakDemoActive = arg !== "off" && arg !== "false";
      persistHome();
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      recordHomeEvents(lastVirtual.events);
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: `peak_demo=${home.peakDemoActive}` });
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "virtual", cmd, arg: home.peakDemoActive ? "on" : "off", virtual: lastVirtual };
    }

    if (cmd === "cloud_toggle") {
      const next = arg ? arg !== "off" && arg !== "false" : !cloud.enabled;
      cloud.setEnabled(next);
      db.setJson("cloud_enabled", next);
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: `cloud_sync=${next}` });
      wsApi?.broadcast({ type: "cloud_status", cloud: cloud.status(), cloudOnline: cloudOnline(), audit: db.getAuditLogs(50) });
      return { ok: true, target: "gateway", cmd, cloud: cloud.status() };
    }

    if (cmd === "demo_timing") {
      const on = arg !== "off" && arg !== "false";
      const secs = on ? 20 : 1200;
      db.setRuleThreshold("rule_vacancy", secs);
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: `demo_timing=${on}` });
      if (serial.getStatus().identified) {
        await serial.sendSignedCommand("vacancy", String(secs), role).catch(() => {});
      }
      wsApi?.broadcast({ type: "rules", rules: db.getRules(), audit: db.getAuditLogs(50) });
      return { ok: true, target: "hybrid", cmd, vacancySec: secs };
    }

    if (cmd === "lights_off") {
      home.turnLightsOff();
      persistHome();
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: "lights_off" });
      if (serial.getStatus().status === "connected") {
        await serial.sendSignedCommand("light", "off", role).catch(() => {});
      }
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "hybrid", cmd, virtual: lastVirtual };
    }

    if (cmd === "energy_saver") {
      if (lastTelem?.safety) return { ok: false, httpStatus: 409, err: "safety_override" };
      if (lastTelem?.away) return { ok: false, httpStatus: 409, err: "away_armed" };
      home.activateEnergySaver();
      persistHome();
      if (lastTelem) lastTelem = { ...lastTelem, eco: true };
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: "energy_saver" });
      if (serial.getStatus().status === "connected") {
        await serial.sendSignedCommand("eco", "on", role).catch(() => {});
        if (lastTelem?.light && Number(lastTelem.light_pct) > 40) {
          await serial.sendSignedCommand("light", "40", role).catch(() => {});
        }
      }
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "hybrid", cmd, virtual: lastVirtual };
    }

    if (cmd === "all_off" || cmd === "emergency_stop") {
      home.turnAllOff();
      persistHome();
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: cmd });
      if (cmd === "emergency_stop") {
        const evt = {
          type: "emergency_stop",
          severity: "critical",
          room: "Hub",
          title: "Emergency Home Shutdown Triggered",
          detail: `All non-critical home circuits cut by ${role}.`,
        };
        db.insertAlert({ category: evt.type, ...evt });
        wsApi?.broadcast({ type: "alert", data: evt, alerts: db.getAlerts(30) });
      }
      if (serial.getStatus().status === "connected") {
        const mcuCmd = cmd === "emergency_stop" ? "emergency" : "all_off";
        await serial.sendSignedCommand(mcuCmd, "", role).catch(() => {});
      }
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "hybrid", cmd, virtual: lastVirtual };
    }

    if (cmd === "night" || cmd === "night_mode") {
      if (lastTelem?.safety) {
        return { ok: false, httpStatus: 409, err: "safety_override" };
      }
      if (lastTelem?.away) {
        return { ok: false, httpStatus: 409, err: "away_armed" };
      }
      home.activateNightMode();
      persistHome();
      lastTelem = lastTelem ? { ...lastTelem, eco: true } : lastTelem;
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: "night_mode" });
      if (serial.getStatus().status === "connected") {
        await serial.sendSignedCommand("night", "", role).catch(() => {});
      }
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "hybrid", cmd, virtual: lastVirtual };
    }

    if (cmd === "ac_config") {
      let parsed = {};
      try {
        parsed = arg.startsWith("{") ? JSON.parse(arg) : {};
      } catch {
        parsed = {};
      }
      const nextOn = typeof parsed.on === "boolean" ? parsed.on : undefined;
      const updated = home.setAppliance("ac_living", nextOn, {
        targetC: parsed.targetC !== undefined ? Number(parsed.targetC) : undefined,
        fanSpeed: parsed.fanSpeed,
        acMode: parsed.acMode,
      });
      if (parsed.acMode === "cool" && lastTelem) {
        lastTelem = { ...lastTelem, eco: false };
      } else if (parsed.acMode === "eco" && lastTelem) {
        lastTelem = { ...lastTelem, eco: true };
      }
      persistHome();
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      recordHomeEvents(lastVirtual.events);
      db.insertAudit({
        origin: "gateway",
        event_type: "cmd",
        role,
        detail: `ac ${updated.on ? "on" : "off"} ${updated.acMode} ${updated.targetC}C`,
      });
      if (serial.getStatus().status === "connected") {
        if (parsed.acMode === "cool" || parsed.acMode === "eco") {
          await serial.sendSignedCommand("eco", parsed.acMode === "eco" ? "on" : "off", role).catch(() => {});
        }
        if (typeof nextOn === "boolean") {
          await serial.sendSignedCommand("ac", nextOn ? "on" : "off", role).catch(() => {});
        }
      }
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "hybrid", cmd, appliance: updated, virtual: lastVirtual };
    }

    if (cmd === "room_toggle") {
      const [roomRaw, stateRaw] = arg.split(":");
      const targetOn = stateRaw !== "off" && stateRaw !== "false";
      const updated = home.toggleRoom(roomRaw, targetOn);
      persistHome();
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: `room ${roomRaw}=${targetOn}` });
      if (serial.getStatus().status === "connected") {
        if (roomRaw === "Living Room") {
          await serial.sendSignedCommand("light", targetOn ? "85" : "off", role).catch(() => {});
        } else if (roomRaw === "Bedroom") {
          await serial.sendSignedCommand("fan", targetOn ? "on" : "off", role).catch(() => {});
        }
      }
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "hybrid", cmd, updated, virtual: lastVirtual };
    }

    if (cmd === "suggestion_approve") {
      home.setAppliance("ac_living", true, { acMode: "eco", targetC: 26, fanSpeed: "auto" });
      persistHome();
      if (serial.getStatus().status === "connected") {
        await serial.sendSignedCommand("eco", "on", role).catch(() => {});
      }
      lastVirtual = home.step({ ...(lastTelem ?? {}), eco: true }, Date.now(), db.getRules());
      db.insertAudit({ origin: "gateway", event_type: "ai_opt", role, detail: "approved_peak_eco_26C" });
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "hybrid", cmd, virtual: lastVirtual };
    }

    if (cmd === "suggestion_dismiss") {
      home.suggestionDismissedUntil = Date.now() + 5 * 60 * 1000;
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      db.insertAudit({ origin: "gateway", event_type: "ai_opt", role, detail: "dismissed_peak_eco" });
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "virtual", cmd, virtual: lastVirtual };
    }

    if (VIRTUAL_APPLIANCE_CMDS.has(cmd)) {
      const current = home.appliances.get(cmd);
      const nextOn = arg === "toggle" ? !current?.on : arg !== "off" && arg !== "false";
      const updated = home.setAppliance(cmd, nextOn);
      persistHome();
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
      recordHomeEvents(lastVirtual.events);
      db.insertAudit({ origin: "gateway", event_type: "cmd", role, detail: `${cmd}=${nextOn}` });
      mqttHub?.publish("elly/appliances", updated);
      wsApi?.broadcast({ type: "virtual", data: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, target: "virtual", cmd, appliance: updated, virtual: lastVirtual };
    }

    if (MCU_COMMANDS.has(cmd)) {
      if (cmd === "privacy" && arg !== "on" && arg !== "off") {
        return { ok: false, httpStatus: 400, err: "bad_arg" };
      }
      if (cmd === "vacancy" && !(Number(arg) >= 10 && Number(arg) <= 86400)) {
        return { ok: false, httpStatus: 400, err: "bad_arg" };
      }
      const serialSt = serial.getStatus();
      if (serialSt.status !== "connected") {
        return {
          ok: false,
          httpStatus: 503,
          err: "serial_unavailable",
          detail: serialSt.lastError || `Board serial port is ${serialSt.status}`,
          serialStatus: serialSt,
        };
      }
      try {
        const sent = await serial.sendSignedCommand(cmd, arg, role);
        if (cmd === "vacancy") {
          db.setRuleThreshold("rule_vacancy", Number(arg));
        }
        if (cmd === "eco") {
          const ecoOn = arg !== "off" && arg !== "false";
          home.setAppliance("ac_living", undefined, { acMode: ecoOn ? "eco" : "cool" });
          if (lastTelem) lastTelem = { ...lastTelem, eco: ecoOn };
          persistHome();
          lastVirtual = home.step(lastTelem ?? {}, Date.now(), db.getRules());
          wsApi?.broadcast({ type: "virtual", data: lastVirtual });
        }
        db.insertAudit({ origin: "gateway", seq: sent.seq, event_type: "cmd", role, detail: `${cmd} ${arg}`.trim() });
        wsApi?.broadcast({ type: "audit", audit: db.getAuditLogs(50) });
        return { ok: true, target: "mcu", sent, virtual: lastVirtual };
      } catch (err) {
        return { ok: false, httpStatus: 503, err: err.message };
      }
    }

    return { ok: false, httpStatus: 400, err: "unknown_cmd", cmd };
  }

  /* Optional LLM intent mapping. The key stays on the server, and the answer is only a suggestion:
     it must be on the whitelist and allowed for the caller's role, then it still goes through confirmation + RBAC. */
  async function nlpLlm(text, role) {
    if (!cfg.llmEndpoint || !cfg.llmKey) return { ok: false, err: "llm_not_configured" };
    const clean = String(text).slice(0, 300);
    try {
      const res = await fetch(cfg.llmEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.llmKey}` },
        body: JSON.stringify({
          model: cfg.llmModel,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                'Map smart home text to ONE JSON object {"cmd":string,"arg":string,"label":string} and nothing else. Allowed cmd values: ' +
                [...LLM_ALLOWED].join(", "),
            },
            { role: "user", content: clean },
          ],
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return { ok: false, err: `llm_http_${res.status}` };
      const data = await res.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
      const cmd = String(parsed.cmd || "");
      const arg = String(parsed.arg ?? "").slice(0, 48);
      if (!LLM_ALLOWED.has(cmd) || !isRoleAllowed(role, cmd, arg)) return { ok: false, err: "llm_intent_rejected" };
      return { ok: true, intent: { cmd, arg, label: String(parsed.label || `${cmd} ${arg}`).slice(0, 80) } };
    } catch (err) {
      return { ok: false, err: err.name === "TimeoutError" ? "llm_timeout" : "llm_failed" };
    }
  }

  function getSnapshot() {
    return {
      serial: serial.getStatus(),
      mcuInfo,
      telem: lastTelem,
      virtual: lastVirtual,
      backfillTotal,
      telemetryHistory: db.getRecentTelemetry(90),
      dailyEnergy: db.getDailyEnergy(7),
      deviceEnergy: db.getDeviceDailyEnergy(),
      rules: db.getRules(),
      visionEvents: db.getVisionEvents(25),
      cloudOnline: cloudOnline(),
      cloud: cloud.status(),
      mqttPublished: mqttHub?.publishedCount ?? 0,
      audit: db.getAuditLogs(40),
      alerts: db.getAlerts(25),
    };
  }

  mqttHub = new MqttHub(
    cfg.mqttPort,
    (_target, msg) => {
      // role was forced by the broker from the MQTT login
      dispatchCommand(msg).catch(() => {});
    },
    { pins: cfg.pins, gatewaySecret: cfg.mqttGatewaySecret }
  );

  wsApi = new WsApiServer(cfg.httpPort, {
    getHealth: () => ({ ok: true }),
    getSnapshot,
    getTelemetry: (limit) => db.getRecentTelemetry(limit),
    getAudit: (limit) => db.getAuditLogs(limit),
    getAlerts: (limit) => db.getAlerts(limit),
    getDailyEnergy: () => db.getDailyEnergy(7),
    getDeviceEnergy: () => db.getDeviceDailyEnergy(),
    getRules: () => db.getRules(),
    toggleRule: (body = {}) => {
      const role = normalizeRole(body.role);
      if (role === "guest") {
        db.insertAudit({ origin: "gateway", event_type: "rbac_deny", role, detail: `rule ${body.id}` });
        wsApi?.broadcast({ type: "audit", audit: db.getAuditLogs(50) });
        return { ok: false, httpStatus: 403, err: "rbac_denied", role };
      }
      const rules = db.toggleRule(body.id, Boolean(body.enabled));
      db.insertAudit({ origin: "gateway", event_type: "rule", role, detail: `${body.id}=${Boolean(body.enabled)}` });
      lastVirtual = home.step(lastTelem ?? {}, Date.now(), rules);
      wsApi?.broadcast({ type: "rules", rules, virtual: lastVirtual, audit: db.getAuditLogs(50) });
      return { ok: true, rules };
    },
    getVisionEvents: (limit) => db.getVisionEvents(limit),
    recordVisionEvent: async (body = {}) => {
      const summary = String(body.summary || "Motion detected in local vision frame");
      const motionScore = Number(body.motionScore || 0);
      const privacyMode = Boolean(body.privacyMode);
      const retentionMin = Number(db.getJson("vision_retention_min", 60));
      const armed = Boolean(lastTelem?.away || body.armed);
      db.insertVisionEvent(
        { summary, motion_score: motionScore, privacy_mode: privacyMode, armed },
        retentionMin
      );
      const visionEvents = db.getVisionEvents(25);
      const rules = db.getRules();
      const intrusionRule = rules.find((r) => r.id === "rule_intrusion");
      if (!privacyMode && armed && intrusionRule?.enabled) {
        db.touchRuleTrigger("rule_intrusion");
        const alert = {
          category: "intrusion",
          severity: "critical",
          room: "Living Room",
          title: "Smart Vision Away Intrusion",
          detail: `${summary} (RAM score ${motionScore.toFixed(1)}).`,
        };
        db.insertAlert(alert);
        mqttHub?.publish("elly/alerts", alert);
        wsApi?.broadcast({ type: "alert", data: alert, alerts: db.getAlerts(30), visionEvents, rules: db.getRules() });
        if (body.escalateSafety && serial.getStatus().status === "connected") {
          await serial.sendSignedCommand("trip", "intrusion", "system").catch(() => {});
        }
      } else {
        wsApi?.broadcast({ type: "vision", visionEvents });
      }
      return { ok: true, visionEvents };
    },
    ackAlerts: () => {
      db.acknowledgeAlerts();
      const alerts = db.getAlerts(25);
      wsApi?.broadcast({ type: "alerts", alerts });
      return { ok: true, alerts };
    },
    dispatchCommand,
    pruneVision: (body = {}) => {
      const minutes = Math.min(1440, Math.max(1, Number(body.retentionMin || 60)));
      db.setJson("vision_retention_min", minutes);
      const removed = db.pruneVisionEvents(minutes);
      db.insertAudit({ origin: "gateway", event_type: "vision_retention", role: normalizeRole(body.role), detail: `${minutes}min` });
      return { ok: true, retentionMin: minutes, removed, visionEvents: db.getVisionEvents(25) };
    },
    nlpLlm,
  }, {
    auth,
    origins: cfg.dashboardOrigins,
    tls: cfg.tlsCert && cfg.tlsKey ? { cert: cfg.tlsCert, key: cfg.tlsKey } : null,
  });

  return {
    cfg,
    db,
    home,
    serial,
    auth,
    cloud,
    mqttHub,
    wsApi,
    dispatchCommand,
    getSnapshot,
    async start() {
      await mqttHub.start();
      await wsApi.start();
      serial.start();
      cloud.start();
      virtualTimer = setInterval(() => {
        if (!lastTelem || Date.now() - lastTelem.receivedAt > 2500) {
          lastVirtual = home.step({}, Date.now(), db.getRules());
          recordHomeEvents(lastVirtual.events);
          mqttHub.publish("elly/appliances", lastVirtual);
          wsApi.broadcast({
            type: "virtual",
            data: lastVirtual,
            serial: serial.getStatus(),
            deviceEnergy: db.getDeviceDailyEnergy(),
          });
        }
      }, 1000);
    },
    async stop() {
      clearInterval(virtualTimer);
      virtualTimer = null;
      serial.stop();
      cloud.stop();
      await wsApi.stop();
      await mqttHub.stop();
      db.close();
    },
  };
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const gw = createGateway();
  await gw.start();
  console.log(
    `[Home Automation Gateway] HTTP/WS on ${gw.cfg.tlsCert ? "https" : "http"}://127.0.0.1:${gw.cfg.httpPort}, MQTT on 127.0.0.1:${gw.cfg.mqttPort}, Serial ${gw.cfg.serialPort}`
  );
  const shutdown = async () => {
    await gw.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
