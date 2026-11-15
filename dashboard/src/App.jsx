import { useState } from "react";
import { Sidebar } from "./components/Sidebar.jsx";
import { CommandHeader } from "./components/CommandHeader.jsx";
import { OverviewAndQuickActions } from "./components/OverviewAndQuickActions.jsx";
import { RoomGrid } from "./components/RoomGrid.jsx";
import { RulesAndOptimizerPanel } from "./components/RulesAndOptimizerPanel.jsx";
import { EnergyAndTelemetryCharts } from "./components/EnergyAndTelemetryCharts.jsx";
import { SmartVisionPanel } from "./components/SmartVisionPanel.jsx";
import { AuditAndBackfillPanel } from "./components/AuditAndBackfillPanel.jsx";
import { LoginScreen } from "./components/LoginScreen.jsx";
import { useEllyGateway } from "./hooks/useEllyGateway.js";

const VIEW_META = {
  home: { title: "Home Command Center", subtitle: "Live hardware telemetry, scenes & room control" },
  energy: { title: "Energy & Automation", subtitle: "SQLite consumption analytics & rule policies" },
  vision: { title: "Vision & Security", subtitle: "Browser-local camera, consent-gated clips & away alerts" },
  hardware: { title: "Hardware & Flash Lab", subtitle: "MCXN236 diagnostics, W25Q64 hash chain & simulation hooks" },
};

const ROLE_ALLOWED_TABS = {
  owner: ["home", "energy", "vision", "hardware"],
  family: ["home", "energy", "vision"],
  guest: ["home"],
};

export default function App() {
  const {
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
    clearToast,
    sendCommand,
    toggleRule,
    postVisionEvent,
    ackAlerts,
  } = useEllyGateway();

  const [activeTab, setActiveTab] = useState("home");
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [voiceStatus, setVoiceStatus] = useState(null);

  async function handleAction(cmd, arg = "", needsConfirm = false) {
    if (needsConfirm) {
      setPendingConfirm({
        cmd,
        arg,
        label: `Confirm ${cmd}${arg ? ` (${arg})` : ""} as ${role}`,
      });
      return;
    }
    await sendCommand(cmd, arg);
  }

  async function handleConfirmedExecute() {
    if (!pendingConfirm) return;
    const item = pendingConfirm;
    setPendingConfirm(null);
    await sendCommand(item.cmd, item.arg);
  }

  if (!role) {
    return <LoginScreen onLogin={login} error={loginError} />;
  }

  const allowedTabs = ROLE_ALLOWED_TABS[role] || ROLE_ALLOWED_TABS.guest;
  const currentTab = allowedTabs.includes(activeTab) ? activeTab : "home";
  const privacy = Boolean(snapshot?.telem?.privacy);
  const meta = VIEW_META[currentTab] || VIEW_META.home;

  return (
    <div className="app-frame">
      <Sidebar
        activeTab={currentTab}
        onTabChange={setActiveTab}
        connected={connected}
        snapshot={snapshot}
        role={role}
        onLogout={logout}
      />

      <div className="workspace">
        <CommandHeader
          title={meta.title}
          subtitle={meta.subtitle}
          snapshot={snapshot}
          role={role}
          onClearSafety={() => handleAction("safety_clear", "", true)}
          onTogglePrivacy={() => handleAction("privacy", privacy ? "off" : "on", true)}
          onExecuteIntent={(intent) => sendCommand(intent.cmd, intent.arg)}
          onRequestConfirmation={(intent) => setPendingConfirm(intent)}
          onVoiceReply={(text, ok) => setVoiceStatus({ text, ok })}
          askLlm={askLlm}
        />

        <main className="content">
          {toast && (
            <div className={`notice-bar ${toast.ok ? "ok" : "err"}`}>
              <span>{toast.text}</span>
              <button className="btn" style={{ padding: "3px 8px", fontSize: "0.74rem" }} onClick={clearToast}>
                Dismiss
              </button>
            </div>
          )}

          {voiceStatus && (
            <div className={`notice-bar ${voiceStatus.ok ? "info" : "err"}`}>
              <span>{voiceStatus.text}</span>
              <button
                className="btn"
                style={{ padding: "3px 8px", fontSize: "0.74rem" }}
                onClick={() => setVoiceStatus(null)}
              >
                Close
              </button>
            </div>
          )}

          {currentTab === "home" && (
            <>
              <OverviewAndQuickActions snapshot={snapshot} role={role} onAction={handleAction} />
              <RulesAndOptimizerPanel
                snapshot={snapshot}
                role={role}
                onToggleRule={toggleRule}
                onAction={handleAction}
                onlySuggestion
              />
              <RoomGrid snapshot={snapshot} role={role} onAction={handleAction} />
            </>
          )}

          {currentTab === "energy" && (
            <>
              <RulesAndOptimizerPanel
                snapshot={snapshot}
                role={role}
                onToggleRule={toggleRule}
                onAction={handleAction}
              />
              <EnergyAndTelemetryCharts
                snapshot={snapshot}
                liveSeries={liveSeries}
                onAckAlerts={ackAlerts}
                showAnalytics
              />
            </>
          )}

          {currentTab === "vision" && (
            <SmartVisionPanel
              privacyMode={privacy}
              awayArmed={Boolean(snapshot?.telem?.away)}
              canUseCamera={role !== "guest"}
              visionEvents={snapshot?.visionEvents || []}
              onVisionEvent={postVisionEvent}
              onRetentionChange={pruneVision}
            />
          )}

          {currentTab === "hardware" && (
            <AuditAndBackfillPanel snapshot={snapshot} role={role} onAction={handleAction} />
          )}
        </main>
      </div>

      {pendingConfirm && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>Confirm Critical Action</h3>
            <p style={{ color: "var(--muted)", lineHeight: 1.5, fontSize: "0.86rem" }}>
              Role <strong style={{ color: "var(--text)" }}>{role.toUpperCase()}</strong> requested:
              <br />
              <strong style={{ color: "var(--text)" }}>{pendingConfirm.label}</strong>
              <br />
              <span className="mono">
                {pendingConfirm.cmd} {pendingConfirm.arg}
              </span>
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={() => setPendingConfirm(null)}>
                Cancel
              </button>
              <button className="btn solid" onClick={handleConfirmedExecute}>
                Confirm &amp; Sign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
