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
launcher selects the next available port and configures the UI automatically.

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

Each result includes median and low-percentile RSSI, SNR, transmit rate,
signal variation, link-down percentage, serving radio, channel changes, and
an explicit assessment. A result is marked low confidence when live readings
are unavailable, scan-backed readings are stale, too few readings arrive, or
the stream does not cover most of the capture window. Sessions are stored
only in the browser's local storage.

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
6. **Room survey** — ranks named locations using repeatable signal and link
   stability measurements instead of inferred 3D coordinates.
