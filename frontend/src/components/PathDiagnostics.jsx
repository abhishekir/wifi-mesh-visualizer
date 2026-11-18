import {
  TONE_COLORS,
  describeInternetRoute,
  jitterTone,
  latencyTone,
  lossTone,
} from "../utils/diagnostics";

// Router latency/loss and internet-route rows, shared by both HUDs. Takes the
// host HUD's row/label/value styles so it matches either panel's type scale.
export default function PathDiagnostics({ path, styles }) {
  if (!path) return null;

  const row = (label, value, { tone, tag, title } = {}) => (
    <div style={styles.row} title={title}>
      <span style={styles.label}>{label}</span>
      <span
        style={tone ? { ...styles.value, color: TONE_COLORS[tone] } : styles.value}
      >
        {value}
        {tag && <span style={local.tag}>{tag}</span>}
      </span>
    </div>
  );

  const ping = path.ping;
  const route = describeInternetRoute(path);

  return (
    <>
      {row("Router", path.router ?? "Not found", {
        tone: path.router ? undefined : "unknown",
        title: "Gateway of the Wi-Fi interface. Pings go over Wi-Fi only.",
      })}
      {path.router &&
        (ping ? (
          <>
            {row(
              "Latency",
              ping.avgMs != null ? `${ping.avgMs} ms` : "No replies",
              {
                tone: ping.avgMs != null ? latencyTone(ping.avgMs) : "poor",
                tag: ping.p95Ms != null ? `p95 ${ping.p95Ms}` : null,
                title: `Round trip to the router over the last ${ping.sent} pings. Measures only the Wi-Fi hop, not your internet connection.`,
              },
            )}
            {ping.jitterMs != null &&
              row("Jitter", `${ping.jitterMs} ms`, {
                tone: jitterTone(ping.jitterMs),
                title: "Average change in latency between consecutive pings.",
              })}
            {row("Loss", `${ping.lossPct}%`, {
              tone: lossTone(ping.lossPct),
              tag: `of ${ping.sent}`,
              title:
                "Pings to the router that got no reply. Some routers ignore ping; if every ping is lost while the signal is strong, that's the likely cause.",
            })}
          </>
        ) : (
          row("Latency", path.checkedAge == null ? "Measuring…" : "Unavailable", {
            tone: "unknown",
          })
        ))}
      {row("Internet", route.label, {
        tone: route.tone,
        title: "Interface carrying the IPv4 default route.",
      })}
      {route.note && <div style={local.note}>{route.note}</div>}
    </>
  );
}

const local = {
  tag: { color: "#667", marginLeft: 4, fontSize: 10, fontWeight: 400 },
  note: { color: "#ffcc00", fontSize: 10, marginTop: 2 },
};
