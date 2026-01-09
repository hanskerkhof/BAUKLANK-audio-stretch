import asyncio
import json
import logging
import time
import socket
import platform
import getpass
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Set, Dict

import websockets
import serial
import serial.tools.list_ports

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
# These are "system/virtual" ports you never want to probe.
SERIAL_PORT_EXCLUDE: Set[str] = {
    "/dev/cu.debug-console",
    "/dev/cu.Bluetooth-Incoming-Port",
}

# Engine slots (extend later: ["A","B","C"...])
ENGINE_SLOTS = ["A", "B"]

# ✅ Stable mapping: controller deviceId -> engine slot
# This lets your ESP8266 controller firmware stay generic.
DEVICE_ID_TO_ENGINE: Dict[str, str] = {
    "BHS_CNTRL_1": "A",
    "BHS_CNTRL_2": "B",
    "BHS_CNTRL_3": "A",
    "BHS_CNTRL_4": "B",
}

# ✅ Strict allowlist:
# If True, ONLY controllers whose deviceId is listed in DEVICE_ID_TO_ENGINE are accepted.
STRICT_DEVICE_ID_ALLOWLIST = True

# =========================
# Logging
# =========================
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s.%(msecs)03d | %(levelname)-5s | %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("websockets").setLevel(logging.INFO)
log = logging.getLogger("ws-server-multi")


# =========================
# Version
# =========================
def load_server_version() -> str:
    try:
        version_file = Path(__file__).with_name("version.json")
        data = json.loads(version_file.read_text(encoding="utf-8"))
        v = data.get("version")
        return str(v) if v else "0.0.0"
    except Exception:
        return "0.0.0"


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
    hostname = ""
    try:
        hostname = socket.gethostname()
    except Exception:
        hostname = ""

    platform_label = ""
    try:
        platform_label = f"{platform.system()} {platform.release()}".strip()
    except Exception:
        platform_label = ""

    machine = ""
    try:
        machine = platform.machine()
    except Exception:
        machine = ""

    user = ""
    try:
        user = getpass.getuser()
    except Exception:
        user = ""

    ips = _get_all_ipv4()
    primary_ip = ips[0] if ips else ""

    # Multi app expects "type":"machineStatus"
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
    "version": load_server_version(),
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
        for engine_id in ENGINE_SLOTS:
            await ws.send(json.dumps(current_controller_status(engine_id)))
    except Exception as e:
        log.debug(f"⚠️ Could not send initial status to {client_id}: {e}")

    try:
        async for raw in ws:
            # Optional: handle browser->server messages later
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

        # Skip non-JSON debug lines
        if not text.startswith("{"):
            continue

        try:
            return json.loads(text)
        except Exception:
            continue
    return None


def _probe_port_for_controller(port: str) -> Optional[ControllerInfo]:
    """
    Open a port briefly, ask whoareyou, wait for hello.
    """
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

        # ✅ Strict allowlist (prevents mystery controllers from attaching)
        if STRICT_DEVICE_ID_ALLOWLIST and device_id not in DEVICE_ID_TO_ENGINE:
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
# Multi-controller state
# =========================
ENGINE_TO_CONTROLLER: Dict[str, ControllerInfo] = {}  # engine -> ControllerInfo
PORT_TO_ENGINE: Dict[str, str] = {}  # port -> engine
PORT_TASKS: Dict[str, asyncio.Task] = {}  # port -> task


def current_controller_status(engine_id: str) -> dict:
    info = ENGINE_TO_CONTROLLER.get(engine_id)
    if not info:
        return {"type": "controllerStatus", "engine": engine_id, "connected": False}
    return {
        "type": "controllerStatus",
        "engine": engine_id,
        "connected": True,
        "port": info.port,
        "deviceId": info.device_id,
        "fw": info.fw,
    }


def assign_engine_for_controller(info: ControllerInfo) -> Optional[str]:
    """
    Decide which engine slot this controller should drive.
    Priority:
      1) deviceId mapping (DEVICE_ID_TO_ENGINE)
      2) first free slot
    """
    desired = DEVICE_ID_TO_ENGINE.get(info.device_id)
    if desired:
        if desired not in ENGINE_SLOTS:
            log.warning(f"⚠️ deviceId={info.device_id} mapped to invalid engine slot: {desired}")
            return None

        occupied = ENGINE_TO_CONTROLLER.get(desired)
        if occupied and occupied.device_id != info.device_id:
            log.warning(
                f"⚠️ Engine slot {desired} already occupied by deviceId={occupied.device_id}; "
                f"cannot assign deviceId={info.device_id}"
            )
            return None
        return desired

    # Fallback: first free engine slot
    for engine_id in ENGINE_SLOTS:
        if engine_id not in ENGINE_TO_CONTROLLER:
            return engine_id
    return None


async def serial_port_task(engine_id: str, info: ControllerInfo):
    """
    Open a controller port and forward incoming {"type":"set",...} to WS,
    tagging with engine="A"/"B".
    """
    port = info.port
    try:
        ser = serial.Serial(port=port, baudrate=SERIAL_BAUD, timeout=0.2)
    except Exception as e:
        log.warning(f"⚠️ Could not open controller port {port}: {e}")
        return

    log.info(f"🎛️ Controller {engine_id} connected on {port} (deviceId={info.device_id})")

    ENGINE_TO_CONTROLLER[engine_id] = info
    PORT_TO_ENGINE[port] = engine_id

    await broadcast(current_controller_status(engine_id))

    try:
        while True:
            raw = await asyncio.to_thread(ser.readline)
            if not raw:
                continue

            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                continue

            log.debug(f"📟 SERIAL {engine_id} {port}: {text}")

            try:
                msg = json.loads(text)
            except Exception:
                continue

            if msg.get("type") == "set":
                if "engine" not in msg:
                    msg["engine"] = engine_id
                await broadcast(msg)

    except Exception as e:
        log.warning(f"🔌 Controller {engine_id} disconnected / read error on {port}: {e}")
    finally:
        try:
            ser.close()
        except Exception:
            pass

        if ENGINE_TO_CONTROLLER.get(engine_id) and ENGINE_TO_CONTROLLER[engine_id].port == port:
            del ENGINE_TO_CONTROLLER[engine_id]
        if PORT_TO_ENGINE.get(port) == engine_id:
            del PORT_TO_ENGINE[port]

        await broadcast(current_controller_status(engine_id))


async def serial_manager_task():
    """
    Scans ports and attaches up to ENGINE_SLOTS controllers concurrently.
    """
    while True:
        try:
            ports = _list_candidate_ports()
            log.debug(f"🔎 Serial scan: {ports}")

            # If we have free slots, probe ports not already connected
            free_slots = [e for e in ENGINE_SLOTS if e not in ENGINE_TO_CONTROLLER]
            if free_slots:
                for port in ports:
                    if port in PORT_TO_ENGINE:
                        continue

                    info = await asyncio.to_thread(_probe_port_for_controller, port)
                    if not info:
                        continue

                    # ✅ If the same deviceId is already connected, ignore this port.
                    # This prevents one physical controller (or a ghost port) from attaching twice.
                    if any(ci.device_id == info.device_id for ci in ENGINE_TO_CONTROLLER.values()):
                        log.info(
                            f"🛑 Ignoring {port}: deviceId={info.device_id} already connected on "
                            f"{[ci.port for ci in ENGINE_TO_CONTROLLER.values() if ci.device_id == info.device_id][0]}"
                        )
                        continue

                    engine_id = assign_engine_for_controller(info)
                    if not engine_id:
                        log.info(
                            f"⚠️ Found controller deviceId={info.device_id} on {port} "
                            f"but no assignable engine slot."
                        )
                        continue

                    PORT_TASKS[port] = asyncio.create_task(serial_port_task(engine_id, info))

                    free_slots = [e for e in ENGINE_SLOTS if e not in ENGINE_TO_CONTROLLER]
                    if not free_slots:
                        break

            # Clean up finished tasks
            dead_ports = [p for p, t in PORT_TASKS.items() if t.done()]
            for p in dead_ports:
                try:
                    _ = PORT_TASKS[p].result()
                except Exception:
                    pass
                del PORT_TASKS[p]

        except Exception as e:
            log.debug(f"⚠️ serial_manager_task loop error: {e}")

        await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)


async def main():
    log.info(f"🚀 Signalsmith Multi Control Server v{SERVER_VERSION_MSG.get('version', '0.0.0')} starting up...")
    log.info(f"🌐 WS on ws://{WS_HOST}:{WS_PORT}")
    log.info(f"🔧 Serial: baud={SERIAL_BAUD} scanEvery={SERIAL_SCAN_INTERVAL_SEC}s probeTimeout={SERIAL_PROBE_TIMEOUT_SEC}s")
    log.info(f"🎯 Match: deviceType={TARGET_DEVICE_TYPE}")
    log.info(f"🎚️ Engine slots: {ENGINE_SLOTS}")
    log.info(f"🔒 deviceId->engine mapping: {DEVICE_ID_TO_ENGINE}")
    log.info(f"🧷 strict allowlist: {STRICT_DEVICE_ID_ALLOWLIST}")

    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        log.info("✅ WebSocket server started")

        await asyncio.gather(
            asyncio.create_task(serial_manager_task()),
            asyncio.create_task(machine_status_task()),
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
