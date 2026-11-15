import { useRef, useState } from "react";
import { AlertTriangle, Lock, Mic, MicOff, Send, Unlock, Volume2 } from "lucide-react";
import { intentFromLlm, parseStructuredIntent } from "../utils/nlp.js";

const QUICK_PHRASES = [
  "Turn off all lights",
  "Set bedroom AC to 23 degrees",
  "Activate energy saver mode",
  "Activate night mode",
  "Turn on wireless power pad",
  "Why did energy spike?",
];

export function CommandHeader({
  title,
  subtitle,
  snapshot,
  role,
  onClearSafety,
  onTogglePrivacy,
  onExecuteIntent,
  onRequestConfirmation,
  onVoiceReply,
  askLlm,
}) {
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const recRef = useRef(null);

  const telem = snapshot?.telem;
  const safetyLatched = Boolean(telem?.safety);
  const privacy = Boolean(telem?.privacy);

  function maybeSpeak(text) {
    if (!speakReplies || typeof window === "undefined" || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
    } catch {
      // ignore
    }
  }

  async function processText(raw) {
    const text = raw.trim();
    if (!text) return;
    setShowHints(false);

    let parsed = parseStructuredIntent(text);
    if (!parsed && askLlm) {
      // offline rules found nothing: ask the gateway's LLM (if configured), result is only a suggestion
      parsed = intentFromLlm(await askLlm(text));
    }
    if (parsed?.kind === "unsupported") {
      onVoiceReply(parsed.message, false);
      maybeSpeak(parsed.message);
      return;
    }
    if (!parsed) {
      const msg = `No matching command for "${text}". Try "set light to 40%" or "set AC to 22C".`;
      onVoiceReply(msg, false);
      maybeSpeak(msg);
      return;
    }

    if (parsed.kind === "query") {
      const virt = snapshot?.virtual;
      const latestAlert = snapshot?.alerts?.[0];
      const msg = [
        `Load ${virt?.totalWatts ?? "--"} W (baseline ${virt?.baselineAvgWatts ?? "--"} W).`,
        telem
          ? `Node ${Number(telem.temp_c).toFixed(1)}C, Coil ${virt?.padTempC ?? "--"}C, Safety ${
              telem.safety ? telem.safety_reason : "normal"
            }.`
          : "MCU pending.",
        latestAlert ? `Latest: ${latestAlert.title}.` : "No active alerts.",
      ].join(" ");
      onVoiceReply(msg, true);
      maybeSpeak(msg);
      return;
    }

    if (parsed.requiresConfirmation) {
      onVoiceReply(`Confirm required: ${parsed.label}`, true);
      onRequestConfirmation(parsed);
      return;
    }

    onVoiceReply(`${parsed.label} (${parsed.source})`, true);
    maybeSpeak(parsed.label);
    await onExecuteIntent(parsed);
  }

  function toggleMic() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      onVoiceReply("Browser SpeechRecognition unavailable here; type command instead.", false);
      return;
    }
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SpeechRec();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (evt) => {
      const transcript = evt.results?.[0]?.[0]?.transcript || "";
      setInput(transcript);
      processText(transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  return (
    <>
      <header className="cmd-header">
        <div className="cmd-title">
          <h1>{title}</h1>
        </div>

        <div className="cmd-bar-wrap">
          <form
            className="cmd-form"
            style={{ flex: 1 }}
            onSubmit={(e) => {
              e.preventDefault();
              processText(input);
            }}
          >
            <input
              className="cmd-input"
              value={input}
              onFocus={() => setShowHints(true)}
              onBlur={() => setTimeout(() => setShowHints(false), 180)}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Command: "Set light 40%", "AC 22C", "Turn off all"...'
            />
            <button
              type="button"
              className={`btn icon-btn ${speakReplies ? "active" : ""}`}
              title="Speak responses aloud"
              onClick={() => setSpeakReplies((v) => !v)}
            >
              <Volume2 size={13} />
            </button>
            <button
              type="button"
              className={`btn icon-btn ${listening ? "danger" : ""}`}
              title="Browser speech input"
              onClick={toggleMic}
            >
              {listening ? <MicOff size={13} /> : <Mic size={13} />}
            </button>
            <button type="submit" className="btn solid icon-btn">
              <Send size={13} />
            </button>
          </form>

          {showHints && (
            <div className="hints-dropdown">
              {QUICK_PHRASES.map((phrase) => (
                <button
                  key={phrase}
                  type="button"
                  className="btn"
                  style={{ fontSize: "0.73rem", padding: "4px 9px" }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setInput(phrase);
                    processText(phrase);
                  }}
                >
                  {phrase}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="cmd-actions">
          <button
            className={`btn ${privacy ? "warn" : ""}`}
            onClick={onTogglePrivacy}
            title={privacy ? "Privacy mode on — click to disable" : "Enable privacy mode"}
          >
            {privacy ? <Lock size={14} /> : <Unlock size={14} />}
            {privacy ? "Private" : "Privacy"}
          </button>
        </div>
      </header>

      {safetyLatched && (
        <div className="safety-banner">
          <span>
            <strong>Safety Latch Active</strong> — {telem?.safety_reason || "Hardware safety triggered"}
          </span>
          <button
            className="btn danger"
            disabled={role !== "owner"}
            onClick={onClearSafety}
            style={{ flexShrink: 0 }}
          >
            <AlertTriangle size={13} /> Clear Safety
          </button>
        </div>
      )}
    </>
  );
}
