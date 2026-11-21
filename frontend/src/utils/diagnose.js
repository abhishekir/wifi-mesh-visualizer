// Turns a /diagnose report into per-hop verdicts and suggestions. The hop
// whose latency rises first under load is where traffic queues; every verdict
// quotes the measurements behind it.

export const QUEUE_MS = 30; // latency rise under load that means a queue is filling
// Pings lost beyond the previous hop's in one phase; a single lost ping isn't
// enough to blame a hop.
const MIN_LOST = 2;
// Real throughput is ~50–65% of the PHY rate, so above this share of the link
// rate the Wi-Fi link itself is the limit.
const WIFI_LIMIT_SHARE = 0.45;
const PHASES = ["download", "upload"];

const ms = (value) => `${Math.round(value)} ms`;
const when = (phase) => (phase === "idle" ? "while idle" : `during ${phase}`);

function phaseText(hop, phase) {
  const stats = hop[phase];
  if (stats?.avgMs == null) return `${phase} no replies`;
  const loss = stats.lossPct > 0 ? ` (${stats.lossPct}% loss)` : "";
  return `${phase} ${ms(stats.avgMs)}${loss}`;
}

export function hopEvidence(hop) {
  return ["idle", ...PHASES].map((phase) => phaseText(hop, phase)).join(", ");
}

// Latency added by load in one phase; null when either phase had no replies
// (total loss is judged by lossyPhase, not as a latency drop).
function riseOf(hop, phase) {
  const loaded = hop?.[phase]?.avgMs;
  const idle = hop?.idle?.avgMs;
  return loaded == null || idle == null ? null : loaded - idle;
}

// Largest rise from idle to a loaded phase, minus the same rise at `base`
// (the previous hop) so each hop is charged only for its own queue.
function worstRise(hop, base) {
  let worst = null;
  for (const phase of PHASES) {
    const own = riseOf(hop, phase);
    const inherited = base ? riseOf(base, phase) : 0;
    if (own == null || inherited == null) continue;
    if (!worst || own - inherited > worst.rise) {
      worst = { phase, rise: own - inherited };
    }
  }
  return worst;
}

const lost = (hop, phase) => {
  const stats = hop?.[phase];
  return stats ? Math.round((stats.lossPct * stats.sent) / 100) : 0;
};

// First phase where this hop lost MIN_LOST more pings than the previous hop.
function lossyPhase(hop, base) {
  return (
    ["idle", ...PHASES].find(
      (phase) => lost(hop, phase) - lost(base, phase) >= MIN_LOST,
    ) ?? null
  );
}

// Internet traffic leaves by another interface (Ethernet, or Wi-Fi is off).
const offWifi = (report) =>
  !report.vpn && report.internetInterface !== report.wifiInterface;

function assessWifi(report, router) {
  const { link } = report;
  const hop = "Wi-Fi link";
  if (!router) {
    return { hop, status: "unknown", summary: "Router not found.", evidence: [] };
  }
  const width = link.widthMhz ? ` ${link.widthMhz} MHz` : "";
  const evidence = [
    `Signal ${link.rssi} dBm, SNR ${link.snr} dB, ${link.band}${width}, link rate ${link.txRate} Mbps`,
    `Router ${router.address}: ${hopEvidence(router)}`,
  ];
  if (offWifi(report)) {
    return {
      hop,
      status: "unknown",
      summary: `Internet traffic goes via ${report.internetInterface}, not Wi-Fi, so this run didn't load the Wi-Fi link.`,
      evidence,
    };
  }
  const problems = [];
  if (link.rssi && link.rssi < -70) problems.push(`Weak signal (${link.rssi} dBm)`);
  const lossy = lossyPhase(router);
  if (lossy) {
    problems.push(`${router[lossy].lossPct}% of pings to the router were lost ${when(lossy)}`);
  }
  const rise = worstRise(router);
  const congested = rise?.rise > QUEUE_MS;
  if (congested) {
    problems.push(
      `Latency to the router rises ${ms(rise.rise)} during ${rise.phase}: the Wi-Fi link is congested`,
    );
  }
  return problems.length
    ? { hop, status: "problem", summary: `${problems.join(". ")}.`, evidence, congested }
    : { hop, status: "ok", summary: "Stable latency and no loss to the router, idle and under load.", evidence };
}

function assessUpstream(vpn, router, isp) {
  const hop = "Router to ISP";
  if (vpn) {
    return { hop, status: "unknown", summary: "Not measured while the VPN is on.", evidence: [] };
  }
  if (!router) {
    return { hop, status: "unknown", summary: "Not measured: router not found.", evidence: [] };
  }
  if (!isp) {
    return { hop, status: "unknown", summary: "The ISP's first hop didn't answer.", evidence: [] };
  }
  const evidence = [`First hop past the router ${isp.address}: ${hopEvidence(isp)}`];
  const problems = [];
  const rise = worstRise(isp, router);
  const bufferbloat = rise?.rise > QUEUE_MS;
  if (bufferbloat) {
    problems.push(
      `Latency builds up past the router during ${rise.phase} (+${ms(rise.rise)}): the modem or ISP link is queuing traffic (bufferbloat)`,
    );
  }
  const lossy = lossyPhase(isp, router);
  if (lossy) {
    problems.push(`Packets are lost past the router (${isp[lossy].lossPct}% ${when(lossy)})`);
  }
  return problems.length
    ? { hop, status: "problem", summary: `${problems.join(". ")}.`, evidence, bufferbloat }
    : { hop, status: "ok", summary: "No extra latency or loss past the router.", evidence };
}

function assessInternet(vpn, base, internet) {
  const hop = vpn ? "Internet (through VPN)" : "Internet past your ISP";
  if (!internet) return { hop, status: "unknown", summary: "Not measured.", evidence: [] };
  const evidence = [`${internet.address}: ${hopEvidence(internet)}`];
  const problems = [];
  const rise = worstRise(internet, base);
  if (rise?.rise > QUEUE_MS) {
    problems.push(`Latency rises a further ${ms(rise.rise)} during ${rise.phase}`);
  }
  const lossy = lossyPhase(internet, base);
  if (lossy) {
    problems.push(`${internet[lossy].lossPct}% of pings were lost ${when(lossy)}`);
  }
  return problems.length
    ? { hop, status: "problem", summary: `${problems.join(". ")}.`, evidence }
    : { hop, status: "ok", summary: "No extra latency or loss.", evidence };
}

function assessThroughput(report) {
  const hop = "Speed";
  const { downloadMbps: down, uploadMbps: up, link, vpn } = report;
  const tx = link.txRateUnderLoad;
  if (down == null && up == null) {
    return { hop, status: "unknown", summary: "Speed test didn't complete.", evidence: [] };
  }
  const evidence = [
    `Download ${down ?? "?"} Mbps, upload ${up ?? "?"} Mbps; Wi-Fi link rate under load ${tx || "?"} Mbps`,
  ];
  if (offWifi(report)) {
    return { hop, status: "unknown", summary: "Measured off Wi-Fi, so it says nothing about the Wi-Fi link.", evidence };
  }
  if (!tx) {
    return { hop, status: "unknown", summary: "Wi-Fi link rate unknown, so the limit can't be placed.", evidence };
  }
  const share = Math.max(down ?? 0, up ?? 0) / tx;
  if (share >= WIFI_LIMIT_SHARE) {
    return {
      hop,
      status: "problem",
      // macOS reports only the Mac's transmit rate, not the access point's.
      summary: `Throughput reaches ${Math.round(share * 100)}% of the Wi-Fi link rate: the Wi-Fi link is likely the limit (estimate).`,
      evidence,
    };
  }
  return {
    hop,
    status: "info",
    summary: `Throughput is well under the Wi-Fi link rate, so the cap is past your Wi-Fi: ${vpn ? "the VPN or " : ""}your ISP plan.`,
    evidence,
  };
}

function suggest(report, findings) {
  const { link, vpn, downloadMbps: down, uploadMbps: up } = report;
  const [wifi, upstream, internet, speed] = findings;
  const tips = [];
  if (vpn) {
    tips.push(
      "Disconnect the VPN and run again. It carries all internet traffic, so your ISP can't be measured separately.",
    );
  }
  if (link.rssi && link.rssi < -67) {
    tips.push(
      `Signal is weak here (${link.rssi} dBm). Move closer to the router or add a mesh unit between it and this spot.`,
    );
  }
  if (link.band === "2.4GHz" && link.ssidBands) {
    tips.push(
      link.ssidBands.includes("5GHz")
        ? "You're on 2.4 GHz although your network also broadcasts 5 GHz, which is usually several times faster. Move closer to the router, or give 5 GHz its own network name and join it."
        : "Only 2.4 GHz is visible for your network here. Turn on 5 GHz in the router if it's off; it's usually several times faster.",
    );
  }
  if (link.neighborsOnChannel >= 3) {
    const options = link.band === "2.4GHz" ? " (1, 6 or 11)" : "";
    tips.push(
      `${link.neighborsOnChannel} other networks overlap channel ${link.channel}. Pick a less crowded channel${options} in the router's settings.`,
    );
  }
  if (link.band !== "2.4GHz" && link.widthMhz && link.widthMhz < 80) {
    tips.push(
      `Channel width is ${link.widthMhz} MHz. Allowing 80 MHz in the router's settings roughly doubles the link's capacity.`,
    );
  }
  if (wifi.congested) {
    tips.push(
      "Pause heavy transfers on other devices and run again. If the spike goes away, they were saturating the Wi-Fi.",
    );
  }
  if (upstream.bufferbloat) {
    tips.push(
      "Turn on QoS or Smart Queue Management (SQM) on the router, set to about 90% of your plan's speed. If the router can't, ask the ISP about the modem.",
    );
  }
  if (speed.status === "info" && !vpn) {
    tips.push(
      `Compare ${down ?? "?"}/${up ?? "?"} Mbps with your ISP plan. If they match, the plan is the limit and only an upgrade will go faster.`,
    );
  }
  if (internet.status === "problem" && !vpn) {
    tips.push(
      "Latency or loss starts past your ISP's first hop. If it keeps happening, report it to the ISP with these numbers.",
    );
  }
  return tips;
}

export function assessDiagnosis(report) {
  const byName = Object.fromEntries(report.hops.map((hop) => [hop.name, hop]));
  const { router, isp, internet } = byName;
  const findings = [
    assessWifi(report, router),
    assessUpstream(report.vpn, router, isp),
    assessInternet(report.vpn, isp ?? router, internet),
    assessThroughput(report),
  ];
  return { findings, suggestions: suggest(report, findings) };
}
