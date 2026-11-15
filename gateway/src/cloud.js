/*
 * Optional cloud mirror: every interval, a small aggregate summary (never raw camera/mic data) is
 * queued in SQLite and POSTed to CLOUD_SYNC_URL. While the internet or the toggle is off, rows
 * stay queued and flush in order when it returns. Point it at any HTTPS ingest endpoint
 * (API Gateway, Azure Function, Cloud Run). tools/mock_cloud.mjs is a local receiver for demos.
 */
export class CloudSync {
  constructor({ url, token, intervalMs, db, getSummary, onChange }) {
    this.url = url;
    this.token = token;
    this.intervalMs = intervalMs;
    this.db = db;
    this.getSummary = getSummary;
    this.onChange = onChange;
    this.enabled = true;
    this.online = false;
    this.lastOkTs = 0;
    this.lastError = null;
    this.timer = null;
    this.busy = false;
  }

  get configured() {
    return Boolean(this.url);
  }

  start() {
    if (!this.configured || this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled) this.online = false;
    this.onChange?.(this.status());
  }

  status() {
    return {
      configured: this.configured,
      enabled: this.enabled,
      online: this.configured && this.enabled && this.online,
      queued: this.configured ? this.db.cloudOutboxSize() : 0,
      lastOkTs: this.lastOkTs,
      lastError: this.lastError,
    };
  }

  async tick() {
    if (!this.configured || this.busy) return;
    this.busy = true;
    try {
      this.db.enqueueCloud("summary", this.getSummary());
      if (!this.enabled) return;
      while (true) {
        const rows = this.db.peekCloudOutbox(50);
        if (rows.length === 0) break;
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ items: rows.map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload) })) }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`cloud HTTP ${res.status}`);
        this.db.dropCloudOutboxUpTo(rows[rows.length - 1].id);
        this.online = true;
        this.lastOkTs = Date.now();
        this.lastError = null;
        if (rows.length < 50) break;
      }
    } catch (err) {
      this.online = false;
      this.lastError = err.message;
    } finally {
      this.busy = false;
      this.onChange?.(this.status());
    }
  }
}
