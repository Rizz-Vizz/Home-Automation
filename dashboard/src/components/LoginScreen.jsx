import { useState } from "react";

export function LoginScreen({ onLogin, error }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!pin) return;
    setBusy(true);
    await onLogin(pin);
    setBusy(false);
    setPin("");
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-title">Home Automation</div>
        <p className="login-sub">Enter your household PIN. Your role comes from the PIN.</p>
        <input
          className="login-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN"
          aria-label="PIN"
        />
        <div style={{ fontSize: "0.74rem", color: "var(--dim)", textAlign: "center", marginTop: -4 }}>
          Configured in <code>gateway/.env</code> (pass <code>--demo</code> to gen_secrets for 1/2/3)
        </div>
        {error && <div className="login-error">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy || !pin}>
          {busy ? "Checking..." : "Unlock"}
        </button>
      </form>
    </div>
  );
}
