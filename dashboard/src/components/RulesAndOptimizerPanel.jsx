import { CheckCircle, Sliders, XCircle, Zap } from "lucide-react";

const RULE_SCOPE = {
  rule_vacancy: "MCU Eco",
  rule_daylight: "MCU Eco",
  rule_coil: "Gateway Enforced",
  rule_overload: "Gateway Enforced",
  rule_intrusion: "Gateway Enforced",
  rule_night: "Policy Tag",
};

export function RulesAndOptimizerPanel({ snapshot, role, onToggleRule, onAction, onlySuggestion = false }) {
  const rules = snapshot?.rules || [];
  const suggestion = snapshot?.virtual?.aiSuggestion;
  const isGuest = role === "guest";

  if (onlySuggestion && !suggestion) {
    return null;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {suggestion && (
        <div className="notice-bar info">
          <div>
            <strong style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Zap size={14} /> {suggestion.title}
            </strong>
            <div style={{ fontSize: "0.79rem", marginTop: 2 }}>{suggestion.detail}</div>
          </div>
          <div className="btn-row">
            <button className="btn solid" disabled={isGuest} onClick={() => onAction("suggestion_approve", "")}>
              <CheckCircle size={13} /> Approve Eco 26C
            </button>
            <button className="btn" disabled={isGuest} onClick={() => onAction("suggestion_dismiss", "")}>
              <XCircle size={13} /> Dismiss
            </button>
          </div>
        </div>
      )}

      {!onlySuggestion && (
        <section className="panel">
          <div className="section-head">
            <h2>
              <Sliders size={15} /> Automation Rules (SQLite)
            </h2>
            <span className="section-sub">
              {isGuest ? "Guest role: read-only" : "Owner & Family can enable/disable rules"}
            </span>
          </div>

          <div className="rules-grid">
            {rules.map((rule) => (
              <div className="rule-card" key={rule.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <strong style={{ fontSize: "0.84rem" }}>{rule.name}</strong>
                  <button
                    role="switch"
                    aria-checked={Boolean(rule.enabled)}
                    aria-label={`Toggle ${rule.name}`}
                    className={`switch ${rule.enabled ? "on" : ""}`}
                    disabled={isGuest}
                    onClick={() => onToggleRule(rule.id, !rule.enabled)}
                  />
                </div>
                <small style={{ color: "var(--muted)", fontSize: "0.75rem" }}>{rule.action_desc}</small>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto" }}>
                  <span className="tag">{RULE_SCOPE[rule.id] || "Gateway"}</span>
                  <span className="mono" style={{ fontSize: "0.71rem", color: "var(--dim)" }}>
                    {rule.triggered_count || 0} hits
                    {rule.last_triggered_ts ? ` · ${new Date(rule.last_triggered_ts).toLocaleTimeString()}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
