/**
 * The handoff assistant, on the opportunity screen.
 *
 * This component renders; it never reasons. Every verdict, finding and sentence below comes
 * from `src/handoff`, reached only through its public exports — the UI has no second opinion
 * about the policy and cannot drift away from it.
 *
 * THE STAND-IN LABEL IS NOT DECORATION. The text in a brief is composed by a deterministic
 * local template, not by a model: no API key, no network call, no download. The badge says
 * so next to every run, because a reader must never mistake this for model output.
 */
import type {
  Finding,
  GateResult,
  HandoffDecision,
  HandoffRunRecord,
  HeightCheck,
  ModelStamp,
  Severity,
} from "@/handoff";

/**
 * The engine's POLICY_SUMMARY, structurally. Taken as a prop rather than imported, so this
 * file holds no runtime import of `@/handoff` -- which, through the engine's pool import,
 * would otherwise be evaluated while `next build` collects route configuration, before any
 * database exists.
 */
export interface PolicySummary {
  version: string;
  gate_a: { owner: string; condition: string; grants: string };
  gate_b: { owner: string; condition: string; grants: string };
  conflict: { condition: string; grants: string };
}

const DECISION_TONE: Record<HandoffDecision, string> = {
  ACCEPTED: "pill--ok",
  PROVISIONAL: "pill--warn",
  BLOCKED: "pill--alarm",
};

const SEVERITY_TONE: Record<Severity, string> = {
  INFO: "pill",
  MISSING: "pill--warn",
  BLOCKER: "pill--alarm",
};

const RUN_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatRunTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : RUN_TIME.format(parsed).replace(",", "");
}

export function StandInBadge({ model }: { model: ModelStamp }) {
  return (
    <span className="handoff__badge" title={model.label}>
      {model.badge}
    </span>
  );
}

function Gate({ gate }: { gate: GateResult }) {
  return (
    <div style={{ marginBottom: "0.6rem" }}>
      <div>
        <span className={`pill ${gate.passes ? "pill--ok" : "pill--warn"}`}>
          Gate {gate.name} {gate.passes ? "passes" : "not met"}
        </span>{" "}
        <span className="small muted">{gate.owner}</span>
      </div>
      <div className="small">{gate.condition}</div>
      {gate.unmet.length > 0 ? (
        <ul className="small" style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
          {gate.unmet.map((item) => (
            <li key={item.field}>
              <strong>{item.label}:</strong> {item.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function HeightCheckLine({ check }: { check: HeightCheck }) {
  const tone =
    check.status === "WITHIN_LIMIT"
      ? "pill--ok"
      : check.status === "BREACH"
        ? "pill--alarm"
        : "pill--warn";
  return (
    <p className="small">
      <span className={`pill ${tone}`}>{check.status.replace(/_/g, " ").toLowerCase()}</span>{" "}
      {check.statement}
    </p>
  );
}

function FindingLine({ finding }: { finding: Finding }) {
  return (
    <div className="finding">
      <span className={`pill ${SEVERITY_TONE[finding.severity]}`}>{finding.severity}</span>
      <span>
        <strong>{finding.label}</strong> — {finding.message}
        <span className="code muted"> {finding.field}</span>
      </span>
    </div>
  );
}

function Run({
  run,
  index,
  model,
}: {
  run: HandoffRunRecord;
  index: number;
  model: ModelStamp;
}) {
  return (
    <details className="run" open={index === 0}>
      <summary>
        <span className={`pill ${DECISION_TONE[run.decision]}`}>{run.decision}</span>
        <span className="small">{formatRunTime(run.created_at)}</span>
        <StandInBadge model={model} />
        <span className="small muted code">{run.policy_version}</span>
      </summary>
      <div className="run__body">
        <p className="run__reason">
          <strong>Coordinator:</strong> {run.decision_reason}
        </p>

        <h3>What the preparer assembled</h3>
        <p className="small">{run.brief.summary}</p>

        <div className="small">
          <strong>Known</strong>
          <ul style={{ margin: "0.2rem 0 0.6rem", paddingLeft: "1.1rem" }}>
            {run.brief.known.map((fact) => (
              <li key={fact.field}>
                {fact.label}: {fact.value}
              </li>
            ))}
          </ul>
          <strong>Not known</strong>
          {run.brief.unknown.length === 0 ? (
            <p className="muted" style={{ margin: "0.2rem 0 0.6rem" }}>
              Nothing the policy needs is missing.
            </p>
          ) : (
            <ul style={{ margin: "0.2rem 0 0.6rem", paddingLeft: "1.1rem" }}>
              {run.brief.unknown.map((item) => (
                <li key={item.field}>
                  {item.label}: {item.note}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="small">
          <strong>Proposed next step ({run.brief.proposed_next_step.owner}):</strong>{" "}
          {run.brief.proposed_next_step.action} — {run.brief.proposed_next_step.detail}
        </p>

        <h3>What the checker found</h3>
        <HeightCheckLine check={run.review.height_check} />
        <Gate gate={run.review.gate_a} />
        <Gate gate={run.review.gate_b} />
        {run.review.findings.length === 0 ? (
          <p className="small muted">No findings.</p>
        ) : (
          <div>
            {run.review.findings.map((finding) => (
              <FindingLine key={`${finding.code}:${finding.field}`} finding={finding} />
            ))}
          </div>
        )}

        <p className="small muted" style={{ marginTop: "0.8rem" }}>
          This run is stored exactly as it was decided, together with the facts it read. It
          is never rewritten: edit the brief above, run the assistant again, and both runs
          stay readable side by side.
        </p>
      </div>
    </details>
  );
}

export function HandoffPanel({
  opportunityCode,
  runs,
  action,
  model,
  policy,
}: {
  opportunityCode: string;
  runs: HandoffRunRecord[];
  /** The server action that runs the engine. Passed in so this file stays render-only. */
  action: (formData: FormData) => Promise<void>;
  /** MODEL_STAND_IN, straight from the engine. The badge text is its own, not the UI's. */
  model: ModelStamp;
  /** POLICY_SUMMARY, straight from the engine, so the panel cannot describe a stale policy. */
  policy: PolicySummary;
}) {
  return (
    <section>
      <div className="group-heading">
        <h2 style={{ margin: 0 }}>Handoff assistant</h2>
        <StandInBadge model={model} />
      </div>
      <p className="small muted" style={{ maxWidth: "46rem" }}>
        {model.label} Three roles run in order — a preparer assembles the brief from
        what the CRM actually holds, a checker tests it against the edition rules, and a
        coordinator decides whether the enquiry moves. Missing facts and conflicting requests
        change the outcome.
      </p>

      <div className="panel">
        <p className="small" style={{ margin: 0 }}>
          <strong>Policy {policy.version}</strong>
        </p>
        <ul className="small" style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem" }}>
          <li>
            <strong>Gate A ({policy.gate_a.owner}):</strong>{" "}
            {policy.gate_a.condition} {policy.gate_a.grants}
          </li>
          <li>
            <strong>Gate B ({policy.gate_b.owner}):</strong>{" "}
            {policy.gate_b.condition} {policy.gate_b.grants}
          </li>
          <li>
            <strong>Conflict:</strong> {policy.conflict.condition}{" "}
            {policy.conflict.grants}
          </li>
        </ul>
        <form action={action} className="form-actions">
          <input type="hidden" name="opportunity_code" value={opportunityCode} />
          <button type="submit">Run the handoff assistant</button>
          <span className="small muted">
            Each run is saved with the facts it used. Nothing is overwritten.
          </span>
        </form>
      </div>

      <h3>Run history</h3>
      {runs.length === 0 ? (
        <p className="empty">
          The assistant has not been run for this enquiry yet.
        </p>
      ) : (
        runs.map((run, index) => (
          <Run key={run.id} run={run} index={index} model={model} />
        ))
      )}
    </section>
  );
}
