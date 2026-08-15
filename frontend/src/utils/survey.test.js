import { describe, expect, it } from "vitest";
import {
  aggregateSurvey,
  classifySurvey,
  decodeSurveyStorage,
  isWithinSurveyWindow,
  mergeSurveyStates,
  mergeSurveyStatesForPersistence,
  migrateSurveyState,
  normalizeSurveySessionName,
  percentile,
  sampleFromMeshFrame,
  sessionToCsv,
  SURVEY_STORAGE_VERSION,
} from "./survey.js";

function reading(overrides = {}) {
  return {
    timestamp: 1_000,
    linkUp: true,
    ssid: "Home",
    bssid: "aa:bb:cc:dd:ee:ff",
    rssi: -58,
    snr: 30,
    txRate: 500,
    channel: 36,
    rssiSource: "iface",
    scanAge: 1,
    scanStale: false,
    ...overrides,
  };
}

function fullWindow(overrides = {}) {
  return Array.from({ length: 100 }, (_, index) =>
    reading({ timestamp: 1_000 + index * 100, ...overrides })
  );
}

describe("percentile", () => {
  it("sorts values and interpolates between samples", () => {
    expect(percentile([30, 10, 20, 40], 0.5)).toBe(25);
    expect(percentile([30, 10, 20, 40], 0.1)).toBeCloseTo(13);
  });

  it("ignores non-numeric values and handles an empty set", () => {
    expect(percentile([null, Number.NaN, -50], 0.5)).toBe(-50);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("isWithinSurveyWindow", () => {
  it("accepts boundary samples and rejects readings outside the window", () => {
    expect(isWithinSurveyWindow(1_000, 1_000, 11_000)).toBe(true);
    expect(isWithinSurveyWindow(11_000, 1_000, 11_000)).toBe(true);
    expect(isWithinSurveyWindow(999, 1_000, 11_000)).toBe(false);
    expect(isWithinSurveyWindow(11_001, 1_000, 11_000)).toBe(false);
  });
});

describe("normalizeSurveySessionName", () => {
  it("trims valid names and repairs empty values", () => {
    expect(normalizeSurveySessionName("  Upstairs  ")).toBe("Upstairs");
    expect(normalizeSurveySessionName("   ")).toBe("Untitled survey");
    expect(normalizeSurveySessionName(null)).toBe("Untitled survey");
  });
});

describe("sampleFromMeshFrame", () => {
  it("normalizes a mesh frame and lowercases the BSSID", () => {
    const sample = sampleFromMeshFrame({
      timestamp: 12.5,
      scanAge: 2,
      scanStale: false,
      connection: {
        linkUp: true,
        ssid: "Home",
        bssid: "AA:BB:CC:DD:EE:FF",
        rssi: -62,
        snr: 24,
        txRate: 300,
        channel: 149,
        rssiSource: "iface",
      },
    });

    expect(sample).toMatchObject({
      timestamp: 12_500,
      bssid: "aa:bb:cc:dd:ee:ff",
      rssi: -62,
      channel: 149,
    });
  });

  it("preserves an offline frame while removing sentinel measurements", () => {
    const sample = sampleFromMeshFrame({
      timestamp: 12.5,
      connection: { linkUp: false, rssi: 0, snr: 0, txRate: 0, channel: 0 },
    });

    expect(sample.linkUp).toBe(false);
    expect(sample.rssi).toBeNull();
    expect(sample.channel).toBeNull();
  });

  it("keeps severe SNR values but drops an unavailable zero sentinel", () => {
    const severe = sampleFromMeshFrame({
      connection: {
        linkUp: true,
        rssi: -60,
        noise: -55,
        snr: -5,
      },
    });
    const unavailable = sampleFromMeshFrame({
      connection: {
        linkUp: true,
        rssi: 0,
        noise: -90,
        snr: 0,
      },
    });
    const validZero = sampleFromMeshFrame({
      connection: {
        linkUp: true,
        rssi: -90,
        noise: -90,
        snr: 0,
      },
    });

    expect(severe.snr).toBe(-5);
    expect(unavailable.snr).toBeNull();
    expect(validZero.snr).toBe(0);
  });
});

describe("aggregateSurvey", () => {
  it("produces a healthy, high-confidence live survey", () => {
    const result = aggregateSurvey(fullWindow(), {
      room: "Office",
      startedAt: 1_000,
      endedAt: 11_000,
    });

    expect(result).toMatchObject({
      room: "Office",
      sampleCount: 100,
      sampleCoveragePercent: 100,
      validRssiSampleCount: 100,
      ifaceSampleCount: 100,
      medianRssi: -58,
      lowRssi: -58,
      linkDownPercent: 0,
      primaryBssid: "aa:bb:cc:dd:ee:ff",
      associationChanges: 0,
    });
    expect(result.confidence.level).toBe("high");
    expect(result.classification.level).toBe("healthy");
  });

  it("uses scan-backed RSSI with low confidence when live permission is absent", () => {
    const result = aggregateSurvey(
      fullWindow({ rssi: -72, rssiSource: "scan", snr: null }),
      { startedAt: 1_000, endedAt: 11_000 }
    );

    expect(result.medianRssi).toBe(-72);
    expect(result.ifaceSampleCount).toBe(0);
    expect(result.scanSampleCount).toBe(100);
    expect(result.confidence.level).toBe("low");
    expect(result.classification.level).toBe("weak");
  });

  it("rates confidence from the live readings actually used", () => {
    const samples = fullWindow({ rssi: -75, rssiSource: "scan" });
    samples[99] = {
      ...samples[99],
      rssi: -55,
      rssiSource: "iface",
    };
    const result = aggregateSurvey(samples, {
      startedAt: 1_000,
      endedAt: 11_000,
    });

    expect(result.validRssiSampleCount).toBe(100);
    expect(result.signalSampleCount).toBe(1);
    expect(result.medianRssi).toBe(-55);
    expect(result.confidence.level).toBe("low");
  });

  it("classifies a non-positive SNR as dead-zone risk", () => {
    const result = aggregateSurvey(fullWindow({ snr: -5 }), {
      startedAt: 1_000,
      endedAt: 11_000,
    });

    expect(result.medianSnr).toBe(-5);
    expect(result.classification.level).toBe("dead-zone");
  });

  it("returns no-data when frames have no usable RSSI", () => {
    const result = aggregateSurvey(
      fullWindow({ rssi: null, rssiSource: null }),
      { startedAt: 1_000, endedAt: 11_000 }
    );

    expect(result.validRssiSampleCount).toBe(0);
    expect(result.confidence.level).toBe("low");
    expect(result.classification.level).toBe("no-data");
  });

  it("flags a sustained disconnect as dead-zone risk", () => {
    const samples = fullWindow().map((sample, index) =>
      index < 20
        ? reading({
            ...sample,
            linkUp: false,
            rssi: null,
            snr: null,
            txRate: null,
          })
        : sample
    );
    const result = aggregateSurvey(samples, {
      startedAt: 1_000,
      endedAt: 11_000,
    });

    expect(result.linkDownPercent).toBe(20);
    expect(result.classification.level).toBe("dead-zone");
  });

  it("records an entirely offline room as dead-zone risk", () => {
    const result = aggregateSurvey(
      fullWindow({
        linkUp: false,
        rssi: null,
        snr: null,
        txRate: null,
        bssid: null,
      }),
      { startedAt: 1_000, endedAt: 11_000 }
    );

    expect(result.linkDownPercent).toBe(100);
    expect(result.validRssiSampleCount).toBe(0);
    expect(result.classification.level).toBe("dead-zone");
  });

  it("downgrades confidence when stream frames are missing", () => {
    const result = aggregateSurvey(fullWindow().slice(0, 20), {
      startedAt: 1_000,
      endedAt: 11_000,
    });

    expect(result.sampleCoveragePercent).toBe(20);
    expect(result.confidence.level).toBe("low");
    expect(result.confidence.reasons.join(" ")).toContain("expected stream frames");
  });

  it("treats an over-age scan cache as a data-quality warning", () => {
    const result = aggregateSurvey(fullWindow({ scanAge: 9 }), {
      startedAt: 1_000,
      endedAt: 11_000,
    });

    expect(result.scanStalePercent).toBe(100);
    expect(result.maxScanAge).toBe(9);
    expect(result.confidence.level).toBe("low");
  });

  it("counts BSSID and channel association changes without counting outages", () => {
    const samples = [
      reading({ timestamp: 1_000, bssid: "ap-1", channel: 36 }),
      reading({ timestamp: 1_100, bssid: "ap-2", channel: 36 }),
      reading({ timestamp: 1_200, linkUp: false, bssid: null, channel: null }),
      reading({ timestamp: 1_300, bssid: "ap-3", channel: 149 }),
      reading({ timestamp: 1_400, bssid: "ap-3", channel: 149 }),
    ];
    const result = aggregateSurvey(samples, {
      startedAt: 1_000,
      endedAt: 1_500,
    });

    expect(result.associationChanges).toBe(1);
    expect(result.bssids).toEqual(["ap-1", "ap-2", "ap-3"]);
    expect(result.channels).toEqual([36, 149]);
  });
});

describe("classifySurvey", () => {
  const base = {
    validRssiSampleCount: 50,
    linkDownPercent: 0,
    lowRssi: -60,
    medianRssi: -55,
    medianSnr: 30,
    rssiStdDev: 2,
  };

  it("separates weak and dead-zone thresholds", () => {
    expect(classifySurvey({ ...base, lowRssi: -72 }).level).toBe("weak");
    expect(classifySurvey({ ...base, lowRssi: -82 }).level).toBe("dead-zone");
  });

  it("reports the metric that caused a classification", () => {
    const result = classifySurvey({ ...base, medianSnr: 8 });
    expect(result.level).toBe("dead-zone");
    expect(result.reasons[0]).toContain("SNR");
  });
});

describe("survey persistence", () => {
  it("preserves an empty malformed storage value until explicit reset", () => {
    const decoded = decodeSurveyStorage("");

    expect(decoded.blocked).toBe(true);
    expect(decoded.error).toContain("left untouched");
    expect(decoded.state.sessions).toEqual([]);
  });

  it("migrates legacy session samples and repairs invalid active ids", () => {
    const migrated = migrateSurveyState({
      version: 0,
      activeSessionId: "missing",
      sessions: [
        {
          id: "session-1",
          name: "Baseline",
          createdAt: 100,
          samples: [{ id: "run-1", room: "Kitchen", endedAt: 200 }],
        },
      ],
    });

    expect(migrated.version).toBe(SURVEY_STORAGE_VERSION);
    expect(migrated.activeSessionId).toBe("session-1");
    expect(migrated.sessions[0].nameUpdatedAt).toBe(100);
    expect(migrated.sessions[0].measurements[0]).toMatchObject({
      id: "run-1",
      room: "Kitchen",
      capturedAt: 200,
    });
  });

  it("merges concurrent measurements by id without losing either tab", () => {
    const session = {
      id: "session-1",
      name: "Home",
      createdAt: 100,
      updatedAt: 100,
      measurements: [],
    };
    const merged = mergeSurveyStates(
      {
        activeSessionId: "session-1",
        sessions: [
          {
            ...session,
            updatedAt: 200,
            measurements: [
              { id: "run-a", room: "Office", capturedAt: 200 },
            ],
          },
        ],
      },
      {
        activeSessionId: "session-1",
        sessions: [
          {
            ...session,
            updatedAt: 300,
            measurements: [
              { id: "run-b", room: "Kitchen", capturedAt: 300 },
            ],
          },
        ],
      }
    );

    expect(
      merged.sessions[0].measurements.map((measurement) => measurement.id)
    ).toEqual(["run-a", "run-b"]);
  });

  it("does not let a stale measurement write revert a newer session name", () => {
    const merged = mergeSurveyStates(
      {
        sessions: [
          {
            id: "session-1",
            name: "Upstairs survey",
            createdAt: 100,
            updatedAt: 200,
            nameUpdatedAt: 200,
            measurements: [],
          },
        ],
      },
      {
        sessions: [
          {
            id: "session-1",
            name: "Home",
            createdAt: 100,
            updatedAt: 300,
            nameUpdatedAt: 100,
            measurements: [
              { id: "run-later", room: "Office", capturedAt: 300 },
            ],
          },
        ],
      }
    );

    expect(merged.sessions[0].name).toBe("Upstairs survey");
    expect(merged.sessions[0].nameUpdatedAt).toBe(200);
    expect(merged.sessions[0].updatedAt).toBe(300);
    expect(merged.sessions[0].measurements).toHaveLength(1);
  });

  it("keeps deletion tombstones from resurrecting stale tab data", () => {
    const merged = mergeSurveyStates(
      {
        sessions: [
          {
            id: "session-1",
            name: "Home",
            createdAt: 100,
            updatedAt: 300,
            measurements: [],
          },
        ],
        deletedMeasurementIds: ["run-old"],
      },
      {
        sessions: [
          {
            id: "session-1",
            name: "Home",
            createdAt: 100,
            updatedAt: 200,
            measurements: [
              { id: "run-old", room: "Office", capturedAt: 200 },
            ],
          },
        ],
      }
    );

    expect(merged.sessions[0].measurements).toEqual([]);
    expect(merged.deletedMeasurementIds).toEqual(["run-old"]);
  });

  it("applies stored session tombstones before a stale tab writes", () => {
    const merged = mergeSurveyStatesForPersistence(
      {
        sessions: [
          {
            id: "session-old",
            name: "Deleted elsewhere",
            createdAt: 100,
            updatedAt: 200,
            measurements: [],
          },
        ],
      },
      {
        sessions: [],
        deletedSessionIds: ["session-old"],
      }
    );

    expect(merged.sessions).toEqual([]);
    expect(merged.deletedSessionIds).toEqual(["session-old"]);
  });

  it("keeps explicit local session selections while merging before a write", () => {
    const sessions = [
      {
        id: "session-1",
        name: "First",
        createdAt: 100,
        updatedAt: 100,
        measurements: [],
      },
      {
        id: "session-2",
        name: "Second",
        createdAt: 200,
        updatedAt: 200,
        measurements: [],
      },
    ];
    const merged = mergeSurveyStatesForPersistence(
      {
        sessions,
        activeSessionId: null,
        baselineSessionId: null,
      },
      {
        sessions,
        activeSessionId: "session-1",
        baselineSessionId: "session-2",
      }
    );

    expect(merged.activeSessionId).toBeNull();
    expect(merged.baselineSessionId).toBeNull();
  });

  it("exports quoted CSV including explicit classification reasons", () => {
    const csv = sessionToCsv({
      name: 'Home, "August"',
      measurements: [
        {
          room: "Office",
          capturedAt: 1_000,
          classification: { label: "Healthy", reasons: ["Stable signal"] },
          confidence: { label: "High confidence" },
          channels: [36, 149],
        },
      ],
    });

    expect(csv).toContain('"Home, ""August"""');
    expect(csv).toContain('"36; 149"');
    expect(csv).toContain('"Stable signal"');
  });

  it("neutralizes spreadsheet formulas in user-controlled CSV fields", () => {
    const csv = sessionToCsv({
      name: "=DANGEROUS()",
      measurements: [
        {
          room: "+Kitchen",
          capturedAt: 1_000,
          medianRssi: -60,
          classification: { label: "Healthy", reasons: [] },
          confidence: { label: "High confidence", reasons: [] },
        },
      ],
    });

    expect(csv).toContain('"\'=DANGEROUS()"');
    expect(csv).toContain('"\'+Kitchen"');
    expect(csv).toContain('"-60"');
  });

  it("detects formulas hidden behind controls or full-width characters", () => {
    const csv = sessionToCsv({
      name: "\n=HIDDEN()",
      measurements: [
        {
          room: "＝FULLWIDTH()",
          capturedAt: 1_000,
          classification: { label: "Healthy", reasons: [] },
          confidence: { label: "High confidence", reasons: [] },
        },
      ],
    });

    expect(csv).toContain('"\'\n=HIDDEN()"');
    expect(csv).toContain('"\'＝FULLWIDTH()"');
  });
});
