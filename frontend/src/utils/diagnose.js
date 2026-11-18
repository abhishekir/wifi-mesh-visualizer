// Turns a /diagnose report into per-hop verdicts and suggestions. The hop
// whose latency rises first under load is where traffic queues; every verdict
// quotes the measurements behind it.

export const QUEUE_MS = 30; // latency rise under load that means a queue is filling
// Idle pings lost beyond the previous hop's; one in ~30 is noise.
const MIN_LOST = 2;
// Real throughput is ~50–65% of the PHY rate, so above this share of the link
// rate the Wi-Fi link itself is the limit.
const WIFI_LIMIT_SHARE = 0.45;
const PHASES = ["download", "upload"];

const ms = (value) => `${Math.round(value)} ms`;

function phaseText(hop, phase) {
  const stats = hop[phase];
  if (stats?.avgMs == null) return `${phase} no replies`;
  const loss = stats.lossPct > 0 ? ` (${stats.lossPct}% loss)` : "";
  return `${phase} ${ms(stats.avgMs)}${loss}`;
}

export function hopEvidence(hop) {
  return ["idle", ...PHASES].map((phase) => phaseText(hop, phase)).join(", ");
}

// Largest rise in average latency from idle to a loaded phase, minus the same
// rise at `base` (the previous hop) so each hop is charged only for its own
// queue.
function worstRise(hop, base) {
  let worst = null;
  for (const phase of PHASES) {
    const own = hop?.[phase]?.avgMs - hop?.idle?.avgMs;
    const inherited = base ? base[phase]?.avgMs - base.idle?.avgMs : 0;
    const rise = own - (Number.isFinite(inherited) ? inherited : 0);
    if (Number.isFinite(rise) && (!worst || rise > worst.rise)) {
      worst = { phase, rise };
    }
  }
  return worst;
}

const lostIdle = (hop) =>
  hop?.idle ? Math.round((hop.idle.lossPct * hop.idle.sent) / 100) : 0;
const lossy = (hop, base) => lostIdle(hop) - lostIdle(base) >= MIN_LOST;

function assessWifi(link, router) {
  const hop = "Wi-Fi link";
  if (!router) {
    return { hop, status: "unknown", summary: "Router not found.", evidence: [] };
  }
  const width = link.widthMhz ? ` ${link.widthMhz} MHz` : "";
  const evidence = [
    `Signal ${link.rssi} dBm, SNR ${link.snr} dB, ${link.band}${width}, link rate ${link.txRate} Mbps`,
    `Router ${router.address}: ${hopEvidence(router)}`,
  ];
  const problems = [];
  if (link.rssi && link.rssi < -70) problems.push(`Weak signal (${link.rssi} dBm)`);
  if (lossy(router)) {
    problems.push(`${router.idle.lossPct}% of idle pings to the router were lost`);
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
    : { hop, status: "ok", summary: "Stable latency to the router, idle and under load.", evidence };
}

function assessUpstream(vpn, router, isp) {
  const hop = "Router to ISP";
  if (vpn) {
    return { hop, status: "unknown", summary: "Not measured while the VPN is on.", evidence: [] };
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
  if (lossy(isp, router)) {
    problems.push(`Packets are lost past the router (${isp.idle.lossPct}% idle)`);
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
  if (lossy(internet, base)) {
    problems.push(`${internet.idle.lossPct}% of idle pings were lost`);
  }
  return problems.length
    ? { hop, status: "problem", summary: `${problems.join(". ")}.`, evidence }
    : { hop, status: "ok", summary: "No extra latency or loss.", evidence };
}

function assessThroughput(report) {
  const hop = "Speed";
  const { downloadMbps: down, uploadMbps: up, link, vpn } = report;
  if (down == null) {
    return { hop, status: "unknown", summary: "Speed test didn't complete.", evidence: [] };
  }
  const evidence = [
    `Download ${down} Mbps, upload ${up ?? "?"} Mbps; Wi-Fi link rate ${link.txRate} Mbps`,
  ];
  const share = link.txRate ? down / link.txRate : 0;
  if (share >= WIFI_LIMIT_SHARE) {
    return {
      hop,
      status: "problem",
      summary: `Download is ${Math.round(share * 100)}% of the link rate: the Wi-Fi link is the limit.`,
      evidence,
    };
  }
  return {
    hop,
    status: "info",
    summary: `Download is well under the link rate, so the cap is past your Wi-Fi: ${vpn ? "the VPN or " : ""}your ISP plan.`,
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
  if (link.band === "2.4GHz") {
    tips.push(
      link.ssidBands?.includes("5GHz")
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
      `Compare ${down}/${up} Mbps with your ISP plan. If they match, the plan is the limit and only an upgrade will go faster.`,
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
    assessWifi(report.link, router),
    assessUpstream(report.vpn, router, isp),
    assessInternet(report.vpn, isp ?? router, internet),
    assessThroughput(report),
  ];
  return { findings, suggestions: suggest(report, findings) };
}
