// Persist the verdict a `careerrat evaluate <job> --write` run just produced.
//
// The CLI gate (evaluateGate) is deterministic and file-based; the tracker and
// coach-gaps read the typed `evaluation` shape the packet gate writes. This maps
// one to the other and hands it to appPersistEvaluation, the same validated
// writer the browser path uses, so top-level gate/status/note and the nested
// verdict can never diverge.
import { appPersistEvaluation } from "../db/verbs/app.mjs";
import { matchTrackerRecord } from "../intake/match.mjs";
import { packetEvaluationProjection } from "../packet/evaluate.mjs";

const MIN_JOB_BODY_CHARS = 40;
const FIT_RISK_MAX = 80;

export class EvaluationWriteError extends Error {}

function clip(value, max) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function hasReadableBody(job) {
  return (
    String(job?.body || "")
      .replace(/\s+/g, " ")
      .trim().length >= MIN_JOB_BODY_CHARS
  );
}

function compensationFrom(comp = {}) {
  const base = comp.baseBand || null;
  const earnings = comp.annualEarningsBand || null;
  const status =
    comp.verdict === "clear"
      ? "clears-floor"
      : comp.verdict === "below-floor"
        ? "below-floor"
        : "unknown";
  const currency = String(base?.currency || earnings?.currency || "").trim() || null;
  return {
    status,
    currency,
    minBase: base?.min ?? null,
    maxBase: base?.max ?? null,
    minAnnualEarnings: earnings?.min ?? null,
    maxAnnualEarnings: earnings?.max ?? null,
    basis: ["base", "annual-earnings"].includes(comp.basis) ? comp.basis : null,
    source: base || earnings ? "job-description" : "unknown",
    summary: clip(comp.reason, 130),
  };
}

// Same field names the packet gate writes, so coach-gaps and approve-review
// read it without caring which path produced it.
export function buildTypedEvaluation({ result, applicationId, jobPath, now = new Date() }) {
  const gate = String(result.gate || "").toLowerCase();
  if (!["keep", "review", "cut"].includes(gate)) {
    throw new EvaluationWriteError(`Cannot save a verdict with gate "${result.gate}".`);
  }
  const fitRisks =
    gate === "keep"
      ? []
      : (Array.isArray(result.reasons) ? result.reasons : [])
          .filter((r) => String(r ?? "").trim())
          .slice(0, 3)
          .map((r) => clip(r, FIT_RISK_MAX));
  const why = String(result.fit?.why || "").trim();
  return {
    appId: applicationId,
    applicationId,
    gate,
    fitScore: Number.isFinite(Number(result.fit?.score)) ? Number(result.fit.score) : null,
    fitBucket: result.fit?.tier ?? null,
    fitSummary: clip(why || fitRisks[0] || "", 150),
    compensation: compensationFrom(result.comp),
    action: result.action === "apply-now" ? "generate-packet" : String(result.action || "manual"),
    fitReasons: why ? [clip(why, 80)] : [],
    fitRisks,
    requirements: [],
    confidence: "medium",
    manual: { required: gate === "review" },
    ai: { used: false },
    source: { jd: jobPath || null, captured: false },
    evaluatedAt: now.toISOString(),
  };
}

// An explicit id wins, then an id in the job file's frontmatter, then a match on
// the tracker. Only an application row can hold a typed evaluation.
export function resolveApplicationId({ db, explicitId, job }) {
  const fm = job?.frontmatter || {};
  const direct = String(explicitId || fm.appId || fm.applicationId || "").trim();
  if (direct) return direct;
  const match = matchTrackerRecord({
    db,
    url: fm.source || fm.link || fm.url || undefined,
    company: fm.company || undefined,
    role: fm.role || undefined,
  });
  if (!match.matched) {
    throw new EvaluationWriteError(
      "Could not find a tracked application for this job. Pass --app <id>, or add the job to the tracker first."
    );
  }
  if (match.recordType !== "application") {
    throw new EvaluationWriteError(
      `This job is only a sourced lead ("${match.id}"), not an application yet. Pass --app <id> for an application, or promote it first.`
    );
  }
  return match.id;
}

export function persistEvaluationVerdict({ repoRoot, env, db, explicitId, job, result, jobPath }) {
  if (!hasReadableBody(job)) {
    throw new EvaluationWriteError(
      "Not saved: this job file has no readable job text, so the verdict is not a real evaluation. Capture the full posting first."
    );
  }
  const id = resolveApplicationId({ db, explicitId, job });
  const evaluation = buildTypedEvaluation({ result, applicationId: id, jobPath });
  let outcome;
  try {
    outcome = appPersistEvaluation({
      repoRoot,
      env,
      id,
      evaluation,
      projection: packetEvaluationProjection(evaluation),
    });
  } catch (error) {
    throw new EvaluationWriteError(
      error?.code === "NOT_FOUND"
        ? `No application with id "${id}".`
        : `Could not save the verdict: ${error?.message || error}`
    );
  }
  return { id, gate: evaluation.gate, status: outcome.to, evaluation };
}
