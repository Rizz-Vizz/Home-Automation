"""End-to-end COM6 hardware verification harness for ELLY Edge FRDM-MCXN236 firmware."""

import argparse
import hashlib
import hmac
import json
import sys
import time
import serial

import os


def load_master_hex(cli_value: str) -> str:
    """Master secret comes from --key-hex or gateway/.env (ELLY_MASTER_KEY), never from source."""
    if cli_value:
        return cli_value.strip()
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", "gateway", ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("ELLY_MASTER_KEY="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    sys.exit("No master key: run firmware/tools/gen_secrets.py or pass --key-hex")


def derive_device_key(master_hex: str, uid_hex: str) -> bytes:
    return hmac.new(bytes.fromhex(master_hex), f"ELLY-DEV1|{uid_hex}".encode("utf-8"), hashlib.sha256).digest()


def sign_command(cmd: str, arg: str, role: str, seq: int, nonce: int, key: bytes) -> dict:
    canonical = f"{cmd}|{arg}|{role}|{seq}|{nonce}".encode("utf-8")
    sig = hmac.new(key, canonical, hashlib.sha256).hexdigest()
    return {"cmd": cmd, "arg": arg, "role": role, "seq": seq, "sig": sig}


class BoardClient:
    def __init__(self, port: str, baud: int, master_hex: str):
        self.ser = serial.Serial(port, baud, timeout=0.25)
        self.master_hex = master_hex
        self.key = None
        self.nonce = None
        self.seq = 0
        self.lines = []

    def close(self):
        if self.ser and self.ser.is_open:
            self.ser.close()

    def _read_available(self, wait_s: float):
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            raw = self.ser.readline()
            if not raw:
                continue
            text = raw.decode("utf-8", errors="replace").strip()
            if not text.startswith("{"):
                continue
            try:
                msg = json.loads(text)
                self.lines.append(msg)
            except json.JSONDecodeError:
                pass

    def drain(self, wait_s: float = 0.2):
        self._read_available(wait_s)
        out = list(self.lines)
        self.lines.clear()
        return out

    def wait_for(self, predicate, timeout_s: float = 4.0):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            for idx, msg in enumerate(self.lines):
                if predicate(msg):
                    return self.lines.pop(idx)
            self._read_available(0.15)
        raise TimeoutError("Timed out waiting for matching JSON frame from board")

    def send_raw(self, payload: dict):
        line = json.dumps(payload, separators=(",", ":")) + "\n"
        self.ser.write(line.encode("utf-8"))
        self.ser.flush()

    def identify(self, telem: dict):
        self.key = derive_device_key(self.master_hex, telem["uid"])
        self.nonce = int(telem["nonce"])
        self.seq = int(telem.get("last_seq", 0))

    def send_cmd(self, cmd: str, arg: str = "", role: str = "owner", seq_override=None):
        seq = self.seq if seq_override is None else seq_override
        if seq_override is None:
            self.seq += 1
        pkt = sign_command(cmd, arg, role, seq, self.nonce, self.key)
        self.send_raw(pkt)
        if cmd == "flash_id":
            pred = lambda m: m.get("type") == "flash_id"
        elif cmd == "can_diag":
            pred = lambda m: m.get("type") == "can"
        elif cmd == "audit_dump":
            pred = lambda m: m.get("type") == "audit_begin"
        else:
            pred = lambda m: m.get("type") == "ack" and m.get("cmd") == cmd
        return pkt, self.wait_for(pred, timeout_s=3.5)


def run_verification(args) -> int:
    client = BoardClient(args.port, args.baud, load_master_hex(args.key_hex))
    results = []

    def record(name: str, passed: bool, detail: str):
        tag = "PASS" if passed else "FAIL"
        print(f"[{tag}] {name}: {detail}")
        results.append((name, passed))

    try:
        client.drain(0.6)
        # Synchronize seq strictly above the board's current anti-replay counter
        first_telem = client.wait_for(lambda m: m.get("type") == "telem", timeout_s=3.0)
        client.identify(first_telem)
        board_seq = client.seq
        _, _ = client.send_cmd("heartbeat", "", role="system")

        _, ping = client.send_cmd("ping")
        uid = ping.get("uid", "")
        record(
            "Ping + Chip UID + Hardware Init",
            ping.get("ok") is True and len(uid) == 32 and ping.get("can_ok") is True,
            f"uid={uid} jedec={ping.get('jedec')} flash_ok={ping.get('flash_ok')} can_ok={ping.get('can_ok')}",
        )

        _, fid = client.send_cmd("flash_id")
        record(
            "W25Q64 JEDEC Verification",
            fid.get("ok") is True and fid.get("jedec") == "ef4017",
            f"jedec={fid.get('jedec')} dev={fid.get('dev')} audit_n={fid.get('audit_n')}",
        )

        telem = client.wait_for(lambda m: m.get("type") == "telem", timeout_s=2.5)
        accel_mag = (telem["ax"] ** 2 + telem["ay"] ** 2 + telem["az"] ** 2) ** 0.5
        sensors_ok = (
            telem.get("accel_ok") is True
            and 500 <= accel_mag <= 1600
            and 10.0 <= telem.get("temp_c", 0.0) <= 85.0
            and 0.0 <= telem.get("lux", -1.0) <= 5000.0
            and 25.0 <= telem.get("db", 0.0) <= 120.0
        )
        record(
            "Live Sensors (FXLS8974 / LPADC / PDM0)",
            sensors_ok,
            f"accel_mag={accel_mag:.0f}mg temp={telem.get('temp_c')}C lux={telem.get('lux')} db={telem.get('db')}",
        )

        _, can_ack = client.send_cmd("can_diag")
        record("CAN1 Loopback Diagnostic", can_ack.get("ok") is True, json.dumps(can_ack))

        _, rgb_ack = client.send_cmd("rgb", "0,75,90")
        record("CTIMER3 RGB PWM Control", rgb_ack.get("ok") is True, json.dumps(rgb_ack))

        # Security check 1: bad HMAC
        bad_pkt = sign_command("light", "on", "owner", client.seq + 1, client.nonce, client.key)
        bad_pkt["sig"] = ("0" if bad_pkt["sig"][0] != "0" else "1") + bad_pkt["sig"][1:]
        client.send_raw(bad_pkt)
        bad_ack = client.wait_for(
            lambda m: m.get("type") == "ack" and m.get("cmd") == "light", timeout_s=2.5
        )
        record("HMAC-SHA256 Tamper Rejection", bad_ack.get("err") == "bad_hmac", json.dumps(bad_ack))

        # Security check 2: anti-replay using stale counter
        _, rep_ack = client.send_cmd("light", "on", "owner", seq_override=max(1, client.seq - 2))
        record("Anti-Replay Rejection", rep_ack.get("err") == "replay_rejected", json.dumps(rep_ack))

        # Security check 2b: a command signed for another boot session must not verify
        old_session = sign_command("light", "on", "owner", client.seq + 50, client.nonce + 1, client.key)
        client.send_raw(old_session)
        old_ack = client.wait_for(lambda m: m.get("type") == "ack" and m.get("cmd") == "light", timeout_s=2.5)
        record("Old-Boot Replay Rejection (nonce)", old_ack.get("err") == "bad_hmac", json.dumps(old_ack))

        # Security check 3: Guest RBAC denial
        _, guest_ack = client.send_cmd("away_disarm", "", role="guest")
        record("Guest RBAC Enforcement", guest_ack.get("err") == "rbac_denied", json.dumps(guest_ack))

        # Safety is open to every role: a guest can hit Emergency, but cannot clear it or turn privacy off
        _, em_ack = client.send_cmd("emergency", "", role="guest")
        _, guest_clear = client.send_cmd("safety_clear", "", role="guest")
        _, guest_priv = client.send_cmd("privacy", "off", role="guest")
        _, owner_clear = client.send_cmd("safety_clear", "", role="owner")
        record(
            "Emergency For All Roles, Clear Owner-Only",
            em_ack.get("ok") is True
            and em_ack.get("safety") is True
            and guest_clear.get("err") == "rbac_denied"
            and guest_priv.get("err") == "rbac_denied"
            and owner_clear.get("ok") is True,
            f"emergency={em_ack.get('ok')} guest_clear={guest_clear.get('err')} guest_priv={guest_priv.get('err')}",
        )

        # Safety overrides Automation check
        client.send_cmd("alert_test", "thermal", role="owner")
        _, blocked_ack = client.send_cmd("light", "on", role="owner")
        _, clear_ack = client.send_cmd("safety_clear", "", role="owner")
        _, restored_ack = client.send_cmd("light", "80", role="owner")
        record(
            "Safety Override Precedence",
            blocked_ack.get("err") == "safety_override"
            and clear_ack.get("ok") is True
            and restored_ack.get("ok") is True,
            f"blocked={blocked_ack.get('err')} restored={restored_ack.get('ok')}",
        )

        if not args.skip_edge:
            print("Waiting >4.5s without heartbeat to verify Autonomous Amber Edge Mode + W25Q64 buffering...")
            time.sleep(5.2)
            client.drain(0.3)
            edge_telem = client.wait_for(lambda m: m.get("type") == "telem", timeout_s=2.5)
            time.sleep(2.2)
            _, hb_ack = client.send_cmd("heartbeat", "", role="system")
            time.sleep(0.6)
            burst = client.drain(0.4)
            backfills = [m for m in burst if m.get("type") == "backfill"]
            record(
                "Edge Mode Timeout & W25Q64 Backfill",
                edge_telem.get("edge") is True and hb_ack.get("ok") is True and len(backfills) >= 1,
                f"edge_telem={edge_telem.get('edge')} buffered={edge_telem.get('telem_q')} backfilled={len(backfills)}",
            )

        # Guest RBAC check + scene/away checks
        _, guest_all_off = client.send_cmd("all_off", "", role="guest")
        _, night_ack = client.send_cmd("night", "", role="family")
        _, arm_ack = client.send_cmd("away_arm", "", role="owner")
        _, blocked_away = client.send_cmd("light", "50", role="owner")
        _, disarm_ack = client.send_cmd("away_disarm", "", role="owner")
        _, off_ack = client.send_cmd("all_off", "", role="owner")
        _, restore_light = client.send_cmd("light", "80", role="owner")
        record(
            "Scene Presets (All-Off / Night) & Away Guard",
            guest_all_off.get("err") == "rbac_denied"
            and night_ack.get("ok") is True
            and arm_ack.get("ok") is True
            and blocked_away.get("err") == "away_armed"
            and disarm_ack.get("ok") is True
            and off_ack.get("ok") is True
            and restore_light.get("ok") is True,
            f"guest={guest_all_off.get('err')} away={blocked_away.get('err')} night={night_ack.get('ok')}",
        )

        # Audit hash chain verification
        client.drain(0.2)
        client.send_cmd("audit_dump", "12")
        audits = []
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            for item in client.drain(0.15):
                if item.get("type") == "audit":
                    audits.append(item)
                elif item.get("type") == "audit_end":
                    deadline = 0.0
                    break
        chain_ok = len(audits) >= 2 and all(
            audits[i]["prev"] == audits[i - 1]["hash"][:16] for i in range(1, len(audits))
        )
        record("W25Q64 Hash-Chained Audit Log", chain_ok, f"entries={len(audits)}")

    finally:
        client.close()

    failed = [name for name, ok in results if not ok]
    print(f"\nSummary: {len(results) - len(failed)}/{len(results)} hardware checks passed.")
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description="Verify flashed ELLY Edge FRDM-MCXN236 over COM port.")
    parser.add_argument("--port", default="COM6", help="MCU-Link VCOM serial port")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--key-hex", default="", help="64 hex chars; default reads gateway/.env")
    parser.add_argument("--skip-edge", action="store_true")
    args = parser.parse_args()
    sys.exit(run_verification(args))


if __name__ == "__main__":
    main()
