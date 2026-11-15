import crypto from "node:crypto";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* PIN login -> random bearer token held in memory. The role comes from the session, never from the request. */
export class AuthService {
  constructor(pins) {
    this.pins = pins;
    this.sessions = new Map();
    this.fails = new Map();
  }

  login(pin, remote = "local") {
    const f = this.fails.get(remote) || { n: 0, until: 0 };
    if (Date.now() < f.until) return { ok: false, err: "locked", retryMs: f.until - Date.now() };

    let role = null;
    for (const r of ["owner", "family", "guest"]) {
      if (safeEqual(pin ?? "", this.pins[r])) role = r;
    }
    if (!role) {
      f.n += 1;
      if (f.n >= MAX_FAILS) {
        f.until = Date.now() + LOCK_MS;
        f.n = 0;
      }
      this.fails.set(remote, f);
      return { ok: false, err: "bad_pin" };
    }
    this.fails.delete(remote);
    const token = crypto.randomBytes(32).toString("hex");
    this.sessions.set(token, { role, expires: Date.now() + SESSION_TTL_MS });
    return { ok: true, token, role };
  }

  verify(token) {
    const s = this.sessions.get(String(token || ""));
    if (!s) return null;
    if (Date.now() > s.expires) {
      this.sessions.delete(token);
      return null;
    }
    return { role: s.role };
  }

  logout(token) {
    this.sessions.delete(String(token || ""));
  }
}
