const healthColor = {
  Excellent: "#00ff88",
  Good: "#88ff00",
  Fair: "#ffcc00",
  Poor: "#ff3333",
};

function getHealth(rssi) {
  if (rssi >= -50) return "Excellent";
  if (rssi >= -60) return "Good";
  if (rssi >= -70) return "Fair";
  return "Poor";
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function MeshHUD({ meshData, connected, roamEvents = [] }) {
  if (!connected) {
    return (
      <div style={styles.container}>
        <div style={styles.disconnected}>
          Connecting to mesh scanner...
          <div style={styles.sub}>
            Run <code>python3 server.py</code>
          </div>
        </div>
      </div>
    );
  }

  if (!meshData?.nodes) {
    return (
      <div style={styles.container}>
        <div style={styles.waiting}>Scanning for networks...</div>
      </div>
    );
  }

  const { nodes, connection } = meshData;
  const meshNetworks = nodes.filter((n) => n.isMesh);
  const uniqueSSIDs = [...new Set(nodes.map((n) => n.ssid))];
  const meshSSIDs = [...new Set(meshNetworks.map((n) => n.ssid))];
  const connHealth = getHealth(connection.rssi);
  const connColor = healthColor[connHealth];

  return (
    <div style={styles.container}>
      <div style={styles.title}>Wi-Fi Mesh Visualizer</div>

      {/* Connected network */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Connected</div>
        <div style={styles.row}>
          <span style={styles.label}>SSID</span>
          <span style={styles.value}>{connection.ssid}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Signal</span>
          <span style={{ ...styles.value, color: connColor }}>
            {connection.rssi} dBm
          </span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Tx Rate</span>
          <span style={styles.value}>{connection.txRate} Mbps</span>
        </div>
        <div style={styles.healthBadge}>
          <span
            style={{
              ...styles.healthDot,
              backgroundColor: connColor,
              boxShadow: `0 0 8px ${connColor}`,
            }}
          />
          <span style={{ ...styles.healthText, color: connColor }}>
            {connHealth}
          </span>
        </div>
      </div>

      {/* Network stats */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Scan Results</div>
        <div style={styles.row}>
          <span style={styles.label}>APs Found</span>
          <span style={styles.value}>{nodes.length}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Networks</span>
          <span style={styles.value}>{uniqueSSIDs.length}</span>
        </div>
        {meshSSIDs.length > 0 && (
          <div style={styles.row}>
            <span style={styles.label}>Mesh</span>
            <span style={{ ...styles.value, color: "#4ecdc4" }}>
              {meshSSIDs.join(", ")}
            </span>
          </div>
        )}
      </div>

      {/* Node list */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          Nodes ({nodes.length})
        </div>
        <div style={styles.nodeList}>
          {nodes.slice(0, 8).map((node, i) => {
            const health = getHealth(node.rssi);
            const color = healthColor[health];
            return (
              <div key={node.bssid + node.channel} style={styles.nodeRow}>
                <span style={styles.nodeName}>
                  {node.ssid}
                  <span style={styles.nodeBand}>{node.band}</span>
                </span>
                <span style={{ ...styles.nodeSignal, color }}>
                  {node.rssi}
                </span>
              </div>
            );
          })}
          {nodes.length > 8 && (
            <div style={styles.moreNodes}>+{nodes.length - 8} more</div>
          )}
        </div>
      </div>

      {/* Roaming log */}
      {roamEvents.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            Roaming Events ({roamEvents.length})
          </div>
          <div style={styles.nodeList}>
            {roamEvents.slice(-5).reverse().map((evt, i) => (
              <div key={evt.time + i} style={styles.roamRow}>
                <span style={styles.roamTime}>{formatTime(evt.time)}</span>
                <span style={styles.roamArrow}>
                  CH{evt.from} → CH{evt.to}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    position: "absolute",
    top: 20,
    left: 20,
    background: "rgba(10, 12, 20, 0.88)",
    backdropFilter: "blur(12px)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12,
    padding: "16px 20px",
    color: "#e0e0e0",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 12,
    minWidth: 230,
    maxWidth: 280,
    maxHeight: "calc(100vh - 40px)",
    overflowY: "auto",
    zIndex: 10,
    userSelect: "none",
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    color: "#ffffff",
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  section: {
    marginBottom: 12,
    paddingBottom: 10,
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 600,
    color: "#556",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  label: { color: "#778" },
  value: { fontWeight: 600, color: "#ccc" },
  healthBadge: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  healthDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    display: "inline-block",
  },
  healthText: {
    fontSize: 13,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  nodeList: { marginTop: 4 },
  nodeRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "3px 0",
    fontSize: 11,
  },
  nodeName: {
    color: "#aab",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 160,
  },
  nodeBand: {
    fontSize: 9,
    color: "#556",
    marginLeft: 4,
  },
  nodeSignal: { fontWeight: 600, fontSize: 11 },
  moreNodes: {
    color: "#445",
    fontSize: 10,
    textAlign: "center",
    marginTop: 4,
  },
  roamRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "2px 0",
    fontSize: 10,
  },
  roamTime: { color: "#556", fontFamily: "monospace" },
  roamArrow: { color: "#ff8800", fontWeight: 600, fontSize: 11 },
  disconnected: { color: "#ff6666", fontWeight: 600, fontSize: 13 },
  waiting: { color: "#aaa", fontSize: 13 },
  sub: { color: "#999", fontSize: 10, marginTop: 6, fontWeight: 400 },
};
