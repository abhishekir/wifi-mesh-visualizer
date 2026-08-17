import { useEffect, useMemo, useRef, useState } from "react";
import useSurveySessions from "../hooks/useSurveySessions.js";
import {
  aggregateSurvey,
  isWithinSurveyWindow,
  normalizeSurveySessionName,
  sampleFromMeshFrame,
  sessionToCsv,
  SURVEY_DURATION_SECONDS,
  SURVEY_STORAGE_VERSION,
  usableSnr,
} from "../utils/survey.js";
import "./SurveyView.css";

const STATUS_ORDER = {
  "dead-zone": 0,
  "no-data": 1,
  weak: 2,
  healthy: 3,
};

function defaultSessionName() {
  return `Home survey ${new Date().toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })}`;
}

function roomKey(room) {
  return String(room ?? "").trim().toLocaleLowerCase();
}

function groupedRooms(session) {
  const groups = new Map();
  for (const measurement of session?.measurements ?? []) {
    const key = roomKey(measurement.room);
    if (!key) continue;
    const group = groups.get(key) ?? {
      room: measurement.room,
      runs: [],
    };
    group.runs.push(measurement);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      group.runs.sort((a, b) => b.capturedAt - a.capturedAt);
      return { ...group, latest: group.runs[0] };
    })
    .sort((a, b) => {
      const statusDifference =
        (STATUS_ORDER[a.latest.classification?.level] ?? 9) -
        (STATUS_ORDER[b.latest.classification?.level] ?? 9);
      if (statusDifference !== 0) return statusDifference;
      return (a.latest.lowRssi ?? -Infinity) - (b.latest.lowRssi ?? -Infinity);
    });
}

function latestByRoom(session) {
  return new Map(
    groupedRooms(session).map((group) => [roomKey(group.room), group.latest])
  );
}

function metric(value, suffix = "") {
  return value == null ? "—" : `${value}${suffix}`;
}

function formatCapturedAt(timestamp) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function safeFilename(name) {
  return (
    String(name || "wifi-survey")
      .trim()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "wifi-survey"
  );
}

function downloadText(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ResultMetric({ label, value, tone }) {
  return (
    <div className="survey-metric">
      <span>{label}</span>
      <strong className={tone ? `survey-tone-${tone}` : ""}>{value}</strong>
    </div>
  );
}

export default function SurveyView({ meshData, connected, onCaptureChange }) {
  const {
    sessions,
    activeSessionId,
    baselineSessionId,
    activeSession,
    baselineSession,
    storageError,
    storageBlocked,
    persistedMeasurementIds,
    resetStorage,
    createSession,
    setActiveSessionId,
    setBaselineSessionId,
    renameSession,
    addMeasurement,
    deleteMeasurement,
    deleteSession,
  } = useSurveySessions();
  const [newSessionName, setNewSessionName] = useState(defaultSessionName);
  const [roomName, setRoomName] = useState("");
  const [capture, setCapture] = useState(null);
  const [capturedSamples, setCapturedSamples] = useState(0);
  const [clock, setClock] = useState(0);
  const [lastSavedRoom, setLastSavedRoom] = useState(null);
  const [pendingMeasurementSave, setPendingMeasurementSave] = useState(null);
  const [captureError, setCaptureError] = useState(null);
  const captureRef = useRef(null);
  const samplesRef = useRef([]);

  const rooms = useMemo(() => groupedRooms(activeSession), [activeSession]);
  const baselineRooms = useMemo(
    () => latestByRoom(baselineSession),
    [baselineSession]
  );
  const knownRoomNames = useMemo(
    () => [...new Set(rooms.map((group) => group.room))].sort(),
    [rooms]
  );

  useEffect(() => {
    const current = captureRef.current;
    if (!current) return;
    const receivedAt = Date.now();
    if (
      !isWithinSurveyWindow(
        receivedAt,
        current.startedAt,
        current.endsAt
      )
    ) {
      return;
    }
    const sample = sampleFromMeshFrame(meshData);
    if (!sample) return;
    // Use local receipt time for the survey window. VITE_WS_BASE can point at
    // another Mac whose wall clock is not synchronized with this browser.
    samplesRef.current.push({
      ...sample,
      sourceTimestamp: sample.timestamp,
      timestamp: receivedAt,
    });
    setCapturedSamples(samplesRef.current.length);
  }, [meshData]);

  useEffect(
    () => () => {
      onCaptureChange?.(false);
    },
    [onCaptureChange]
  );

  useEffect(() => {
    if (
      !pendingMeasurementSave ||
      !persistedMeasurementIds.has(pendingMeasurementSave.id)
    ) {
      return;
    }
    setLastSavedRoom(pendingMeasurementSave.room);
    setPendingMeasurementSave(null);
  }, [pendingMeasurementSave, persistedMeasurementIds]);

  useEffect(() => {
    if (!storageBlocked) return;
    setPendingMeasurementSave(null);
    setLastSavedRoom(null);
    if (!captureRef.current) return;
    captureRef.current = null;
    samplesRef.current = [];
    onCaptureChange?.(false);
    setCapture(null);
    setCapturedSamples(0);
    setCaptureError(
      "Capture cancelled because survey history is not currently writable."
    );
  }, [storageBlocked, onCaptureChange]);

  useEffect(() => {
    if (!capture) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      setClock(now);
      const current = captureRef.current;
      if (!current) return;
      if (storageBlocked) return;
      if (!sessions.some((session) => session.id === current.sessionId)) {
        captureRef.current = null;
        samplesRef.current = [];
        onCaptureChange?.(false);
        setCapture(null);
        setCapturedSamples(0);
        setLastSavedRoom(null);
        setCaptureError(
          "Capture cancelled because its survey session was removed in another tab."
        );
        return;
      }
      if (now < current.endsAt) return;

      const samples = samplesRef.current.filter(
        (sample) =>
          isWithinSurveyWindow(
            sample.timestamp,
            current.startedAt,
            current.endsAt
          )
      );
      if (samples.length === 0) {
        captureRef.current = null;
        samplesRef.current = [];
        onCaptureChange?.(false);
        setCapture(null);
        setCapturedSamples(0);
        setLastSavedRoom(null);
        setCaptureError(
          "Capture failed because no collector frames arrived. Nothing was saved; check the server connection and retry."
        );
        return;
      }

      const result = aggregateSurvey(samples, {
        room: current.room,
        startedAt: current.startedAt,
        endedAt: current.endsAt,
      });
      const measurementId = addMeasurement(current.sessionId, {
        ...result,
        capturedAt: current.endsAt,
      });
      setPendingMeasurementSave({ id: measurementId, room: current.room });
      setLastSavedRoom(null);
      setCaptureError(null);
      captureRef.current = null;
      samplesRef.current = [];
      onCaptureChange?.(false);
      setCapture(null);
      setCapturedSamples(0);
    }, 100);
    return () => clearInterval(timer);
  }, [capture, addMeasurement, onCaptureChange, sessions, storageBlocked]);

  function handleCreateSession() {
    const name = newSessionName.trim();
    if (!name || storageBlocked) return;
    createSession(name);
    setNewSessionName(defaultSessionName());
    setLastSavedRoom(null);
    setCaptureError(null);
  }

  function startCapture(roomOverride) {
    const room = String(roomOverride ?? roomName).trim();
    if (
      !room ||
      !activeSession ||
      !connected ||
      !meshData ||
      storageBlocked ||
      captureRef.current
    ) {
      return;
    }
    const startedAt = Date.now();
    const next = {
      room,
      sessionId: activeSession.id,
      startedAt,
      endsAt: startedAt + SURVEY_DURATION_SECONDS * 1000,
    };
    captureRef.current = next;
    samplesRef.current = [];
    onCaptureChange?.(true);
    setRoomName(room);
    setLastSavedRoom(null);
    setCaptureError(null);
    setCapturedSamples(0);
    setClock(startedAt);
    setCapture(next);
  }

  function cancelCapture() {
    captureRef.current = null;
    samplesRef.current = [];
    onCaptureChange?.(false);
    setCapture(null);
    setCapturedSamples(0);
    setCaptureError(null);
  }

  function handleDeleteSession() {
    if (!activeSession) return;
    if (
      window.confirm(
        `Delete "${activeSession.name}" and all of its room measurements?`
      )
    ) {
      deleteSession(activeSession.id);
      setLastSavedRoom(null);
    }
  }

  function exportJson() {
    if (!activeSession) return;
    const payload = {
      version: SURVEY_STORAGE_VERSION,
      exportedAt: new Date().toISOString(),
      session: activeSession,
    };
    downloadText(
      `${safeFilename(activeSession.name)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  }

  function exportCsv() {
    if (!activeSession) return;
    downloadText(
      `${safeFilename(activeSession.name)}.csv`,
      sessionToCsv(activeSession),
      "text/csv;charset=utf-8"
    );
  }

  const progress = capture
    ? Math.min(1, Math.max(0, (clock - capture.startedAt) / (capture.endsAt - capture.startedAt)))
    : 0;
  const secondsRemaining = capture
    ? Math.max(0, (capture.endsAt - clock) / 1000)
    : 0;
  const connection = connected ? meshData?.connection : null;
  const collectorFailed =
    connection != null && Object.hasOwn(connection, "error");
  const liveSnr = usableSnr(connection);
  const canCapture =
    Boolean(activeSession && roomName.trim() && connected && meshData) &&
    !capture &&
    !storageBlocked;

  return (
    <main className="survey-view">
      <header className="survey-heading">
        <div>
          <div className="survey-eyebrow">Room-based diagnostics</div>
          <h1>Dead-Zone Survey</h1>
          <p>
            Stand in each room and record a {SURVEY_DURATION_SECONDS}-second
            sample. Named locations make the comparison independent of the
            estimated 3D puck position.
          </p>
        </div>
        <div
          className={`survey-live-status ${
            connected ? "survey-live-online" : "survey-live-offline"
          }`}
        >
          <span />
          {connected ? "Collector online" : "Collector disconnected"}
        </div>
      </header>

      {storageError && (
        <div className="survey-banner survey-banner-danger survey-banner-recovery">
          <span>{storageError}</span>
          {storageBlocked && (
            <button
              className="survey-button survey-button-danger"
              onClick={resetStorage}
            >
              Reset saved history
            </button>
          )}
        </div>
      )}
      {captureError && (
        <div className="survey-banner survey-banner-danger">
          {captureError}
        </div>
      )}
      {collectorFailed && (
        <div className="survey-banner survey-banner-danger">
          Wi-Fi telemetry is temporarily unavailable because the collector
          reported an error. Captured error frames are excluded from outage
          scoring.
        </div>
      )}
      {!collectorFailed && connection?.rssiSource === "scan" && (
        <div className="survey-banner survey-banner-warn">
          RSSI is scan-backed. Results will be marked low confidence until
          Location Services is enabled for the terminal running the server.
        </div>
      )}
      {connected && meshData && !collectorFailed && !connection?.linkUp && (
        <div className="survey-banner survey-banner-danger">
          Wi-Fi is currently offline. You can still capture this location to
          record the outage.
        </div>
      )}
      {lastSavedRoom && (
        <div className="survey-banner survey-banner-success">
          Saved a new measurement for {lastSavedRoom}.
        </div>
      )}

      <div className="survey-layout">
        <section className="survey-card survey-session-card">
          <div className="survey-section-title">
            <span>1</span>
            Survey session
          </div>

          <label className="survey-label" htmlFor="survey-session">
            Active session
          </label>
          <select
            id="survey-session"
            value={activeSessionId ?? ""}
            onChange={(event) => setActiveSessionId(event.target.value || null)}
            disabled={Boolean(capture)}
          >
            <option value="">No session selected</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} ({session.measurements.length})
              </option>
            ))}
          </select>

          {activeSession && (
            <label className="survey-label" htmlFor="survey-session-name">
              Session name
              <input
                key={`${activeSession.id}:${activeSession.nameUpdatedAt}:${activeSession.name}`}
                id="survey-session-name"
                defaultValue={activeSession.name}
                onBlur={(event) => {
                  const nextName = normalizeSurveySessionName(
                    event.currentTarget.value
                  );
                  event.currentTarget.value = nextName;
                  renameSession(activeSession.id, nextName);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                disabled={Boolean(capture) || storageBlocked}
              />
            </label>
          )}

          <div className="survey-new-session">
            <input
              aria-label="New session name"
              value={newSessionName}
              onChange={(event) => setNewSessionName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleCreateSession();
              }}
              disabled={Boolean(capture) || storageBlocked}
            />
            <button
              className="survey-button survey-button-secondary"
              onClick={handleCreateSession}
              disabled={
                !newSessionName.trim() || Boolean(capture) || storageBlocked
              }
            >
              New
            </button>
          </div>

          <label className="survey-label" htmlFor="survey-baseline">
            Compare against
          </label>
          <select
            id="survey-baseline"
            value={baselineSessionId ?? ""}
            onChange={(event) =>
              setBaselineSessionId(event.target.value || null)
            }
            disabled={!activeSession || Boolean(capture) || storageBlocked}
          >
            <option value="">No baseline</option>
            {sessions
              .filter((session) => session.id !== activeSessionId)
              .map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name}
                </option>
              ))}
          </select>

          <div className="survey-button-row">
            <button
              className="survey-button survey-button-secondary"
              onClick={exportJson}
              disabled={!activeSession?.measurements.length}
            >
              Export JSON
            </button>
            <button
              className="survey-button survey-button-secondary"
              onClick={exportCsv}
              disabled={!activeSession?.measurements.length}
            >
              Export CSV
            </button>
          </div>
          <button
            className="survey-button survey-button-danger"
            onClick={handleDeleteSession}
            disabled={!activeSession || Boolean(capture) || storageBlocked}
          >
            Delete session
          </button>
          <p className="survey-privacy-note">
            Exports can contain your SSID and mesh-radio BSSIDs.
          </p>
        </section>

        <section className="survey-card survey-capture-card">
          <div className="survey-section-title">
            <span>2</span>
            Capture a room
          </div>

          <label className="survey-label" htmlFor="survey-room">
            Room or location
          </label>
          <input
            id="survey-room"
            list="survey-known-rooms"
            value={roomName}
            onChange={(event) => setRoomName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canCapture) startCapture();
            }}
            placeholder="e.g. Upstairs office"
            disabled={Boolean(capture) || storageBlocked}
          />
          <datalist id="survey-known-rooms">
            {knownRoomNames.map((room) => (
              <option key={room} value={room} />
            ))}
          </datalist>

          <div className="survey-current-link">
            <ResultMetric
              label="Live signal"
              value={metric(connection?.rssi || null, " dBm")}
            />
            <ResultMetric
              label="SNR"
              value={metric(liveSnr, " dB")}
            />
            <ResultMetric
              label="Channel"
              value={metric(connection?.channel || null)}
            />
            <ResultMetric
              label="Serving radio"
              value={connection?.bssid || "Unavailable"}
            />
          </div>

          {capture ? (
            <div className="survey-capture-progress">
              <div className="survey-capture-copy">
                <strong>Sampling {capture.room}</strong>
                <span>
                  {secondsRemaining.toFixed(1)}s · {capturedSamples} frames
                </span>
              </div>
              <div className="survey-progress-track">
                <div style={{ width: `${progress * 100}%` }} />
              </div>
              <button
                className="survey-button survey-button-danger"
                onClick={cancelCapture}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="survey-button survey-button-primary survey-start-button"
              onClick={() => startCapture()}
              disabled={!canCapture}
            >
              Start {SURVEY_DURATION_SECONDS}s sample
            </button>
          )}

          {!activeSession && (
            <p className="survey-help">Create or select a session first.</p>
          )}
          {activeSession && !connected && (
            <p className="survey-help">
              Start the Python server before recording a room.
            </p>
          )}
          <p className="survey-help">
            Stay in one place during capture. Repeat a room if people,
            appliances, or doors change the radio environment.
          </p>
        </section>
      </div>

      <section className="survey-results">
        <div className="survey-results-heading">
          <div>
            <div className="survey-section-title">
              <span>3</span>
              Room comparison
            </div>
            <p>Worst locations appear first; the newest run represents each room.</p>
          </div>
          {activeSession && (
            <strong>{activeSession.measurements.length} total samples</strong>
          )}
        </div>

        {!activeSession ? (
          <div className="survey-empty">Create a session to begin.</div>
        ) : rooms.length === 0 ? (
          <div className="survey-empty">
            No rooms measured yet. Capture the spot where Wi-Fi feels weakest
            first.
          </div>
        ) : (
          <div className="survey-room-list">
            {rooms.map(({ room, latest, runs }) => {
              const baseline = baselineRooms.get(roomKey(room));
              const delta =
                latest.medianRssi != null && baseline?.medianRssi != null
                  ? Math.round((latest.medianRssi - baseline.medianRssi) * 10) /
                    10
                  : null;
              return (
                <article
                  className={`survey-room-card survey-status-${latest.classification?.level ?? "no-data"}`}
                  key={roomKey(room)}
                >
                  <div className="survey-room-header">
                    <div>
                      <div className="survey-room-title-row">
                        <h2>{room}</h2>
                        <span className="survey-status-badge">
                          {latest.classification?.label ?? "No data"}
                        </span>
                        <span
                          className={`survey-confidence survey-confidence-${latest.confidence?.level ?? "low"}`}
                        >
                          {latest.confidence?.label ?? "Low confidence"}
                        </span>
                      </div>
                      <p>
                        Latest {formatCapturedAt(latest.capturedAt)} · {runs.length}{" "}
                        {runs.length === 1 ? "run" : "runs"}
                      </p>
                    </div>
                    <button
                      className="survey-button survey-button-secondary"
                      onClick={() => startCapture(room)}
                      disabled={
                        !connected ||
                        !meshData ||
                        Boolean(capture) ||
                        storageBlocked
                      }
                    >
                      Retest
                    </button>
                  </div>

                  <div className="survey-room-metrics">
                    <ResultMetric
                      label="Median signal"
                      value={metric(latest.medianRssi, " dBm")}
                    />
                    <ResultMetric
                      label="Low signal (P10)"
                      value={metric(latest.lowRssi, " dBm")}
                    />
                    <ResultMetric
                      label="Median SNR"
                      value={metric(latest.medianSnr, " dB")}
                    />
                    <ResultMetric
                      label="Median Tx rate"
                      value={metric(latest.medianTxRate, " Mbps")}
                    />
                    <ResultMetric
                      label="Link down"
                      value={metric(latest.linkDownPercent, "%")}
                    />
                    <ResultMetric
                      label="Signal variation"
                      value={metric(latest.rssiStdDev, " dB")}
                    />
                  </div>

                  {baseline && (
                    <div className="survey-baseline-delta">
                      <span>Compared with {baselineSession.name}</span>
                      <strong
                        className={
                          delta == null
                            ? ""
                            : delta >= 0
                              ? "survey-tone-good"
                              : "survey-tone-bad"
                        }
                      >
                        {delta == null
                          ? "No comparable RSSI"
                          : `${delta > 0 ? "+" : ""}${delta} dB median`}
                      </strong>
                    </div>
                  )}

                  <div className="survey-room-details">
                    <div>
                      <span>Network</span>
                      <strong>{latest.ssid || "Unknown"}</strong>
                    </div>
                    <div>
                      <span>Serving radio</span>
                      <strong title={latest.primaryBssid || ""}>
                        {latest.primaryBssid || "Unavailable"}
                      </strong>
                    </div>
                    <div>
                      <span>Channels</span>
                      <strong>{latest.channels?.join(", ") || "Unknown"}</strong>
                    </div>
                    <div>
                      <span>Association changes</span>
                      <strong>{latest.associationChanges ?? 0}</strong>
                    </div>
                  </div>

                  <div className="survey-findings">
                    <div>
                      <strong>Assessment</strong>
                      <ul>
                        {(latest.classification?.reasons ?? []).map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <strong>Data quality</strong>
                      <ul>
                        {(latest.confidence?.reasons ?? []).map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <details className="survey-run-history">
                    <summary>Show all {runs.length} runs</summary>
                    {runs.map((run) => (
                      <div className="survey-run-row" key={run.id}>
                        <span>{formatCapturedAt(run.capturedAt)}</span>
                        <span>{metric(run.medianRssi, " dBm median")}</span>
                        <span>{run.classification?.label ?? "No data"}</span>
                        <button
                          onClick={() =>
                            deleteMeasurement(activeSession.id, run.id)
                          }
                          disabled={storageBlocked}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
