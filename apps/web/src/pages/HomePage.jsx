import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Card } from "../components/Card.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { getDashboard } from "../lib/api.js";
import { SetupReadinessCard } from "./SetupReadinessCard.jsx";

// / (Home) — M10: Focus card (buildFocusCard's exact 4-branch priority:
// interview → action → review → clear) + the pipeline snapshot stat row
// (buildJobsRail) + the capped Next Steps queue with "View all" into /jobs.
// Every field renders directly off GET /api/data/dashboard — never
// re-derived client-side (M10 design doc §2).
const FOCUS_TONE_BADGE = {
  error: "badge--error",
  warning: "badge--warn",
  success: "badge--ok",
  secondary: "badge--muted",
};

export function HomePage() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const [setup, setSetup] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getDashboard()
      .then((snapshot) => {
        if (!cancelled) setSetup(snapshot?.setup || null);
      })
      .catch(() => {
        if (!cancelled) setSetup(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (noDatabase) {
    return (
      <PageScaffold title="Rolester">
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      title="Rolester"
      subtitle="Your weekly loop — what needs you, your pipeline, what's next."
    >
      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p>Loading…</p> : null}

      {data ? (
        <>
          <SetupReadinessCard setup={setup} />
          <FocusCard focus={data.focus} />
          <PipelineSnapshot rail={data.jobs.rail} />
          <NextStepsQueue nextSteps={data.nextSteps} />
        </>
      ) : null}
    </PageScaffold>
  );
}

function FocusCard({ focus }) {
  if (!focus) return null;
  const tone = FOCUS_TONE_BADGE[focus.tone] || "badge--muted";
  const ctaTo = focus.detailId ? `/jobs?open=${encodeURIComponent(focus.detailId)}` : "/jobs";
  return (
    <Card
      title={focus.label}
      actions={focus.dueText ? <span className={`badge ${tone}`}>{focus.dueText}</span> : null}
    >
      <p className="job-drawer__timeline-title">{focus.title}</p>
      <p className="field__hint">{focus.company}</p>
      {focus.detail ? <p>{focus.detail}</p> : null}
      {focus.kind === "interview" && focus.facts?.length ? (
        <div className="chip-row">
          {focus.facts.map((f) => (
            <span className="chip" key={f.label}>
              <span className="field__label">{f.label}:</span>&nbsp;{f.value}
            </span>
          ))}
        </div>
      ) : null}
      {focus.note ? <p className="field__hint">{focus.note}</p> : null}
      <Link className="btn btn--primary" to={ctaTo}>
        {focus.cta}
      </Link>
    </Card>
  );
}

function PipelineSnapshot({ rail }) {
  if (!rail) return null;
  const tiles = [
    { label: "Screen+", value: rail.screenPlus },
    { label: "Fresh sourced", value: rail.fresh },
    { label: "High fit", value: rail.highFit },
    { label: "Needs gate", value: rail.manualReview },
    { label: "Closed", value: rail.terminal },
  ];
  return (
    <Card title="Pipeline snapshot">
      <div className="pipeline-snapshot">
        {tiles.map((t) => (
          <div className="pipeline-snapshot__tile" key={t.label}>
            <span className="pipeline-snapshot__value">{t.value}</span>
            <span className="pipeline-snapshot__label">{t.label}</span>
          </div>
        ))}
      </div>
      {rail.nextDecision ? (
        <p className="field__hint">
          {rail.nextDecision.title} — {rail.nextDecision.summary}
        </p>
      ) : null}
    </Card>
  );
}

function NextStepsQueue({ nextSteps }) {
  return (
    <Card title="Next steps" actions={<Link to="/jobs">View all</Link>}>
      {!nextSteps?.length ? (
        <p className="field__hint">Nothing waiting on you right now.</p>
      ) : (
        <ul className="job-drawer__list">
          {nextSteps.map((step, i) => (
            // nextSteps entries have no stable id across sources (communication/
            // follow-up/review) — company+title+index is unique enough for this
            // capped, non-reorderable render.
            // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
            <li key={`${step.detailId || step.title}-${i}`}>
              <Link
                to={step.detailId ? `/jobs?open=${encodeURIComponent(step.detailId)}` : "/jobs"}
              >
                {step.title}
              </Link>{" "}
              — {step.company} · {step.dueText}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
