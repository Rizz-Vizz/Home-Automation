import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Fan, Flame, Home, Lightbulb, Plug, Snowflake, Wifi, X } from "lucide-react";

const ROOM_ORDER = ["Living Room", "Bedroom", "Kitchen", "Office"];

const RGB_PRESETS = [
  { label: "Warm", rgb: "90,52,18", swatch: "#f59e0b" },
  { label: "Day", rgb: "80,85,85", swatch: "#e5e7eb" },
  { label: "Cyan", rgb: "0,75,95", swatch: "#38bdf8" },
  { label: "Green", rgb: "0,90,30", swatch: "#22c55e" },
  { label: "Amber", rgb: "95,38,0", swatch: "#d97706" },
];

const GUEST_ALLOWED_DEVICES = new Set(["light_hub", "plug_tv", "lamp_living", "lamp_bed"]);

function DeviceIcon({ kind, on }) {
  const color = on ? undefined : "var(--dim)";
  if (kind === "light") return <Lightbulb size={14} color={on ? "#fbbf24" : color} />;
  if (kind === "climate") return <Snowflake size={14} color={on ? "#38bdf8" : color} />;
  if (kind === "fan") return <Fan size={14} color={on ? "#22c55e" : color} />;
  if (kind === "plug") return <Plug size={14} color={on ? "#22c55e" : color} />;
  if (kind === "wireless_power") return <Wifi size={14} color={on ? "#4f8ef7" : color} />;
  return null;
}

export function RoomGrid({ snapshot, role, onAction }) {
  const [dimPct, setDimPct] = useState(80);
  const [selectedDevId, setSelectedDevId] = useState(null);
  const [showSecondary, setShowSecondary] = useState(false);

  const appliances = snapshot?.virtual?.appliances || [];
  const rules = snapshot?.rules || [];
  const telem = snapshot?.telem;

  useEffect(() => {
    if (typeof telem?.light_pct === "number" && telem.light) {
      setDimPct(telem.light_pct);
    }
  }, [telem?.light_pct, telem?.light]);

  const selectedDev = appliances.find((d) => d.id === selectedDevId) || null;
  const acDev = appliances.find((d) => d.id === "ac_living");
  const isGuest = role === "guest";
  const hardwareLocked = Boolean(telem?.safety || telem?.away);

  const grouped = ROOM_ORDER.map((room) => ({
    room,
    items: appliances.filter((d) => d.room === room),
  }));

  function handleDeviceToggle(dev) {
    const targetCmd = dev.hwSynced || dev.id;
    onAction(targetCmd, dev.on ? "off" : "on");
  }

  function updateAcConfig(patch) {
    if (!acDev) return;
    onAction(
      "ac_config",
      JSON.stringify({
        on: patch.on ?? acDev.on,
        targetC: patch.targetC ?? acDev.targetC ?? 24,
        fanSpeed: patch.fanSpeed ?? acDev.fanSpeed ?? "auto",
        acMode: patch.acMode ?? acDev.acMode ?? "cool",
      })
    );
  }

  return (
    <section className="panel">
      <div className="section-head">
        <h2>
          <Home size={15} /> Rooms &amp; Devices
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {appliances.length > 0 && (
            <span className="section-sub">
              {appliances.filter((d) => d.on).length} of {appliances.length} active
            </span>
          )}
          {!isGuest && (
            <button
              className="btn"
              style={{ padding: "3px 8px", fontSize: "0.72rem" }}
              onClick={() => setShowSecondary((v) => !v)}
            >
              {showSecondary ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {showSecondary ? "Standard View" : "Show All Plugs"}
            </button>
          )}
        </div>
      </div>

      <div className="rooms-grid">
        {grouped.map(({ room, items }) => {
          // Filter items based on role and secondary toggle
          const visibleItems = items.filter((d) => {
            if (isGuest) {
              return GUEST_ALLOWED_DEVICES.has(d.id);
            }
            if (!showSecondary) {
              // Hide minor secondary background plugs in standard view
              if (["lamp_living", "lamp_bed", "plug_kettle", "plug_desk"].includes(d.id)) {
                return false;
              }
            }
            return true;
          });

          if (visibleItems.length === 0) return null;

          const activeItems = visibleItems.filter((d) => d.on).length;
          const roomWatts = visibleItems.reduce((acc, d) => acc + Number(d.currentWatts || 0), 0);
          const canToggleRoom = !isGuest && !telem?.safety;
          const controllableActive = visibleItems.some((d) => d.id !== "fridge" && d.on);

          return (
            <div className="room-card" key={room}>
              {/* Room Header */}
              <div className="room-head">
                <div className="room-head-info">
                  <div className="room-name">{room}</div>
                  <div className="room-meta">
                    {activeItems}/{visibleItems.length} on &middot; {roomWatts.toFixed(0)} W
                  </div>
                </div>
                {canToggleRoom && (
                  <button
                    className="btn"
                    style={{ padding: "3px 9px", fontSize: "0.73rem" }}
                    onClick={() => onAction("room_toggle", `${room}:${controllableActive ? "off" : "on"}`)}
                  >
                    {controllableActive ? "All Off" : "All On"}
                  </button>
                )}
              </div>

              {/* Device List */}
              <div className="device-list">
                {visibleItems.map((dev) => {
                  const isDeviceLocked =
                    (isGuest && !GUEST_ALLOWED_DEVICES.has(dev.id)) ||
                    dev.id === "fridge" ||
                    (dev.hwSynced && hardwareLocked);

                  return (
                    <div className="device-row" key={dev.id}>
                      <div className="device-left">
                        <span className="device-icon">
                          <DeviceIcon kind={dev.kind} on={dev.on} />
                        </span>
                        <span
                          className="device-name"
                          title={dev.name}
                          style={{ cursor: "pointer", color: dev.on ? "var(--text)" : "var(--muted)" }}
                          onClick={() => setSelectedDevId(dev.id)}
                        >
                          {dev.name}
                        </span>
                      </div>

                      <div className="device-right">
                        <span className="device-watts">
                          {dev.currentWatts || 0} W
                        </span>

                        {dev.id === "fridge" ? (
                          <span
                            className="badge"
                            style={{
                              fontSize: "0.7rem",
                              color: dev.doorOpen ? "var(--red)" : "var(--dim)",
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                              padding: "2px 6px"
                            }}
                          >
                            {dev.doorOpen ? "Open" : "Closed"}
                          </span>
                        ) : (
                          <button
                            role="switch"
                            aria-checked={Boolean(dev.on)}
                            aria-label={`Toggle ${dev.name}`}
                            className={`switch ${dev.on ? "on" : ""}`}
                            disabled={Boolean(isDeviceLocked)}
                            onClick={() => handleDeviceToggle(dev)}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Living Room Sub-Controls: Dimmer & RGB (Owner / Family only) */}
              {room === "Living Room" && !isGuest && (
                <div className="room-controls">
                  <div className="ctrl-row">
                    <span className="ctrl-label">
                      Dimmer <strong>{dimPct}%</strong>
                    </span>
                    <div className="ctrl-inline">
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={dimPct}
                        disabled={hardwareLocked}
                        onChange={(e) => setDimPct(Number(e.target.value))}
                        style={{ width: 88 }}
                      />
                      <button
                        className="btn"
                        style={{ padding: "2px 8px", fontSize: "0.72rem" }}
                        disabled={hardwareLocked}
                        onClick={() => onAction("light", String(dimPct))}
                      >
                        Set
                      </button>
                    </div>
                  </div>

                  <div className="ctrl-row">
                    <span className="ctrl-label">Color</span>
                    <div className="rgb-swatch">
                      {RGB_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          className="swatch-btn"
                          disabled={hardwareLocked}
                          onClick={() => onAction("rgb", p.rgb)}
                        >
                          <span className="swatch-dot" style={{ background: p.swatch }} />
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Bedroom Sub-Controls: AC Thermostat (Owner / Family only) */}
              {room === "Bedroom" && !isGuest && acDev && (
                <div className="room-controls">
                  <div className="ctrl-row">
                    <span className="ctrl-label">
                      AC Thermostat <strong className="mono">{acDev.targetC ?? 24}°C</strong>
                    </span>
                    <div className="ac-controls">
                      <button
                        className="ac-btn"
                        disabled={hardwareLocked}
                        onClick={() => updateAcConfig({ targetC: Math.max(16, (acDev.targetC ?? 24) - 1) })}
                      >
                        -1°C
                      </button>
                      <button
                        className="ac-btn"
                        disabled={hardwareLocked}
                        onClick={() => updateAcConfig({ targetC: Math.min(30, (acDev.targetC ?? 24) + 1) })}
                      >
                        +1°C
                      </button>
                      {["cool", "eco", "fan"].map((mode) => (
                        <button
                          key={mode}
                          className={`ac-btn ${acDev.acMode === mode ? "active" : ""}`}
                          disabled={hardwareLocked}
                          onClick={() => updateAcConfig({ acMode: mode })}
                        >
                          {mode.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Office Sub-Controls: Wireless Power Pad Status */}
              {room === "Office" && (
                <div className="thermal-note">
                  <Flame
                    size={12}
                    color={snapshot?.virtual?.padTempC >= 48 ? "#ef4444" : "#22c55e"}
                  />
                  ElectraWireless Pad · Thermal Guard active (&ge; 52°C cutoff)
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Device Detail Modal */}
      {selectedDev && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setSelectedDevId(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="section-head" style={{ marginBottom: 12 }}>
              <h2>{selectedDev.name}</h2>
              <button className="btn icon-btn" onClick={() => setSelectedDevId(null)}>
                <X size={14} />
              </button>
            </div>
            <div style={{ fontSize: "0.82rem", display: "grid", gap: 9, color: "var(--muted)" }}>
              <div>
                <strong style={{ color: "var(--text)" }}>Room &amp; Status:</strong> {selectedDev.room} &middot;{" "}
                {selectedDev.on ? "Active" : "Standby"} ({selectedDev.currentWatts || 0} W)
              </div>
              <div>
                <strong style={{ color: "var(--text)" }}>Device Type:</strong>{" "}
                {selectedDev.provenance === "hardware"
                  ? "Physical FRDM-MCXN236 Actuator (RGB CTIMER3)"
                  : "Gateway Software Digital Twin"}
              </div>
              <div>
                <strong style={{ color: "var(--text)" }}>Access:</strong> Allowed for{" "}
                {(selectedDev.assignedUsers || []).join(", ")}
              </div>
              <div>
                <strong style={{ color: "var(--text)" }}>Automation:</strong>{" "}
                {(selectedDev.linkedRules || []).length === 0
                  ? "Manual switch only"
                  : selectedDev.linkedRules
                      .map((rid) => rules.find((r) => r.id === rid)?.name || rid)
                      .join(", ")}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
