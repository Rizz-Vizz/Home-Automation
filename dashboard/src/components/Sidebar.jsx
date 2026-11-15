import { Cpu, Home, LogOut, Shield, Sliders } from "lucide-react";

const NAV_ITEMS = [
  { id: "home", label: "Home", icon: Home },
  { id: "energy", label: "Energy & Rules", icon: Sliders },
  { id: "vision", label: "Vision & Security", icon: Shield },
  { id: "hardware", label: "Hardware & Flash", icon: Cpu },
];

const ROLE_ALLOWED_TABS = {
  owner: ["home", "energy", "vision", "hardware"],
  family: ["home", "energy", "vision"],
  guest: ["home"],
};

export function Sidebar({ activeTab, onTabChange, connected, snapshot, role, onLogout }) {
  const serial = snapshot?.serial;
  const telem = snapshot?.telem;
  const mcu = snapshot?.mcuInfo;
  const cloud = snapshot?.cloud;

  const boardLive = serial?.status === "connected" && serial?.firmwareType === "elly_edge_fw";
  const safetyLatched = Boolean(telem?.safety);
  const edgeMode = Boolean(telem?.edge);
  const activeDevices = (snapshot?.virtual?.appliances || []).filter((d) => d.on).length;
  const unackedAlerts = (snapshot?.alerts || []).filter((a) => !a.acknowledged).length;

  const boardDotClass = boardLive
    ? safetyLatched
      ? "danger"
      : edgeMode
        ? "warn"
        : "ok"
    : "danger";

  const boardStatus = safetyLatched
    ? "SAFETY"
    : edgeMode
      ? "EDGE"
      : boardLive
        ? "LIVE"
        : "STANDBY";

  const allowedTabs = ROLE_ALLOWED_TABS[role] || ROLE_ALLOWED_TABS.guest;
  const visibleNav = NAV_ITEMS.filter((item) => allowedTabs.includes(item.id));

  return (
    <aside className="sidebar">
      <div>
        {/* Brand mark */}
        <div className="brand">
          <div className="brand-mark">HA</div>
          <div>
            <div className="brand-title">Home Automation</div>
            <div className="brand-sub">FRDM-MCXN236 Hub</div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="nav-list" aria-label="Primary sections">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const badge =
              item.id === "home"
                ? activeDevices > 0
                  ? `${activeDevices} on`
                  : null
                : item.id === "vision" && unackedAlerts > 0
                  ? `${unackedAlerts}`
                  : null;
            return (
              <button
                key={item.id}
                className={`nav-item ${activeTab === item.id ? "active" : ""}`}
                onClick={() => onTabChange(item.id)}
              >
                <span className="nav-label">
                  <Icon size={15} />
                  {item.label}
                </span>
                {badge && (
                  <span className={`nav-badge ${item.id === "vision" ? "alert" : ""}`}>{badge}</span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer status + role switcher */}
      <div className="sidebar-footer">
        {/* Gateway WS */}
        <div className="status-row">
          <span className="status-label">
            <span className={`dot ${connected ? "ok" : "danger"}`} />
            Gateway WS
          </span>
          <span className="status-val">{connected ? "UP" : "OFFLINE"}</span>
        </div>

        {/* Serial / board */}
        <div className="status-row">
          <span className="status-label">
            <span className={`dot ${boardDotClass}`} />
            {serial?.port || "COM6"}
          </span>
          <span className="status-val">{boardStatus}</span>
        </div>

        {role !== "guest" && (
          <>
            {/* MQTT */}
            <div className="status-row">
              <span className="status-label">
                <span className={`dot ${connected ? "ok" : ""}`} />
                MQTT :1883
              </span>
              <span className="status-val">{snapshot?.mqttPublished ?? 0}</span>
            </div>

            {/* Flash chip */}
            <div className="status-row">
              <span className="status-label">W25Q64</span>
              <span className="status-val">{mcu?.jedec ? mcu.jedec.toUpperCase() : "--"}</span>
            </div>

            {/* Cloud mirror */}
            <div className="status-row">
              <span className="status-label">
                <span className={`dot ${cloud?.online ? "ok" : cloud?.configured ? "warn" : ""}`} />
                Cloud mirror
              </span>
              <span className="status-val">
                {!cloud?.configured ? "LOCAL ONLY" : cloud.online ? "SYNCED" : `QUEUED ${cloud.queued ?? 0}`}
              </span>
            </div>
          </>
        )}

        {/* Signed-in role (set by the PIN used at login, not selectable here) */}
        <div className="role-section">
          <div className="role-label">Signed in as</div>
          <div className="signed-in">
            <strong>{role.charAt(0).toUpperCase() + role.slice(1)}</strong>
            <button className="btn" onClick={onLogout} title="Sign out">
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
