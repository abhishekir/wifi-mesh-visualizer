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
React UI in your browser.

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
- Two `Broadcaster` instances (`terrain`, `mesh`) fan-out frames to all
  subscribers. Slow clients drop the oldest frame instead of blocking the
  producer; CoreWLAN is polled once per stream regardless of client count.

## macOS privilege note

Modern macOS only returns live `rssiValue()` and `noiseMeasurement()` to
processes running as root. Without sudo the iface reports 0, and the server
back-fills RSSI from the latest scan (you'll see a `~scan` badge next to the
signal in the HUD). For a live, sub-second link reading:

```bash
sudo python3 server.py
```

The mesh view works either way — `scanForNetworksWithName_error_` does not
require elevation.

## Configuration

Override the WebSocket origin (when the server isn't on localhost):

```bash
# frontend/.env
VITE_WS_BASE=ws://192.168.1.42:8765
```

## What's useful for debugging mesh failures

1. **Roam markers** — every channel change is logged with the position where
   it happened. A cluster of roams in one spot usually means weak handoff
   coverage.
2. **Mesh topology panel** — shows distinct BSSID count and channels per SSID.
   If your "mesh" only reports 1 radio, the satellite isn't broadcasting.
3. **Scan age** — turns orange when the macOS scanner stops returning data;
   indicates Wi-Fi sleep, driver issues, or out-of-range conditions.
4. **Connection beam** — drops when the link goes down even if the SSID
   doesn't change; useful for spotting sub-second drops the OS hides.
5. **Heatmap** — running-average per cell, walk around to map dead spots.
