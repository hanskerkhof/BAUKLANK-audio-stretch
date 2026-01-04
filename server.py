# v4
import asyncio
import json
import logging
import time
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
    format="%(asctime)s.%(msecs)03d | %(levelname)-5s | %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("websockets").setLevel(logging.INFO)
log = logging.getLogger("ws-server")


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


async def ws_handler(ws):
    client = f"{ws.remote_address}"
    client_id = f"{id(ws):x}"
    CLIENTS.add(ws)
    log.info(f"🔗 WS client connected: {client} (id={client_id})")

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

        try:
            # Tell WS clients we have a controller (optional UI feature)
            await broadcast({
                "type": "serial",
                "status": "connected",
                "port": controller.port,
                "deviceId": controller.device_id,
                "fw": controller.fw,
            })

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

            await broadcast({
                "type": "serial",
                "status": "disconnected",
                "port": controller.port,
                "deviceId": controller.device_id,
            })

            # Back to scanning
            await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)


async def main():
    log.info("🚀 Server starting up...")
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

# import asyncio
# import json
# import logging
# import time
# from dataclasses import dataclass
# from typing import Optional, Set
#
# import websockets
# import serial
# import serial.tools.list_ports
#
#
# # =========================
# # Config
# # =========================
# WS_HOST = "localhost"
# WS_PORT = 8765
#
# SERIAL_BAUD = 115200
# SERIAL_SCAN_INTERVAL_SEC = 2.0
# SERIAL_PROBE_TIMEOUT_SEC = 1.0
#
# # Match rules (adjust to your taste)
# TARGET_DEVICE_TYPE = "bauklank-controller"
# # If you only have one controller, you can leave TARGET_DEVICE_ID = None
# TARGET_DEVICE_ID = None  # e.g. "ctrl-01"
#
#
# # =========================
# # Logging
# # =========================
# logging.basicConfig(
#     level=logging.DEBUG,
#     format="%(asctime)s.%(msecs)03d | %(levelname)-5s | %(message)s",
#     datefmt="%H:%M:%S",
# )
# logging.getLogger("websockets").setLevel(logging.INFO)
# log = logging.getLogger("ws-server")
#
#
# # =========================
# # WebSocket client registry
# # =========================
# CLIENTS: Set[websockets.WebSocketServerProtocol] = set()
#
#
# async def broadcast(message: dict):
#     if not CLIENTS:
#         return
#     payload = json.dumps(message)
#     dead = []
#     for ws in CLIENTS:
#         try:
#             await ws.send(payload)
#         except websockets.exceptions.ConnectionClosed:
#             dead.append(ws)
#     for ws in dead:
#         CLIENTS.discard(ws)
#
#
# async def ws_handler(ws):
#     client = f"{ws.remote_address}"
#     client_id = f"{id(ws):x}"
#     CLIENTS.add(ws)
#     log.info(f"🔗 WS client connected: {client} (id={client_id})")
#
#     try:
#         async for raw in ws:
#             # Optional: if later you want browser->server commands, handle them here.
#             log.debug(f"📥 WS from {client_id}: {raw}")
#     except websockets.exceptions.ConnectionClosed as e:
#         log.info(f"🔌 WS client disconnected: {client_id} code={e.code} reason={e.reason}")
#     finally:
#         CLIENTS.discard(ws)
#
#
# # =========================
# # Serial device handling
# # =========================
# @dataclass
# class ControllerInfo:
#     port: str
#     device_id: str
#     device_type: str
#     fw: str
#
#
# def _write_json_line(ser: serial.Serial, message: dict) -> None:
#     line = (json.dumps(message) + "\n").encode("utf-8")
#     ser.write(line)
#     ser.flush()
#
#
# # v2
# def _read_json_line(ser: serial.Serial, *, timeout_sec: float) -> Optional[dict]:
#     start = time.time()
#     while (time.time() - start) < timeout_sec:
#         raw = ser.readline()
#         if not raw:
#             continue
#
#         text = raw.decode("utf-8", errors="replace").strip()
#         if text:
#             log.debug(f"🧪 RX <- {ser.port}: {text}")  # <-- add this
#
#         if not text:
#             continue
#         try:
#             return json.loads(text)
#         except Exception:
#             continue
#     return None
#
# # def _read_json_line(ser: serial.Serial, *, timeout_sec: float) -> Optional[dict]:
# #     """
# #     Blocking read up to one JSON line. Returns dict or None on timeout/bad data.
# #     """
# #     start = time.time()
# #     while (time.time() - start) < timeout_sec:
# #         raw = ser.readline()
# #         if not raw:
# #             continue
# #         try:
# #             text = raw.decode("utf-8", errors="replace").strip()
# #             if not text:
# #                 continue
# #             return json.loads(text)
# #         except Exception:
# #             # Non-json noise is allowed; just ignore.
# #             continue
# #     return None
#
#
# def _probe_port_for_controller(port: str) -> Optional[ControllerInfo]:
#     """
#     Open a port briefly, ask whoareyou, wait for hello.
#     """
#     try:
#         ser = serial.Serial(port=port, baudrate=SERIAL_BAUD, timeout=0.1)
#     except Exception as e:
#         log.debug(f"🧪 Probe open failed: {port} ({e})")
#         return None
#
#     try:
#         log.debug(f"🧪 Probing serial port: {port}")
#
#         # Ask device to identify itself
#         probe_msg = {"type": "whoareyou"}
#
#         # DEBUG: show what we send
#         log.debug(f"🧪 TX -> {port}: {probe_msg}")
#
#         _write_json_line(ser, probe_msg)
#
#         # DEBUG: show what we expect
#         expected = {
#             "type": "hello",
#             "deviceType": TARGET_DEVICE_TYPE,
#             "deviceId": TARGET_DEVICE_ID if TARGET_DEVICE_ID is not None else "<any>",
#         }
#         log.debug(f"🧪 EXPECT <- {port}: {expected}")
#
#         msg = _read_json_line(ser, timeout_sec=SERIAL_PROBE_TIMEOUT_SEC)
#         if not msg:
#             log.debug(f"🧪 No response on: {port}")
#             return None
#
#         if msg.get("type") != "hello":
#             log.debug(f"🧪 Unexpected response on {port}: {msg}")
#             return None
#
#         device_type = str(msg.get("deviceType", ""))
#         device_id = str(msg.get("deviceId", ""))
#         fw = str(msg.get("fw", ""))
#
#         if device_type != TARGET_DEVICE_TYPE:
#             log.debug(f"🧪 Not our deviceType on {port}: {device_type}")
#             return None
#
#         if TARGET_DEVICE_ID is not None and device_id != TARGET_DEVICE_ID:
#             log.debug(f"🧪 Not our deviceId on {port}: {device_id}")
#             return None
#
#         log.info(f"✅ Found controller on {port}: deviceId={device_id} fw={fw}")
#         return ControllerInfo(port=port, device_id=device_id, device_type=device_type, fw=fw)
#
#     except Exception as e:
#         log.debug(f"🧪 Probe error on {port}: {e}")
#         return None
#     finally:
#         try:
#             ser.close()
#         except Exception:
#             pass
#
#
# def _list_candidate_ports() -> list[str]:
#     ports = []
#     for p in serial.tools.list_ports.comports():
#         ports.append(p.device)
#     return ports
#
#
# async def serial_reader_task():
#     """
#     Keeps trying to find the controller. When found, stays connected and forwards incoming messages to WS.
#     If disconnected, goes back to scanning.
#     """
#     while True:
#         ports = _list_candidate_ports()
#         log.debug(f"🔎 Serial scan: {ports}")
#
#         controller = None
#         for port in ports:
#             controller = await asyncio.to_thread(_probe_port_for_controller, port)
#             if controller:
#                 break
#
#         if not controller:
#             await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)
#             continue
#
#         # We found it — now open “for real” and stream messages
#         try:
#             ser = serial.Serial(port=controller.port, baudrate=SERIAL_BAUD, timeout=0.2)
#         except Exception as e:
#             log.warning(f"⚠️ Could not open controller port {controller.port}: {e}")
#             await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)
#             continue
#
#         log.info(f"🎛️ Controller connected on {controller.port} (deviceId={controller.device_id})")
#
#         try:
#             # Tell WS clients we have a controller (optional UI feature)
#             await broadcast({
#                 "type": "serial",
#                 "status": "connected",
#                 "port": controller.port,
#                 "deviceId": controller.device_id,
#                 "fw": controller.fw,
#             })
#
#             while True:
#                 raw = ser.readline()
#                 if not raw:
#                     continue
#
#                 text = raw.decode("utf-8", errors="replace").strip()
#                 if not text:
#                     continue
#
#                 # Debug: show raw serial line
#                 log.debug(f"📟 SERIAL {controller.port}: {text}")
#
#                 try:
#                     msg = json.loads(text)
#                 except Exception:
#                     continue
#
#                 # Only forward "set" messages (or forward all if you prefer)
#                 if msg.get("type") == "set":
#                     # Forward as-is to the web app
#                     await broadcast(msg)
#                 elif msg.get("type") == "hello":
#                     # Could happen if ESP prints hello on its own; ignore or log
#                     pass
#                 else:
#                     # For now: ignore other types
#                     pass
#
#         except Exception as e:
#             log.warning(f"🔌 Controller disconnected / read error on {controller.port}: {e}")
#         finally:
#             try:
#                 ser.close()
#             except Exception:
#                 pass
#
#             await broadcast({
#                 "type": "serial",
#                 "status": "disconnected",
#                 "port": controller.port,
#                 "deviceId": controller.device_id,
#             })
#
#             # Back to scanning
#             await asyncio.sleep(SERIAL_SCAN_INTERVAL_SEC)
#
#
# async def main():
#     log.info("🚀 Server starting up...")
#     log.info(f"🌐 WS on ws://{WS_HOST}:{WS_PORT}")
#     log.info(f"🔧 Serial: baud={SERIAL_BAUD} scanEvery={SERIAL_SCAN_INTERVAL_SEC}s probeTimeout={SERIAL_PROBE_TIMEOUT_SEC}s")
#     log.info(f"🎯 Match: deviceType={TARGET_DEVICE_TYPE} deviceId={TARGET_DEVICE_ID}")
#
#     async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
#         log.info("✅ WebSocket server started")
#
#         # Start serial task
#         serial_task = asyncio.create_task(serial_reader_task())
#
#         # Run forever
#         await serial_task
#
#
# if __name__ == "__main__":
#     try:
#         asyncio.run(main())
#     except KeyboardInterrupt:
#         pass
#
#
# # import asyncio
# # import json
# # import logging
# # import random
# # import signal
# # import time
# # import websockets
# #
# #
# # # =========================
# # # Parameters
# # # =========================
# # MIN_RATE = 0.25
# # MAX_RATE = 2.0
# # THRESHOLD = 1.0
# # BELOW_THRESHOLD_WEIGHT = 3   # higher => more likely < THRESHOLD
# # SLEEP_DURATION = 2
# #
# #
# # # =========================
# # # Logging setup
# # # =========================
# # logging.basicConfig(
# #     level=logging.DEBUG,  # change to logging.INFO for less noise
# #     format="%(asctime)s.%(msecs)03d | %(levelname)-5s | %(message)s",
# #     datefmt="%H:%M:%S",
# # )
# # logging.getLogger("websockets").setLevel(logging.INFO)
# # log = logging.getLogger("ws-server")
# #
# #
# # def weighted_random_rate(*, min_rate, max_rate, threshold, below_threshold_weight):
# #     """
# #     Picks a random rate between min_rate..max_rate, but biases towards values below threshold.
# #     """
# #     if min_rate >= max_rate:
# #         raise ValueError(f"MIN_RATE must be < MAX_RATE (got {min_rate} >= {max_rate})")
# #
# #     threshold = max(min(threshold, max_rate), min_rate)
# #
# #     below_range = max(0.0, threshold - min_rate)
# #     above_range = max(0.0, max_rate - threshold)
# #
# #     # If threshold is at an extreme, fallback to uniform
# #     if below_range == 0.0 or above_range == 0.0:
# #         return random.uniform(min_rate, max_rate)
# #
# #     # Weighted choice: below gets multiplied weight
# #     below_weight = below_range * below_threshold_weight
# #     above_weight = above_range * 1.0
# #     pick = random.uniform(0.0, below_weight + above_weight)
# #
# #     if pick < below_weight:
# #         # pick in below part
# #         t = pick / below_weight
# #         return min_rate + t * below_range
# #     else:
# #         # pick in above part
# #         t = (pick - below_weight) / above_weight
# #         return threshold + t * above_range
# #
# #
# # async def handler(websocket):
# #     client = f"{websocket.remote_address}"
# #     client_id = f"{id(websocket):x}"
# #
# #     sent_count = 0
# #     start_time = time.time()
# #
# #     log.info(f"🔗 Client connected: {client} (id={client_id})")
# #
# #     try:
# #         # Optional: show any incoming messages (handy later if you add control from browser -> server)
# #         async def receive_loop():
# #             try:
# #                 async for raw in websocket:
# #                     log.debug(f"📥 Received from {client_id}: {raw}")
# #             except websockets.exceptions.ConnectionClosed:
# #                 pass
# #
# #         receive_task = asyncio.create_task(receive_loop())
# #
# #         while True:
# #             rate_value = weighted_random_rate(
# #                 min_rate=MIN_RATE,
# #                 max_rate=MAX_RATE,
# #                 threshold=THRESHOLD,
# #                 below_threshold_weight=BELOW_THRESHOLD_WEIGHT,
# #             )
# #
# #             msg_rate = {"type": "rate", "value": rate_value}
# #             await websocket.send(json.dumps(msg_rate))
# #             sent_count += 1
# #             log.debug(f"📤 Sent to {client_id}: {msg_rate}")
# #
# #             random_pitch = random.choice([True, False])
# #             msg_pitch = {"type": "pitch", "value": random_pitch}
# #             await websocket.send(json.dumps(msg_pitch))
# #             sent_count += 1
# #             log.debug(f"📤 Sent to {client_id}: {msg_pitch}")
# #
# #             # Random volume (1..100) for testing
# #             random_volume = random.randint(1, 100)
# #             msg_volume = {"type": "volume", "value": random_volume}
# #             await websocket.send(json.dumps(msg_volume))
# #             sent_count += 1
# #             log.debug(f"📤 Sent to {client_id}: {msg_volume}")
# #
# #             await asyncio.sleep(SLEEP_DURATION)
# #
# #         # while True:
# #         #     rate_value = weighted_random_rate(
# #         #         min_rate=MIN_RATE,
# #         #         max_rate=MAX_RATE,
# #         #         threshold=THRESHOLD,
# #         #         below_threshold_weight=BELOW_THRESHOLD_WEIGHT,
# #         #     )
# #         #
# #         #     msg_rate = {"type": "rate", "value": rate_value}
# #         #     await websocket.send(json.dumps(msg_rate))
# #         #     sent_count += 1
# #         #     log.debug(f"📤 Sent to {client_id}: {msg_rate}")
# #         #
# #         #     random_pitch = random.choice([True, False])
# #         #     msg_pitch = {"type": "pitch", "value": random_pitch}
# #         #     await websocket.send(json.dumps(msg_pitch))
# #         #     sent_count += 1
# #         #     log.debug(f"📤 Sent to {client_id}: {msg_pitch}")
# #         #
# #         #     await asyncio.sleep(SLEEP_DURATION)
# #
# #     except websockets.exceptions.ConnectionClosed as e:
# #         log.info(f"🔌 Client disconnected: {client} (id={client_id}) code={e.code} reason={e.reason}")
# #     except Exception:
# #         log.exception(f"💥 Handler crashed for client {client} (id={client_id})")
# #     finally:
# #         elapsed = time.time() - start_time
# #         log.info(f"🧾 Client session ended: id={client_id} sent={sent_count} elapsed={elapsed:.1f}s")
# #
# #
# # async def main():
# #     log.info("🚀 Server starting up...")
# #     log.info(
# #         "📊 Parameters: "
# #         f"MIN_RATE={MIN_RATE}, MAX_RATE={MAX_RATE}, THRESHOLD={THRESHOLD}, "
# #         f"BELOW_THRESHOLD_WEIGHT={BELOW_THRESHOLD_WEIGHT}, SLEEP_DURATION={SLEEP_DURATION}"
# #     )
# #
# #     async with websockets.serve(handler, "localhost", 8765):
# #         log.info("🌐 WebSocket server started on ws://localhost:8765")
# #
# #         # Keep running until Ctrl+C / SIGTERM
# #         stop_event = asyncio.Event()
# #
# #         def request_stop(*_args):
# #             log.info("🛑 Stop requested (signal). Shutting down...")
# #             stop_event.set()
# #
# #         loop = asyncio.get_running_loop()
# #         for sig in (signal.SIGINT, signal.SIGTERM):
# #             try:
# #                 loop.add_signal_handler(sig, request_stop)
# #             except NotImplementedError:
# #                 # Windows / some environments
# #                 pass
# #
# #         await stop_event.wait()
# #
# #     log.info("✅ Server shutdown complete.")
# #
# #
# # if __name__ == "__main__":
# #     asyncio.run(main())
