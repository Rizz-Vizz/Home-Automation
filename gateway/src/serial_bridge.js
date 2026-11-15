import EventEmitter from "node:events";
import { SerialPort } from "serialport";
import { deriveDeviceKey, signMcuCommand } from "./hmac.js";

export class SerialBridge extends EventEmitter {
  constructor(options) {
    super();
    this.portName = options.serialPort;
    this.baudRate = options.serialBaud || 115200;
    this.masterKeyHex = options.masterKeyHex;
    this.deviceKey = null;
    this.uid = null;
    this.nonce = null;
    this.heartbeatMs = options.heartbeatMs || 1000;
    this.db = options.db;
    this.transportFactory = options.transportFactory ?? null;

    this.seq = 0;
    this.port = null;
    this.rxBuffer = "";
    this.status = "disconnected";
    this.lastError = null;
    this.lastFrameTs = 0;
    this.lastFirmwareType = null;
    this.unrecognizedLines = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.closed = false;
  }

  start() {
    this.closed = false;
    this._openPort();
    this.heartbeatTimer = setInterval(() => {
      if (this.status === "connected" && this.deviceKey) {
        this.sendSignedCommand("heartbeat", "", "system").catch(() => {});
      }
    }, this.heartbeatMs);
  }

  stop() {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    if (this.port && typeof this.port.close === "function") {
      try {
        this.port.close();
      } catch {
        // Ignore close errors during shutdown
      }
    }
    this.status = "disconnected";
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._openPort();
    }, 3000);
  }

  _openPort() {
    if (this.closed) return;
    try {
      const transport = this.transportFactory
        ? this.transportFactory()
        : new SerialPort({ path: this.portName, baudRate: this.baudRate, autoOpen: true });

      this.port = transport;
      this.rxBuffer = "";

      transport.on("open", () => {
        this.status = "connected";
        this.lastError = null;
        this.unrecognizedLines = 0;
        this.emit("status", this.getStatus());
      });

      transport.on("data", (chunk) => this._onData(chunk));

      transport.on("error", (err) => {
        this.status = "error";
        this.lastError = err.message;
        this.emit("status", this.getStatus());
        this._scheduleReconnect();
      });

      transport.on("close", () => {
        this.status = "disconnected";
        this.emit("status", this.getStatus());
        this._scheduleReconnect();
      });

      if (transport.isOpen || transport.writable) {
        this.status = "connected";
      }
    } catch (err) {
      this.status = "error";
      this.lastError = err.message;
      this.emit("status", this.getStatus());
      this._scheduleReconnect();
    }
  }

  _onData(chunk) {
    this.rxBuffer += chunk.toString("utf8");
    let nlIdx;
    while ((nlIdx = this.rxBuffer.indexOf("\n")) !== -1) {
      const line = this.rxBuffer.slice(0, nlIdx).trim();
      this.rxBuffer = this.rxBuffer.slice(nlIdx + 1);
      if (line.length > 0) {
        this._handleLine(line);
      }
    }
  }

  _handleLine(line) {
    if (!line.startsWith("{")) {
      this.unrecognizedLines += 1;
      if (this.unrecognizedLines >= 3 && this.lastFirmwareType !== "non_elly_firmware") {
        this.lastFirmwareType = "non_elly_firmware";
        this.status = "non_elly_firmware";
        this.lastError = `Serial port emitting non-JSON stream (sample: ${line.slice(0, 40)})`;
        this.emit("status", this.getStatus());
      }
      return;
    }

    try {
      const msg = JSON.parse(line);
      this.lastFrameTs = Date.now();
      this.lastFirmwareType = "elly_edge_fw";
      if (this.status !== "connected") {
        this.status = "connected";
        this.lastError = null;
        this.emit("status", this.getStatus());
      }
      this._identify(msg);
      if (typeof msg.last_seq === "number" && msg.last_seq > this.seq) {
        this.seq = msg.last_seq;
      }
      this.emit("frame", msg);
    } catch {
      // Drop partial boot fragments cleanly
    }
  }

  /* The board announces its chip UID and per-boot nonce in boot/telemetry frames. */
  _identify(msg) {
    if (typeof msg.uid !== "string" || !/^[0-9a-f]{32}$/.test(msg.uid) || typeof msg.nonce !== "number") return;
    if (msg.uid !== this.uid) {
      this.uid = msg.uid;
      this.deviceKey = deriveDeviceKey(this.masterKeyHex, msg.uid);
      this.nonce = null;
    }
    if (msg.nonce !== this.nonce) {
      this.nonce = msg.nonce;
      this.seq = 0; // new boot session, the board's replay counter restarted too
    }
  }

  async sendSignedCommand(cmd, arg = "", role = "system") {
    if (!this.port || (this.status !== "connected" && this.status !== "non_elly_firmware")) {
      throw new Error(`Board serial link unavailable (${this.status})`);
    }
    if (!this.deviceKey || this.nonce === null) {
      throw new Error("Board not identified yet (waiting for first telemetry frame)");
    }
    this.seq += 1;
    const payload = signMcuCommand(cmd, arg, role, this.seq, this.nonce, this.deviceKey);
    const wire = JSON.stringify(payload) + "\n";

    await new Promise((resolve, reject) => {
      this.port.write(wire, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return payload;
  }

  getStatus() {
    return {
      port: this.portName,
      baudRate: this.baudRate,
      status: this.status,
      firmwareType: this.lastFirmwareType,
      lastFrameTs: this.lastFrameTs,
      lastError: this.lastError,
      identified: Boolean(this.deviceKey && this.nonce !== null),
      uid: this.uid,
      nextSeq: this.seq + 1,
    };
  }
}
