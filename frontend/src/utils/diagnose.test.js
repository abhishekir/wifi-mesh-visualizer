import { describe, it, expect } from "vitest";
import { assessDiagnosis, hopEvidence } from "./diagnose.js";

const stats = (avgMs, lossPct = 0, sent = 50) => ({ sent, lossPct, avgMs });
const hop = (name, address, idle, download, upload) => ({
  name,
  address,
  idle: stats(...idle),
  download: stats(...download),
  upload: stats(...upload),
});

// Measured 2026-11-17: crowded 2.4 GHz link, VPN on.
const congestedWifiOverVpn = {
  link: {
    rssi: -24, snr: 48, txRate: 144, txRateUnderLoad: 144, channel: 9,
    band: "2.4GHz", widthMhz: 20, neighborsOnChannel: 15, ssidBands: ["2.4GHz"],
  },
  vpn: true,
  wifiInterface: "en0",
  internetInterface: "utun4",
  hops: [
    hop("router", "192.168.1.1", [10.9], [184.7, 4.1], [21.4, 1.9]),
    hop("internet", "1.1.1.1", [102.6], [291.1, 6.1], [108.9, 3.7]),
  ],
  downloadMbps: 92.7,
  uploadMbps: 41.6,
};

// Strong 5 GHz link, no VPN; the queue builds past the router on upload.
const uploadBloatAtHome = {
  link: {
    rssi: -48, snr: 50, txRate: 866, txRateUnderLoad: 866, channel: 149,
    band: "5GHz", widthMhz: 80, neighborsOnChannel: 1, ssidBands: ["2.4GHz", "5GHz"],
  },
  vpn: false,
  wifiInterface: "en0",
  internetInterface: "en0",
  hops: [
    hop("router", "192.168.86.1", [5], [8], [9]),
    hop("isp", "73.158.238.1", [12], [20], [700]),
    hop("internet", "1.1.1.1", [24], [33], [714]),
  ],
  downloadMbps: 231,
  uploadMbps: 52,
};

const withHop = (report, replacement) => ({
  ...report,
  hops: report.hops.map((h) => (h.name === replacement.name ? replacement : h)),
});
const withLink = (report, link) => ({ ...report, link: { ...report.link, ...link } });
const byHop = (result) =>
  Object.fromEntries(result.findings.map((f) => [f.hop, f]));
const tips = (report) => assessDiagnosis(report).suggestions.join("\n");

describe("assessDiagnosis", () => {
  it("blames a congested Wi-Fi link when router latency rises under load", () => {
    const f = byHop(assessDiagnosis(congestedWifiOverVpn));
    expect(f["Wi-Fi link"].status).toBe("problem");
    expect(f["Wi-Fi link"].summary).toMatch(/rises 174 ms during download/);
    expect(f["Wi-Fi link"].summary).toMatch(/4.1% of pings to the router were lost during download/);
    expect(f["Speed"].summary).toMatch(/reaches 64% of the Wi-Fi link rate.*\(estimate\)/);
  });

  it("charges each hop only for its own queue and loss", () => {
    // Internet latency rose 189 ms, but 174 of that is the Wi-Fi queue.
    const f = byHop(assessDiagnosis(congestedWifiOverVpn));
    expect(f["Internet (through VPN)"].status).toBe("ok");
  });

  it("doesn't judge the ISP through a VPN", () => {
    const result = assessDiagnosis(congestedWifiOverVpn);
    expect(byHop(result)["Router to ISP"].status).toBe("unknown");
    expect(result.suggestions[0]).toMatch(/Disconnect the VPN/);
  });

  it("suggests band and channel fixes for a crowded 2.4 GHz link", () => {
    const text = tips(congestedWifiOverVpn);
    expect(text).toMatch(/Only 2.4 GHz is visible/);
    expect(text).toMatch(/15 other networks overlap channel 9.*\(1, 6 or 11\)/);
    expect(text).toMatch(/Pause heavy transfers/);
  });

  it("finds upload bufferbloat past the router and a plan cap", () => {
    const result = assessDiagnosis(uploadBloatAtHome);
    const f = byHop(result);
    expect(f["Wi-Fi link"].status).toBe("ok");
    expect(f["Router to ISP"].summary).toMatch(/during upload \(\+684 ms\).*bufferbloat/);
    expect(f["Internet past your ISP"].status).toBe("ok");
    expect(f["Speed"].status).toBe("info");
    const text = result.suggestions.join("\n");
    expect(text).toMatch(/Smart Queue Management/);
    expect(text).toMatch(/Compare 231\/52 Mbps with your ISP plan/);
    expect(text).not.toMatch(/VPN|2.4 GHz|channel/);
  });

  it("flags a narrow 5 GHz channel", () => {
    expect(tips(withLink(uploadBloatAtHome, { widthMhz: 40 }))).toMatch(
      /Channel width is 40 MHz/,
    );
  });

  it("ignores a single lost ping", () => {
    const report = withHop(uploadBloatAtHome, {
      ...uploadBloatAtHome.hops[2],
      idle: stats(24, 3.3, 30),
    });
    expect(byHop(assessDiagnosis(report))["Internet past your ISP"].status).toBe("ok");
  });

  it("reports idle loss to the router", () => {
    const report = withHop(uploadBloatAtHome, hop("router", "192.168.86.1", [5, 8], [8], [9]));
    expect(byHop(assessDiagnosis(report))["Wi-Fi link"].summary).toMatch(
      /8% of pings to the router were lost while idle/,
    );
  });

  // R7
  it("reports loss under load even when latency stays flat", () => {
    const report = withHop(uploadBloatAtHome, hop("router", "192.168.86.1", [8], [22, 25], [9]));
    const wifi = byHop(assessDiagnosis(report))["Wi-Fi link"];
    expect(wifi.status).toBe("problem");
    expect(wifi.summary).toMatch(/25% of pings to the router were lost during download/);
  });

  // R3
  it("treats a loaded phase with no replies as loss, not a latency drop", () => {
    const report = withHop(uploadBloatAtHome, {
      ...hop("router", "192.168.86.1", [10], [0], [9]),
      download: { sent: 50, lossPct: 100, avgMs: null },
    });
    const f = byHop(assessDiagnosis(report));
    expect(f["Wi-Fi link"].status).toBe("problem");
    expect(f["Wi-Fi link"].summary).toMatch(/100% of pings to the router were lost during download/);
    expect(f["Wi-Fi link"].evidence[1]).toMatch(/download no replies/);
    // The ISP hop isn't charged for the router's missing download phase.
    expect(f["Router to ISP"].summary).toMatch(/during upload/);
  });

  // R1
  it("doesn't judge Wi-Fi when internet traffic uses another interface", () => {
    const report = { ...uploadBloatAtHome, internetInterface: "en7", downloadMbps: 900 };
    const f = byHop(assessDiagnosis(report));
    expect(f["Wi-Fi link"].status).toBe("unknown");
    expect(f["Wi-Fi link"].summary).toMatch(/goes via en7, not Wi-Fi/);
    expect(f["Speed"].status).toBe("unknown");
    expect(tips(report)).not.toMatch(/ISP plan/);
  });

  // R16
  it("still judges Wi-Fi when there's no internet route", () => {
    const report = { ...uploadBloatAtHome, internetInterface: null };
    const wifi = byHop(assessDiagnosis(report))["Wi-Fi link"];
    expect(wifi.status).toBe("ok");
    expect(wifi.summary).not.toMatch(/null/);
  });

  // R5
  it("compares throughput with the link rate measured under load", () => {
    // Idle link rate read 144 Mbps, but the link ran at 400 under load.
    const report = withLink(
      { ...uploadBloatAtHome, downloadMbps: 92, uploadMbps: 30 },
      { txRate: 144, txRateUnderLoad: 400 },
    );
    expect(byHop(assessDiagnosis(report))["Speed"].status).toBe("info");
  });

  // R8
  it("doesn't place the limit when the link rate is unknown", () => {
    const report = withLink(uploadBloatAtHome, { txRateUnderLoad: 0 });
    expect(byHop(assessDiagnosis(report))["Speed"]).toMatchObject({
      status: "unknown",
      summary: expect.stringMatching(/link rate unknown/),
    });
    expect(tips(report)).not.toMatch(/ISP plan/);
  });

  // R6
  it("skips the band tip when the scan can't tell which bands exist", () => {
    const report = withLink(congestedWifiOverVpn, {
      ssidBands: null,
      neighborsOnChannel: null,
    });
    expect(tips(report)).not.toMatch(/2.4 GHz|overlap/);
  });

  // R10
  it("prints ? for a failed upload test", () => {
    expect(tips({ ...uploadBloatAtHome, uploadMbps: null })).toMatch(
      /Compare 231\/\? Mbps/,
    );
  });

  // R11
  it("doesn't blame the ISP hop when there's no router", () => {
    const report = {
      ...uploadBloatAtHome,
      hops: [uploadBloatAtHome.hops[2]],
    };
    expect(byHop(assessDiagnosis(report))["Router to ISP"].summary).toBe(
      "Not measured: router not found.",
    );
  });
});

describe("hopEvidence", () => {
  it("lists each phase with loss only when present", () => {
    expect(hopEvidence(congestedWifiOverVpn.hops[0])).toBe(
      "idle 11 ms, download 185 ms (4.1% loss), upload 21 ms (1.9% loss)",
    );
  });
});
