import { describe, it, expect } from "vitest";
import { assessDiagnosis, hopEvidence } from "./diagnose.js";

const stats = (avgMs, lossPct = 0) => ({ sent: 50, lossPct, avgMs });
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
    rssi: -24, snr: 48, txRate: 144, channel: 9, band: "2.4GHz",
    widthMhz: 20, neighborsOnChannel: 15, ssidBands: ["2.4GHz"],
  },
  vpn: true,
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
    rssi: -48, snr: 50, txRate: 866, channel: 149, band: "5GHz",
    widthMhz: 80, neighborsOnChannel: 1, ssidBands: ["2.4GHz", "5GHz"],
  },
  vpn: false,
  hops: [
    hop("router", "192.168.86.1", [5], [8], [9]),
    hop("isp", "73.158.238.1", [12], [20], [700]),
    hop("internet", "1.1.1.1", [24], [33], [714]),
  ],
  downloadMbps: 231,
  uploadMbps: 52,
};

const byHop = (result) =>
  Object.fromEntries(result.findings.map((f) => [f.hop, f]));

describe("assessDiagnosis", () => {
  it("blames a congested Wi-Fi link when router latency rises under load", () => {
    const result = assessDiagnosis(congestedWifiOverVpn);
    const f = byHop(result);
    expect(f["Wi-Fi link"].status).toBe("problem");
    expect(f["Wi-Fi link"].summary).toMatch(/rises 174 ms during download/);
    expect(f["Wi-Fi link"].summary).toMatch(/congested/);
    expect(f["Speed"].summary).toMatch(/64% of the link rate: the Wi-Fi link is the limit/);
  });

  it("charges each hop only for its own queue", () => {
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
    const tips = assessDiagnosis(congestedWifiOverVpn).suggestions.join("\n");
    expect(tips).toMatch(/Only 2.4 GHz is visible/);
    expect(tips).toMatch(/15 other networks overlap channel 9.*\(1, 6 or 11\)/);
    expect(tips).toMatch(/Pause heavy transfers/);
  });

  it("finds upload bufferbloat past the router and a plan cap", () => {
    const result = assessDiagnosis(uploadBloatAtHome);
    const f = byHop(result);
    expect(f["Wi-Fi link"].status).toBe("ok");
    expect(f["Router to ISP"].summary).toMatch(/during upload \(\+684 ms\).*bufferbloat/);
    expect(f["Internet past your ISP"].status).toBe("ok");
    expect(f["Speed"].status).toBe("info");
    const tips = result.suggestions.join("\n");
    expect(tips).toMatch(/Smart Queue Management/);
    expect(tips).toMatch(/Compare 231\/52 Mbps with your ISP plan/);
    expect(tips).not.toMatch(/VPN|2.4 GHz|channel/);
  });

  it("flags a narrow 5 GHz channel", () => {
    const report = {
      ...uploadBloatAtHome,
      link: { ...uploadBloatAtHome.link, widthMhz: 40 },
    };
    expect(assessDiagnosis(report).suggestions.join("\n")).toMatch(
      /Channel width is 40 MHz/,
    );
  });

  it("ignores a single lost ping", () => {
    // Live run: 1 of 30 idle pings to 1.1.1.1 lost through the VPN.
    const report = {
      ...congestedWifiOverVpn,
      hops: [
        hop("router", "192.168.1.1", [18], [205, 1.9], [19]),
        { ...hop("internet", "1.1.1.1", [106], [314], [109]), idle: { sent: 30, lossPct: 3.3, avgMs: 106 } },
      ],
    };
    expect(byHop(assessDiagnosis(report))["Internet (through VPN)"].status).toBe("ok");
  });

  it("reports idle loss to the router", () => {
    const report = {
      ...uploadBloatAtHome,
      hops: [
        hop("router", "192.168.86.1", [5, 8], [8], [9]),
        ...uploadBloatAtHome.hops.slice(1),
      ],
    };
    expect(byHop(assessDiagnosis(report))["Wi-Fi link"].summary).toMatch(
      /8% of idle pings to the router were lost/,
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
