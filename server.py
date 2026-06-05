#!/usr/bin/env python3
"""
Wi-Fi Visualizer — Unified Server

Serves terrain (10 Hz) and mesh (10 Hz) snapshots over one WebSocket on
port 8765, routed by path:
  ws://127.0.0.1:8765/terrain
  ws://127.0.0.1:8765/mesh

Architecture:
  * One CoreWLAN poller per stream produces snapshots on an asyncio loop.
  * Each client subscribes to a small bounded queue. Slow clients drop frames
    instead of holding back the producer.
  * A background thread runs the heavy `scanForNetworksWithName_error_` call
    every SCAN_INTERVAL seconds and updates a cache the mesh stream reads.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
import time
from collections import defaultdict

import websockets
from CoreWLAN import CWWiFiClient

# ── Tunables ────────────────────────────────────────────────────────────
HOST = "127.0.0.1"
PORT = 8765
SCAN_INTERVAL = 3.0          # seconds between background full scans
SCAN_STALE_AFTER = 15.0      # cached scan is dropped if older than this
TERRAIN_HZ = 10
MESH_HZ = 10
MAX_QUEUE = 2                # per-client buffer; drop oldest under backpressure

# ── Logging ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
log = logging.getLogger("wifi")

# ── Shared CoreWLAN handle ──────────────────────────────────────────────
_client = CWWiFiClient.sharedWiFiClient()
_iface = _client.interface()
_iface_lock = threading.Lock()   # CoreWLAN calls are not thread-safe

# ── Scan cache ──────────────────────────────────────────────────────────
_cache_lock = threading.Lock()
_cached_nodes: list[dict] = []
_cached_at: float = 0.0


# ────────────────────────────────────────────────────────────────────────
# CoreWLAN polling
# ────────────────────────────────────────────────────────────────────────

def health_from_rssi(rssi: int) -> str:
    if rssi >= -50:
        return "Excellent"
    if rssi >= -60:
        return "Good"
    if rssi >= -70:
        return "Fair"
    return "Poor"


def _rssi_from_cache(channel: int, ssid: str | None) -> int | None:
    """When CoreWLAN reports rssi=0 (common on modern macOS without sudo),
    fall back to the strongest cached scan entry for our channel."""
    if not channel:
        return None
    with _cache_lock:
        candidates = [n for n in _cached_nodes if n["channel"] == channel]
    if not candidates:
        return None
    if ssid:
        same_ssid = [n for n in candidates if n["ssid"] == ssid]
        if same_ssid:
            return max(n["rssi"] for n in same_ssid)
    return max(n["rssi"] for n in candidates)


def poll_wifi() -> dict:
    """One snapshot of the current connection. Always returns a dict so the
    UI can distinguish 'no link' from 'transport dead'.

    On modern macOS, `rssiValue()` returns 0 unless the process is privileged.
    We treat 0 as 'reading unavailable' and back-fill from the most recent
    background scan rather than reporting a misleading 'Excellent' link.
    """
    try:
        with _iface_lock:
            rssi = _iface.rssiValue()
            noise = _iface.noiseMeasurement()
            tx_rate = _iface.transmitRate()
            ssid = _iface.ssid()
            ch_obj = _iface.wlanChannel()
            channel = ch_obj.channelNumber() if ch_obj else 0
    except Exception as exc:
        log.warning("poll_wifi failed: %s", exc)
        return {"linkUp": False, "error": str(exc), "timestamp": time.time()}

    link_up = bool(rssi) or bool(noise) or bool(ssid) or bool(channel)
    if not link_up:
        return {
            "linkUp": False,
            "ssid": None,
            "rssi": 0,
            "noise": 0,
            "snr": 0,
            "txRate": 0,
            "channel": 0,
            "health": "Offline",
            "timestamp": time.time(),
        }

    rssi_source = "iface"
    if rssi == 0:
        backfill = _rssi_from_cache(int(channel), ssid)
        if backfill is not None:
            rssi = backfill
            rssi_source = "scan"

    if rssi == 0:
        health = "Unknown"
    else:
        health = health_from_rssi(rssi)

    snr = (rssi - noise) if (rssi and noise) else 0

    return {
        "linkUp": True,
        "ssid": ssid or "Unknown",
        "rssi": int(rssi),
        "noise": int(noise),
        "snr": int(snr),
        "txRate": round(float(tx_rate), 1),
        "channel": int(channel),
        "health": health,
        "rssiSource": rssi_source,
        "timestamp": time.time(),
    }


def scan_networks() -> list[dict]:
    """Full passive scan. Returns deduplicated APs sorted strongest first.

    Mesh detection: a network is "mesh" if it has more than one *distinct
    BSSID*, regardless of channel — that's the only signal that two physical
    radios are broadcasting the same SSID.
    """
    try:
        with _iface_lock:
            networks, error = _iface.scanForNetworksWithName_error_(None, None)
    except Exception as exc:
        log.warning("scan failed: %s", exc)
        return []
    if error or not networks:
        return []

    raw: list[dict] = []
    for net in networks:
        try:
            ssid = net.ssid()
            if not ssid:
                continue
            rssi = int(net.rssiValue())
            ch_obj = net.wlanChannel()
            channel = ch_obj.channelNumber() if ch_obj else 0
            band = "5GHz" if channel > 14 else "2.4GHz"
            bssid = net.bssid()
            if not bssid:
                # macOS hides BSSID for non-connected APs under some privacy
                # settings. Use a stable synthetic id keyed on SSID+channel
                # so the same hidden AP keeps its identity across scans (and
                # therefore its colour and on-screen position). The cost is
                # that two distinct hidden radios on the same SSID+channel
                # collapse into one — accept that trade since mesh detection
                # relies on the *visible* BSSID count anyway.
                bssid = f"hidden:{ssid}:{channel}"
        except Exception as exc:
            log.debug("net parse failed: %s", exc)
            continue

        raw.append({
            "ssid": ssid,
            "bssid": bssid,
            "rssi": rssi,
            "channel": channel,
            "band": band,
        })

    # Deduplicate by BSSID (a single radio scanned twice in one pass).
    by_bssid: dict[str, dict] = {}
    for node in raw:
        existing = by_bssid.get(node["bssid"])
        if existing is None or node["rssi"] > existing["rssi"]:
            by_bssid[node["bssid"]] = node
    deduped = sorted(by_bssid.values(), key=lambda n: n["rssi"], reverse=True)

    # Mesh = an SSID broadcast by >1 distinct BSSID anywhere in this scan.
    bssids_per_ssid: dict[str, set[str]] = defaultdict(set)
    channels_per_ssid: dict[str, set[int]] = defaultdict(set)
    for node in deduped:
        bssids_per_ssid[node["ssid"]].add(node["bssid"])
        channels_per_ssid[node["ssid"]].add(node["channel"])

    for node in deduped:
        bcount = len(bssids_per_ssid[node["ssid"]])
        ccount = len(channels_per_ssid[node["ssid"]])
        node["isMesh"] = bcount > 1
        node["meshNodeCount"] = bcount
        node["meshChannelCount"] = ccount

    return deduped


def scanner_loop():
    """Background scan loop. Always publishes (even empty results) so the
    cache reflects current reality; downstream code uses _cached_at to
    age-out stale data when scans start failing entirely."""
    global _cached_nodes, _cached_at
    while True:
        nodes = scan_networks()
        with _cache_lock:
            if nodes:
                _cached_nodes = nodes
                _cached_at = time.time()
            elif time.time() - _cached_at > SCAN_STALE_AFTER:
                # Wi-Fi has gone away — drop the cache rather than lie.
                _cached_nodes = []
                _cached_at = 0.0
        time.sleep(SCAN_INTERVAL)


def get_current_connection() -> dict:
    """Live connection info. When macOS hides our SSID, infer it from the
    cached scan by matching channel + closest RSSI."""
    snap = poll_wifi()
    ssid = snap.get("ssid")
    channel = snap.get("channel", 0)
    rssi = snap.get("rssi", 0)

    if (not ssid or ssid == "Unknown") and channel:
        with _cache_lock:
            candidates = [n for n in _cached_nodes if n["channel"] == channel]
        if candidates:
            candidates.sort(key=lambda n: abs(n["rssi"] - rssi))
            ssid = candidates[0]["ssid"]
            snap["ssid"] = ssid
            snap["ssidInferred"] = True

    return snap


def inject_live_rssi(nodes: list[dict], connection: dict) -> list[dict]:
    """Refresh the cached node we're connected to with the live RSSI so
    motion shows up between full scans. Match SSID+channel only — never
    cross networks just because two share a channel."""
    if not connection.get("linkUp"):
        return nodes
    live_rssi = connection.get("rssi", 0)
    live_ch = connection.get("channel", 0)
    live_ssid = connection.get("ssid")
    # Don't inject when we don't actually have a fresh live reading — that
    # would clobber a real -46 from the scan with a meaningless 0.
    if (
        not live_ssid
        or live_ssid == "Unknown"
        or not live_ch
        or not live_rssi
    ):
        return nodes
    for node in nodes:
        if node["channel"] == live_ch and node["ssid"] == live_ssid:
            node["rssi"] = live_rssi
            node["live"] = True
            break
    return nodes


def _build_mesh_payload() -> dict:
    with _cache_lock:
        nodes = [dict(n) for n in _cached_nodes]
        cached_at = _cached_at
    connection = get_current_connection()
    nodes = inject_live_rssi(nodes, connection)
    return {
        "nodes": nodes,
        "connection": connection,
        "scanAge": (time.time() - cached_at) if cached_at else None,
        "scanStale": cached_at == 0.0,
        "timestamp": time.time(),
    }


# ────────────────────────────────────────────────────────────────────────
# Pub/sub fan-out
# ────────────────────────────────────────────────────────────────────────

class Broadcaster:
    """One producer task pushes snapshots; many subscriber queues receive
    them. Slow consumers drop the oldest frame instead of blocking."""

    def __init__(self, name: str):
        self.name = name
        self._subs: set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    async def add(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=MAX_QUEUE)
        async with self._lock:
            self._subs.add(q)
        return q

    async def remove(self, q: asyncio.Queue) -> None:
        async with self._lock:
            self._subs.discard(q)

    def publish(self, payload: dict) -> None:
        for q in list(self._subs):
            if q.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    q.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(payload)

    def subscriber_count(self) -> int:
        return len(self._subs)


terrain_bus = Broadcaster("terrain")
mesh_bus = Broadcaster("mesh")


async def producer(bus: Broadcaster, build, hz: int):
    """Poll at fixed rate while at least one client is subscribed."""
    period = 1.0 / hz
    idle_period = 0.5  # check less often when no one is listening
    while True:
        if bus.subscriber_count() == 0:
            await asyncio.sleep(idle_period)
            continue
        try:
            payload = await asyncio.to_thread(build)
            bus.publish(payload)
        except Exception:
            log.exception("producer %s build failed", bus.name)
        await asyncio.sleep(period)


async def serve_stream(websocket, bus: Broadcaster):
    peer = websocket.remote_address
    log.info("[%s] connect %s (subs=%d)", bus.name, peer, bus.subscriber_count() + 1)
    q = await bus.add()
    try:
        while True:
            payload = await q.get()
            await websocket.send(json.dumps(payload))
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception:
        log.exception("[%s] stream error %s", bus.name, peer)
    finally:
        await bus.remove(q)
        log.info("[%s] disconnect %s (subs=%d)", bus.name, peer, bus.subscriber_count())


# ────────────────────────────────────────────────────────────────────────
# Routing
# ────────────────────────────────────────────────────────────────────────

def _request_path(websocket, legacy_path):
    if legacy_path is not None:
        return legacy_path
    req = getattr(websocket, "request", None)
    if req is not None and getattr(req, "path", None):
        return req.path
    return getattr(websocket, "path", "/terrain")


async def handler(websocket, path=None):
    p = _request_path(websocket, path)
    if p.startswith("/mesh"):
        await serve_stream(websocket, mesh_bus)
    elif p.startswith("/terrain"):
        await serve_stream(websocket, terrain_bus)
    else:
        log.warning("unknown path %r, defaulting to terrain", p)
        await serve_stream(websocket, terrain_bus)


# ────────────────────────────────────────────────────────────────────────
# Entrypoint
# ────────────────────────────────────────────────────────────────────────

async def main():
    threading.Thread(target=scanner_loop, daemon=True).start()
    log.info("background scanner started (interval=%.1fs)", SCAN_INTERVAL)

    # Warm cache so the first /mesh client sees data immediately.
    initial = await asyncio.to_thread(scan_networks)
    if initial:
        global _cached_nodes, _cached_at
        with _cache_lock:
            _cached_nodes = initial
            _cached_at = time.time()
        log.info("initial scan: %d APs", len(initial))
    else:
        log.warning("initial scan returned 0 APs")

    terrain_task = asyncio.create_task(producer(terrain_bus, poll_wifi, TERRAIN_HZ))
    mesh_task = asyncio.create_task(producer(mesh_bus, _build_mesh_payload, MESH_HZ))

    async with websockets.serve(handler, HOST, PORT):
        log.info("Wi-Fi Visualizer server running on ws://%s:%d", HOST, PORT)
        log.info("  /terrain  (signal terrain, %d Hz)", TERRAIN_HZ)
        log.info("  /mesh     (mesh scanner, %d Hz)", MESH_HZ)
        try:
            await asyncio.Future()
        finally:
            terrain_task.cancel()
            mesh_task.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("shutting down")
