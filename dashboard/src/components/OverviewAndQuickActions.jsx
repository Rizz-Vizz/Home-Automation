import { Leaf, Moon, Power, Shield, ShieldAlert, Zap } from "lucide-react";

export function OverviewAndQuickActions({ snapshot, role, onAction }) {
  const telem = snapshot?.telem;
  const virt = snapshot?.virtual;
  const appliances = virt?.appliances || [];
  const activeCount = appliances.filter((d) => d.on).length;

  const isGuest = role === "guest";
  const isOwner = role === "owner";
  const isFamily = role === "family";
  const safetyOrAway = Boolean(telem?.safety) || Boolean(telem?.away);

  const lux = telem ? Number(telem.lux) : null;
  const luxState = !telem
    ? "Waiting frame"
    : !telem.eco
      ? "Eco standby"
      : lux > 180
        ? "Cap 15% (Bright)"
        : lux > 75
          ? "Cap 45% (Daylight)"
          : lux > 30
            ? "Cap 70% (Indoor)"
            : "100% (Dark room)";

  const totalWatts = virt?.totalWatts ?? null;
  const dieTempC = telem ? Number(telem.temp_c).toFixed(1) : null;
  const coilTempC = virt?.padTempC ?? null;
  const vibMg = telem?.vib ?? 0;
  const dbVal = telem ? Number(telem.db).toFixed(1) : null;

  const securityStatus = telem?.safety
    ? "ALERT"
    : telem?.away
      ? "AWAY"
      : "NORMAL";

  const securityColor = telem?.safety
    ? "var(--red, #ef4444)"
    : telem?.away
      ? "var(--warn, #f59e0b)"
      : "var(--ok, #22c55e)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Unified 4-cell overview row */}
      <div className="telemetry-primary">
        {/* Cell 1: Total Power */}
        <div className="telem-primary-cell">
          <div className="telem-primary-label">
            <span>Home Load</span>
            <span className="tag twin">Twin</span>
          </div>
          <div className="telem-primary-val">
            {totalWatts !== null ? (
              <>
                {totalWatts}
                <span className="telem-primary-unit">W</span>
              </>
            ) : (
              "--"
            )}
          </div>
          <div className="telem-primary-sub">
            {activeCount}/{appliances.length || "--"} devices on
            {virt?.baselineAvgWatts != null ? ` · base ${virt.baselineAvgWatts} W` : ""}
          </div>
        </div>

        {/* Cell 2: Climate & Thermal */}
        <div className="telem-primary-cell">
          <div className="telem-primary-label">
            <span>Climate / Temp</span>
            <span className="tag hw">Node</span>
          </div>
          <div className="telem-primary-val">
            {dieTempC !== null ? (
              <>
                {dieTempC}
                <span className="telem-primary-unit">°C</span>
              </>
            ) : (
              "--"
            )}
          </div>
          <div className="telem-primary-sub">
            {coilTempC !== null ? `Pad Coil ${coilTempC}°C · ${virt?.padEfficiencyPct ?? "--"}% eff` : "FRDM-MCXN236 Die"}
          </div>
        </div>

        {/* Cell 3: Ambient Light */}
        <div className="telem-primary-cell">
          <div className="telem-primary-label">
            <span>Ambient Light</span>
            <span className="tag hw">Sensor</span>
          </div>
          <div className="telem-primary-val">
            {lux !== null ? (
              <>
                {lux.toFixed(0)}
                <span className="telem-primary-unit">idx</span>
              </>
            ) : (
              "--"
            )}
          </div>
          <div className="telem-primary-sub">{luxState} (Q2 phototransistor)</div>
        </div>

        {/* Cell 4: Security & Audio */}
        <div className="telem-primary-cell">
          <div className="telem-primary-label">
            <span>Security Status</span>
            <span className="tag" style={{ color: securityColor, borderColor: securityColor }}>
              {securityStatus}
            </span>
          </div>
          <div className="telem-primary-val" style={{ color: securityColor }}>
            {securityStatus}
          </div>
          <div className="telem-primary-sub">
            Sound {dbVal !== null ? `${dbVal} rel dB` : "--"} · Vib {vibMg} mg
          </div>
        </div>
      </div>

      {/* Quick Scenes */}
      <div className="panel" style={{ padding: "12px 16px" }}>
        <div className="scene-bar">
          <div className="scene-pills">
            <button className="scene-pill" disabled={isGuest} onClick={() => onAction("all_off", "", true)}>
              <Power size={13} />
              Turn Off All
            </button>

            {!isGuest && (
              <button
                className="scene-pill"
                disabled={safetyOrAway}
                onClick={() => onAction("night_mode", "")}
              >
                <Moon size={13} />
                Night Mode
              </button>
            )}

            {isOwner && (
              <button
                className={`scene-pill ${telem?.away ? "active" : ""}`}
                onClick={() => onAction(telem?.away ? "away_disarm" : "away_arm", "", true)}
              >
                <Shield size={13} />
                {telem?.away ? "Disarm Away" : "Away Mode"}
              </button>
            )}

            {!isGuest && (
              <button
                className="scene-pill"
                disabled={safetyOrAway}
                onClick={() => onAction("energy_saver", "")}
              >
                <Zap size={13} />
                Energy Saver
              </button>
            )}

            {!isGuest && (
              <button
                className={`scene-pill ${telem?.eco ? "active" : ""}`}
                onClick={() => onAction("eco", telem?.eco ? "off" : "on")}
              >
                <Leaf size={13} />
                Auto-Eco {telem?.eco ? "ON" : "OFF"}
              </button>
            )}
          </div>

          {/* Safety cutoff open to all roles */}
          <button className="scene-pill danger-pill" onClick={() => onAction("emergency_stop", "", true)}>
            <ShieldAlert size={13} />
            Emergency Stop
          </button>
        </div>
      </div>
    </div>
  );
}
