# v2.9
import asyncio
import json
import logging
import time
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Set

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

# Match rules (adjust to your taste)
TARGET_DEVICE_TYPE = "bauklank-controller"
# If you only have one controller, you can leave TARGET_DEVICE_ID = None
TARGET_DEVICE_ID = None  # e.g. "ctrl-01"


# =========================
# Logging
# =========================
logging.basicConfig(
    level=logging.DEBUG,
    # level=logging.WARNING,
    format="%(asctime)s.%(msecs)03d | %(levelname)-5s | %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("websockets").setLevel(logging.INFO)
log = logging.getLogger("ws-server")

# =========================
# Version
# =========================
def load_server_version() -> str:
    """Load semantic version string from version.json sitting next to this script."""
    try:
        version_file = Path(__file__).with_name("version.json")
        data = json.loads(version_file.read_text(encoding="utf-8"))
        version = data.get("version")
        return str(version) if version else "0.0.0"
    except Exception:
        return "0.0.0"


SERVER_STATE: dict = {
    "type": "server",
    "version": load_server_version(),
}


# =========================
# WebSocket client registry
# =========================
CLIENTS: Set[websockets.WebSocketServerProtocol] = set()

# Cached controller state (so new WS clients immediately see current status)
# Shape:
#   {"type":"controller","status":"disconnected"}
# or
#   {"type":"controller","status":"connected","port":"...","deviceId":"...","fw":"..."}
CONTROLLER_STATE: dict = {
    "type": "controller",
    "status": "disconnected",
}



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


async def ws_handler(ws):
    client = f"{ws.remote_address}"
    client_id = f"{id(ws):x}"
    CLIENTS.add(ws)
    log.info(f"🔗 WS client connected: {client} (id={client_id})")

    # Immediately inform this client about current server + controller status
    try:
        await ws.send(json.dumps(SERVER_STATE))
    except Exception as e:
        log.debug(f"⚠️ Could not send initial server status to {client_id}: {e}")

    try:
        await ws.send(json.dumps(CONTROLLER_STATE))
    except Exception as e:
        log.debug(f"⚠️ Could not send initial controller status to {client_id}: {e}")

    # Immediately inform this client about current controller status
    try:
        await ws.send(json.dumps(CONTROLLER_STATE))
    except Exception as e:
        log.debug(f"⚠️ Could not send initial controller status to {client_id}: {e}")

    try:
        async for raw in ws:
            # Optional: if later you want browser->server commands, handle them here.
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


# v2
def _read_json_line(ser: serial.Serial, *, timeout_sec: float) -> Optional[dict]:
    start = time.time()
    while (time.time() - start) < timeout_sec:
        raw = ser.readline()
        if not raw:
            continue

        text = raw.decode("utf-8", errors="replace").strip()
        if text:
            log.debug(f"🧪 RX <- {ser.port}: {text}")

        # ✅ Skip non-JSON debug lines like: "DBG volume=42"
        if not text.startswith("{"):
            continue

        if not text:
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

        # Ask device to identify itself
        probe_msg = {"type": "whoareyou"}

        # DEBUG: show what we send
        log.debug(f"🧪 TX -> {port}: {probe_msg}")

        _write_json_line(ser, probe_msg)

        # DEBUG: show what we expect
        expected = {
            "type": "hello",
            "deviceType": TARGET_DEVICE_TYPE,
            "deviceId": TARGET_DEVICE_ID if TARGET_DEVICE_ID is not None else "<any>",
        }
        log.debug(f"🧪 EXPECT <- {port}: {expected}")

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

        if TARGET_DEVICE_ID is not None and device_id != TARGET_DEVICE_ID:
            log.debug(f"🧪 Not our deviceId on {port}: {device_id}")
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
    ports = []
    for p in serial.tools.list_ports.comports():
        ports.append(p.device)
    return ports


async def serial_reader_task():
    """
    Keeps trying to find the controller. When found, stays connected and forwards incoming messages to WS.
    If disconnected, goes back to scanning.
    """
    while True:
        ports = _list_candidate_ports()
        log.debug(f"🔎 Serial scan: {ports}")

        controller = None
        for port in ports:
            controller = await asyncio.to_thread(_probe_port_for_controller, port)
            if controller:
                break

        if not controller:
            await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)
            continue

        # We found it — now open “for real” and stream messages
        try:
            ser = serial.Serial(port=controller.port, baudrate=SERIAL_BAUD, timeout=0.2)
        except Exception as e:
            log.warning(f"⚠️ Could not open controller port {controller.port}: {e}")
            await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)
            continue

        log.info(f"🎛️ Controller connected on {controller.port} (deviceId={controller.device_id})")

        try:            # Tell WS clients we have a controller (optional UI feature)
            CONTROLLER_STATE.update({
                "type": "controller",
                "status": "connected",
                "port": controller.port,
                "deviceId": controller.device_id,
                "fw": controller.fw,
            })
            await broadcast(CONTROLLER_STATE)

            while True:
                # ✅ IMPORTANT: don't block the asyncio loop with a sync readline()
                raw = await asyncio.to_thread(ser.readline)

                if not raw:
                    continue

                text = raw.decode("utf-8", errors="replace").strip()
                if not text:
                    continue

                # Debug: show raw serial line
                log.debug(f"📟 SERIAL {controller.port}: {text}")

                try:
                    msg = json.loads(text)
                except Exception:
                    continue

                # Only forward "set" messages (or forward all if you prefer)
                if msg.get("type") == "set":
                    # Forward as-is to the web app
                    await broadcast(msg)
                elif msg.get("type") == "hello":
                    # Could happen if ESP prints hello on its own; ignore or log
                    pass
                else:
                    # For now: ignore other types
                    pass

        except Exception as e:
            log.warning(f"🔌 Controller disconnected / read error on {controller.port}: {e}")
        finally:
            try:
                ser.close()
            except Exception:
                pass

            CONTROLLER_STATE.update({
                "type": "controller",
                "status": "disconnected",
                "port": controller.port,
                "deviceId": controller.device_id,
            })
            await broadcast(CONTROLLER_STATE)

            # Back to scanning
            await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)


async def main():
    log.info(f"🚀 Signalsmith Control Server v{SERVER_STATE.get('version', '0.0.0')} starting up...")
    log.info(f"🌐 WS on ws://{WS_HOST}:{WS_PORT}")
    log.info(f"🔧 Serial: baud={SERIAL_BAUD} scanEvery={SERIAL_SCAN_INTERVAL_SEC}s probeTimeout={SERIAL_PROBE_TIMEOUT_SEC}s")
    log.info(f"🎯 Match: deviceType={TARGET_DEVICE_TYPE} deviceId={TARGET_DEVICE_ID}")

    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        log.info("✅ WebSocket server started")

        # Start serial task
        serial_task = asyncio.create_task(serial_reader_task())

        # Run forever
        await serial_task


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

