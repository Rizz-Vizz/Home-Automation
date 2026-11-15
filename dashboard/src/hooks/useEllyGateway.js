import { useCallback, useEffect, useRef, useState } from "react";

const GATEWAY_HTTP = (import.meta.env.VITE_GATEWAY_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const GATEWAY_WS = GATEWAY_HTTP.replace(/^http/, "ws") + "/ws";

const SESSION_KEY = "elly_session";

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function useEllyGateway() {
  const [session, setSession] = useState(loadSession);
  const role = session?.role ?? null;
  const token = session?.token ?? null;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [loginError, setLoginError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [liveSeries, setLiveSeries] = useState([]);
  const [toast, setToast] = useState(null);
  const wsRef = useRef(null);

  const pushPoint = useCallback((telem, virtual) => {
    const point = {
      ts: Date.now(),
      powerW: Number(virtual?.totalWatts ?? 0),
      padTempC: Number(virtual?.padTempC ?? 0),
      lux: telem ? Number(telem.lux ?? 0) : null,
      tempC: telem ? Number(telem.temp_c ?? 0) : null,
      db: telem ? Number(telem.db ?? 0) : null,
    };
    setLiveSeries((prev) => [...prev.slice(-59), point]);
  }, []);

  const endSession = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
    setSnapshot(null);
  }, []);

  /* Every API call carries the bearer token. A 401 means the session ended. */
  const api = useCallback(
    async (path, { method = "GET", body } = {}) => {
      const res = await fetch(`${GATEWAY_HTTP}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && path !== "/api/login") endSession();
      return res;
    },
    [endSession]
  );

  const login = useCallback(async (pin) => {
    setLoginError(null);
    try {
      const res = await fetch(`${GATEWAY_HTTP}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setLoginError(data.err === "locked" ? "Too many attempts. Wait a minute." : "Wrong PIN");
        return false;
      }
      const next = { token: data.token, role: data.role };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      setSession(next);
      return true;
    } catch {
      setLoginError("Gateway unreachable");
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/api/logout", { method: "POST", body: {} });
    } catch {
      // gateway offline, session is dropped locally anyway
    }
    endSession();
  }, [api, endSession]);

  const refreshSnapshot = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const res = await api("/api/snapshot");
      if (!res.ok) return;
      const data = await res.json();
      setSnapshot(data);
      if (Array.isArray(data.telemetryHistory) && data.telemetryHistory.length > 0) {
        setLiveSeries(
          data.telemetryHistory.slice(-60).map((row) => ({
            ts: row.ts,
            powerW: Number(row.power_w ?? 0),
            padTempC: Number(row.pad_temp_c ?? 0),
            lux: Number(row.lux ?? 0),
            tempC: Number(row.temp_c ?? 0),
            db: Number(row.db ?? 0),
          }))
        );
      }
    } catch {
      // Gateway offline; WS reconnect loop handles recovery
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer = null;

    if (!token) {
      setConnected(false);
      return undefined;
    }
    refreshSnapshot();

    function connectWs() {
      if (cancelled) return;
      const ws = new WebSocket(GATEWAY_WS);
      wsRef.current = ws;

      ws.onopen = () => {
        // the gateway says nothing until it has seen a valid session token
        ws.send(JSON.stringify({ type: "auth", token }));
        setConnected(true);
      };
      ws.onclose = (evt) => {
        setConnected(false);
        if (evt.code === 4401) {
          if (!cancelled) endSession();
          return;
        }
        if (!cancelled) {
          reconnectTimer = setTimeout(connectWs, 2000);
        }
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "snapshot") {
            setSnapshot(msg.data);
          } else if (msg.type === "serial_status") {
            setSnapshot((prev) => (prev ? { ...prev, serial: msg.data } : prev));
          } else if (msg.type === "boot" || msg.type === "flash_id" || msg.type === "can") {
            setSnapshot((prev) => (prev ? { ...prev, mcuInfo: msg.mcuInfo } : prev));
          } else if (msg.type === "telem") {
            setSnapshot((prev) =>
              prev
                ? {
                    ...prev,
                    telem: msg.data.telem,
                    virtual: msg.data.virtual,
                    mcuInfo: msg.data.mcuInfo,
                    deviceEnergy: msg.data.deviceEnergy || prev.deviceEnergy,
                    rules: msg.data.rules || prev.rules,
                    cloudOnline: msg.data.cloudOnline ?? prev.cloudOnline,
                    cloud: msg.data.cloud || prev.cloud,
                    mqttPublished: msg.data.mqttPublished ?? prev.mqttPublished,
                  }
                : prev
            );
            pushPoint(msg.data.telem, msg.data.virtual);
          } else if (msg.type === "virtual") {
            setSnapshot((prev) =>
              prev
                ? {
                    ...prev,
                    virtual: msg.data,
                    serial: msg.serial || prev.serial,
                    audit: msg.audit || prev.audit,
                    deviceEnergy: msg.deviceEnergy || prev.deviceEnergy,
                  }
                : prev
            );
            pushPoint(null, msg.data);
          } else if (msg.type === "rules") {
            setSnapshot((prev) =>
              prev
                ? {
                    ...prev,
                    rules: msg.rules || prev.rules,
                    virtual: msg.virtual || prev.virtual,
                    audit: msg.audit || prev.audit,
                  }
                : prev
            );
          } else if (msg.type === "vision") {
            setSnapshot((prev) => (prev ? { ...prev, visionEvents: msg.visionEvents || prev.visionEvents } : prev));
          } else if (msg.type === "cloud_status") {
            setSnapshot((prev) =>
              prev
                ? {
                    ...prev,
                    cloudOnline: msg.cloudOnline ?? prev.cloudOnline,
                    cloud: msg.cloud || prev.cloud,
                    audit: msg.audit || prev.audit,
                  }
                : prev
            );
          } else if (msg.type === "audit") {
            setSnapshot((prev) => (prev ? { ...prev, audit: msg.audit || prev.audit } : prev));
          } else if (msg.type === "alert" || msg.type === "alerts") {
            setSnapshot((prev) =>
              prev
                ? {
                    ...prev,
                    alerts: msg.alerts || prev.alerts,
                    visionEvents: msg.visionEvents || prev.visionEvents,
                    rules: msg.rules || prev.rules,
                  }
                : prev
            );
          } else if (msg.type === "backfill") {
            setSnapshot((prev) => {
              if (!prev) return prev;
              const rec = msg.data ? { source: "backfill", ts: Date.now(), ...msg.data } : null;
              const nextHist = rec ? [...(prev.telemetryHistory || []), rec].slice(-90) : prev.telemetryHistory;
              return {
                ...prev,
                backfillTotal: msg.backfillTotal ?? (prev.backfillTotal || 0) + 1,
                telemetryHistory: nextHist,
              };
            });
          } else if (msg.type === "ack" && msg.data?.ok === false) {
            setToast({ ok: false, text: `MCU rejected ${msg.data.cmd}: ${msg.data.err}` });
          }
        } catch {
          // Ignore malformed WS frames
        }
      };
    }

    connectWs();
    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [token, pushPoint, refreshSnapshot, endSession]);

  const sendCommand = useCallback(
    async (cmd, arg = "") => {
      try {
        const res = await api("/api/cmd", { method: "POST", body: { cmd, arg } });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setToast({
            ok: false,
            text: data.detail || `${cmd} blocked (${data.err || res.status})`,
          });
        } else {
          setToast({ ok: true, text: `Executed ${cmd}${arg ? ` (${arg})` : ""} as ${role}` });
          if (data.virtual) {
            setSnapshot((prev) => (prev ? { ...prev, virtual: data.virtual } : prev));
          }
        }
        return data;
      } catch (err) {
        setToast({ ok: false, text: `Gateway unreachable: ${err.message}` });
        return { ok: false, err: err.message };
      }
    },
    [api, role]
  );

  const ackAlerts = useCallback(async () => {
    try {
      await api("/api/alerts/ack", { method: "POST", body: {} });
    } catch {
      // Ignore offline ack
    }
  }, [api]);

  const toggleRule = useCallback(
    async (id, enabled) => {
      try {
        const res = await api("/api/rules/toggle", { method: "POST", body: { id, enabled } });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setToast({ ok: false, text: `Rule toggle blocked (${data.err || res.status}) for ${role}` });
        } else {
          setSnapshot((prev) => (prev ? { ...prev, rules: data.rules } : prev));
          setToast({ ok: true, text: `Rule ${id} ${enabled ? "enabled" : "disabled"}` });
        }
        return data;
      } catch (err) {
        setToast({ ok: false, text: `Gateway unreachable: ${err.message}` });
        return { ok: false, err: err.message };
      }
    },
    [api, role]
  );

  const postVisionEvent = useCallback(async (payload) => {
    try {
      const res = await api("/api/vision/event", { method: "POST", body: payload });
      const data = await res.json();
      if (data.ok && data.visionEvents) {
        setSnapshot((prev) => (prev ? { ...prev, visionEvents: data.visionEvents } : prev));
      }
      return data;
    } catch {
      return { ok: false };
    }
  }, [api]);

  const pruneVision = useCallback(
    async (retentionMin) => {
      try {
        const res = await api("/api/vision/prune", { method: "POST", body: { retentionMin } });
        const data = await res.json();
        if (data.ok && data.visionEvents) {
          setSnapshot((prev) => (prev ? { ...prev, visionEvents: data.visionEvents } : prev));
        }
        return data;
      } catch {
        return { ok: false };
      }
    },
    [api]
  );

  const askLlm = useCallback(
    async (text) => {
      try {
        const res = await api("/api/nlp", { method: "POST", body: { text } });
        return await res.json();
      } catch {
        return { ok: false };
      }
    },
    [api]
  );

  return {
    role,
    login,
    logout,
    loginError,
    pruneVision,
    askLlm,
    connected,
    snapshot,
    liveSeries,
    toast,
    clearToast: () => setToast(null),
    sendCommand,
    toggleRule,
    postVisionEvent,
    ackAlerts,
    refreshSnapshot,
  };
}
