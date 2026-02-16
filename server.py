#!/usr/bin/env python3
"""
Wi-Fi Visualizer — Unified Server
Serves both terrain (10Hz) and mesh (10Hz) data over a single
WebSocket server on port 8765, routed by path:
  ws://127.0.0.1:8765/terrain
  ws://127.0.0.1:8765/mesh
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import websockets
from CoreWLAN import CWWiFiClient

# --- Shared CoreWLAN handle ---
_client = CWWiFiClient.sharedWiFiClient()
_iface = _client.interface()

# --- Thread synchronisation ---
_iface_lock = threading.Lock()  # protects all _iface calls (CoreWLAN is not thread-safe)
_lock = threading.Lock()        # protects _cached_nodes
_cached_nodes: list[dict] = []
SCAN_INTERVAL = 3.0


# ────────────────────────────────────────
# Terrain helpers (connected-network data)
# ────────────────────────────────────────

def poll_wifi() -> dict | None:
    try:
        with _iface_lock:
            rssi = _iface.rssiValue()
            noise = _iface.noiseMeasurement()
            tx_rate = _iface.transmitRate()
            ssid = _iface.ssid() or "Unknown"
            ch_obj = _iface.wlanChannel()
            channel = ch_obj.channelNumber() if ch_obj else 0
        snr = rssi - noise

        if rssi == 0 and noise == 0:
            return None

        if rssi >= -50:
            health = "Excellent"
        elif rssi >= -60:
            health = "Good"
        elif rssi >= -70:
            health = "Fair"
        else:
            health = "Poor"

        return {
            "rssi": rssi, "noise": noise, "txRate": int(tx_rate),
            "snr": snr, "ssid": ssid, "channel": channel,
            "health": health, "timestamp": time.time(),
        }
    except Exception:
        return None


async def stream_terrain(websocket):
    print(f"[terrain] client connected: {websocket.remote_address}")
    try:
        while True:
            data = await asyncio.to_thread(poll_wifi)
            msg = json.dumps(data if data else {"error": "No Wi-Fi data"})
            await websocket.send(msg)
            await asyncio.sleep(0.1)  # 10 Hz
    except websockets.exceptions.ConnectionClosed:
        print(f"[terrain] client disconnected: {websocket.remote_address}")


# ──────────────────────────
# Mesh scanner helpers
# ──────────────────────────

def scan_networks() -> list[dict]:
    try:
        with _iface_lock:
            networks, error = _iface.scanForNetworksWithName_error_(None, None)
        if error or not networks:
            return []

        raw = []
        for net in networks:
            ssid = net.ssid()
            if not ssid:
                continue
            rssi = net.rssiValue()
            ch_obj = net.wlanChannel()
            channel = ch_obj.channelNumber() if ch_obj else 0
            band = "5GHz" if channel > 14 else "2.4GHz"
            bssid = net.bssid() or f"{ssid}:{channel}"
            raw.append({
                "ssid": ssid, "bssid": bssid, "rssi": rssi,
                "channel": channel, "band": band,
            })

        raw.sort(key=lambda x: x["rssi"], reverse=True)

        # Deduplicate: keep only the strongest signal per SSID+channel
        seen: dict[str, dict] = {}
        for node in raw:
            key = f"{node['ssid']}:{node['channel']}"
            if key not in seen or node["rssi"] > seen[key]["rssi"]:
                seen[key] = node
        deduped = list(seen.values())
        deduped.sort(key=lambda x: x["rssi"], reverse=True)

        # Mark mesh networks (SSIDs with multiple channels/nodes)
        ssid_groups: dict[str, list] = {}
        for node in deduped:
            ssid_groups.setdefault(node["ssid"], []).append(node)
        for node in deduped:
            grp = ssid_groups[node["ssid"]]
            node["isMesh"] = len(grp) > 1
            node["meshNodeCount"] = len(grp)

        return deduped
    except Exception as e:
        print(f"Scan error: {e}")
        return []


def scanner_loop():
    global _cached_nodes
    while True:
        nodes = scan_networks()
        if nodes:
            with _lock:
                _cached_nodes = nodes
        time.sleep(SCAN_INTERVAL)


def get_current_connection() -> dict:
    try:
        with _iface_lock:
            ssid = _iface.ssid()  # may be None due to macOS privacy
            rssi = _iface.rssiValue()
            ch_obj = _iface.wlanChannel()
            channel = ch_obj.channelNumber() if ch_obj else 0
            noise = _iface.noiseMeasurement()
            tx_rate = int(_iface.transmitRate())

        # If SSID is hidden by macOS privacy, infer it from scan data
        # by matching channel + closest RSSI
        if not ssid:
            with _lock:
                candidates = [n for n in _cached_nodes
                              if n["channel"] == channel]
            if candidates:
                candidates.sort(key=lambda n: abs(n["rssi"] - rssi))
                ssid = candidates[0]["ssid"]

        return {
            "ssid": ssid or "Unknown",
            "rssi": rssi,
            "noise": noise,
            "txRate": tx_rate,
            "channel": channel,
        }
    except Exception:
        return {"ssid": "Unknown", "rssi": -80, "noise": -90,
                "txRate": 0, "channel": 0}


def inject_live_rssi(nodes, connection):
    """Update the cached node matching our connected network with a live RSSI
    reading so the user position tracks movement between full scans."""
    live_rssi = connection["rssi"]
    live_ch = connection["channel"]
    live_ssid = connection["ssid"]
    for node in nodes:
        # Match by SSID+channel, or by channel alone if SSID was inferred
        if node["channel"] == live_ch and (
            node["ssid"] == live_ssid or live_ssid == "Unknown"
        ):
            node["rssi"] = live_rssi
            break
    return nodes


def _build_mesh_payload():
    """Build mesh payload in a thread so _iface_lock doesn't block the event loop."""
    with _lock:
        nodes = [dict(n) for n in _cached_nodes]
    connection = get_current_connection()
    nodes = inject_live_rssi(nodes, connection)
    return {
        "nodes": nodes,
        "connection": connection,
        "timestamp": time.time(),
    }


async def stream_mesh(websocket):
    print(f"[mesh] client connected: {websocket.remote_address}")
    try:
        while True:
            payload = await asyncio.to_thread(_build_mesh_payload)
            await websocket.send(json.dumps(payload))
            await asyncio.sleep(0.1)  # 10 Hz — live RSSI makes this useful
    except websockets.exceptions.ConnectionClosed:
        print(f"[mesh] client disconnected: {websocket.remote_address}")


# ─────────────────────────
# Path-based routing
# ─────────────────────────

async def handler(websocket, path=None):
    # Legacy API passes path as 2nd arg; modern API uses websocket.request.path
    if path is None:
        path = getattr(websocket, "path", "/terrain")
    if path == "/mesh":
        await stream_mesh(websocket)
    else:
        # default to terrain
        await stream_terrain(websocket)


async def main():
    # Start background mesh scanner
    threading.Thread(target=scanner_loop, daemon=True).start()
    print("Background mesh scanner started")

    initial = scan_networks()
    if initial:
        global _cached_nodes
        with _lock:
            _cached_nodes = initial
        print(f"Initial scan: {len(initial)} access points")

    async with websockets.serve(handler, "127.0.0.1", 8765):
        print()
        print("  Wi-Fi Visualizer server running")
        print("  ws://127.0.0.1:8765/terrain  (signal terrain, 10Hz)")
        print("  ws://127.0.0.1:8765/mesh     (mesh scanner, 10Hz)")
        print()
        print("  Press Ctrl+C to stop.")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
