import { useEffect, useRef, useState } from "react";
import { Bell, Camera, CameraOff, EyeOff, Radio, Trash2, Volume2 } from "lucide-react";
import { clearClips, deleteClip, listClips, pruneClips, saveClip } from "../utils/clipStore.js";

const CLIP_SECONDS = 8;

export function SmartVisionPanel({ privacyMode, awayArmed, canUseCamera = true, visionEvents = [], onVisionEvent, onRetentionChange }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const prevFrameRef = useRef(null);
  const lastEventMsRef = useRef(0);
  const recorderRef = useRef(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [motionScore, setMotionScore] = useState(0);
  const [motionAlertOn, setMotionAlertOn] = useState(true);
  const [recEnabled, setRecEnabled] = useState(false);
  const [retentionMin, setRetentionMin] = useState(60);
  const [clips, setClips] = useState([]);
  const [recording, setRecording] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [playUrl, setPlayUrl] = useState(null);
  const [camError, setCamError] = useState(null);
  const [speakerMsg, setSpeakerMsg] = useState("");

  async function refreshClips() {
    try {
      setClips(await listClips());
    } catch {
      setClips([]);
    }
  }

  function stopRecorder(discard) {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.discard = discard;
      rec.stop();
    }
  }

  /* Event-based recording: a short real clip of the live stream, saved locally with a retention limit */
  function recordClip(meta) {
    const stream = streamRef.current;
    if (!stream || recorderRef.current?.state === "recording" || typeof MediaRecorder === "undefined") return;
    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.discard = false;
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = async () => {
      setRecording(false);
      recorderRef.current = null;
      if (rec.discard || chunks.length === 0) return;
      try {
        await saveClip({ ts: Date.now(), blob: new Blob(chunks, { type: rec.mimeType || "video/webm" }), ...meta });
        await refreshClips();
      } catch {
        // storage full or blocked: the event is still logged on the gateway
      }
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    setTimeout(() => rec.state === "recording" && rec.stop(), CLIP_SECONDS * 1000);
  }

  function stopStream() {
    stopRecorder(true);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setMotionScore(0);
    prevFrameRef.current = null;
  }

  async function startStream() {
    if (privacyMode || !canUseCamera) return;
    setCamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 16 / 9 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraActive(true);
      setShowConsent(false);
    } catch (err) {
      setCamError(err.message || "Webcam unavailable");
    }
  }

  function triggerSpeakerTest() {
    if (privacyMode) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(740, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(980, ctx.currentTime + 0.16);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.26);
      setSpeakerMsg("Browser tone played locally");
    } catch {
      setSpeakerMsg("AudioContext unavailable");
    }
  }

  useEffect(() => {
    if (privacyMode) {
      stopStream();
    }
  }, [privacyMode]);

  useEffect(() => {
    refreshClips();
  }, []);

  // retention is enforced on a timer, not only when something new is saved
  useEffect(() => {
    const run = () => pruneClips(retentionMin).then((n) => n > 0 && refreshClips()).catch(() => {});
    run();
    const t = setInterval(run, 30000);
    return () => clearInterval(t);
  }, [retentionMin]);

  useEffect(() => {
    return () => playUrl && URL.revokeObjectURL(playUrl);
  }, [playUrl]);

  useEffect(() => {
    if (!cameraActive || privacyMode) return undefined;

    const timer = setInterval(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) return;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const curr = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const prev = prevFrameRef.current;

      if (prev) {
        let diffSum = 0;
        for (let i = 0; i < curr.length; i += 16) {
          diffSum += Math.abs(curr[i] - prev[i]) + Math.abs(curr[i + 1] - prev[i + 1]);
        }
        const pct = Math.min(100, Math.round((diffSum / (curr.length / 8)) * 1.4));
        setMotionScore(pct);

        if (motionAlertOn && pct >= 14 && Date.now() - lastEventMsRef.current > 6000) {
          lastEventMsRef.current = Date.now();
          if (recEnabled) {
            recordClip({ motionScore: pct, summary: awayArmed ? "Away motion" : "Motion" });
          }
          onVisionEvent?.({
            summary: awayArmed ? "Motion detected while Away Mode armed" : "Room occupancy motion event",
            motionScore: pct,
            privacyMode: false,
            retentionMin,
            armed: awayArmed,
            escalateSafety: awayArmed,
          });
        }
      }
      prevFrameRef.current = new Uint8ClampedArray(curr);
    }, 500);

    return () => clearInterval(timer);
  }, [cameraActive, privacyMode, motionAlertOn, recEnabled, retentionMin, awayArmed, onVisionEvent]);

  useEffect(() => () => stopStream(), []);

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h2>
          <Camera size={15} /> Smart Camera (this browser only)
        </h2>
        <div className="btn-row">
          {cameraActive && (
            <span className="tag" style={{ color: "#ef4444", borderColor: "#ef4444" }} aria-live="polite">
              ● CAMERA ON{recording ? " · REC" : ""}
            </span>
          )}
          <span className={`tag ${motionScore > 12 ? "hw" : ""}`}>
            {motionScore > 12 ? `Occupied ${motionScore}%` : `Idle ${motionScore}%`}
          </span>
          {!cameraActive ? (
            <button
              className="btn solid"
              disabled={privacyMode || !canUseCamera}
              title={canUseCamera ? "" : "Guests cannot use the camera"}
              onClick={() => setShowConsent(true)}
            >
              <Camera size={13} /> Enable Webcam
            </button>
          ) : (
            <button className="btn" onClick={stopStream}>
              <CameraOff size={13} /> Stop
            </button>
          )}
        </div>
      </div>

      {showConsent && !cameraActive && (
        <div className="notice-bar info">
          <span>
            Turn on this computer's webcam? Video stays in this browser. When clip capture is on, an {CLIP_SECONDS} s clip is
            saved here on each motion event and deleted after the retention time. You can stop at any time.
          </span>
          <span className="btn-row">
            <button className="btn solid" onClick={startStream}>I consent</button>
            <button className="btn" onClick={() => setShowConsent(false)}>Cancel</button>
          </span>
        </div>
      )}

      <div className="btn-row">
        <button
          className={`btn ${motionAlertOn ? "active" : ""}`}
          style={{ padding: "4px 9px", fontSize: "0.74rem" }}
          onClick={() => setMotionAlertOn((v) => !v)}
        >
          <Bell size={12} /> Motion Alerts {motionAlertOn ? "ON" : "OFF"}
        </button>
        <button
          className={`btn ${recEnabled ? "danger" : ""}`}
          style={{ padding: "4px 9px", fontSize: "0.74rem" }}
          disabled={privacyMode}
          onClick={() => setRecEnabled((v) => !v)}
        >
          <Radio size={12} /> {recEnabled ? "Clip Recording ON" : "Clip Recording OFF"}
        </button>
        <button
          className="btn"
          style={{ padding: "4px 9px", fontSize: "0.74rem" }}
          disabled={privacyMode}
          onClick={triggerSpeakerTest}
          title={speakerMsg || "Local browser AudioContext test tone"}
        >
          <Volume2 size={12} /> Browser Speaker Test
        </button>
        <select
          className="btn"
          style={{ padding: "4px 8px", fontSize: "0.74rem" }}
          value={retentionMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            setRetentionMin(v);
            onRetentionChange?.(v);
          }}
          aria-label="Clip and event retention"
        >
          <option value={15}>Keep 15 min</option>
          <option value={60}>Keep 1 h</option>
          <option value={1440}>Keep 24 h</option>
        </select>
        {speakerMsg && <span className="section-sub">{speakerMsg}</span>}
      </div>

      <div className="vision-box">
        <video ref={videoRef} className="vision-video" autoPlay muted playsInline />
        <canvas ref={canvasRef} width="320" height="180" style={{ display: "none" }} />

        {!cameraActive && !privacyMode && (
          <div style={{ position: "absolute", color: "var(--muted)", fontSize: "0.82rem", textAlign: "center", padding: 14 }}>
            {camError
              ? `Webcam notice: ${camError}`
              : "Enable Webcam for frame-difference motion detection. Video never leaves this browser."}
          </div>
        )}

        {privacyMode && (
          <div className="privacy-curtain">
            <EyeOff size={24} color="#f59e0b" />
            <strong>Privacy Curtain Active</strong>
            <small style={{ color: "var(--muted)" }}>
              Camera stopped, recording halted, and motion events paused. Saved clips follow the retention time.
            </small>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginTop: 4 }}>
        <div>
          <h3 style={{ fontSize: "0.82rem", margin: "4px 0 6px 0", color: "var(--muted)" }}>
            Saved Motion Clips ({clips.length})
          </h3>
          {clips.length > 0 ? (
            <div className="table-scroll" style={{ maxHeight: 180 }}>
              <table>
                <thead>
                  <tr>
                    <th>Saved Clip</th>
                    <th>Motion</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {clips.slice(0, 10).map((c) => (
                    <tr key={c.id}>
                      <td className="mono">
                        <button
                          className="btn"
                          style={{ padding: "2px 8px", fontSize: "0.72rem" }}
                          onClick={() => setPlayUrl(URL.createObjectURL(c.blob))}
                        >
                          Play
                        </button>{" "}
                        {new Date(c.ts).toLocaleTimeString()}
                      </td>
                      <td className="mono">{Number(c.motionScore || 0).toFixed(0)}%</td>
                      <td>
                        <button
                          className="btn"
                          style={{ padding: "2px 8px", fontSize: "0.72rem" }}
                          onClick={() => deleteClip(c.id).then(refreshClips)}
                          aria-label="Delete clip"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn" style={{ marginTop: 8 }} onClick={() => clearClips().then(refreshClips)}>
                Delete all clips
              </button>
            </div>
          ) : (
            <div style={{ padding: "14px", border: "1px solid var(--border)", borderRadius: 8, color: "var(--dim)", fontSize: "0.78rem", textAlign: "center" }}>
              No recorded clips yet. Turn "Clip Recording ON" to capture clips on motion.
            </div>
          )}
          {playUrl && (
            <div style={{ marginTop: 10 }}>
              <video src={playUrl} controls autoPlay style={{ width: "100%", borderRadius: 8, maxHeight: 220 }} />
            </div>
          )}
        </div>

        <div>
          <h3 style={{ fontSize: "0.82rem", margin: "4px 0 6px 0", color: "var(--muted)" }}>
            Intrusion &amp; Motion Log ({visionEvents.length})
          </h3>
          {visionEvents.length > 0 ? (
            <div className="table-scroll" style={{ maxHeight: 220 }}>
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event Metadata</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {visionEvents.slice(0, 15).map((ev) => (
                    <tr key={ev.id}>
                      <td className="mono">{new Date(ev.ts).toLocaleTimeString()}</td>
                      <td>{ev.summary}</td>
                      <td className="mono">{Number(ev.motion_score || 0).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: "14px", border: "1px solid var(--border)", borderRadius: 8, color: "var(--dim)", fontSize: "0.78rem", textAlign: "center" }}>
              No motion events logged. Events appear here when motion exceeds the detection threshold.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
