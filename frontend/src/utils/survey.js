export const SURVEY_DURATION_SECONDS = 10;
export const SURVEY_STORAGE_VERSION = 2;
const EXPECTED_SAMPLE_HZ = 10;
const SCAN_AGE_WARNING_SECONDS = 8;

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
    if (!sample.linkUp) {
      previous = null;
      continue;
    }
    if (previous) {
      const bothHaveBssid = previous.bssid && sample.bssid;
      const neitherHasBssid = !previous.bssid && !sample.bssid;
      if (
        (bothHaveBssid && previous.bssid !== sample.bssid) ||
        (neitherHasBssid && previous.channel !== sample.channel) ||
        (!bothHaveBssid &&
          !neitherHasBssid &&
          previous.channel !== sample.channel)
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
    scanAge: finite(meshData.scanAge) ? meshData.scanAge : null,
    scanStale: Boolean(meshData.scanStale),
  };
}

export function assessSurveyConfidence(metrics) {
  const reasons = [];

  if (metrics.validRssiSampleCount === 0) {
    return {
      level: "low",
      label: "Low confidence",
      reasons: ["No usable RSSI readings were captured."],
    };
  }

  if (metrics.ifaceSampleCount === 0) {
    reasons.push(
      "RSSI came from the slower scan cache; grant macOS Location Services for live readings."
    );
  } else if (metrics.ifaceSampleCount < metrics.validRssiSampleCount * 0.8) {
    reasons.push("Live interface RSSI covered less than 80% of usable readings.");
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
  if (metrics.scanStalePercent > 0) {
    reasons.push("The background network scan was stale during part of the capture.");
  }

  if (
    metrics.ifaceSampleCount === 0 ||
    metrics.signalSampleCount < 10 ||
    metrics.sampleCoveragePercent <= 50 ||
    metrics.scanStalePercent >= 50
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

  if (metrics.validRssiSampleCount === 0) {
    return {
      level: "no-data",
      label: "No signal data",
      reasons: ["Frames arrived, but none contained a usable RSSI reading."],
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
  const connected = ordered.filter((sample) => sample.linkUp);
  const withRssi = connected.filter((sample) => finite(sample.rssi));
  const ifaceSamples = withRssi.filter(
    (sample) => sample.rssiSource === "iface"
  );
  const scanSamples = withRssi.filter((sample) => sample.rssiSource === "scan");
  // Prefer truly live readings. Fall back to scan-backed RSSI so a
  // permission-limited survey still produces a result with low confidence.
  const signalSamples = ifaceSamples.length > 0 ? ifaceSamples : withRssi;
  const rssiValues = signalSamples.map((sample) => sample.rssi);
  const startedAt = finite(options.startedAt)
    ? options.startedAt
    : ordered[0]?.timestamp ?? Date.now();
  const endedAt = finite(options.endedAt)
    ? options.endedAt
    : ordered.at(-1)?.timestamp ?? startedAt;
  const total = ordered.length;
  const scanAges = numeric(ordered.map((sample) => sample.scanAge));
  const staleCount = ordered.filter(
    (sample) =>
      sample.scanStale ||
      (finite(sample.scanAge) && sample.scanAge > SCAN_AGE_WARNING_SECONDS)
  ).length;
  const elapsedSeconds = Math.max(0, endedAt - startedAt) / 1000;
  const expectedSamples = elapsedSeconds * EXPECTED_SAMPLE_HZ;

  const metrics = {
    room: String(options.room ?? "").trim(),
    startedAt,
    endedAt,
    elapsedSeconds: rounded(elapsedSeconds),
    sampleCount: total,
    sampleCoveragePercent: rounded(
      expectedSamples ? Math.min(100, (total / expectedSamples) * 100) : 0
    ),
    connectedSampleCount: connected.length,
    offlineSampleCount: total - connected.length,
    validRssiSampleCount: withRssi.length,
    signalSampleCount: signalSamples.length,
    ifaceSampleCount: ifaceSamples.length,
    scanSampleCount: scanSamples.length,
    linkDownPercent: rounded(total ? ((total - connected.length) / total) * 100 : 100),
    scanStalePercent: rounded(total ? (staleCount / total) * 100 : 0),
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
  const activeSessionId = sessionIds.has(source.activeSessionId)
    ? source.activeSessionId
    : sessions[0]?.id ?? null;
  const baselineSessionId =
    sessionIds.has(source.baselineSessionId) &&
    source.baselineSessionId !== activeSessionId
      ? source.baselineSessionId
      : null;

  return {
    version: SURVEY_STORAGE_VERSION,
    sessions,
    activeSessionId,
    baselineSessionId,
    deletedSessionIds: unique(
      (
        Array.isArray(source.deletedSessionIds)
          ? source.deletedSessionIds
          : []
      ).map(String)
    ).sort(),
    deletedMeasurementIds: unique(
      (
        Array.isArray(source.deletedMeasurementIds)
          ? source.deletedMeasurementIds
          : []
      ).map(String)
    ).sort(),
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
    return {
      state: migrateSurveyState(JSON.parse(stored)),
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
  const current = migrateSurveyState(currentRaw);
  const incoming = migrateSurveyState(incomingRaw);
  const deletedSessionIds = unique(
    [...current.deletedSessionIds, ...incoming.deletedSessionIds].map(String)
  ).sort();
  const deletedMeasurementIds = unique(
    [
      ...current.deletedMeasurementIds,
      ...incoming.deletedMeasurementIds,
    ].map(String)
  ).sort();
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
  const activeSessionId = sessionIds.has(current.activeSessionId)
    ? current.activeSessionId
    : sessionIds.has(incoming.activeSessionId)
      ? incoming.activeSessionId
      : sessions[0]?.id ?? null;
  const baselineSessionId =
    sessionIds.has(current.baselineSessionId) &&
    current.baselineSessionId !== activeSessionId
      ? current.baselineSessionId
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
    deletedMeasurementIds,
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
    "signalSampleCount",
    "ifaceSampleCount",
    "scanSampleCount",
    "scanStalePercent",
    "medianScanAge",
    "maxScanAge",
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
    measurement.signalSampleCount,
    measurement.ifaceSampleCount,
    measurement.scanSampleCount,
    measurement.scanStalePercent,
    measurement.medianScanAge,
    measurement.maxScanAge,
    measurement.classification?.reasons,
    measurement.confidence?.reasons,
  ]);

  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\n");
}
