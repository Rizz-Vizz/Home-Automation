import { Cpu, FlaskConical, HardDrive, RefreshCw, ShieldAlert } from "lucide-react";

export function AuditAndBackfillPanel({ snapshot, role, onAction }) {
  const audits = snapshot?.audit || [];
  const backfillTotal = snapshot?.backfillTotal || 0;
  const recentBackfills = (snapshot?.telemetryHistory || []).filter((r) => r.source === "backfill").slice(-10);
  const mcu = snapshot?.mcuInfo;
  const serial = snapshot?.serial;
  const virt = snapshot?.virtual;

  const isGuest = role === "guest";
  const isOwner = role === "owner";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="panel">
        <div className="section-head">
          <h2>
            <Cpu size={15} /> FRDM-MCXN236 Identity &amp; Diagnostics
          </h2>
          <span className="mono section-sub">
            {mcu?.uid ? `UID ${mcu.uid}` : "Waiting MCU ping"}
          </span>
        </div>

        <div className="btn-row" style={{ flexWrap: "wrap" }}>
          <button
            className={`btn ${snapshot?.telem?.vac_s && snapshot.telem.vac_s <= 60 ? "active" : ""}`}
            disabled={role !== "owner"}
            title="Vacancy auto-off is 20 minutes normally. Demo timing makes it 20 seconds."
            onClick={() => onAction("demo_timing", snapshot?.telem?.vac_s && snapshot.telem.vac_s <= 60 ? "off" : "on")}
          >
            Vacancy timer: {snapshot?.telem?.vac_s ? (snapshot.telem.vac_s >= 60 ? `${Math.round(snapshot.telem.vac_s / 60)} min` : `${snapshot.telem.vac_s} s (demo)`) : "--"}
          </button>
          <button
            className={`btn ${snapshot?.cloud?.enabled ? "active" : ""}`}
            disabled={role !== "owner" || !snapshot?.cloud?.configured}
            title={snapshot?.cloud?.configured ? "Pause or resume the cloud mirror" : "Set CLOUD_SYNC_URL in gateway/.env to enable"}
            onClick={() => onAction("cloud_toggle", snapshot?.cloud?.enabled ? "off" : "on")}
          >
            Cloud mirror: {!snapshot?.cloud?.configured ? "not configured" : snapshot.cloud.enabled ? `on (${snapshot.cloud.queued} queued)` : "paused"}
          </button>
        </div>

        <div className="btn-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <div className="btn-row">
            <button className="btn" onClick={() => onAction("can_diag", "")}>
              CAN1 self-test, internal loopback ({mcu?.can_ok ? "PASS" : "--"})
            </button>
            <button className="btn" onClick={() => onAction("flash_id", "")}>
              Verify W25Q64 ({mcu?.jedec || "--"})
            </button>
            <button className="btn" onClick={() => onAction("audit_dump", "12")}>
              <RefreshCw size={13} /> Dump Flash Audit
            </button>
            <button className="btn" onClick={() => onAction("backfill_sync", "")}>
              <HardDrive size={13} /> Sync Backfill ({backfillTotal})
            </button>
          </div>

          <div className="mono section-sub">
            Serial: {serial?.port || "COM6"} ({serial?.status || "unknown"}) · FW {mcu?.fw || "--"}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <h2>
            <FlaskConical size={15} /> Fault &amp; Tariff Simulation Triggers
          </h2>
          <span className="section-sub">
            Synthetic test hooks to exercise real MCU safety latch and 2-4 PM Eco recommendation
          </span>
        </div>

        <div className="btn-row">
          <button
            className={`btn ${virt?.appliances?.find((d) => d.id === "pad_tx")?.faultInjected ? "danger" : ""}`}
            disabled={!isOwner}
            onClick={() => {
              const padFault = Boolean(virt?.appliances?.find((d) => d.id === "pad_tx")?.faultInjected);
              onAction("pad_fault", padFault ? "off" : "on", true);
            }}
          >
            {virt?.appliances?.find((d) => d.id === "pad_tx")?.faultInjected
              ? "Stop Coil Overheat Sim"
              : "Inject Coil Overheat Fault"}
          </button>
          <button
            className={`btn ${virt?.isPeakWindow ? "warn" : ""}`}
            disabled={isGuest}
            onClick={() => onAction("peak_demo", virt?.isPeakWindow ? "off" : "on")}
          >
            {virt?.isPeakWindow ? "Stop 2-4 PM Peak Tariff Sim" : "Simulate 2-4 PM Peak Tariff"}
          </button>
          <button
            className={`btn ${virt?.appliances?.find((d) => d.id === "fridge")?.doorOpen ? "warn" : ""}`}
            disabled={!isOwner}
            onClick={() => {
              const fridge = virt?.appliances?.find((d) => d.id === "fridge");
              onAction("fridge_door", fridge?.doorOpen ? "off" : "on");
            }}
          >
            {virt?.appliances?.find((d) => d.id === "fridge")?.doorOpen
              ? "Close Fridge Door"
              : "Simulate Fridge Door Ajar"}
          </button>
        </div>
      </section>

      <section className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>
            <ShieldAlert size={15} /> W25Q64 Hash-Chained Audit &amp; Edge Backfill Log
          </h2>
          <span className="section-sub">{audits.length} recent records shown</span>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Origin</th>
                <th>Seq</th>
                <th>Event</th>
                <th>Role</th>
                <th>Detail</th>
                <th>SHA-256 Chain</th>
              </tr>
            </thead>
            <tbody>
              {audits.length === 0 ? (
                <tr>
                  <td colSpan="6" style={{ color: "var(--dim)" }}>
                    No audit records yet. Run Dump Flash Audit or execute commands.
                  </td>
                </tr>
              ) : (
                audits.map((row) => (
                  <tr key={row.id}>
                    <td>{row.origin}</td>
                    <td className="mono">{row.seq || "-"}</td>
                    <td>{row.event_type}</td>
                    <td>{row.role}</td>
                    <td>{row.detail}</td>
                    <td className="mono" style={{ fontSize: "0.72rem", color: "var(--dim)" }}>
                      {row.entry_hash ? `${row.prev_hash || "00"} -> ${row.entry_hash.slice(0, 12)}` : "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {recentBackfills.length > 0 && (
          <div className="section-sub">
            Recovered {recentBackfills.length} offline W25Q64 Edge Mode frames (latest:{" "}
            {Number(recentBackfills[recentBackfills.length - 1].temp_c).toFixed(1)}C,{" "}
            {Number(recentBackfills[recentBackfills.length - 1].lux).toFixed(0)} light idx).
          </div>
        )}
      </section>
    </div>
  );
}
