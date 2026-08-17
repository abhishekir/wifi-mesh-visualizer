export const SURVEY_DURATION_SECONDS = 10;
export const SURVEY_STORAGE_VERSION = 3;
const DEFAULT_EXPECTED_SAMPLE_HZ = 10;
const MIN_EXPECTED_SAMPLE_HZ = 1;
const MAX_EXPECTED_SAMPLE_HZ = 20;
const REPRESENTATIVE_SOURCE_SHARE = 0.8;
const SCAN_AGE_WARNING_SECONDS = 8;
const MAX_TOMBSTONES = 1000;

export const SURVEY_THRESHOLDS = Object.freeze({
  weakMedianRssi: -67,
  weakLowRssi: -70,
  deadLowRssi: -78,
  weakSnr: 20,
  deadSnr: 10,
  weakVariability: 8,
  deadLinkDownPercent: 10,
});

export function normalizeSurveySessionName(name) {
  return String(name ?? "").trim() || "Untitled survey";
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function rounded(value, digits = 1) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numeric(values) {
  return values.filter(finite);
}

export function percentile(values, fraction) {
  const sorted = numeric(values).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const q = Math.min(1, Math.max(0, fraction));
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function standardDeviation(values) {
  const valid = numeric(values);
  if (valid.length < 2) return 0;
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const variance =
    valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length;
  return Math.sqrt(variance);
}

function mostCommon(values) {
  const counts = new Map();
  let winner = null;
  let winnerCount = 0;
  for (const value of values) {
    if (value == null || value === "") continue;
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  }
  return winner;
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
}

function normalizedTombstoneTimes(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const [id, deletedAt] of Object.entries(raw)) {
    if (finite(deletedAt) && deletedAt >= 0) {
      result[String(id)] = deletedAt;
    }
  }
  return result;
}

function compactTombstones(ids, rawTimes) {
  const times = normalizedTombstoneTimes(rawTimes);
  const selectedIds = unique([
    ...ids.map(String),
    ...Object.keys(times),
  ])
    .sort(
      (left, right) =>
        (times[right] ?? 0) - (times[left] ?? 0) ||
        left.localeCompare(right)
    )
    .slice(0, MAX_TOMBSTONES)
    .sort();
  const selectedTimes = {};
  for (const id of selectedIds) {
    if (finite(times[id])) selectedTimes[id] = times[id];
  }
  return { ids: selectedIds, times: selectedTimes };
}

function mergeTombstoneTimes(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [id, deletedAt] of Object.entries(
      normalizedTombstoneTimes(source)
    )) {
      merged[id] = Math.max(merged[id] ?? 0, deletedAt);
    }
  }
  return merged;
}

function expectedSampleHz(samples) {
  const intervals = [];
  for (let index = 1; index < samples.length; index += 1) {
    const interval = samples[index].timestamp - samples[index - 1].timestamp;
    if (interval > 0) intervals.push(interval);
  }
  const medianInterval = percentile(intervals, 0.5);
  if (!finite(medianInterval) || medianInterval <= 0) {
    return DEFAULT_EXPECTED_SAMPLE_HZ;
  }
  return Math.min(
    MAX_EXPECTED_SAMPLE_HZ,
    Math.max(MIN_EXPECTED_SAMPLE_HZ, 1000 / medianInterval)
  );
}

export function isWithinSurveyWindow(timestamp, startedAt, endedAt) {
  return (
    finite(timestamp) &&
    finite(startedAt) &&
    finite(endedAt) &&
    timestamp >= startedAt &&
    timestamp <= endedAt
  );
}

export function usableSnr(connection = {}) {
  if (!connection || typeof connection !== "object") return null;
  const hasRssi = finite(connection.rssi) && connection.rssi !== 0;
  const hasNoise = finite(connection.noise) && connection.noise !== 0;
  return hasRssi &&
    finite(connection.snr) &&
    (connection.snr !== 0 || hasNoise)
    ? connection.snr
    : null;
}

function associationChanges(samples) {
  let changes = 0;
  let previous = null;

  for (const sample of samples) {
    if (sample.collectorError != null) continue;
    if (!sample.linkUp) {
      previous = null;
      continue;
    }
    if (!sample.bssid && sample.channel == null) continue;
    if (previous) {
      const bothHaveBssid = Boolean(previous.bssid && sample.bssid);
      const bothHaveChannel =
        previous.channel != null && sample.channel != null;
      if (
        (bothHaveBssid && previous.bssid !== sample.bssid) ||
        (bothHaveChannel && previous.channel !== sample.channel)
      ) {
        changes += 1;
      }
    }
    previous = sample;
  }

  return changes;
}

export function sampleFromMeshFrame(meshData) {
  if (!meshData || typeof meshData !== "object") return null;
  const connection = meshData.connection ?? {};
  const hasRssi = finite(connection.rssi) && connection.rssi !== 0;
  const frameTimestamp = finite(meshData.timestamp)
    ? meshData.timestamp * 1000
    : Date.now();

  return {
    timestamp: frameTimestamp,
    linkUp: Boolean(connection.linkUp),
    ssid: connection.ssid || null,
    bssid:
      typeof connection.bssid === "string"
        ? connection.bssid.toLowerCase()
        : null,
    rssi: hasRssi ? connection.rssi : null,
    // The server uses zero as an unavailable sentinel when noise is absent,
    // but a negative SNR is a real (and severe) reading that must be kept.
    snr: usableSnr(connection),
    txRate:
      finite(connection.txRate) && connection.txRate > 0
        ? connection.txRate
        : null,
    channel:
      finite(connection.channel) && connection.channel > 0
        ? connection.channel
        : null,
    rssiSource: connection.rssiSource || null,
    collectorError:
      Object.hasOwn(connection, "error") && connection.error != null
        ? String(connection.error)
        : null,
    scanAge: finite(meshData.scanAge) ? meshData.scanAge : null,
    scanStale: Boolean(meshData.scanStale),
  };
}

export function assessSurveyConfidence(metrics) {
  const reasons = [];

  if (metrics.validRssiSampleCount === 0) {
    if (metrics.collectorFaultSampleCount > 0) {
      reasons.push(
        `${metrics.collectorFaultSampleCount} collector frames contained telemetry errors.`
      );
    }
    reasons.push("No usable RSSI readings were captured.");
    return {
      level: "low",
      label: "Low confidence",
      reasons,
    };
  }

  if (metrics.signalSource === "scan") {
    reasons.push(
      "RSSI came from the slower scan cache; grant macOS Location Services for live readings."
    );
  } else if (metrics.signalSource === "mixed") {
    reasons.push(
      "Neither live nor scan-backed RSSI covered enough of the window for a representative signal result."
    );
  } else if (metrics.signalSource === "unknown") {
    reasons.push("RSSI readings did not identify their measurement source.");
  }

  if (metrics.elapsedSeconds < SURVEY_DURATION_SECONDS * 0.8) {
    reasons.push("The capture window was shorter than recommended.");
  }
  if (metrics.sampleCoveragePercent < 80) {
    reasons.push(
      `Only ${metrics.sampleCoveragePercent}% of expected stream frames arrived.`
    );
  }
  if (metrics.signalSampleCount < 10) {
    reasons.push("Fewer than 10 RSSI readings contributed to the result.");
  }
  if (metrics.collectorFaultPercent > 0) {
    reasons.push(
      `Collector telemetry failed for ${metrics.collectorFaultPercent}% of received frames.`
    );
  }
  if (metrics.signalSource === "scan" && metrics.scanStalePercent > 0) {
    reasons.push("Scan-backed RSSI was stale during part of the capture.");
  }

  if (
    metrics.signalSource !== "iface" ||
    metrics.signalSampleCount < 10 ||
    metrics.sampleCoveragePercent <= 50 ||
    metrics.collectorFaultPercent >= 50 ||
    (metrics.signalSource === "scan" && metrics.scanStalePercent >= 50)
  ) {
    return { level: "low", label: "Low confidence", reasons };
  }

  if (reasons.length > 0) {
    return { level: "medium", label: "Medium confidence", reasons };
  }

  return {
    level: "high",
    label: "High confidence",
    reasons: ["Live interface readings covered the full survey window."],
  };
}

export function classifySurvey(metrics) {
  const t = SURVEY_THRESHOLDS;

  if (metrics.sampleCount === 0) {
    return {
      level: "no-data",
      label: "No stream data",
      reasons: ["No collector frames arrived during this capture."],
    };
  }

  const deadReasons = [];
  if (metrics.linkDownPercent >= t.deadLinkDownPercent) {
    deadReasons.push(
      `The Wi-Fi link was down for ${metrics.linkDownPercent}% of the capture.`
    );
  }
  if (metrics.lowRssi != null && metrics.lowRssi < t.deadLowRssi) {
    deadReasons.push(
      `Low-percentile signal fell below ${t.deadLowRssi} dBm.`
    );
  }
  if (metrics.medianSnr != null && metrics.medianSnr < t.deadSnr) {
    deadReasons.push(`Median SNR fell below ${t.deadSnr} dB.`);
  }
  if (deadReasons.length > 0) {
    return { level: "dead-zone", label: "Dead-zone risk", reasons: deadReasons };
  }

  if (
    metrics.linkSampleCount === 0 &&
    metrics.collectorFaultSampleCount > 0
  ) {
    return {
      level: "no-data",
      label: "Collector unavailable",
      reasons: ["Collector errors prevented any Wi-Fi link observations."],
    };
  }

  if (
    finite(metrics.sampleCoveragePercent) &&
    metrics.sampleCoveragePercent <= 50
  ) {
    return {
      level: "no-data",
      label: "Incomplete capture",
      reasons: [
        `Collector frames covered only ${metrics.sampleCoveragePercent}% of the capture window.`,
      ],
    };
  }

  if (metrics.signalSource === "mixed") {
    return {
      level: "no-data",
      label: "Mixed signal sources",
      reasons: [
        "Neither live nor scan-backed RSSI represented at least 80% of usable readings.",
      ],
    };
  }

  if (metrics.validRssiSampleCount === 0) {
    return {
      level: "no-data",
      label: "No signal data",
      reasons: ["Frames arrived, but none contained a usable RSSI reading."],
    };
  }

  if (metrics.signalSampleCount < 10) {
    return {
      level: "no-data",
      label: "Insufficient signal data",
      reasons: ["Fewer than 10 representative RSSI readings were captured."],
    };
  }

  const weakReasons = [];
  if (metrics.linkDownPercent > 0) {
    weakReasons.push("At least one link-down sample was observed.");
  }
  if (metrics.lowRssi != null && metrics.lowRssi < t.weakLowRssi) {
    weakReasons.push(
      `Low-percentile signal fell below ${t.weakLowRssi} dBm.`
    );
  }
  if (metrics.medianRssi != null && metrics.medianRssi < t.weakMedianRssi) {
    weakReasons.push(`Median signal fell below ${t.weakMedianRssi} dBm.`);
  }
  if (metrics.medianSnr != null && metrics.medianSnr < t.weakSnr) {
    weakReasons.push(`Median SNR fell below ${t.weakSnr} dB.`);
  }
  if (metrics.rssiStdDev >= t.weakVariability) {
    weakReasons.push(
      `Signal varied by ${metrics.rssiStdDev} dB, suggesting an unstable edge location.`
    );
  }
  if (weakReasons.length > 0) {
    return { level: "weak", label: "Needs attention", reasons: weakReasons };
  }

  return {
    level: "healthy",
    label: "Healthy",
    reasons: ["Signal, SNR, and link stability stayed above warning thresholds."],
  };
}

export function aggregateSurvey(samples, options = {}) {
  const ordered = [...(samples ?? [])]
    .filter((sample) => sample && finite(sample.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  const collectorFaults = ordered.filter(
    (sample) => sample.collectorError != null
  );
  const linkSamples = ordered.filter(
    (sample) => sample.collectorError == null
  );
  const connected = linkSamples.filter((sample) => sample.linkUp);
  const offline = linkSamples.filter((sample) => !sample.linkUp);
  const withRssi = connected.filter((sample) => finite(sample.rssi));
  const ifaceSamples = withRssi.filter(
    (sample) => sample.rssiSource === "iface"
  );
  const scanSamples = withRssi.filter((sample) => sample.rssiSource === "scan");
  const ifaceShare = withRssi.length
    ? ifaceSamples.length / withRssi.length
    : 0;
  const scanShare = withRssi.length
    ? scanSamples.length / withRssi.length
    : 0;
  let signalSource = "none";
  let signalSamples = [];
  if (ifaceShare >= REPRESENTATIVE_SOURCE_SHARE) {
    signalSource = "iface";
    signalSamples = ifaceSamples;
  } else if (scanShare >= REPRESENTATIVE_SOURCE_SHARE) {
    signalSource = "scan";
    signalSamples = scanSamples;
  } else if (
    withRssi.length > 0 &&
    ifaceSamples.length === 0 &&
    scanSamples.length === 0
  ) {
    signalSource = "unknown";
    signalSamples = withRssi;
  } else if (withRssi.length > 0) {
    signalSource = "mixed";
  }
  const rssiValues = signalSamples.map((sample) => sample.rssi);
  const startedAt = finite(options.startedAt)
    ? options.startedAt
    : ordered[0]?.timestamp ?? Date.now();
  const endedAt = finite(options.endedAt)
    ? options.endedAt
    : ordered.at(-1)?.timestamp ?? startedAt;
  const total = ordered.length;
  const scanAges = numeric(ordered.map((sample) => sample.scanAge));
  const staleScanCount = scanSamples.filter(
    (sample) =>
      sample.scanStale ||
      (finite(sample.scanAge) && sample.scanAge > SCAN_AGE_WARNING_SECONDS)
  ).length;
  const elapsedSeconds = Math.max(0, endedAt - startedAt) / 1000;
  const inferredSampleHz = expectedSampleHz(ordered);
  const expectedSamples = elapsedSeconds * inferredSampleHz;

  const metrics = {
    room: String(options.room ?? "").trim(),
    startedAt,
    endedAt,
    elapsedSeconds: rounded(elapsedSeconds),
    expectedSampleHz: rounded(inferredSampleHz),
    sampleCount: total,
    sampleCoveragePercent: rounded(
      expectedSamples ? Math.min(100, (total / expectedSamples) * 100) : 0
    ),
    linkSampleCount: linkSamples.length,
    connectedSampleCount: connected.length,
    offlineSampleCount: offline.length,
    collectorFaultSampleCount: collectorFaults.length,
    collectorFaultPercent: rounded(
      total ? (collectorFaults.length / total) * 100 : 0
    ),
    validRssiSampleCount: withRssi.length,
    signalSampleCount: signalSamples.length,
    signalSource,
    ifaceSampleCount: ifaceSamples.length,
    ifaceCoveragePercent: rounded(
      withRssi.length ? (ifaceSamples.length / withRssi.length) * 100 : 0
    ),
    scanSampleCount: scanSamples.length,
    linkDownPercent: rounded(
      linkSamples.length ? (offline.length / linkSamples.length) * 100 : null
    ),
    scanStalePercent: rounded(
      total ? (staleScanCount / total) * 100 : 0
    ),
    medianScanAge: rounded(percentile(scanAges, 0.5)),
    maxScanAge: rounded(scanAges.length ? Math.max(...scanAges) : null),
    medianRssi: rounded(percentile(rssiValues, 0.5)),
    lowRssi: rounded(percentile(rssiValues, 0.1)),
    minRssi: rounded(rssiValues.length ? Math.min(...rssiValues) : null),
    medianSnr: rounded(percentile(signalSamples.map((sample) => sample.snr), 0.5)),
    medianTxRate: rounded(
      percentile(signalSamples.map((sample) => sample.txRate), 0.5)
    ),
    rssiStdDev: rounded(standardDeviation(rssiValues)),
    ssid: mostCommon(connected.map((sample) => sample.ssid)),
    primaryBssid: mostCommon(connected.map((sample) => sample.bssid)),
    bssids: unique(connected.map((sample) => sample.bssid)).sort(),
    channels: unique(connected.map((sample) => sample.channel)).sort(
      (a, b) => a - b
    ),
    collectorErrors: unique(
      collectorFaults.map((sample) => sample.collectorError)
    ),
    associationChanges: associationChanges(ordered),
  };

  metrics.confidence = assessSurveyConfidence(metrics);
  metrics.classification = classifySurvey(metrics);
  return metrics;
}

function normalizedMeasurement(measurement, fallbackId) {
  if (!measurement || typeof measurement !== "object") return null;
  return {
    ...measurement,
    id: String(measurement.id || fallbackId),
    room: String(measurement.room ?? "").trim(),
    capturedAt: finite(measurement.capturedAt)
      ? measurement.capturedAt
      : finite(measurement.endedAt)
        ? measurement.endedAt
        : Date.now(),
  };
}

export function migrateSurveyState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sessions = (Array.isArray(source.sessions) ? source.sessions : [])
    .filter((session) => session && typeof session === "object")
    .map((session, sessionIndex) => {
      const sessionId = String(session.id ?? "");
      const migrationTime = Date.now();
      const createdAt = finite(session.createdAt)
        ? session.createdAt
        : migrationTime;
      const updatedAt = finite(session.updatedAt)
        ? session.updatedAt
        : createdAt;
      const measurements = (
        Array.isArray(session.measurements)
          ? session.measurements
          : Array.isArray(session.samples)
            ? session.samples
            : []
      )
        .map((measurement, measurementIndex) =>
          normalizedMeasurement(
            measurement,
            `legacy-${sessionId || sessionIndex}-${measurementIndex}`
          )
        )
        .filter(Boolean);
      return {
        ...session,
        id: sessionId,
        name: normalizeSurveySessionName(session.name),
        createdAt,
        updatedAt,
        // Older schemas only tracked aggregate session updates, so their
        // initial name is conservatively dated at session creation. This
        // prevents a later stale measurement write from impersonating a
        // rename during a cross-tab merge.
        nameUpdatedAt: finite(session.nameUpdatedAt)
          ? session.nameUpdatedAt
          : createdAt,
        measurements,
      };
    })
    .filter((session) => session.id);

  const sessionIds = new Set(sessions.map((session) => session.id));
  const hasActiveSelection = Object.hasOwn(source, "activeSessionId");
  const activeSessionId =
    hasActiveSelection && source.activeSessionId == null
      ? null
      : sessionIds.has(source.activeSessionId)
        ? source.activeSessionId
        : sessions[0]?.id ?? null;
  const baselineSessionId =
    sessionIds.has(source.baselineSessionId) &&
    source.baselineSessionId !== activeSessionId
      ? source.baselineSessionId
      : null;
  const compactedDeletedSessions = compactTombstones(
    Array.isArray(source.deletedSessionIds) ? source.deletedSessionIds : [],
    source.deletedSessionTimestamps
  );
  const compactedDeletedMeasurements = compactTombstones(
    Array.isArray(source.deletedMeasurementIds)
      ? source.deletedMeasurementIds
      : [],
    source.deletedMeasurementTimestamps
  );

  return {
    version: SURVEY_STORAGE_VERSION,
    sessions,
    activeSessionId,
    baselineSessionId,
    deletedSessionIds: compactedDeletedSessions.ids,
    deletedSessionTimestamps: compactedDeletedSessions.times,
    deletedMeasurementIds: compactedDeletedMeasurements.ids,
    deletedMeasurementTimestamps: compactedDeletedMeasurements.times,
  };
}

export function decodeSurveyStorage(stored) {
  if (stored == null) {
    return {
      state: migrateSurveyState(null),
      error: null,
      blocked: false,
    };
  }
  try {
    const parsed = JSON.parse(stored);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Array.isArray(parsed.sessions)
    ) {
      return {
        state: migrateSurveyState(null),
        error:
          "Saved survey history has an unrecognized structure and was left untouched. Reset it to continue.",
        blocked: true,
      };
    }
    const parsedVersion = Number(parsed.version);
    if (
      Object.hasOwn(parsed, "version") &&
      (!Number.isInteger(parsedVersion) ||
        parsedVersion < 0 ||
        parsedVersion > SURVEY_STORAGE_VERSION)
    ) {
      return {
        state: migrateSurveyState(null),
        error:
          "Saved survey history uses an unsupported version and was left untouched. Update the app or reset it to continue.",
        blocked: true,
      };
    }
    return {
      state: migrateSurveyState(parsed),
      error: null,
      blocked: false,
    };
  } catch {
    return {
      state: migrateSurveyState(null),
      error:
        "Saved survey history is malformed and was left untouched. Reset it to continue.",
      blocked: true,
    };
  }
}

export function mergeSurveyStates(currentRaw, incomingRaw) {
  const currentSource =
    currentRaw && typeof currentRaw === "object" ? currentRaw : {};
  const incomingSource =
    incomingRaw && typeof incomingRaw === "object" ? incomingRaw : {};
  const current = migrateSurveyState(currentRaw);
  const incoming = migrateSurveyState(incomingRaw);
  const mergedDeletedSessions = compactTombstones(
    [...current.deletedSessionIds, ...incoming.deletedSessionIds],
    mergeTombstoneTimes(
      current.deletedSessionTimestamps,
      incoming.deletedSessionTimestamps
    )
  );
  const mergedDeletedMeasurements = compactTombstones(
    [
      ...current.deletedMeasurementIds,
      ...incoming.deletedMeasurementIds,
    ],
    mergeTombstoneTimes(
      current.deletedMeasurementTimestamps,
      incoming.deletedMeasurementTimestamps
    )
  );
  const deletedSessionIds = mergedDeletedSessions.ids;
  const deletedMeasurementIds = mergedDeletedMeasurements.ids;
  const deletedSessions = new Set(deletedSessionIds);
  const deletedMeasurements = new Set(deletedMeasurementIds);
  const sessionsById = new Map();

  for (const candidate of [...current.sessions, ...incoming.sessions]) {
    if (deletedSessions.has(candidate.id)) continue;
    const existing = sessionsById.get(candidate.id);
    if (!existing) {
      sessionsById.set(candidate.id, {
        ...candidate,
        measurements: candidate.measurements.filter(
          (measurement) => !deletedMeasurements.has(measurement.id)
        ),
      });
      continue;
    }

    const newer =
      candidate.updatedAt >= existing.updatedAt ? candidate : existing;
    const newerName =
      candidate.nameUpdatedAt > existing.nameUpdatedAt
        ? candidate
        : candidate.nameUpdatedAt < existing.nameUpdatedAt
          ? existing
          : candidate.name.localeCompare(existing.name) >= 0
            ? candidate
            : existing;
    const measurementsById = new Map();
    for (const measurement of [
      ...existing.measurements,
      ...candidate.measurements,
    ]) {
      if (deletedMeasurements.has(measurement.id)) continue;
      const saved = measurementsById.get(measurement.id);
      if (!saved || measurement.capturedAt >= saved.capturedAt) {
        measurementsById.set(measurement.id, measurement);
      }
    }
    sessionsById.set(candidate.id, {
      ...existing,
      ...newer,
      name: newerName.name,
      nameUpdatedAt: Math.max(
        existing.nameUpdatedAt,
        candidate.nameUpdatedAt
      ),
      createdAt: Math.min(existing.createdAt, candidate.createdAt),
      updatedAt: Math.max(existing.updatedAt, candidate.updatedAt),
      measurements: [...measurementsById.values()].sort(
        (a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id)
      ),
    });
  }

  const sessions = [...sessionsById.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );
  const sessionIds = new Set(sessions.map((session) => session.id));
  const currentHasActive = Object.hasOwn(currentSource, "activeSessionId");
  const incomingHasActive = Object.hasOwn(incomingSource, "activeSessionId");
  const activeSessionId =
    currentHasActive && currentSource.activeSessionId == null
      ? null
      : sessionIds.has(current.activeSessionId)
        ? current.activeSessionId
        : incomingHasActive && incomingSource.activeSessionId == null
          ? null
          : sessionIds.has(incoming.activeSessionId)
            ? incoming.activeSessionId
            : sessions[0]?.id ?? null;
  const currentHasBaseline = Object.hasOwn(currentSource, "baselineSessionId");
  const incomingHasBaseline = Object.hasOwn(
    incomingSource,
    "baselineSessionId"
  );
  const baselineSessionId =
    currentHasBaseline && currentSource.baselineSessionId == null
      ? null
      : sessionIds.has(current.baselineSessionId) &&
          current.baselineSessionId !== activeSessionId
        ? current.baselineSessionId
        : incomingHasBaseline && incomingSource.baselineSessionId == null
          ? null
          : sessionIds.has(incoming.baselineSessionId) &&
              incoming.baselineSessionId !== activeSessionId
            ? incoming.baselineSessionId
            : null;

  return {
    version: SURVEY_STORAGE_VERSION,
    sessions,
    activeSessionId,
    baselineSessionId,
    deletedSessionIds,
    deletedSessionTimestamps: mergedDeletedSessions.times,
    deletedMeasurementIds,
    deletedMeasurementTimestamps: mergedDeletedMeasurements.times,
  };
}

export function mergeSurveyStatesForPersistence(currentRaw, storedRaw) {
  const merged = mergeSurveyStates(currentRaw, storedRaw);
  const current =
    currentRaw && typeof currentRaw === "object" ? currentRaw : {};
  const sessionIds = new Set(merged.sessions.map((session) => session.id));
  const hasActiveSelection = Object.hasOwn(current, "activeSessionId");
  const requestedActiveSessionId = current.activeSessionId;
  const activeSessionId = !hasActiveSelection
    ? merged.activeSessionId
    : requestedActiveSessionId == null
      ? null
      : sessionIds.has(requestedActiveSessionId)
        ? requestedActiveSessionId
        : merged.activeSessionId;
  const hasBaselineSelection = Object.hasOwn(current, "baselineSessionId");
  const requestedBaselineSessionId = current.baselineSessionId;
  const baselineSessionId = !hasBaselineSelection
    ? merged.baselineSessionId
    : requestedBaselineSessionId != null &&
        requestedBaselineSessionId !== activeSessionId &&
        sessionIds.has(requestedBaselineSessionId)
      ? requestedBaselineSessionId
      : null;

  return {
    ...merged,
    activeSessionId,
    baselineSessionId,
  };
}

function formulaCandidate(text) {
  const normalized = text.normalize("NFKC");
  let offset = 0;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    const ignorable =
      character.trim() === "" ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      codePoint === 0x2060 ||
      codePoint === 0xfeff;
    if (!ignorable) break;
    offset += character.length;
  }
  return normalized.slice(offset);
}

function csvCell(value) {
  if (value == null) return "";
  let text = Array.isArray(value) ? value.join("; ") : String(value);
  const mayContainUserText =
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.some((entry) => typeof entry === "string"));
  // SSIDs and user-entered names can begin with spreadsheet formula
  // characters. Prefix those fields so opening an export cannot execute them.
  if (mayContainUserText && /^[=+\-@]/.test(formulaCandidate(text))) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function sessionToCsv(session) {
  const headers = [
    "session",
    "room",
    "capturedAt",
    "status",
    "confidence",
    "medianRssi",
    "lowRssi",
    "minRssi",
    "medianSnr",
    "medianTxRate",
    "rssiStdDev",
    "linkDownPercent",
    "ssid",
    "primaryBssid",
    "channels",
    "associationChanges",
    "sampleCount",
    "sampleCoveragePercent",
    "expectedSampleHz",
    "linkSampleCount",
    "collectorFaultSampleCount",
    "collectorFaultPercent",
    "signalSampleCount",
    "signalSource",
    "ifaceSampleCount",
    "ifaceCoveragePercent",
    "scanSampleCount",
    "scanStalePercent",
    "medianScanAge",
    "maxScanAge",
    "collectorErrors",
    "reasons",
    "confidenceReasons",
  ];
  const rows = (session?.measurements ?? []).map((measurement) => [
    session.name,
    measurement.room,
    new Date(measurement.capturedAt).toISOString(),
    measurement.classification?.label,
    measurement.confidence?.label,
    measurement.medianRssi,
    measurement.lowRssi,
    measurement.minRssi,
    measurement.medianSnr,
    measurement.medianTxRate,
    measurement.rssiStdDev,
    measurement.linkDownPercent,
    measurement.ssid,
    measurement.primaryBssid,
    measurement.channels,
    measurement.associationChanges,
    measurement.sampleCount,
    measurement.sampleCoveragePercent,
    measurement.expectedSampleHz,
    measurement.linkSampleCount,
    measurement.collectorFaultSampleCount,
    measurement.collectorFaultPercent,
    measurement.signalSampleCount,
    measurement.signalSource,
    measurement.ifaceSampleCount,
    measurement.ifaceCoveragePercent,
    measurement.scanSampleCount,
    measurement.scanStalePercent,
    measurement.medianScanAge,
    measurement.maxScanAge,
    measurement.collectorErrors,
    measurement.classification?.reasons,
    measurement.confidence?.reasons,
  ]);

  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\n");
}
