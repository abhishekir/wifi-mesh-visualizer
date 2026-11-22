# Wi-Fi Mesh Visualizer

Real-time 3D visualization of Wi-Fi mesh networks on macOS, designed for
debugging roaming, signal hand-offs, and dead spots.

## What it shows

- **Terrain view** — animated 3D heatmap of the connected link's RSSI over
  time. Spikes and drops are visible at a glance.
- **Mesh view** — every nearby AP as a coloured orb, your laptop as a glowing
  puck positioned via least-squares trilateration against the connected
  mesh's BSSIDs. Channel changes drop roam markers on the floor so you can
  see where in the room hand-offs are happening. A persistent ground heatmap
  is painted under your feet as you walk.
- **Survey view** — record repeatable 10-second samples in named rooms, rank
  weak locations, compare against an earlier session, and export JSON or CSV
  evidence.
- **Path panel** (Terrain and Mesh views) — latency, jitter, and packet loss
  from this Mac to the Wi-Fi router, plus whether internet traffic is going
  through a VPN. Use it to tell a weak Wi-Fi hop apart from a slow ISP or VPN.
- **Throughput** (Terrain and Mesh views) — Mbps this Mac is actually moving
  over Wi-Fi each second, from the interface's byte counters, next to the
  link rate. It shows current usage, not capacity; Diagnose measures the most
  the connection can reach.
- **Diagnose view** — a ~30-second run that pings the router, the ISP's first
  hop (via traceroute), and 1.1.1.1 while idle and while macOS's
  `networkQuality` saturates download, then upload. Each hop is charged only
  for the latency it adds beyond the previous hop, so the first hop whose
  latency rises under load is where traffic queues. Results show a verdict per
  hop (Wi-Fi link, router to ISP, internet, speed) with the measurements behind
  it, plus suggestions (band, channel, channel width, QoS/SQM, plan limit,
  VPN). It can't measure Wi-Fi throughput alone (that needs a wired iperf3
  peer) or links between mesh units. With a VPN on, the ISP hop is skipped.

## Requirements

- macOS (uses CoreWLAN via PyObjC)
- Python 3.10+
- Node 18+

## Run

```bash
pip install -r requirements.txt
cd frontend && npm install && cd ..
./start.sh
```

`start.sh` boots the Python server on `ws://127.0.0.1:8765` and opens the
React UI only after the server is listening. If port 8765 is occupied, the
server asks the OS for an available port and reports it to the launcher, which
configures the UI automatically.

## Architecture

```
+----------------------+        WebSocket          +-------------------+
| CoreWLAN (macOS)     |   /terrain  10 Hz         | React + r3f UI    |
|  - rssiValue()       | ────────────────────────▶ |  - SignalHUD      |
|  - scanForNetworks() |   /mesh     10 Hz         |  - MeshScene      |
+----------------------+ ────────────────────────▶ |  - MeshHUD        |
        ▲                                          +-------------------+
        │
   server.py (asyncio, pub/sub fan-out)
```

- A background thread runs `scanForNetworksWithName_error_` every 3 s and
  caches the result. The cache is age-tracked and dropped after 15 s of
  failing scans so the UI can warn instead of showing stale data.
- A second background thread pings the router 10 times every 5 s and keeps
  the last 60 results for the Path panel. The ping is bound to the Wi-Fi
  interface and the router is found from that interface's own default route,
  so a full-tunnel VPN doesn't redirect it to the VPN endpoint. The same
  thread looks up which interface carries traffic to 1.1.1.1 (the real route,
  so VPNs that add `0/1` + `128/1` instead of replacing the default are
  caught); a `utun`, `ipsec`, `ppp`, `tun`, or `tap` interface is reported as
  a VPN.
- Scans and latency measurements share a radio lock. A scan takes the radio
  off channel (router pings measured jumping from ~4 ms to 189 ms, with
  "No route to host" failures), so pings never overlap one, and a diagnosis
  pauses scanning for its whole run. Scans from a second app instance can't
  be paused, so run one instance while diagnosing.
- Two `Broadcaster` instances (`terrain`, `mesh`) fan-out frames to all
  subscribers. Slow clients drop the oldest frame instead of blocking the
  producer; CoreWLAN is polled once per stream regardless of client count.

## macOS privilege note

Since macOS Big Sur, live `rssiValue()` and `noiseMeasurement()` are gated
on either:

1. **Location Services permission** for the terminal app (preferred for
   day-to-day use). Open **System Settings → Privacy & Security → Location
   Services**, scroll down, and enable Location for Terminal or iTerm. No
   restart needed.
2. **Running the server as root** (`sudo python3 server.py`).

Without either, the iface reports rssi=0 and may hide the connected BSSID.
The server back-fills RSSI from the latest scan when it can match by SSID —
you'll see a `~scan` badge next to the signal value in the terrain HUD, and
surveys will be marked low confidence. If the connected SSID is also hidden,
the link RSSI shows as "Unknown" rather than risk picking a neighbouring AP's
RSSI on the same channel.

The mesh view works either way — `scanForNetworksWithName_error_` does not
require elevation.

## Configuration

Override the WebSocket origin (when the server isn't on localhost):

```bash
# frontend/.env
VITE_WS_BASE=ws://192.168.1.42:8765
```

This explicit remote origin takes precedence over the local port selected by
`start.sh`.

Choose a preferred local port or Python executable when launching:

```bash
WIFI_SERVER_PORT=9000 PYTHON=/path/to/python3 ./start.sh
```

## Run a room survey

The 3D mesh floor is useful for relative movement, but it is not a floor
plan: AP positions are generated for display and distance uses a generic
indoor path-loss model. Use named Survey locations as the source of truth
when checking real rooms.

1. Enable Location Services for the terminal running the server so the
   survey receives live RSSI and, when macOS exposes it, the serving BSSID.
2. Open **Survey**, create a session such as `Before moving satellite`, and
   enter a room or location name.
3. Stand still and record a 10-second sample. Start with the place where
   Wi-Fi feels weakest and repeat questionable rooms to account for doors,
   people, and appliance interference.
4. Create another session after changing node placement or settings. Select
   the earlier session under **Compare against** to see the per-room median
   RSSI change.
5. Export JSON for complete structured results or CSV for a spreadsheet.
   Exports may contain the local SSID and BSSIDs.

Each result includes median and low-percentile RSSI, SNR, link rate,
signal variation, link-down percentage, serving radio, channel changes, and
an explicit assessment. A result is marked low confidence when live readings
are unavailable, scan-backed readings are stale, too few readings arrive, or
the stream does not cover most of the capture window. Sessions are stored
only in the browser's local storage.

## What's useful for debugging mesh failures

1. **Roam markers** — every channel change is logged with the position where
   it happened. A cluster of roams in one spot usually means weak handoff
   coverage.
2. **Mesh topology panel** — shows radios (distinct BSSIDs) per band and
   channels per SSID. Each mesh unit usually has one radio per band, so the
   per-band count is the best estimate of how many units are in range. When
   macOS hides BSSIDs, radios on the same channel merge into one entry and the
   panel says the unit count is unknown instead of guessing.
3. **Scan age** — turns orange when the macOS scanner stops returning data;
   indicates Wi-Fi sleep, driver issues, or out-of-range conditions.
4. **Connection beam** — drops when the link goes down even if the SSID
   doesn't change; useful for spotting sub-second drops the OS hides.
5. **Heatmap** — running-average per cell, walk around to map dead spots.
6. **Room survey** — ranks named locations using repeatable signal and link
   stability measurements instead of inferred 3D coordinates.
7. **Path panel** — if router latency and loss look good but speed tests are
   slow, the bottleneck is past your Wi-Fi: the ISP plan, or the VPN when the
   panel shows one. **Link rate** is the radio's negotiated rate, not
   throughput; expect roughly half to two-thirds of it in practice.
   **Throughput** far below that during a slow download doesn't rule out
   Wi-Fi: a busy channel, interference, or retransmissions cut delivered data
   without lowering the link rate. The bottleneck may be upstream, but run
   Diagnose (or a test against a wired machine on your LAN) to tell. Some
   routers ignore ping, so 100% loss with a strong signal usually means that
   rather than a dead link.
