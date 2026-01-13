import asyncio
import argparse
import json
import logging
import time
import subprocess
import socket
import platform
import getpass
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Set, Dict

import websockets
import serial
import serial.tools.list_ports

# ============================================================
# server-multi-both.py
#
# Purpose
# -------
# Single-controller serial bridge that accepts per-channel JSON
# messages from ONE controller and forwards them over WebSocket
# tagged as engine A/B.
#
# Expected serial input (newline-delimited JSON)
# ------------------------------------------------
# {"type":"set","channel":"A","key":"volume","value":7}
# {"type":"set","channel":"B","key":"volume","value":12}
#
# WebSocket output
# ----------------
# Same payload, plus `engine` (A/B). We keep `channel` too.
#
# Why this exists
# ---------------
# Your previous server expected a single-engine payload:
#   {"type":"set","key":"volume","value":7}
# This server supports BOTH engines from a single controller.
# ============================================================

# =========================
# Config
# =========================
WS_HOST = "localhost"
WS_PORT = 8765

SERIAL_BAUD = 115200
SERIAL_SCAN_INTERVAL_SEC = 2.0
SERIAL_PROBE_TIMEOUT_SEC = 1.0

# Match rules
TARGET_DEVICE_TYPE = "bauklank-controller"

# ✅ Serial port exclude list (exact device paths)
SERIAL_PORT_EXCLUDE: Set[str] = {
    "/dev/cu.debug-console",
    "/dev/cu.Bluetooth-Incoming-Port",
}

# Engines carried over WebSocket
ENGINE_SLOTS = ["A", "B"]

# =========================
# CLI
# =========================
def _parse_args():
    parser = argparse.ArgumentParser(
        description="BAUKLANK multi-engine controller bridge (serial -> websocket)."
    )

    parser.add_argument(
        "--engine-count",
        type=int,
        choices=[1, 2],
        default=2,
        help="How many engine slots to serve. Default: 2 (A+B).",
    )
    parser.add_argument(
        "--slot",
        type=str,
        choices=["A", "B"],
        default="A",
        help="When --engine-count=1, which slot to serve (A or B). Default: A.",
    )
    parser.add_argument(
        "--ws-host",
        type=str,
        default=WS_HOST,
        help=f"WebSocket bind host. Default: {WS_HOST}",
    )
    parser.add_argument(
        "--ws-port",
        type=int,
        default=WS_PORT,
        help=f"WebSocket bind port. Default: {WS_PORT}",
    )

    return parser.parse_args()


# ✅ Strict allowlist (optional)
# If True, ONLY controllers whose deviceId is listed here will attach.
STRICT_DEVICE_ID_ALLOWLIST = False
DEVICE_ID_ALLOWLIST: Set[str] = {
    # "BKTP_CTL_01",
}

# ✅ Version display options
APPEND_GIT_HASH_TO_VERSION = True
APPEND_GIT_DIRTY_SUFFIX = True

# ✅ Serial log verbosity options
# "full"   -> log EVERY incoming serial line (very noisy)
# "digest" -> log a compact summary every SERIAL_LOG_DIGEST_EVERY_SEC seconds
# SERIAL_LOG_MODE = "digest"  # "full" | "digest"
SERIAL_LOG_MODE = "full"  # "full" | "digest"
SERIAL_LOG_DIGEST_EVERY_SEC = 5.0
SERIAL_LOG_MAX_KEYS_IN_DIGEST = 10

# ✅ Heartbeat
HEARTBEAT_INTERVAL_SEC = 60.0

# =========================
# Logging
# =========================
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s.%(msecs)03d | %(levelname)-5s | %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("websockets").setLevel(logging.INFO)
log = logging.getLogger("ws-server-multi-both")


# =========================
# Version
# =========================
def _run_git(args: list[str], repo_dir: Path, timeout_s: float = 0.4) -> Optional[str]:
    try:
        res = subprocess.run(
            ["git", *args],
            cwd=str(repo_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout_s,
            check=True,
        )
        out = (res.stdout or "").strip()
        return out if out else None
    except Exception:
        return None


def _git_short_hash(repo_dir: Path) -> Optional[str]:
    return _run_git(["rev-parse", "--short", "HEAD"], repo_dir)


def _git_is_dirty(repo_dir: Path) -> Optional[bool]:
    out = _run_git(["status", "--porcelain"], repo_dir)
    if out is None:
        return None
    return len(out) > 0


def _load_version_json(version_file: Path) -> Optional[str]:
    try:
        raw = version_file.read_text(encoding="utf-8")
    except FileNotFoundError:
        log.warning(f"⚠️ version.json not found at {version_file} — using v0.0.0")
        return None
    except Exception as e:
        log.warning(f"⚠️ Could not read version.json at {version_file} — using v0.0.0 ({e})")
        return None

    try:
        data = json.loads(raw)
    except Exception as e:
        log.warning(f"⚠️ version.json is not valid JSON at {version_file} — using v0.0.0 ({e})")
        return None

    v = data.get("version")
    v = str(v).strip() if v is not None else ""
    if not v:
        log.warning(f"⚠️ version.json missing/empty 'version' at {version_file} — using v0.0.0")
        return None

    return v


def build_server_version() -> str:
    repo_dir = Path(__file__).resolve().parent
    version_file = repo_dir / "version.json"

    base = _load_version_json(version_file) or "0.0.0"

    if not APPEND_GIT_HASH_TO_VERSION:
        return base

    short_hash = _git_short_hash(repo_dir)
    if not short_hash:
        return base

    dirty_suffix = ""
    if APPEND_GIT_DIRTY_SUFFIX:
        dirty = _git_is_dirty(repo_dir)
        if dirty is True:
            dirty_suffix = "-dirty"

    return f"{base}+g{short_hash}{dirty_suffix}"


# =========================
# Machine info (for status bar)
# =========================
def _get_primary_ipv4() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return str(s.getsockname()[0])
        finally:
            s.close()
    except Exception:
        return ""


def _get_all_ipv4() -> list[str]:
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        _name, _aliases, addrs = socket.gethostbyname_ex(hostname)
        for ip in addrs:
            if ip and ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    primary = _get_primary_ipv4()
    if primary and primary not in ips:
        ips.insert(0, primary)

    non_loopback = [ip for ip in ips if not ip.startswith("127.")]
    return non_loopback if non_loopback else ips


def build_machine_status() -> dict:
    try:
        hostname = socket.gethostname()
    except Exception:
        hostname = ""

    try:
        platform_label = f"{platform.system()} {platform.release()}".strip()
    except Exception:
        platform_label = ""

    try:
        machine = platform.machine()
    except Exception:
        machine = ""

    try:
        user = getpass.getuser()
    except Exception:
        user = ""

    ips = _get_all_ipv4()
    primary_ip = ips[0] if ips else ""

    return {
        "type": "machineStatus",
        "hostname": hostname,
        "user": user,
        "platform": platform_label,
        "arch": machine,
        "ip": primary_ip,
        "ips": ips,
        "python": platform.python_version(),
    }


SERVER_VERSION_MSG: dict = {
    "type": "serverVersion",
    "version": build_server_version(),
}

MACHINE_STATUS: dict = build_machine_status()


# =========================
# WebSocket client registry
# =========================
CLIENTS: Set[websockets.WebSocketServerProtocol] = set()


async def broadcast(message: dict):
    if not CLIENTS:
        return
    payload = json.dumps(message)
    dead = []
    for ws in CLIENTS:
        try:
            await ws.send(payload)
        except websockets.exceptions.ConnectionClosed:
            dead.append(ws)
    for ws in dead:
        CLIENTS.discard(ws)


async def machine_status_task():
    global MACHINE_STATUS
    last_payload = json.dumps(MACHINE_STATUS, sort_keys=True)
    while True:
        try:
            next_state = build_machine_status()
            next_payload = json.dumps(next_state, sort_keys=True)
            if next_payload != last_payload:
                MACHINE_STATUS = next_state
                last_payload = next_payload
                await broadcast(MACHINE_STATUS)
        except Exception:
            pass
        await asyncio.sleep(5.0)


async def ws_handler(ws):
    client = f"{ws.remote_address}"
    client_id = f"{id(ws):x}"
    CLIENTS.add(ws)
    log.info(f"🔗 WS client connected: {client} (id={client_id})")

    try:
        await ws.send(json.dumps(SERVER_VERSION_MSG))
        await ws.send(json.dumps(MACHINE_STATUS))
        await ws.send(json.dumps(current_controller_status()))
    except Exception as e:
        log.debug(f"⚠️ Could not send initial status to {client_id}: {e}")

    try:
        async for raw in ws:
            log.debug(f"📥 WS from {client_id}: {raw}")
    except websockets.exceptions.ConnectionClosed as e:
        log.info(f"🔌 WS client disconnected: {client_id} code={e.code} reason={e.reason}")
    finally:
        CLIENTS.discard(ws)


# =========================
# Serial device handling
# =========================
@dataclass
class ControllerInfo:
    port: str
    device_id: str
    device_type: str
    fw: str


def _write_json_line(ser: serial.Serial, message: dict) -> None:
    line = (json.dumps(message) + "\n").encode("utf-8")
    ser.write(line)
    ser.flush()


def _read_json_line(ser: serial.Serial, *, timeout_sec: float) -> Optional[dict]:
    start = time.time()
    while (time.time() - start) < timeout_sec:
        raw = ser.readline()
        if not raw:
            continue

        text = raw.decode("utf-8", errors="replace").strip()
        if text:
            log.debug(f"🧪 RX <- {ser.port}: {text}")

        if not text.startswith("{"):
            continue

        try:
            return json.loads(text)
        except Exception:
            continue
    return None


def _probe_port_for_controller(port: str) -> Optional[ControllerInfo]:
    try:
        ser = serial.Serial(port=port, baudrate=SERIAL_BAUD, timeout=0.1)
    except Exception as e:
        log.debug(f"🧪 Probe open failed: {port} ({e})")
        return None

    try:
        log.debug(f"🧪 Probing serial port: {port}")
        probe_msg = {"type": "whoareyou"}
        log.debug(f"🧪 TX -> {port}: {probe_msg}")
        _write_json_line(ser, probe_msg)

        msg = _read_json_line(ser, timeout_sec=SERIAL_PROBE_TIMEOUT_SEC)
        if not msg:
            log.debug(f"🧪 No response on: {port}")
            return None

        if msg.get("type") != "hello":
            log.debug(f"🧪 Unexpected response on {port}: {msg}")
            return None

        device_type = str(msg.get("deviceType", ""))
        device_id = str(msg.get("deviceId", ""))
        fw = str(msg.get("fw", ""))

        if device_type != TARGET_DEVICE_TYPE:
            log.debug(f"🧪 Not our deviceType on {port}: {device_type}")
            return None

        if STRICT_DEVICE_ID_ALLOWLIST and device_id not in DEVICE_ID_ALLOWLIST:
            log.info(f"🛑 Ignoring controller on {port} with unexpected deviceId={device_id}")
            return None

        log.info(f"✅ Found controller on {port}: deviceId={device_id} fw={fw}")
        return ControllerInfo(port=port, device_id=device_id, device_type=device_type, fw=fw)

    except Exception as e:
        log.debug(f"🧪 Probe error on {port}: {e}")
        return None
    finally:
        try:
            ser.close()
        except Exception:
            pass


def _list_candidate_ports() -> list[str]:
    ports = [p.device for p in serial.tools.list_ports.comports()]
    return [port for port in ports if port not in SERIAL_PORT_EXCLUDE]


# =========================
# Controller state
# =========================
CONTROLLER: Optional[ControllerInfo] = None
SERIAL_TASK: Optional[asyncio.Task] = None


def current_controller_status() -> dict:
    if not CONTROLLER:
        return {"type": "controllerStatus", "connected": False, "engines": ENGINE_SLOTS}

    return {
        "type": "controllerStatus",
        "connected": True,
        "port": CONTROLLER.port,
        "deviceId": CONTROLLER.device_id,
        "fw": CONTROLLER.fw,
        "engines": ENGINE_SLOTS,
    }


async def controller_heartbeat_task():
    while True:
        try:
            if CONTROLLER:
                port_name = Path(CONTROLLER.port).name
                log.info(
                    f"💓 Controller alive: ✅({CONTROLLER.device_id}@{port_name} fw={CONTROLLER.fw}) engines={ENGINE_SLOTS}"
                )
            else:
                log.info("💓 Controller alive: —")
        except Exception as e:
            log.debug(f"⚠️ controller_heartbeat_task loop error: {e}")

        await asyncio.sleep(HEARTBEAT_INTERVAL_SEC)


def _normalize_set_value(msg: dict) -> None:
    key = str(msg.get("key", ""))
    if "value" not in msg:
        return

    raw_val = msg.get("value")
    if key in ("volume", "tone"):
        try:
            msg["value"] = int(raw_val)
        except Exception:
            pass
    elif key == "rate":
        try:
            msg["value"] = float(raw_val)
        except Exception:
            pass


async def serial_port_task(info: ControllerInfo):
    global CONTROLLER

    port = info.port
    try:
        ser = serial.Serial(port=port, baudrate=SERIAL_BAUD, timeout=0.2)
    except Exception as e:
        log.warning(f"⚠️ Could not open controller port {port}: {e}")
        return

    log.info(f"🎛️ Controller connected on {port} (deviceId={info.device_id})")
    CONTROLLER = info
    await broadcast(current_controller_status())

    # Digest accumulators
    digest_started = time.time()
    last_digest = time.time()
    line_count = 0
    json_count = 0
    set_count = 0
    set_key_counts: Dict[str, int] = {}
    last_set_values: Dict[str, object] = {}

    def _emit_digest(force: bool = False) -> None:
        nonlocal last_digest, line_count, json_count, set_count, set_key_counts, last_set_values, digest_started
        if SERIAL_LOG_MODE != "digest":
            return

        now = time.time()
        if not force and (now - last_digest) < SERIAL_LOG_DIGEST_EVERY_SEC:
            return

        if line_count <= 0:
            last_digest = now
            return

        keys_sorted = sorted(set_key_counts.items(), key=lambda kv: kv[1], reverse=True)
        keys_sorted = keys_sorted[: max(1, SERIAL_LOG_MAX_KEYS_IN_DIGEST)]
        parts = []
        for k, n in keys_sorted:
            last_val = last_set_values.get(k, None)
            parts.append(f"{k}×{n} last={last_val}")

        age = now - digest_started
        key_part = " · " + " | ".join(parts) if parts else ""
        log.debug(f"📟 SERIAL {port}: {line_count} lines ({json_count} json, {set_count} set) in {age:.1f}s{key_part}")

        last_digest = now
        digest_started = now
        line_count = 0
        json_count = 0
        set_count = 0
        set_key_counts = {}
        last_set_values = {}

    try:
        while True:
            raw = await asyncio.to_thread(ser.readline)
            if not raw:
                _emit_digest(force=False)
                continue

            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                _emit_digest(force=False)
                continue

            line_count += 1
            if SERIAL_LOG_MODE == "full":
                log.debug(f"📟 SERIAL {port}: {text}")

            try:
                msg = json.loads(text)
                json_count += 1
            except Exception:
                _emit_digest(force=False)
                continue

            if msg.get("type") != "set":
                _emit_digest(force=False)
                continue

            set_count += 1

            channel = str(msg.get("channel", "")).strip().upper()
            if channel not in ENGINE_SLOTS:
                # Ignore legacy messages without channel (or unknown channels)
                _emit_digest(force=False)
                continue

            key = str(msg.get("key", ""))
            if key:
                set_key_counts[key] = set_key_counts.get(key, 0) + 1

            _normalize_set_value(msg)

            if key:
                last_set_values[key] = msg.get("value")

            # Web app compatibility: add engine, keep channel
            msg.setdefault("channel", channel)
            msg["engine"] = channel

            await broadcast(msg)
            _emit_digest(force=False)

    except Exception as e:
        log.warning(f"🔌 Controller disconnected / read error on {port}: {e}")
    finally:
        _emit_digest(force=True)

        try:
            ser.close()
        except Exception:
            pass

        CONTROLLER = None
        await broadcast(current_controller_status())


async def serial_manager_task():
    global SERIAL_TASK

    while True:
        try:
            if SERIAL_TASK and SERIAL_TASK.done():
                try:
                    _ = SERIAL_TASK.result()
                except Exception:
                    pass
                SERIAL_TASK = None

            if not SERIAL_TASK:
                ports = _list_candidate_ports()
                log.debug(f"🔎 Serial scan: {ports}")

                for port in ports:
                    info = await asyncio.to_thread(_probe_port_for_controller, port)
                    if not info:
                        continue

                    SERIAL_TASK = asyncio.create_task(serial_port_task(info))
                    break

        except Exception as e:
            log.debug(f"⚠️ serial_manager_task loop error: {e}")

        await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)


async def main():
    global ENGINE_SLOTS, WS_HOST, WS_PORT

    args = _parse_args()
    WS_HOST = args.ws_host
    WS_PORT = args.ws_port
    ENGINE_SLOTS = [args.slot] if args.engine_count == 1 else ["A", "B"]

    log.info(f"🚀 Multi BOTH Control Server v{SERVER_VERSION_MSG.get('version', '0.0.0')} starting up...")
    log.info(f"🌐 WS on ws://{WS_HOST}:{WS_PORT}")
    log.info(
        f"🔧 Serial: baud={SERIAL_BAUD} scanEvery={SERIAL_SCAN_INTERVAL_SEC}s probeTimeout={SERIAL_PROBE_TIMEOUT_SEC}s"
    )
    log.info(f"🎯 Match: deviceType={TARGET_DEVICE_TYPE}")
    log.info(f"🎚️ Engines: {ENGINE_SLOTS}")
    if STRICT_DEVICE_ID_ALLOWLIST:
        log.info(f"🔒 deviceId allowlist: {sorted(DEVICE_ID_ALLOWLIST)}")

    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        log.info("✅ WebSocket server started")

        await asyncio.gather(
            asyncio.create_task(serial_manager_task()),
            asyncio.create_task(machine_status_task()),
            asyncio.create_task(controller_heartbeat_task()),
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
