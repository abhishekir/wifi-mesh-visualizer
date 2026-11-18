// Display rules for the HUDs' path diagnostics and mesh topology panels.
// Kept free of React so the thresholds and wording can be unit-tested.

export const TONE_COLORS = {
  good: "#00ff88",
  fair: "#ffcc00",
  poor: "#ff3333",
  unknown: "#888",
};

export const LINK_RATE_HINT =
  "The raw rate this Mac last used to send to the access point (PHY rate). " +
  "Real throughput is usually about half to two-thirds of it, and lower " +
  "when other devices share the channel.";

function tone(value, goodBelow, fairBelow) {
  if (!Number.isFinite(value)) return "unknown";
  if (value < goodBelow) return "good";
  if (value < fairBelow) return "fair";
  return "poor";
}

// Thresholds are for the single Wi-Fi hop to the router, not the internet.
export const latencyTone = (ms) => tone(ms, 10, 30);
export const jitterTone = (ms) => tone(ms, 5, 15);
export function lossTone(pct) {
  if (!Number.isFinite(pct)) return "unknown";
  if (pct === 0) return "good";
  return pct < 2 ? "fair" : "poor";
}

export function describeInternetRoute(path) {
  const iface = path?.internetInterface;
  if (!iface) {
    return { label: "No route", tone: "poor", note: null };
  }
  if (path.vpn) {
    return {
      label: `VPN (${iface})`,
      tone: "fair",
      note: "Speed tests measure the VPN path, not your ISP.",
    };
  }
  if (iface === path.wifiInterface) {
    return { label: "Direct", tone: "good", note: null };
  }
  return {
    label: `Via ${iface}`,
    tone: "unknown",
    note: "Internet traffic isn't using Wi-Fi.",
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Per-SSID breakdown of mesh networks (SSIDs broadcast by >1 radio).
export function summarizeMeshNetworks(nodes) {
  const bySsid = new Map();
  for (const node of nodes) {
    if (!node.isMesh) continue;
    let info = bySsid.get(node.ssid);
    if (!info) {
      info = {
        ssid: node.ssid,
        bssids: new Set(),
        channels: new Set(),
        bssidsByBand: new Map(),
        bssidsHidden: false,
      };
      bySsid.set(node.ssid, info);
    }
    info.bssids.add(node.bssid);
    info.channels.add(node.channel);
    if (!info.bssidsByBand.has(node.band)) {
      info.bssidsByBand.set(node.band, new Set());
    }
    info.bssidsByBand.get(node.band).add(node.bssid);
    info.bssidsHidden ||= Boolean(node.bssidHidden);
  }
  return [...bySsid.values()].map((info) => ({
    ssid: info.ssid,
    radios: info.bssids.size,
    channels: info.channels.size,
    bands: [...info.bssidsByBand.keys()].sort().map((band) => ({
      band,
      radios: info.bssidsByBand.get(band).size,
    })),
    bssidsHidden: info.bssidsHidden,
  }));
}

export const HIDDEN_BSSIDS_HINT =
  "macOS hid these access points' BSSIDs, so radios sharing a channel merge " +
  "into one entry. A single dual-band router and several mesh units on the " +
  "same channels look identical here. Enable Location Services for the " +
  "terminal running the server to see BSSIDs.";

export function describeMeshRadios(summary) {
  const channels = plural(summary.channels, "channel");
  if (summary.bssidsHidden) {
    // Entries are per-channel merges, so a radio count would mislead.
    return {
      primary: `${channels} · ${summary.bands.map((b) => b.band).join("/")}`,
      secondary: null,
      title: HIDDEN_BSSIDS_HINT,
    };
  }
  return {
    primary: `${plural(summary.radios, "radio")} · ${channels}`,
    secondary: summary.bands.map((b) => `${b.band} ×${b.radios}`).join(" · "),
    title:
      "A radio is one BSSID. Each mesh unit usually has one radio per band, " +
      "so the per-band count is the best estimate of how many units are in " +
      "range.",
  };
}
