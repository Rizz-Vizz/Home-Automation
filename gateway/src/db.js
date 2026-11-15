import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class EllyDatabase {
  constructor(dbPath) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        uptime_ms INTEGER NOT NULL,
        lux REAL,
        temp_c REAL,
        db REAL,
        vib_mg INTEGER,
        power_w REAL,
        pad_temp_c REAL,
        pad_eff_pct REAL,
        edge_mode INTEGER NOT NULL DEFAULT 0,
        safety_latched INTEGER NOT NULL DEFAULT 0,
        safety_reason TEXT DEFAULT 'normal',
        away_armed INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry(ts DESC);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        origin TEXT NOT NULL,
        seq INTEGER DEFAULT 0,
        event_type TEXT NOT NULL,
        role TEXT NOT NULL,
        detail TEXT NOT NULL,
        prev_hash TEXT DEFAULT '',
        entry_hash TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        room TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS energy_daily (
        day TEXT PRIMARY KEY,
        baseline_kwh REAL NOT NULL,
        eco_kwh REAL NOT NULL,
        saved_kwh REAL NOT NULL,
        peak_kw REAL NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS energy_device_daily (
        day TEXT NOT NULL,
        device_id TEXT NOT NULL,
        wh REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, device_id)
      );

      CREATE TABLE IF NOT EXISTS automation_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        condition_type TEXT NOT NULL,
        threshold REAL NOT NULL DEFAULT 0,
        action_desc TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        triggered_count INTEGER NOT NULL DEFAULT 0,
        last_triggered_ts INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cloud_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        summary TEXT NOT NULL,
        motion_score REAL NOT NULL DEFAULT 0,
        privacy_mode INTEGER NOT NULL DEFAULT 0,
        armed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_vision_ts ON vision_events(ts DESC);
    `);
    this._seedDefaultRules();
  }

  _seedDefaultRules() {
    const defaults = [
      ["rule_vacancy", "Vacancy Auto-Off", "no_motion_sec", 1200, "Cut unoccupied room light & fan after 20 minutes without activity (demo timing: 20 s)", 1],
      ["rule_daylight", "Daylight Harvesting", "lux_gt", 75, "Scale down LED PWM brightness when Q2 lux > 75", 1],
      ["rule_coil", "ElectraWireless Coil Thermal Guard", "coil_temp_c", 52, "Latch MCU safety & cut wireless TX coil >= 52C", 1],
      ["rule_overload", "High Kitchen Load Watch", "watts_gt", 1500, "Raise spike alert when circuit draw > 1500W", 1],
      ["rule_intrusion", "Away Intrusion Monitor", "away_motion", 1, "Escalate webcam motion, J11 dock, or clap while Away armed", 1],
      ["rule_night", "Night Comfort Eco", "after_22h", 22, "Prefer quiet Eco cooling & warm dim lighting during Night Mode", 0],
    ];
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO automation_rules
       (id, name, condition_type, threshold, action_desc, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of defaults) {
      stmt.run(...row);
    }
  }

  getJson(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM kv_state WHERE key = ?").get(String(key));
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  setJson(key, val) {
    this.db
      .prepare(
        "INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(String(key), JSON.stringify(val));
  }

  getLastSeq() {
    const row = this.db.prepare("SELECT value FROM kv_state WHERE key = 'last_seq'").get();
    return row ? Number(row.value) : 0;
  }

  setLastSeq(seq) {
    this.db
      .prepare(
        "INSERT INTO kv_state (key, value) VALUES ('last_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(String(seq));
  }

  insertTelemetry(sample) {
    const ts = sample.ts ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO telemetry
         (ts, source, uptime_ms, lux, temp_c, db, vib_mg, power_w, pad_temp_c, pad_eff_pct,
          edge_mode, safety_latched, safety_reason, away_armed, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ts,
        sample.source ?? "live",
        Number(sample.uptime_ms ?? 0),
        Number(sample.lux ?? 0),
        Number(sample.temp_c ?? 0),
        Number(sample.db ?? 0),
        Number(sample.vib_mg ?? 0),
        Number(sample.power_w ?? 0),
        Number(sample.pad_temp_c ?? 0),
        Number(sample.pad_eff_pct ?? 0),
        sample.edge_mode ? 1 : 0,
        sample.safety_latched ? 1 : 0,
        String(sample.safety_reason ?? "normal"),
        sample.away_armed ? 1 : 0,
        sample.raw_json ?? null
      );

    this._accumulateDailyEnergy(ts, Number(sample.power_w ?? 0), Number(sample.saved_watts ?? 0));
    this._accumulateDeviceEnergy(ts, sample.deviceWatts);
  }

  _accumulateDeviceEnergy(ts, deviceWatts) {
    if (!deviceWatts || typeof deviceWatts !== "object") return;
    const day = new Date(ts).toISOString().slice(0, 10);
    const stmt = this.db.prepare(
      `INSERT INTO energy_device_daily (day, device_id, wh)
       VALUES (?, ?, ?)
       ON CONFLICT(day, device_id) DO UPDATE SET wh = wh + excluded.wh`
    );
    for (const [devId, watts] of Object.entries(deviceWatts)) {
      const w = Number(watts);
      if (!Number.isFinite(w) || w <= 0) continue;
      stmt.run(day, devId, w / 3600);
    }
  }

  _accumulateDailyEnergy(ts, powerW, savedW = 0) {
    if (!Number.isFinite(powerW) || powerW < 0) return;
    const day = new Date(ts).toISOString().slice(0, 10);
    const deltaKwh = (powerW / 1000) * (1 / 3600);
    const savedKwh = Math.max(0, (Number(savedW) || 0) / 1000) * (1 / 3600);
    const baselineKwh = deltaKwh + savedKwh;
    const peakKw = powerW / 1000;

    this.db
      .prepare(
        `INSERT INTO energy_daily (day, baseline_kwh, eco_kwh, saved_kwh, peak_kw, sample_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(day) DO UPDATE SET
           baseline_kwh = baseline_kwh + excluded.baseline_kwh,
           eco_kwh = eco_kwh + excluded.eco_kwh,
           saved_kwh = saved_kwh + excluded.saved_kwh,
           peak_kw = MAX(peak_kw, excluded.peak_kw),
           sample_count = sample_count + 1`
      )
      .run(day, baselineKwh, deltaKwh, savedKwh, peakKw);
  }

  insertAudit(entry) {
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, origin, seq, event_type, role, detail, prev_hash, entry_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.ts ?? Date.now(),
        entry.origin ?? "gateway",
        Number(entry.seq ?? 0),
        String(entry.event_type ?? "cmd"),
        String(entry.role ?? "owner"),
        String(entry.detail ?? ""),
        String(entry.prev_hash ?? ""),
        String(entry.entry_hash ?? "")
      );
  }

  insertAlert(alert) {
    this.db
      .prepare(
        `INSERT INTO alerts (ts, category, severity, room, title, detail, acknowledged)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        alert.ts ?? Date.now(),
        String(alert.category ?? "system"),
        String(alert.severity ?? "warning"),
        String(alert.room ?? "Hub"),
        String(alert.title ?? "Alert"),
        String(alert.detail ?? "")
      );
  }

  acknowledgeAlerts() {
    this.db.prepare("UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0").run();
  }

  getRecentTelemetry(limit = 120) {
    return this.db
      .prepare("SELECT * FROM telemetry ORDER BY id DESC LIMIT ?")
      .all(Number(limit))
      .reverse();
  }

  getAuditLogs(limit = 60) {
    return this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(Number(limit));
  }

  getAlerts(limit = 30) {
    return this.db.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(Number(limit));
  }

  getDailyEnergy(limit = 7) {
    return this.db.prepare("SELECT * FROM energy_daily ORDER BY day DESC LIMIT ?").all(Number(limit)).reverse();
  }

  getDeviceDailyEnergy(day = new Date().toISOString().slice(0, 10)) {
    return this.db
      .prepare("SELECT device_id, wh FROM energy_device_daily WHERE day = ? ORDER BY wh DESC")
      .all(String(day));
  }

  getRules() {
    return this.db.prepare("SELECT * FROM automation_rules ORDER BY rowid ASC").all();
  }

  toggleRule(id, enabled) {
    this.db
      .prepare("UPDATE automation_rules SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, String(id));
    return this.getRules();
  }

  setRuleThreshold(id, threshold) {
    this.db.prepare("UPDATE automation_rules SET threshold = ? WHERE id = ?").run(Number(threshold), String(id));
  }

  enqueueCloud(kind, payload) {
    this.db
      .prepare("INSERT INTO cloud_outbox (ts, kind, payload) VALUES (?, ?, ?)")
      .run(Date.now(), String(kind), JSON.stringify(payload));
    // bounded queue: keep the newest 5000 rows while offline
    this.db.prepare("DELETE FROM cloud_outbox WHERE id <= (SELECT MAX(id) - 5000 FROM cloud_outbox)").run();
  }

  peekCloudOutbox(limit = 50) {
    return this.db.prepare("SELECT * FROM cloud_outbox ORDER BY id ASC LIMIT ?").all(limit);
  }

  dropCloudOutboxUpTo(id) {
    this.db.prepare("DELETE FROM cloud_outbox WHERE id <= ?").run(Number(id));
  }

  cloudOutboxSize() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get().n;
  }

  touchRuleTrigger(id) {
    this.db
      .prepare(
        "UPDATE automation_rules SET triggered_count = triggered_count + 1, last_triggered_ts = ? WHERE id = ?"
      )
      .run(Date.now(), String(id));
  }

  insertVisionEvent(evt, retentionMinutes = 60) {
    const now = evt.ts ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO vision_events (ts, summary, motion_score, privacy_mode, armed)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        now,
        String(evt.summary ?? "Motion detected"),
        Number(evt.motion_score ?? 0),
        evt.privacy_mode ? 1 : 0,
        evt.armed ? 1 : 0
      );
    const cutoff = now - Math.max(1, Number(retentionMinutes)) * 60 * 1000;
    this.db.prepare("DELETE FROM vision_events WHERE ts < ?").run(cutoff);
  }

  pruneVisionEvents(retentionMinutes) {
    const cutoff = Date.now() - Math.max(1, Number(retentionMinutes)) * 60 * 1000;
    return this.db.prepare("DELETE FROM vision_events WHERE ts < ?").run(cutoff).changes;
  }

  getVisionEvents(limit = 25) {
    return this.db.prepare("SELECT * FROM vision_events ORDER BY id DESC LIMIT ?").all(Number(limit));
  }

  close() {
    this.db.close();
  }
}
