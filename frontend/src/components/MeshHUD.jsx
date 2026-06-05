const healthColor = {
  Excellent: "#00ff88",
  Good: "#88ff00",
  Fair: "#ffcc00",
  Poor: "#ff3333",
  Offline: "#666",
  Unknown: "#888",
};

function getHealth(rssi) {
  if (!rssi) return "Unknown";
  if (rssi >= -50) return "Excellent";
  if (rssi >= -60) return "Good";
  if (rssi >= -70) return "Fair";
  return "Poor";
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function bandLabel(channel) {
  if (!channel) return "?";
  return channel > 14 ? "5GHz" : "2.4GHz";
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

  const { nodes, connection, scanStale, scanAge } = meshData;
  const linkUp = !!connection?.linkUp;
  const meshNetworks = nodes.filter((n) => n.isMesh);
  const uniqueSSIDs = [...new Set(nodes.map((n) => n.ssid))];
  const meshSSIDs = [...new Set(meshNetworks.map((n) => n.ssid))];

  const connHealth = linkUp ? getHealth(connection.rssi) : "Offline";
  const connColor = healthColor[connHealth];

  // Per-SSID mesh node breakdown — primary debugging surface.
  const meshBreakdown = {};
  for (const n of meshNetworks) {
    if (!meshBreakdown[n.ssid]) {
      meshBreakdown[n.ssid] = { bssids: new Set(), channels: new Set(), bands: new Set() };
    }
    meshBreakdown[n.ssid].bssids.add(n.bssid);
    meshBreakdown[n.ssid].channels.add(n.channel);
    meshBreakdown[n.ssid].bands.add(n.band);
  }

  return (
    <div style={styles.container}>
      <div style={styles.title}>Wi-Fi Mesh Visualizer</div>

      {scanStale && (
        <div style={styles.warnBanner}>
          Scan cache stale — Wi-Fi may be off or out of range.
        </div>
      )}

      {/* Connected network */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Connected</div>
        {linkUp ? (
          <>
            <div style={styles.row}>
              <span style={styles.label}>SSID</span>
              <span style={styles.value}>
                {connection.ssid}
                {connection.ssidInferred && (
                  <span
                    style={styles.inferredBadge}
                    title="SSID hidden by macOS — inferred from the latest scan by channel + RSSI proximity. The connection beam below is dashed amber while this is in effect."
                  >
                    inferred
                  </span>
                )}
              </span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Channel</span>
              <span style={styles.value}>
                {connection.channel} <span style={styles.bandTag}>{bandLabel(connection.channel)}</span>
              </span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Signal</span>
              <span style={{ ...styles.value, color: connColor }}>
                {connection.rssi} dBm
              </span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Noise</span>
              <span style={styles.value}>{connection.noise} dBm</span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>SNR</span>
              <span style={styles.value}>{connection.snr} dB</span>
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
          </>
        ) : (
          <div style={styles.offline}>No active Wi-Fi link</div>
        )}
      </div>

      {/* Scan summary */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Scan</div>
        <div style={styles.row}>
          <span style={styles.label}>APs Found</span>
          <span style={styles.value}>{nodes.length}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Networks</span>
          <span style={styles.value}>{uniqueSSIDs.length}</span>
        </div>
        {scanAge != null && (
          <div style={styles.row}>
            <span style={styles.label}>Age</span>
            <span style={{ ...styles.value, color: scanAge > 8 ? "#ffaa00" : "#ccc" }}>
              {scanAge.toFixed(1)}s
            </span>
          </div>
        )}
      </div>

      {/* Mesh detail — the debugging primary surface */}
      {meshSSIDs.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Mesh Topology</div>
          {meshSSIDs.map((ssid) => {
            const info = meshBreakdown[ssid];
            const isCurrent = linkUp && connection.ssid === ssid;
            return (
              <div key={ssid} style={{
                ...styles.meshRow,
                borderLeft: isCurrent ? "2px solid #4488ff" : "2px solid transparent",
                paddingLeft: 6,
              }}>
                <div style={styles.meshSsid}>{ssid}</div>
                <div style={styles.meshMeta}>
                  {info.bssids.size} radios · {info.channels.size} channels ·{" "}
                  {[...info.bands].sort().join("/")}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* AP list */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>APs ({nodes.length})</div>
        <div style={styles.nodeList}>
          {nodes.slice(0, 10).map((node) => {
            const health = getHealth(node.rssi);
            const color = healthColor[health];
            const isCurrent =
              linkUp &&
              node.ssid === connection.ssid &&
              node.channel === connection.channel;
            return (
              <div
                key={node.bssid + node.channel}
                style={{
                  ...styles.nodeRow,
                  background: isCurrent ? "rgba(68,136,255,0.08)" : "transparent",
                }}
                title={node.bssid}
              >
                <span style={styles.nodeName}>
                  {node.ssid}
                  <span style={styles.nodeBand}>CH{node.channel}·{node.band}</span>
                </span>
                <span style={{ ...styles.nodeSignal, color }}>{node.rssi}</span>
              </div>
            );
          })}
          {nodes.length > 10 && (
            <div style={styles.moreNodes}>+{nodes.length - 10} more</div>
          )}
        </div>
      </div>

      {/* Roaming log */}
      {roamEvents.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            Roams ({roamEvents.length})
          </div>
          <div style={styles.nodeList}>
            {roamEvents.slice(-8).reverse().map((evt) => (
              <div key={evt.id} style={styles.roamRow}>
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
    minWidth: 240,
    maxWidth: 300,
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
  warnBanner: {
    background: "rgba(255,170,0,0.12)",
    border: "1px solid rgba(255,170,0,0.3)",
    color: "#ffaa00",
    padding: "6px 8px",
    borderRadius: 6,
    fontSize: 11,
    marginBottom: 10,
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
  inferred: { color: "#888", marginLeft: 4, fontSize: 10 },
  inferredBadge: {
    color: "#ffaa00",
    background: "rgba(255,170,0,0.12)",
    border: "1px solid rgba(255,170,0,0.3)",
    borderRadius: 3,
    padding: "0 5px",
    marginLeft: 6,
    fontSize: 9,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    fontWeight: 700,
  },
  bandTag: { color: "#667", marginLeft: 4, fontSize: 10 },
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
  offline: {
    color: "#ff6666",
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 0",
  },
  meshRow: {
    marginBottom: 6,
  },
  meshSsid: {
    color: "#4ecdc4",
    fontWeight: 600,
    fontSize: 12,
  },
  meshMeta: {
    color: "#667",
    fontSize: 10,
    marginTop: 1,
  },
  nodeList: { marginTop: 4 },
  nodeRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "3px 4px",
    fontSize: 11,
    borderRadius: 3,
  },
  nodeName: {
    color: "#aab",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 180,
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
