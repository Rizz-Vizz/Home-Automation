import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { WebSocketServer } from "ws";
import { normalizeRole } from "./hmac.js";

const MAX_BODY = 65536;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      if (tooBig) return;
      raw += chunk;
      if (raw.length > MAX_BODY) {
        tooBig = true;
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export class WsApiServer {
  /* opts = { auth: AuthService, origins: string[], tls?: { cert, key } } */
  constructor(port, handlers, opts) {
    this.port = port;
    this.handlers = handlers;
    this.auth = opts.auth;
    this.origins = new Set(opts.origins || []);
    this.tls = opts.tls || null;
    this.server = null;
    this.wss = null;
    this.scheme = this.tls ? "https" : "http";
  }

  _send(req, res, status, payload) {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    const origin = req.headers.origin;
    if (origin && this.origins.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    }
    res.writeHead(status, headers);
    res.end(status === 204 ? undefined : JSON.stringify(payload));
  }

  _session(req) {
    const h = String(req.headers.authorization || "");
    const m = /^Bearer ([0-9a-f]{64})$/.exec(h);
    return m ? { token: m[1], ...(this.auth.verify(m[1]) || {}) } : null;
  }

  filterSnapshotForRole(snapshot, role) {
    if (!snapshot) return snapshot;
    const r = normalizeRole(role);
    if (r === "owner") return snapshot;

    const filtered = { ...snapshot };

    if (r === "family") {
      filtered.audit = [];
      return filtered;
    }

    if (r === "guest") {
      if (filtered.virtual?.appliances) {
        filtered.virtual = {
          ...filtered.virtual,
          appliances: filtered.virtual.appliances.filter((a) => a.room === "Living Room"),
        };
      }
      filtered.audit = [];
      filtered.visionEvents = [];
      filtered.alerts = [];
      filtered.rules = [];
      if (filtered.deviceEnergy) {
        filtered.deviceEnergy = filtered.deviceEnergy.filter(
          (d) => d.id === "light_hub" || d.id === "plug_tv" || d.id === "lamp_living"
        );
      }
      return filtered;
    }

    return filtered;
  }

  async start() {
    const handler = async (req, res) => {
      const origin = req.headers.origin;
      // Browsers always send Origin on cross-site requests: anything not on the allow-list is refused
      if (origin && !this.origins.has(origin)) {
        this._send(req, res, 403, { ok: false, err: "origin_not_allowed" });
        return;
      }
      if (req.method === "OPTIONS") {
        this._send(req, res, 204, {});
        return;
      }

      const url = new URL(req.url, `${this.scheme}://127.0.0.1:${this.port}`);
      const rawLimit = Number(url.searchParams.get("limit") || 100);
      const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 100;
      const send = (status, payload) => this._send(req, res, status, payload);

      try {
        if (req.method === "GET" && url.pathname === "/api/health") {
          return send(200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/api/login") {
          const body = await readJsonBody(req);
          const result = this.auth.login(String(body.pin ?? ""), req.socket.remoteAddress || "local");
          return send(result.ok ? 200 : result.err === "locked" ? 429 : 401, result);
        }

        const session = this._session(req);
        if (!session?.role) return send(401, { ok: false, err: "auth_required" });
        const role = session.role;

        if (req.method === "POST" && url.pathname === "/api/logout") {
          this.auth.logout(session.token);
          return send(200, { ok: true });
        }
        if (req.method === "GET" && url.pathname === "/api/snapshot") {
          const snap = this.filterSnapshotForRole(this.handlers.getSnapshot(), role);
          return send(200, { ...snap, role });
        }
        if (req.method === "GET" && url.pathname === "/api/telemetry") {
          return send(200, { items: this.handlers.getTelemetry(limit) });
        }
        if (req.method === "GET" && url.pathname === "/api/audit") {
          if (role !== "owner") return send(403, { ok: false, err: "rbac_denied" });
          return send(200, { items: this.handlers.getAudit(limit) });
        }
        if (req.method === "GET" && url.pathname === "/api/alerts") {
          if (role === "guest") return send(403, { ok: false, err: "rbac_denied" });
          return send(200, { items: this.handlers.getAlerts(limit) });
        }
        if (req.method === "GET" && url.pathname === "/api/energy/daily") {
          return send(200, { items: this.handlers.getDailyEnergy() });
        }
        if (req.method === "GET" && url.pathname === "/api/energy/devices") {
          let items = this.handlers.getDeviceEnergy?.() || [];
          if (role === "guest") {
            items = items.filter((d) => d.id === "light_hub" || d.id === "plug_tv" || d.id === "lamp_living");
          }
          return send(200, { items });
        }
        if (req.method === "GET" && url.pathname === "/api/rules") {
          if (role === "guest") return send(403, { ok: false, err: "rbac_denied" });
          return send(200, { items: this.handlers.getRules?.() || [] });
        }
        if (req.method === "POST" && url.pathname === "/api/rules/toggle") {
          if (role === "guest") return send(403, { ok: false, err: "rbac_denied" });
          const body = await readJsonBody(req);
          const result = await this.handlers.toggleRule({ ...body, role });
          return send(result.httpStatus || (result.ok ? 200 : 400), result);
        }
        if (req.method === "GET" && url.pathname === "/api/vision/events") {
          if (role === "guest") return send(403, { ok: false, err: "rbac_denied" });
          return send(200, { items: this.handlers.getVisionEvents?.(limit) || [] });
        }
        if (req.method === "POST" && url.pathname === "/api/vision/event") {
          if (role === "guest") return send(403, { ok: false, err: "rbac_denied" });
          const body = await readJsonBody(req);
          const result = await this.handlers.recordVisionEvent({ ...body, role });
          return send(result.httpStatus || (result.ok ? 200 : 400), result);
        }
        if (req.method === "POST" && url.pathname === "/api/vision/prune") {
          if (role === "guest") return send(403, { ok: false, err: "rbac_denied" });
          const body = await readJsonBody(req);
          return send(200, this.handlers.pruneVision({ ...body, role }));
        }
        if (req.method === "POST" && url.pathname === "/api/alerts/ack") {
          if (role === "guest") return send(403, { ok: false, err: "rbac_denied" });
          return send(200, this.handlers.ackAlerts());
        }
        if (req.method === "POST" && url.pathname === "/api/nlp") {
          const body = await readJsonBody(req);
          return send(200, await this.handlers.nlpLlm(String(body.text ?? ""), role));
        }
        if (req.method === "POST" && url.pathname === "/api/cmd") {
          const body = await readJsonBody(req);
          // The role is always the session's role, whatever the body says
          const result = await this.handlers.dispatchCommand({ ...body, role });
          return send(result.httpStatus || (result.ok ? 200 : 400), result);
        }
        return send(404, { ok: false, err: "not_found" });
      } catch (err) {
        send(500, { ok: false, err: err.message });
      }
    };

    this.server = this.tls
      ? https.createServer({ cert: fs.readFileSync(this.tls.cert), key: fs.readFileSync(this.tls.key) }, handler)
      : http.createServer(handler);

    this.wss = new WebSocketServer({
      server: this.server,
      path: "/ws",
      verifyClient: (info) => !info.origin || this.origins.has(info.origin),
    });
    this.wss.on("connection", (ws) => {
      ws.ellyRole = null;
      // First message must be {type:"auth", token}; nothing is sent before that
      const authTimer = setTimeout(() => {
        if (!ws.ellyRole) ws.close(4401, "auth_timeout");
      }, 3000);
      ws.on("close", () => clearTimeout(authTimer));
      ws.on("message", async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString("utf8"));
        } catch {
          ws.send(JSON.stringify({ type: "cmd_result", data: { ok: false, err: "bad_ws_json" } }));
          return;
        }
        if (!ws.ellyRole) {
          const s = msg.type === "auth" ? this.auth.verify(msg.token) : null;
          if (!s) {
            ws.close(4401, "auth_required");
            return;
          }
          ws.ellyRole = s.role;
          ws.ellyToken = msg.token;
          clearTimeout(authTimer);
          const snap = this.filterSnapshotForRole(this.handlers.getSnapshot(), s.role);
          ws.send(JSON.stringify({ type: "snapshot", data: { ...snap, role: s.role } }));
          return;
        }
        // Session may have been logged out or expired since the socket opened
        const still = this.auth.verify(ws.ellyToken);
        if (!still) {
          ws.close(4401, "session_expired");
          return;
        }
        if (msg.type === "cmd") {
          const result = await this.handlers.dispatchCommand({ ...msg, role: still.role });
          ws.send(JSON.stringify({ type: "cmd_result", data: result }));
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
  }

  broadcast(payload) {
    if (!this.wss) return;
    for (const client of this.wss.clients) {
      if (client.readyState === 1 && client.ellyRole) {
        const role = client.ellyRole;
        if (payload.type === "snapshot") {
          const filtered = this.filterSnapshotForRole(payload.data, role);
          client.send(JSON.stringify({ ...payload, data: { ...filtered, role } }));
        } else if (payload.type === "virtual") {
          let vData = payload.data;
          if (role === "guest" && vData?.appliances) {
            vData = {
              ...vData,
              appliances: vData.appliances.filter((a) => a.room === "Living Room"),
            };
          }
          const vMsg = { ...payload, data: vData };
          if (role !== "owner") {
            vMsg.audit = [];
          }
          client.send(JSON.stringify(vMsg));
        } else if (payload.type === "audit") {
          if (role === "owner") {
            client.send(JSON.stringify(payload));
          }
        } else if (payload.type === "vision" || payload.type === "vision_event") {
          if (role !== "guest") {
            client.send(JSON.stringify(payload));
          }
        } else if (payload.type === "rules") {
          if (role !== "guest") {
            const rMsg = { ...payload };
            if (role !== "owner") rMsg.audit = [];
            client.send(JSON.stringify(rMsg));
          }
        } else if (payload.type === "alert" || payload.type === "alerts") {
          if (role !== "guest") {
            client.send(JSON.stringify(payload));
          }
        } else if (payload.type === "flash_id" || payload.type === "can" || payload.type === "backfill") {
          if (role === "owner") {
            client.send(JSON.stringify(payload));
          }
        } else {
          client.send(JSON.stringify(payload));
        }
      }
    }
  }

  async stop() {
    if (this.wss) {
      for (const client of this.wss.clients) client.close();
      await new Promise((resolve) => this.wss.close(resolve));
    }
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}
