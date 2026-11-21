import { useEffect, useRef, useState } from "react";
import { wsUrl } from "../hooks/useJsonSocket";
import { assessDiagnosis } from "../utils/diagnose";
import "./SurveyView.css";
import "./DiagnoseView.css";

const STAGES = {
  waiting: "Waiting for other measurements to finish…",
  idle: "Measuring idle latency…",
  download: "Saturating download and measuring latency…",
  upload: "Saturating upload and measuring latency…",
};
// Reuses the survey card colours: red, green, amber, grey.
const STATUS = {
  problem: ["survey-status-dead-zone", "Problem"],
  ok: ["survey-status-healthy", "OK"],
  info: ["survey-status-weak", "Limit"],
  unknown: ["survey-status-no-data", "Not measured"],
};

export default function DiagnoseView() {
  const [stage, setStage] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => () => socketRef.current?.close(), []);

  function run() {
    let finished = false;
    setStage("waiting");
    setError(null);
    const ws = new WebSocket(wsUrl("/diagnose"));
    socketRef.current = ws;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.status === "running") {
        setStage(msg.stage);
        return;
      }
      finished = true;
      setStage(null);
      if (msg.status === "done") setReport(msg.report);
      else setError(`Diagnosis failed: ${msg.error}`);
      ws.close();
    };
    ws.onclose = () => {
      if (finished) return;
      setStage(null);
      setError("Lost the connection to the server. Make sure server.py is running.");
    };
  }

  const assessment = report && assessDiagnosis(report);

  return (
    <main className="survey-view">
      <header className="survey-heading">
        <div>
          <div className="survey-eyebrow">Hop-by-hop diagnostics</div>
          <h1>Diagnose</h1>
          <p>
            Pings your router, your ISP&apos;s first hop and the internet while
            idle, then while saturating download and upload. The first hop
            whose latency rises is where traffic queues. Takes about 30 seconds
            and briefly uses your full bandwidth.
          </p>
        </div>
        <button
          className="survey-button survey-button-primary"
          onClick={run}
          disabled={stage != null}
        >
          {stage ? "Running…" : report ? "Run again" : "Run diagnosis"}
        </button>
      </header>

      {stage && <div className="survey-banner">{STAGES[stage]}</div>}
      {error && <div className="survey-banner survey-banner-danger">{error}</div>}

      <section className="survey-results">
        {!assessment ? (
          <div className="survey-empty">No diagnosis yet.</div>
        ) : (
          <>
            <div className="survey-room-list">
              {assessment.findings.map((finding) => {
                const [cardClass, label] = STATUS[finding.status];
                return (
                  <article
                    key={finding.hop}
                    className={`survey-room-card ${cardClass}`}
                  >
                    <div className="survey-room-title-row">
                      <h2>{finding.hop}</h2>
                      <span className="survey-status-badge">{label}</span>
                    </div>
                    <p className="diagnose-summary">{finding.summary}</p>
                    {finding.evidence.length > 0 && (
                      <ul className="diagnose-evidence">
                        {finding.evidence.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </article>
                );
              })}
            </div>
            {assessment.suggestions.length > 0 && (
              <div className="survey-card diagnose-suggestions">
                <div className="survey-section-title">Suggestions</div>
                <ol>
                  {assessment.suggestions.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ol>
              </div>
            )}
            <p className="survey-help">
              Measured {new Date(report.timestamp * 1000).toLocaleString()}.
              Wi-Fi throughput on its own needs a second, wired computer
              (iperf3), and links between mesh units aren&apos;t visible from
              this Mac.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
