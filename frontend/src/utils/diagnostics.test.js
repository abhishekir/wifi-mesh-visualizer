import { describe, it, expect } from "vitest";
import {
  describeInternetRoute,
  describeMeshRadios,
  formatThroughput,
  jitterTone,
  latencyTone,
  lossTone,
  summarizeMeshNetworks,
} from "./diagnostics.js";

const node = (ssid, bssid, channel, band, extra = {}) => ({
  ssid,
  bssid,
  channel,
  band,
  isMesh: true,
  bssidHidden: false,
  ...extra,
});

describe("path tones", () => {
  it("grades router latency, jitter, and loss", () => {
    expect(latencyTone(3.8)).toBe("good");
    expect(latencyTone(18)).toBe("fair");
    expect(latencyTone(45)).toBe("poor");
    expect(jitterTone(1.9)).toBe("good");
    expect(jitterTone(20)).toBe("poor");
    expect(lossTone(0)).toBe("good");
    expect(lossTone(1.7)).toBe("fair");
    expect(lossTone(10)).toBe("poor");
  });

  it("reports unknown when there is no value", () => {
    expect(latencyTone(null)).toBe("unknown");
    expect(lossTone(undefined)).toBe("unknown");
  });
});

describe("describeInternetRoute", () => {
  const base = { wifiInterface: "en0" };

  it("flags a VPN carrying internet traffic", () => {
    const route = describeInternetRoute({
      ...base,
      internetInterface: "utun4",
      vpn: true,
    });
    expect(route.label).toBe("VPN (utun4)");
    expect(route.note).toMatch(/VPN path/);
  });

  it("calls a Wi-Fi default route direct", () => {
    expect(
      describeInternetRoute({ ...base, internetInterface: "en0", vpn: false }),
    ).toEqual({ label: "Direct", tone: "good", note: null });
  });

  it("names a non-Wi-Fi, non-VPN route", () => {
    const route = describeInternetRoute({
      ...base,
      internetInterface: "en7",
      vpn: false,
    });
    expect(route.label).toBe("Via en7");
    expect(route.note).toMatch(/isn't using Wi-Fi/);
  });

  it("handles no default route", () => {
    expect(describeInternetRoute({ ...base, internetInterface: null }).label).toBe(
      "No route",
    );
  });
});

describe("mesh radios", () => {
  it("counts radios per band when BSSIDs are visible", () => {
    const [summary] = summarizeMeshNetworks([
      node("home", "aa", 1, "2.4GHz"),
      node("home", "bb", 149, "5GHz"),
      node("home", "cc", 1, "2.4GHz"),
      node("home", "dd", 149, "5GHz"),
      { ...node("guest", "ee", 6, "2.4GHz"), isMesh: false },
    ]);
    expect(summary).toMatchObject({ ssid: "home", radios: 4, channels: 2 });
    expect(describeMeshRadios(summary)).toMatchObject({
      primary: "4 radios · 2 channels",
      secondary: "2.4GHz ×2 · 5GHz ×2",
    });
  });

  it("refuses to count units when macOS hid BSSIDs", () => {
    const [summary] = summarizeMeshNetworks([
      node("home", "hidden:home:1", 1, "2.4GHz", { bssidHidden: true }),
      node("home", "hidden:home:149", 149, "5GHz", { bssidHidden: true }),
    ]);
    const radios = describeMeshRadios(summary);
    expect(radios.primary).toBe("2 channels · 2.4GHz/5GHz");
    expect(radios.secondary).toBeNull();
    expect(radios.title).toMatch(/hid these access points' BSSIDs/);
  });

  it("treats a partly hidden SSID as hidden", () => {
    const [summary] = summarizeMeshNetworks([
      node("home", "aa", 149, "5GHz"),
      node("home", "hidden:home:1", 1, "2.4GHz", { bssidHidden: true }),
    ]);
    expect(summary.bssidsHidden).toBe(true);
  });

  it("uses singular wording for one channel", () => {
    const [summary] = summarizeMeshNetworks([
      node("home", "aa", 36, "5GHz"),
      node("home", "bb", 36, "5GHz"),
    ]);
    expect(describeMeshRadios(summary).primary).toBe("2 radios · 1 channel");
  });
});

describe("formatThroughput", () => {
  it("shows both directions with one decimal", () => {
    expect(formatThroughput({ downMbps: 100, upMbps: 3.1 })).toBe("↓ 100.0 ↑ 3.1 Mbps");
  });

  it("tells warming up apart from an older server without the field", () => {
    expect(formatThroughput(null)).toBe("Measuring…");
    expect(formatThroughput(undefined)).toBe("Unavailable");
  });
});
