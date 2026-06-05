const healthColor = {
  Excellent: "#00ff88",
  Good: "#88ff00",
  Fair: "#ffcc00",
  Poor: "#ff3333",
  Offline: "#666",
  Unknown: "#888",
};

export default function SignalHUD({ data, connected }) {
  if (!connected) {
    return (
      <div style={styles.container}>
        <div style={styles.disconnected}>
          Connecting to Wi-Fi bridge...
          <div style={styles.sub}>
            Make sure <code>python3 server.py</code> is running
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={styles.container}>
        <div style={styles.waiting}>Waiting for data...</div>
      </div>
    );
  }

  if (!data.linkUp) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>Wi-Fi Signal Visualizer</div>
        <div style={styles.offline}>No active Wi-Fi link</div>
        <div style={styles.sub}>Connect to a network to see terrain</div>
      </div>
    );
  }

  const color = healthColor[data.health] || "#ffffff";

  return (
    <div style={styles.container}>
      <div style={styles.title}>Wi-Fi Signal Visualizer</div>

      <div style={styles.row}>
        <span style={styles.label}>SSID</span>
        <span style={styles.value}>{data.ssid}</span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>Signal</span>
        <span style={{ ...styles.value, color }}>
          {data.rssi} dBm
          {data.rssiSource === "scan" && (
            <span style={styles.fromScan} title="Backfilled from scan (run as root for live RSSI)">
              ~scan
            </span>
          )}
        </span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>Noise</span>
        <span style={styles.value}>{data.noise} dBm</span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>SNR</span>
        <span style={styles.value}>{data.snr} dB</span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>Tx Rate</span>
        <span style={styles.value}>{data.txRate} Mbps</span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>Channel</span>
        <span style={styles.value}>{data.channel}</span>
      </div>

      <div style={styles.healthBadge}>
        <span
          style={{
            ...styles.healthDot,
            backgroundColor: color,
            boxShadow: `0 0 8px ${color}`,
          }}
        />
        <span style={{ ...styles.healthText, color }}>{data.health}</span>
      </div>
    </div>
  );
}

const styles = {
  container: {
    position: "absolute",
    top: 20,
    left: 20,
    background: "rgba(10, 12, 20, 0.85)",
    backdropFilter: "blur(10px)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    padding: "16px 22px",
    color: "#e0e0e0",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 13,
    minWidth: 220,
    zIndex: 10,
    userSelect: "none",
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: "#ffffff",
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  label: {
    color: "#888",
    marginRight: 16,
  },
  value: {
    fontWeight: 600,
    color: "#e0e0e0",
  },
  healthBadge: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    paddingTop: 10,
    borderTop: "1px solid rgba(255,255,255,0.1)",
  },
  healthDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    display: "inline-block",
  },
  healthText: {
    fontSize: 16,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  disconnected: {
    color: "#ff6666",
    fontWeight: 600,
    fontSize: 14,
  },
  waiting: {
    color: "#aaa",
    fontSize: 14,
  },
  offline: {
    color: "#ff6666",
    fontSize: 14,
    fontWeight: 600,
    marginBottom: 6,
  },
  sub: {
    color: "#999",
    fontSize: 11,
    marginTop: 6,
    fontWeight: 400,
  },
  fromScan: {
    fontSize: 10,
    color: "#888",
    marginLeft: 6,
    fontWeight: 400,
  },
};
