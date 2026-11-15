import net from "node:net";
import { Aedes } from "aedes";
import crypto from "node:crypto";
import mqtt from "mqtt";

function same(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class MqttHub {
  /* auth = { pins: {owner,family,guest}, gatewaySecret } ; username is the role name (or "gateway") */
  constructor(port, onCommand, auth) {
    this.port = port;
    this.onCommand = onCommand;
    this.auth = auth;
    this.aedes = null;
    this.server = null;
    this.client = null;
    this.publishedCount = 0;
  }

  async start() {
    this.aedes = await Aedes.createBroker();

    this.aedes.authenticate = (client, username, password, cb) => {
      const user = String(username ?? "");
      const pass = password ? password.toString("utf8") : "";
      if (user === "gateway" && same(pass, this.auth.gatewaySecret)) {
        client.ellyUser = "gateway";
        return cb(null, true);
      }
      if (["owner", "family", "guest"].includes(user) && same(pass, this.auth.pins[user])) {
        client.ellyUser = user;
        return cb(null, true);
      }
      const err = new Error("bad credentials");
      err.returnCode = 4;
      return cb(err, false);
    };

    // Clients can only publish commands, and the role is forced from their login, never from the payload.
    this.aedes.authorizePublish = (client, packet, cb) => {
      if (!client || client.ellyUser === "gateway") return cb(null);
      if (/^elly\/cmd\/[^/]+$/.test(packet.topic)) {
        try {
          const msg = JSON.parse(packet.payload.toString("utf8"));
          msg.role = client.ellyUser;
          packet.payload = Buffer.from(JSON.stringify(msg));
          return cb(null);
        } catch {
          return cb(new Error("bad json"));
        }
      }
      return cb(new Error("publish not allowed"));
    };

    this.aedes.authorizeSubscribe = (client, sub, cb) => {
      if (client?.ellyUser === "gateway") return cb(null, sub);
      if (sub.topic.startsWith("elly/cmd")) return cb(new Error("subscribe not allowed"));
      return cb(null, sub);
    };

    this.server = net.createServer(this.aedes.handle);
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });

    this.client = mqtt.connect(`mqtt://127.0.0.1:${this.port}`, {
      clientId: "elly-gateway-core",
      username: "gateway",
      password: this.auth.gatewaySecret,
      reconnectPeriod: 2000,
    });

    await new Promise((resolve, reject) => {
      this.client.once("connect", resolve);
      this.client.once("error", reject);
    });

    this.client.subscribe("elly/cmd/+");
    this.client.on("message", (topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString("utf8"));
        const target = topic.split("/")[2] || "node";
        this.onCommand?.(target, msg);
      } catch {
        // Ignore malformed MQTT command JSON
      }
    });
  }

  publish(topic, data) {
    if (!this.client?.connected) return;
    this.publishedCount += 1;
    this.client.publish(topic, JSON.stringify(data));
  }

  async stop() {
    if (this.client) {
      await new Promise((resolve) => this.client.end(true, resolve));
    }
    if (this.aedes) {
      await new Promise((resolve) => this.aedes.close(resolve));
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}
