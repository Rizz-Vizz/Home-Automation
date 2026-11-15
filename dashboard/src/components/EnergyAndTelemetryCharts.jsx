import { useState } from "react";
import { AlertCircle, BarChart3, CheckCircle2, TrendingUp } from "lucide-react";

function TelemetryChart({ series, chartMode }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  if (!series || series.length < 2) {
    return (
      <div style={{ height: 185, display: "grid", placeItems: "center", color: "var(--dim)", fontSize: "0.82rem" }}>
        Waiting for live telemetry stream...
      </div>
    );
  }

  const w = 540;
  const h = 175;
  const padL = 42;
  const padR = 12;
  const padT = 14;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const isPower = chartMode === "power";
  const maxY = isPower
    ? Math.max(300, ...series.map((p) => p.powerW || 0))
    : Math.max(100, ...series.map((p) => Math.max(p.lux || 0, p.db || 0, p.tempC || 0)));

  const xAt = (i) => padL + (i / Math.max(1, series.length - 1)) * plotW;
  const yAt = (val, ceiling) => padT + plotH - (Math.min(ceiling, Math.max(0, val || 0)) / ceiling) * plotH;

  const primaryPts = series
    .map((p, i) => `${xAt(i).toFixed(1)},${yAt(isPower ? p.powerW : p.lux, maxY).toFixed(1)}`)
    .join(" ");

  const secondaryPts = series
    .map((p, i) => `${xAt(i).toFixed(1)},${yAt(isPower ? p.padTempC : p.db, isPower ? 70 : maxY).toFixed(1)}`)
    .join(" ");

  const activePoint = hoverIdx !== null && series[hoverIdx] ? series[hoverIdx] : series[series.length - 1];

  return (
    <div>
      <div
        className="mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.73rem",
          color: "var(--muted)",
          marginBottom: 6,
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <span>{activePoint?.ts ? new Date(activePoint.ts).toLocaleTimeString() : "--"}</span>
        {isPower ? (
          <span>
            <span style={{ color: "#22c55e" }}>Load {Number(activePoint.powerW || 0).toFixed(1)} W</span> ·{" "}
            <span style={{ color: "#f59e0b" }}>Coil {Number(activePoint.padTempC || 0).toFixed(1)} C</span>
          </span>
        ) : (
          <span>
            <span style={{ color: "#38bdf8" }}>Q2 {Number(activePoint.lux || 0).toFixed(1)} idx</span> ·{" "}
            <span style={{ color: "#22c55e" }}>U7 {Number(activePoint.db || 0).toFixed(1)} rel dB</span> ·{" "}
            <span>Die {Number(activePoint.tempC || 0).toFixed(1)} C</span>
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        style={{ width: "100%", height: 185, background: "#0b0c0f", borderRadius: 8, border: "1px solid var(--border)" }}
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * w;
          const idx = Math.round(((relX - padL) / plotW) * (series.length - 1));
          setHoverIdx(Math.max(0, Math.min(series.length - 1, idx)));
        }}
      >
        {[0, 0.5, 1].map((frac) => {
          const y = padT + plotH * (1 - frac);
          const label = Math.round(maxY * frac);
          return (
            <g key={frac}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#20232b" strokeDasharray="3 3" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="9.5" fill="#6b7280">
                {label}
              </text>
            </g>
          );
        })}

        <polyline fill="none" stroke={isPower ? "#22c55e" : "#38bdf8"} strokeWidth="2" points={primaryPts} />
        <polyline
          fill="none"
          stroke={isPower ? "#f59e0b" : "#22c55e"}
          strokeWidth="1.6"
          strokeDasharray={isPower ? "4 3" : "0"}
          points={secondaryPts}
        />

        {hoverIdx !== null && (
          <line
            x1={xAt(hoverIdx)}
            y1={padT}
            x2={xAt(hoverIdx)}
            y2={padT + plotH}
            stroke="#52525b"
            strokeWidth="1"
          />
        )}
      </svg>
    </div>
  );
}

export function EnergyAndTelemetryCharts({ snapshot, liveSeries, onAckAlerts, showAnalytics = true }) {
  const [chartMode, setChartMode] = useState("power");
  const [energyTab, setEnergyTab] = useState("daily");
  const daily = snapshot?.dailyEnergy || [];
  const alerts = snapshot?.alerts || [];
  const appliances = snapshot?.virtual?.appliances || [];
  const deviceEnergy = snapshot?.deviceEnergy || [];

  const whMap = new Map(deviceEnergy.map((row) => [row.device_id, Number(row.wh || 0)]));
  const ranking = appliances
    .map((dev) => ({
      id: dev.id,
      name: dev.name,
      provenance: dev.provenance,
      wh: whMap.get(dev.id) || 0,
      liveW: Number(dev.currentWatts || 0),
    }))
    .sort((a, b) => (b.wh !== a.wh ? b.wh - a.wh : b.liveW - a.liveW))
    .slice(0, 6);

  const maxRankVal = Math.max(0.01, ...ranking.map((r) => (r.wh > 0 ? r.wh : r.liveW)));

  const weeklyTotals = daily.reduce(
    (acc, d) => ({
      usedWh: acc.usedWh + d.eco_kwh * 1000,
      savedWh: acc.savedWh + d.saved_kwh * 1000,
      peakW: Math.max(acc.peakW, d.peak_kw * 1000),
      days: acc.days + 1,
    }),
    { usedWh: 0, savedWh: 0, peakW: 0, days: 0 }
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="panel">
        <div className="section-head">
          <h2>
            <TrendingUp size={15} /> Live Telemetry Trend
          </h2>
          <div className="seg-tabs">
            <button
              className={`role-btn ${chartMode === "power" ? "active" : ""}`}
              onClick={() => setChartMode("power")}
            >
              Load / Coil
            </button>
            <button
              className={`role-btn ${chartMode === "sensors" ? "active" : ""}`}
              onClick={() => setChartMode("sensors")}
            >
              Board HW
            </button>
          </div>
        </div>
        <TelemetryChart series={liveSeries} chartMode={chartMode} />
      </section>

      {showAnalytics && (
        <section className="panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="section-head">
              <h2>
                <BarChart3 size={15} /> Device Energy Ranking (Today Wh)
              </h2>
              <span className="section-sub">Integrated from modeled/MCU watt draw in SQLite</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {ranking.map((item) => {
                const metric = item.wh > 0 ? item.wh : item.liveW;
                const widthPct = Math.min(100, Math.max(3, Math.round((metric / maxRankVal) * 100)));
                return (
                  <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem" }}>
                      <span>
                        {item.name}{" "}
                        <span className={`tag ${item.provenance === "hardware" ? "hw" : "twin"}`}>
                          {item.provenance === "hardware" ? "HW" : "Twin"}
                        </span>
                      </span>
                      <span className="mono">
                        {item.wh.toFixed(2)} Wh ({item.liveW} W)
                      </span>
                    </div>
                    <div style={{ height: 4, borderRadius: 99, background: "var(--bg)", overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${widthPct}%`,
                          height: "100%",
                          background: item.provenance === "hardware" ? "var(--sky)" : "var(--green)",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="section-head">
              <h2>Daily vs Eco-Saved Wh (SQLite)</h2>
              <div className="seg-tabs">
                <button
                  className={`role-btn ${energyTab === "daily" ? "active" : ""}`}
                  onClick={() => setEnergyTab("daily")}
                >
                  Daily
                </button>
                <button
                  className={`role-btn ${energyTab === "weekly" ? "active" : ""}`}
                  onClick={() => setEnergyTab("weekly")}
                >
                  7-Day
                </button>
              </div>
            </div>
            {daily.length === 0 ? (
              <div className="section-sub">Accumulation starts as telemetry samples arrive.</div>
            ) : energyTab === "weekly" ? (
              <div className="device-row mono" style={{ fontSize: "0.78rem" }}>
                <span>{weeklyTotals.days}d window</span>
                <span>Used: {weeklyTotals.usedWh.toFixed(1)} Wh</span>
                <span style={{ color: "var(--green)" }}>Eco Saved: {weeklyTotals.savedWh.toFixed(1)} Wh</span>
                <span>Peak {weeklyTotals.peakW.toFixed(0)} W</span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {daily.map((d) => (
                  <div className="device-row mono" style={{ fontSize: "0.77rem" }} key={d.day}>
                    <span>{d.day}</span>
                    <span>Used: {(d.eco_kwh * 1000).toFixed(1)} Wh</span>
                    <span style={{ color: "var(--green)" }}>Saved: {(d.saved_kwh * 1000).toFixed(1)} Wh</span>
                    <span style={{ color: "var(--dim)" }}>Peak {(d.peak_kw * 1000).toFixed(0)} W</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="section-head">
          <h2>Smart Alerts &amp; Spike Log</h2>
          {alerts.some((a) => !a.acknowledged) && (
            <button className="btn" style={{ padding: "4px 9px", fontSize: "0.75rem" }} onClick={onAckAlerts}>
              <CheckCircle2 size={13} /> Acknowledge All
            </button>
          )}
        </div>
        <div className="table-scroll" style={{ maxHeight: 195 }}>
          <table>
            <thead>
              <tr>
                <th>Level</th>
                <th>Room</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 ? (
                <tr>
                  <td colSpan="3" style={{ color: "var(--dim)" }}>
                    No spike, thermal, or intrusion alerts logged.
                  </td>
                </tr>
              ) : (
                alerts.map((a) => (
                  <tr key={a.id} style={{ opacity: a.acknowledged ? 0.5 : 1 }}>
                    <td>
                      <span className={`tag ${a.severity === "critical" ? "danger" : "warn"}`}>
                        <AlertCircle size={10} />
                        {a.severity}
                      </span>
                    </td>
                    <td>{a.room}</td>
                    <td>
                      <strong>{a.title}</strong>
                      <div style={{ color: "var(--muted)" }}>{a.detail}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
