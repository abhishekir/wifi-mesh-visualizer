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
  * A second background thread pings the Wi-Fi router and checks which
    interface carries internet traffic every PROBE_INTERVAL seconds; both
    streams attach the result as `path`.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import ipaddress
import json
import logging
import math
import os
import re
import signal
import subprocess
import threading
import time
from collections import defaultdict, deque

import websockets
from CoreWLAN import CWInterface, CWWiFiClient

# ── Tunables ────────────────────────────────────────────────────────────
HOST = "127.0.0.1"
PORT = int(os.environ.get("WIFI_SERVER_PORT", "8765"))
PORT_FILE = os.environ.get("WIFI_SERVER_PORT_FILE")
SCAN_INTERVAL = 3.0          # seconds between background full scans
SCAN_STALE_AFTER = 15.0      # cached scan is dropped if older than this
TERRAIN_HZ = 10
MESH_HZ = 10
MAX_QUEUE = 2                # per-client buffer; drop oldest under backpressure
PROBE_INTERVAL = 5.0         # seconds between router ping bursts / route checks
PING_BURST = 10              # pings per burst, 0.2 s apart
PING_WINDOW = 60             # recent pings kept for latency/loss stats

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
# Scans get their own interface instance, used by one thread at a time. A
# full scan can block for 10+ seconds; sharing _iface_lock would freeze every
# live poll (and both streams) for its duration.
_ifname = _iface.interfaceName() if _iface else None
_scan_iface = CWInterface.interfaceWithName_(_ifname) if _ifname else None
# Held by scans and by every latency measurement. A scan takes the radio off
# channel, which measured as router pings jumping from ~4 ms to 189 ms and
# failing with "No route to host"; measurements must not overlap one.
_radio_lock = threading.Lock()

# ── Scan cache ──────────────────────────────────────────────────────────
_cache_lock = threading.Lock()
_cached_nodes: list[dict] = []
_cached_at: float = 0.0

# ── Path probe state ────────────────────────────────────────────────────
_path_lock = threading.Lock()
_ping_samples: deque = deque(maxlen=PING_WINDOW)  # RTT in ms, None if lost
_path_router: str | None = None
_path_internet_iface: str | None = None
_path_checked_at: float = 0.0

# ── Throughput state ────────────────────────────────────────────────────
THROUGHPUT_INTERVAL = 1.0    # seconds between Wi-Fi byte-counter samples
_throughput_lock = threading.Lock()
_throughput_sample: tuple[float, int, int] | None = None  # (monotonic, in, out)
_throughput: dict | None = None


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


_BAND_NAMES = {1: "2.4GHz", 2: "5GHz", 3: "6GHz"}  # CWChannelBand values
_WIDTH_MHZ = {1: 20, 2: 40, 3: 80, 4: 160}          # CWChannelWidth values


def band_name(ch_obj) -> str:
    """Band label from CoreWLAN. The channel number alone is ambiguous: the
    6 GHz plan reuses numbers from both the 2.4 GHz and 5 GHz plans."""
    return _BAND_NAMES.get(ch_obj.channelBand(), "?") if ch_obj else "?"


def _rssi_from_cache(channel: int, ssid: str | None) -> int | None:
    """Strongest cached RSSI for the (channel, ssid) pair, or None.

    Only back-fills when SSID is known — channel-only matches risk picking a
    neighbour AP on a crowded 2.4 GHz channel and over-reporting our link by
    10–20 dB. Caller is expected to show 'Unknown' health when this returns
    None.
    """
    if not channel or not ssid:
        return None
    with _cache_lock:
        candidates = [
            n for n in _cached_nodes
            if n["channel"] == channel and n["ssid"] == ssid
        ]
    if not candidates:
        return None
    return max(n["rssi"] for n in candidates)


def _infer_ssid_from_cache(channel: int, current_rssi: int) -> str | None:
    """Best-guess SSID for the current channel from the latest scan.

    If we have a real live RSSI, pick the candidate whose own scan RSSI is
    closest — that's most likely the AP we're attached to. If we have no
    live RSSI (rssi=0), pick the strongest AP on this channel: still a
    guess, but the most likely correct one.
    """
    if not channel:
        return None
    with _cache_lock:
        candidates = [n for n in _cached_nodes if n["channel"] == channel]
    if not candidates:
        return None
    if current_rssi:
        candidates.sort(key=lambda n: abs(n["rssi"] - current_rssi))
    else:
        candidates.sort(key=lambda n: n["rssi"], reverse=True)
    return candidates[0]["ssid"]


def poll_wifi() -> dict:
    """Raw snapshot from CoreWLAN — no SSID inference, no RSSI back-fill.

    Always returns a dict so the UI can distinguish 'no link' from 'transport
    dead'. Callers that want inference/back-fill should use
    `get_current_connection`.
    """
    try:
        with _iface_lock:
            rssi = _iface.rssiValue()
            noise = _iface.noiseMeasurement()
            tx_rate = _iface.transmitRate()
            ssid = _iface.ssid()
            # BSSID is location-gated on recent macOS releases. Treat it as
            # optional so a denied permission does not hide otherwise useful
            # link telemetry.
            try:
                bssid = _iface.bssid()
            except Exception:
                bssid = None
            ch_obj = _iface.wlanChannel()
            channel = ch_obj.channelNumber() if ch_obj else 0
            band = band_name(ch_obj)
            width = _WIDTH_MHZ.get(ch_obj.channelWidth()) if ch_obj else None
    except Exception as exc:
        log.warning("poll_wifi failed: %s", exc)
        return {"linkUp": False, "error": str(exc), "timestamp": time.time()}

    link_up = bool(rssi) or bool(noise) or bool(ssid) or bool(channel)
    if not link_up:
        return {
            "linkUp": False,
            "ssid": None,
            "bssid": None,
            "rssi": 0,
            "noise": 0,
            "snr": 0,
            "txRate": 0,
            "channel": 0,
            "health": "Offline",
            "timestamp": time.time(),
        }

    return {
        "linkUp": True,
        "ssid": ssid,
        "bssid": str(bssid).lower() if bssid else None,
        "rssi": int(rssi),
        "noise": int(noise),
        # PyObjC may return None on transient errors — guard the float cast.
        "txRate": round(float(tx_rate or 0), 1),
        "channel": int(channel),
        "band": band,
        "widthMhz": width,
        "timestamp": time.time(),
    }


def scan_networks() -> list[dict]:
    """Full passive scan. Returns deduplicated APs sorted strongest first.

    Mesh detection: a network is "mesh" if it has more than one *distinct
    BSSID*, regardless of channel — that's the only signal that two physical
    radios are broadcasting the same SSID.
    """
    try:
        networks, error = _scan_iface.scanForNetworksWithName_error_(None, None)
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
            band = band_name(ch_obj)
            bssid = net.bssid()
            bssid_hidden = not bssid
            if bssid_hidden:
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
            # The UI can't count mesh units from synthetic ids: every radio
            # on one SSID+channel shares a single id.
            "bssidHidden": bssid_hidden,
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
        with _radio_lock:
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


# ────────────────────────────────────────────────────────────────────────
# Path probe — router latency/loss and the internet route
# ────────────────────────────────────────────────────────────────────────

# Interface prefixes macOS VPN clients create (utun: WireGuard, GlobalProtect,
# most app-based VPNs; ipsec: built-in IKEv2; ppp: L2TP).
_TUNNEL_PREFIXES = ("utun", "ipsec", "ppp", "tun", "tap")
_PING_REPLY = re.compile(r"icmp_seq=(\d+) .*?time=([\d.]+) ms")
_PING_TOTALS = re.compile(r"(\d+) packets transmitted, (\d+) packets received")
INTERNET_ANCHOR = "1.1.1.1"  # public host standing in for "the internet"


def _route_lookup(*args: str) -> dict:
    """`route -n get ...` as a {field: value} dict; empty when no route."""
    try:
        out = subprocess.run(
            ["route", "-n", "get", *args],
            capture_output=True, text=True, timeout=2,
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("route lookup failed: %s", exc)
        return {}
    fields = {}
    for line in out.splitlines():
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip()
    return fields


def router_address(ifname: str | None) -> str | None:
    """Gateway of the Wi-Fi interface's own default route.

    Scoped to the interface on purpose: a full-tunnel VPN replaces the global
    default route, and following that would ping the VPN endpoint instead of
    the router.
    """
    if not ifname:
        return None
    gateway = _route_lookup("-ifscope", ifname, "default").get("gateway")
    try:
        return str(ipaddress.ip_address(gateway)) if gateway else None
    except ValueError:
        return None  # e.g. "link#14" on a point-to-point interface


def internet_interface() -> str | None:
    """Interface carrying traffic to the internet anchor — a tunnel when a
    VPN has taken over. Looks up the real destination rather than the default
    route: VPNs such as wg-quick add 0/1 + 128/1 and leave the default alone."""
    return _route_lookup(INTERNET_ANCHOR).get("interface")


def parse_ping(output: str, interrupted_every: float | None = None) -> list[float | None] | None:
    """RTT in ms per sequence number, or None if lost. None overall when the
    output has no statistics (ping didn't run).

    For a ping stopped by SIGINT that sent every `interrupted_every` seconds,
    the last unanswered sends that could still have been in flight are
    dropped (measured: 11 sent, 10 received, nothing lost). Earlier unanswered
    sends still count as lost.
    """
    totals = _PING_TOTALS.search(output)
    if not totals:
        return None
    sent = int(totals.group(1))
    replies = {}
    for seq, ms in _PING_REPLY.findall(output):
        replies.setdefault(int(seq), float(ms))  # ignore (DUP!) replies
    samples = [replies.get(seq) for seq in range(sent)]
    if interrupted_every and replies:
        in_flight = math.ceil(max(replies.values()) / 1000 / interrupted_every) + 1
        samples = samples[:max(max(replies) + 1, sent - in_flight)]
    return samples


def ping_router(router: str, ifname: str) -> list[float | None] | None:
    """Ping the router PING_BURST times, bound to the Wi-Fi interface so the
    result measures only the Wi-Fi hop."""
    deadline = math.ceil(PING_BURST * 0.2) + 2
    try:
        proc = subprocess.run(
            ["ping", "-n", "-b", ifname, "-c", str(PING_BURST), "-i", "0.2",
             "-W", "1000", "-t", str(deadline), router],
            capture_output=True, text=True, timeout=deadline + 2,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("ping failed: %s", exc)
        return None
    return parse_ping(proc.stdout)


def ping_stats(samples: list[float | None]) -> dict | None:
    if not samples:
        return None
    rtts = [s for s in samples if s is not None]
    stats = {
        "sent": len(samples),
        "lossPct": round(100 * (len(samples) - len(rtts)) / len(samples), 1),
        "avgMs": None,
        "p95Ms": None,
        "jitterMs": None,
    }
    if rtts:
        ordered = sorted(rtts)
        stats["avgMs"] = round(sum(rtts) / len(rtts), 1)
        stats["p95Ms"] = round(ordered[math.ceil(0.95 * len(ordered)) - 1], 1)
        # Mean change between consecutive replies (RFC 3550-style jitter).
        steps = [abs(b - a) for a, b in zip(rtts, rtts[1:])]
        stats["jitterMs"] = round(sum(steps) / len(steps), 1) if steps else 0.0
    return stats


def probe_loop():
    """Background path probe. Runs off the poll path because one ping burst
    takes ~2 s."""
    global _path_router, _path_internet_iface, _path_checked_at
    while True:
        started = time.time()
        try:
            router = router_address(_ifname)
            internet_iface = internet_interface()
            samples = None
            if router:
                with _radio_lock:
                    samples = ping_router(router, _ifname)
            with _path_lock:
                # A new router means a new network; old pings measured another
                # link. A burst that couldn't run leaves nothing current to show.
                if router != _path_router or samples is None:
                    _ping_samples.clear()
                if samples:
                    _ping_samples.extend(samples)
                _path_router = router
                _path_internet_iface = internet_iface
                _path_checked_at = time.time()
        except Exception:
            log.exception("path probe failed")
        time.sleep(max(0.0, PROBE_INTERVAL - (time.time() - started)))


def path_snapshot() -> dict:
    with _path_lock:
        samples = list(_ping_samples)
        router = _path_router
        internet_iface = _path_internet_iface
        checked_at = _path_checked_at
    return {
        "router": router,
        "ping": ping_stats(samples),
        "wifiInterface": _ifname,
        "internetInterface": internet_iface,
        "vpn": is_tunnel(internet_iface),
        "checkedAge": (time.time() - checked_at) if checked_at else None,
    }


def parse_netstat_bytes(output: str) -> tuple[int, int] | None:
    """(bytes in, bytes out) from `netstat -ibn -I <iface>`'s link row."""
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 10 and parts[2].startswith("<Link#"):
            return int(parts[6]), int(parts[9])
    return None


def wifi_throughput() -> dict | None:
    """Mbps the Wi-Fi interface actually moved over the last ~second, all
    traffic combined. Samples at most once per THROUGHPUT_INTERVAL however
    many streams ask. None until two samples close enough together exist."""
    global _throughput_sample, _throughput
    with _throughput_lock:
        now = time.monotonic()
        if _throughput_sample and now - _throughput_sample[0] < THROUGHPUT_INTERVAL:
            return _throughput
        try:
            counts = parse_netstat_bytes(subprocess.run(
                ["netstat", "-ibn", "-I", _ifname or ""],
                capture_output=True, text=True, timeout=2,
            ).stdout)
        except (OSError, subprocess.SubprocessError):
            counts = None
        _throughput = None
        if counts and _throughput_sample:
            then, rx, tx = _throughput_sample
            dt = now - then
            # A long gap (no viewers) would average over it; a counter going
            # backwards means the interface reset.
            if dt <= 3 * THROUGHPUT_INTERVAL and counts[0] >= rx and counts[1] >= tx:
                _throughput = {
                    "downMbps": round((counts[0] - rx) * 8 / dt / 1e6, 1),
                    "upMbps": round((counts[1] - tx) * 8 / dt / 1e6, 1),
                }
        _throughput_sample = (now, *counts) if counts else None
        return _throughput


def is_tunnel(iface: str | None) -> bool:
    return bool(iface and iface.startswith(_TUNNEL_PREFIXES))


# ────────────────────────────────────────────────────────────────────────
# Diagnosis — per-hop latency idle and under load
# ────────────────────────────────────────────────────────────────────────

class DiagnosisCancelled(Exception):
    pass


def _first_hop_past(router: str) -> str | None:
    """First responding traceroute hop that isn't the router: normally the
    ISP's gateway (or the modem, behind a double NAT)."""
    try:
        out = subprocess.run(
            ["traceroute", "-n", "-m", "4", "-q", "1", "-w", "1", INTERNET_ANCHOR],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) > 1 and parts[1] not in ("*", router):
            return parts[1]
    return None


def _network_quality(direction: str) -> tuple[float | None, float]:
    """Throughput in Mbps for one direction ("dl" or "ul") via macOS's
    networkQuality, which saturates the connection while it runs, and the
    peak Wi-Fi transmit rate sampled meanwhile (an idle link reads low)."""
    skip = "-u" if direction == "dl" else "-d"
    peak_tx = 0.0
    try:
        proc = subprocess.Popen(
            ["networkQuality", skip, "-c", "-M", "10"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
    except OSError:
        return None, peak_tx
    deadline = time.time() + 30
    while True:
        peak_tx = max(peak_tx, poll_wifi().get("txRate") or 0)
        try:
            out = proc.communicate(timeout=0.5)[0]
            break
        except subprocess.TimeoutExpired:
            if time.time() > deadline:
                proc.kill()
                out = proc.communicate()[0]
                break
    try:
        bps = json.loads(out).get(f"{direction}_throughput")
    except (ValueError, AttributeError):
        bps = None
    return (round(bps / 1e6, 1) if bps else None), peak_tx


def _ping_during(targets: dict, action):
    """Ping every target every 0.2 s while action() runs. Returns action's
    result and {name: ping_stats}."""
    procs = {}
    try:
        for name, (ip, wifi_only) in targets.items():
            procs[name] = subprocess.Popen(
                ["ping", "-n", "-i", "0.2", *(["-b", _ifname] if wifi_only else []), ip],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            )
        result = action()
    finally:
        for proc in procs.values():
            proc.send_signal(signal.SIGINT)  # ping prints its totals on SIGINT
        outputs = {name: proc.communicate()[0] for name, proc in procs.items()}
    return result, {
        name: ping_stats(parse_ping(out, interrupted_every=0.2) or [])
        for name, out in outputs.items()
    }


def _channel_context(link: dict) -> dict:
    """Other networks sharing the link's spectrum, and the bands the user's
    own SSID was seen on. None when the scan can't tell."""
    with _cache_lock:
        nodes = list(_cached_nodes)
    ssid, ch, band = link.get("ssid"), link.get("channel"), link.get("band")
    if not nodes or not ch or ssid in (None, "Unknown"):
        return {"neighborsOnChannel": None, "ssidBands": None}
    if band == "2.4GHz":
        # 20 MHz channels overlap neighbours up to 4 numbers away.
        def overlaps(c):
            return abs(c - ch) < 5
    else:
        # A wider link spans a width-aligned block of 20 MHz channels (5 MHz
        # per channel number; blocks start at 36 on 5 GHz, 1 on 6 GHz).
        span = (link.get("widthMhz") or 20) // 5
        base = 36 if band == "5GHz" else 1

        def overlaps(c):
            return (c - base) // span == (ch - base) // span
    return {
        "neighborsOnChannel": len({
            n["bssid"] for n in nodes
            if n["ssid"] != ssid and n["band"] == band and overlaps(n["channel"])
        }),
        "ssidBands": sorted({n["band"] for n in nodes if n["ssid"] == ssid}),
    }


def run_diagnosis(progress, cancel: threading.Event) -> dict:
    """Measure the router, the ISP's first hop, and the internet idle, then
    while networkQuality saturates download and then upload. The hop whose
    latency rises first under load is where traffic queues. ~30 s. Raises
    DiagnosisCancelled at the next phase once `cancel` is set."""
    progress("waiting")
    with _radio_lock:  # pauses scans and the path probe for the whole run
        link = get_current_connection()
        router = router_address(_ifname)
        internet_iface = internet_interface()
        vpn = is_tunnel(internet_iface)
        targets = {}
        if router:
            targets["router"] = (router, True)
            # Through a VPN the first hop past the router is a tunnel hop.
            isp = None if vpn else _first_hop_past(router)
            if isp:
                targets["isp"] = (isp, False)
        targets["internet"] = (INTERNET_ANCHOR, False)

        def measure(stage, action):
            if cancel.is_set():
                raise DiagnosisCancelled
            progress(stage)
            return _ping_during(targets, action)

        _, idle = measure("idle", lambda: time.sleep(6))
        (down_mbps, dl_tx), download = measure("download", lambda: _network_quality("dl"))
        (up_mbps, ul_tx), upload = measure("upload", lambda: _network_quality("ul"))
        link["txRateUnderLoad"] = max(dl_tx, ul_tx)

    link.update(_channel_context(link))
    return {
        "link": link,
        "vpn": vpn,
        "wifiInterface": _ifname,
        "internetInterface": internet_iface,
        "hops": [
            {"name": name, "address": ip, "idle": idle[name],
             "download": download[name], "upload": upload[name]}
            for name, (ip, _) in targets.items()
        ],
        "downloadMbps": down_mbps,
        "uploadMbps": up_mbps,
        "timestamp": time.time(),
    }


def get_current_connection() -> dict:
    """Live connection info with SSID inference and RSSI back-fill applied.

    Order matters: infer SSID first (so the back-fill can look up the right
    AP), then back-fill RSSI (so the noise/snr/health values can be derived
    consistently). The terrain and mesh streams both call this.
    """
    snap = poll_wifi()
    if not snap.get("linkUp"):
        return snap

    rssi_source = "iface"

    # 1) SSID inference for macOS-hidden current network.
    if not snap.get("ssid") and snap.get("channel"):
        inferred = _infer_ssid_from_cache(snap["channel"], snap["rssi"])
        if inferred:
            snap["ssid"] = inferred
            snap["ssidInferred"] = True
    if not snap.get("ssid"):
        snap["ssid"] = "Unknown"

    # 2) RSSI back-fill for unprivileged rssiValue() → 0.
    if snap["rssi"] == 0 and snap["ssid"] != "Unknown":
        backfill = _rssi_from_cache(snap["channel"], snap["ssid"])
        if backfill is not None:
            snap["rssi"] = backfill
            rssi_source = "scan"

    # 3) Derived values — health and SNR after rssi is final.
    snap["health"] = health_from_rssi(snap["rssi"]) if snap["rssi"] else "Unknown"
    snap["snr"] = (
        snap["rssi"] - snap["noise"] if snap["rssi"] and snap["noise"] else 0
    )
    snap["rssiSource"] = rssi_source
    return snap


def inject_live_rssi(nodes: list[dict], connection: dict) -> list[dict]:
    """Tag the cached node we're connected to with the live RSSI in a
    SEPARATE field — never overwrite `rssi`. Match SSID+channel only.

    Why a separate field: live RSSI comes from the active antenna and is
    typically 10–20 dB stronger than the same AP's passive-scan reading.
    Other APs in the mesh only ever have scan readings. Mixing the two
    feeds into trilateration makes the puck jump every time the laptop
    roams — the "strong-reading bias" hops to whichever AP is currently
    connected. Keeping `rssi` uniform across all APs and exposing the
    live value as `liveRssi` lets the UI render fresh signal on the
    connected AP without distorting the position math.
    """
    if not connection.get("linkUp"):
        return nodes
    live_rssi = connection.get("rssi", 0)
    live_ch = connection.get("channel", 0)
    live_ssid = connection.get("ssid")
    # Don't inject when we don't actually have a fresh live reading. If RSSI
    # was backfilled from the scan cache, publishing it as `liveRssi` would
    # make the UI treat stale scan data as a 10 Hz live signal.
    if (
        not live_ssid
        or live_ssid == "Unknown"
        or not live_ch
        or not live_rssi
        or connection.get("rssiSource") != "iface"
    ):
        return nodes
    for node in nodes:
        if node["channel"] == live_ch and node["ssid"] == live_ssid:
            node["liveRssi"] = live_rssi
            node["live"] = True
            break
    return nodes


def _build_terrain_payload() -> dict:
    return {
        **get_current_connection(),
        "path": path_snapshot(),
        "throughput": wifi_throughput(),
    }


def _build_mesh_payload() -> dict:
    with _cache_lock:
        nodes = [dict(n) for n in _cached_nodes]
        cached_at = _cached_at
    connection = get_current_connection()
    nodes = inject_live_rssi(nodes, connection)
    return {
        "nodes": nodes,
        "connection": connection,
        "path": path_snapshot(),
        "throughput": wifi_throughput(),
        "meshHz": MESH_HZ,
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
    loop = asyncio.get_running_loop()
    next_tick = loop.time()
    while True:
        if bus.subscriber_count() == 0:
            await asyncio.sleep(idle_period)
            next_tick = loop.time()
            continue
        try:
            payload = await asyncio.to_thread(build)
            bus.publish(payload)
        except Exception:
            log.exception("producer %s build failed", bus.name)
        # Schedule on a fixed cadence so build time doesn't stretch the
        # period. After a stall, resume from now rather than bursting.
        next_tick = max(next_tick + period, loop.time())
        await asyncio.sleep(next_tick - loop.time())


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


async def serve_diagnosis(websocket):
    """One run per connection: stage updates, then the report. Closing the
    socket cancels the run at its next phase; runs queue on the radio lock."""
    loop = asyncio.get_running_loop()
    cancel = threading.Event()

    def progress(stage):
        asyncio.run_coroutine_threadsafe(
            websocket.send(json.dumps({"status": "running", "stage": stage})), loop
        )

    run = asyncio.ensure_future(asyncio.to_thread(run_diagnosis, progress, cancel))
    closed = asyncio.ensure_future(websocket.wait_closed())
    await asyncio.wait({run, closed}, return_when=asyncio.FIRST_COMPLETED)
    if closed.done():
        cancel.set()
    closed.cancel()
    try:
        report = await run
        await websocket.send(json.dumps({"status": "done", "report": report}))
    except (DiagnosisCancelled, websockets.exceptions.ConnectionClosed):
        pass
    except Exception as exc:
        log.exception("diagnosis failed")
        with contextlib.suppress(websockets.exceptions.ConnectionClosed):
            await websocket.send(json.dumps({"status": "error", "error": str(exc)}))


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
    elif p.startswith("/diagnose"):
        await serve_diagnosis(websocket)
    elif p.startswith("/terrain"):
        await serve_stream(websocket, terrain_bus)
    else:
        log.warning("unknown path %r, defaulting to terrain", p)
        await serve_stream(websocket, terrain_bus)


# ────────────────────────────────────────────────────────────────────────
# Entrypoint
# ────────────────────────────────────────────────────────────────────────

async def main():
    try:
        server = await websockets.serve(handler, HOST, PORT)
    except OSError as exc:
        if not PORT_FILE or PORT == 0 or exc.errno != errno.EADDRINUSE:
            raise
        log.warning("port %d is in use; requesting an available port", PORT)
        server = await websockets.serve(handler, HOST, 0)

    actual_port = server.sockets[0].getsockname()[1]
    if PORT_FILE:
        with open(PORT_FILE, "w", encoding="utf-8") as port_file:
            port_file.write(str(actual_port))

    log.info("Wi-Fi Visualizer server running on ws://%s:%d", HOST, actual_port)
    log.info("  /terrain  (signal terrain, %d Hz)", TERRAIN_HZ)
    log.info("  /mesh     (mesh scanner, %d Hz)", MESH_HZ)

    tasks = []
    try:
        # Warm cache so the first /mesh payload contains current scan data.
        initial = await asyncio.to_thread(scan_networks)
        if initial:
            global _cached_nodes, _cached_at
            with _cache_lock:
                _cached_nodes = initial
                _cached_at = time.time()
            log.info("initial scan: %d APs", len(initial))
        else:
            log.warning("initial scan returned 0 APs")

        threading.Thread(target=scanner_loop, daemon=True).start()
        log.info("background scanner started (interval=%.1fs)", SCAN_INTERVAL)
        threading.Thread(target=probe_loop, daemon=True).start()
        log.info("path probe started (interval=%.1fs)", PROBE_INTERVAL)
        tasks = [
            asyncio.create_task(
                producer(terrain_bus, _build_terrain_payload, TERRAIN_HZ)
            ),
            asyncio.create_task(
                producer(mesh_bus, _build_mesh_payload, MESH_HZ)
            ),
        ]
        await asyncio.Future()
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("shutting down")
