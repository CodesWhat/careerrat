// Persist the verdict a `careerrat evaluate <job> --write` run just produced.
//
// The CLI gate (evaluateGate) is deterministic and file-based; the tracker and
// coach-gaps read the typed `evaluation` shape the packet gate writes. This maps
// one to the other and hands it to appPersistEvaluation, the same validated
// writer the browser path uses, so top-level gate/status/note and the nested
// verdict can never diverge.
import { appPersistEvaluation } from "../db/verbs/app.mjs";
import { packetEvaluationProjection } from "../packet/evaluate.mjs";
import { normalizeUrl } from "../scoring/sourced-delta.mjs";
import { normalizeTextKey } from "../tracker/tracker-data.mjs";

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

const GENERIC_PATH_WORDS = new Set([
  "careers",
  "career",
  "jobs",
  "job",
  "openings",
  "positions",
  "join",
  "join us",
  "work with us",
  "about",
  "company",
  "search",
  "en",
  "us",
  "apply",
  "opportunities",
  "open roles",
]);
const JOB_ID_PARAM = /(^|_|-)(id|jid|job|jobid|req|reqid|posting|requisition)$|^gh_jid$/i;
const COMPANY_SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc)\b/g;
const SENIORITY = new Set([
  "senior",
  "sr",
  "junior",
  "jr",
  "lead",
  "principal",
  "staff",
  "i",
  "ii",
  "iii",
]);

function companyKey(value) {
  return normalizeTextKey(value).replace(COMPANY_SUFFIX, "").replace(/\s+/g, " ").trim();
}

function sameCompany(a, b) {
  const x = companyKey(a);
  const y = companyKey(b);
  return Boolean(x) && x === y;
}

function roleTokens(value) {
  return normalizeTextKey(value)
    .split(" ")
    .filter((t) => t && !SENIORITY.has(t));
}

function compatibleRole(a, b) {
  const x = normalizeTextKey(a);
  const y = normalizeTextKey(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = roleTokens(a);
  const ty = roleTokens(b);
  if (!tx.length || !ty.length) return false;
  const shared = tx.filter((t) => ty.includes(t)).length;
  return shared / Math.min(tx.length, ty.length) >= 0.5;
}

// A posting URL only identifies one job when it points past the careers index:
// a root, "/careers", "/jobs/search" and the like are shared by every role.
export function isSpecificPostingUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return false;
  }
  for (const key of url.searchParams.keys()) if (JOB_ID_PARAM.test(key)) return true;
  const segments = url.pathname
    .split("/")
    .map((s) => normalizeTextKey(decodeURIComponent(s)))
    .filter(Boolean);
  return segments.some((s) => !GENERIC_PATH_WORDS.has(s));
}

function sameSpecificUrl(a, b) {
  if (!a || !b || !isSpecificPostingUrl(a) || !isSpecificPostingUrl(b)) return false;
  return normalizeUrl(a) === normalizeUrl(b);
}

function jobFacts(job) {
  const fm = job?.frontmatter || {};
  return {
    url: String(fm.source || fm.link || fm.url || "").trim(),
    company: String(fm.company || "").trim(),
    role: String(fm.role || "").trim(),
  };
}

function describe(row) {
  return `${row.company || "?"}, ${row.role || "?"} (${row.id})`;
}

function describeJob({ company, role }) {
  return `${company || "?"}, ${role || "?"}`;
}

function loadRows(db, table) {
  const recordType = table === "applications" ? "application" : "sourced";
  return db
    .prepare(`SELECT id, data FROM ${table}`)
    .all()
    .map((row) => ({ recordType, ...JSON.parse(row.data), id: row.id }));
}

function postingMatches(row, facts) {
  if (sameSpecificUrl(facts.url, row.link)) return true;
  return sameCompany(facts.company, row.company) && compatibleRole(facts.role, row.role);
}

// An explicit id is the person's choice, so only a clearly different company
// stops it (a typo guard). A frontmatter id is not a choice, it is a claim, and
// has to agree with the posting before a verdict lands on that row.
// Automatic matching needs the specific posting URL or company plus role; a
// company alone, a shared careers URL, or more than one hit is ambiguous.
export function resolveApplicationId({ db, explicitId, job }) {
  const facts = jobFacts(job);
  const fm = job?.frontmatter || {};
  const explicit = String(explicitId || "").trim();
  const claimed = String(fm.appId || fm.applicationId || "").trim();

  if (explicit) {
    const row = loadRows(db, "applications").find((r) => r.id === explicit);
    if (row && facts.company && row.company && !sameCompany(facts.company, row.company)) {
      throw new EvaluationWriteError(
        `Not saved: this job is ${describeJob(facts)} but ${describe(row)} is a different company. Check the id you passed to --app.`
      );
    }
    return explicit;
  }

  const apps = loadRows(db, "applications");
  if (claimed) {
    const row = apps.find((r) => r.id === claimed);
    if (!row) throw new EvaluationWriteError(`No application with id "${claimed}".`);
    if (!postingMatches(row, facts)) {
      throw new EvaluationWriteError(
        `Not saved: the job file says it belongs to ${claimed}, but the job is ${describeJob(facts)} and ${claimed} is ${describe(row)}. Pass --app <id> to choose the application yourself.`
      );
    }
    return claimed;
  }

  const hits = apps.filter((row) => postingMatches(row, facts));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) {
    throw new EvaluationWriteError(
      `Not saved: ${describeJob(facts)} matches more than one application (${hits.map((r) => r.id).join(", ")}). Pass --app <id> to choose one.`
    );
  }
  const sameCo = apps.filter((row) => sameCompany(facts.company, row.company));
  if (sameCo.length) {
    throw new EvaluationWriteError(
      `Not saved: no application matches ${describeJob(facts)}, only other roles at that company (${sameCo.map((r) => describe(r)).join("; ")}). Pass --app <id> to choose one.`
    );
  }
  const lead = loadRows(db, "sourced").find((row) => postingMatches(row, facts));
  if (lead) {
    throw new EvaluationWriteError(
      `This job is only a sourced lead ("${lead.id}"), not an application yet. Pass --app <id> for an application, or promote it first.`
    );
  }
  throw new EvaluationWriteError(
    "Could not find a tracked application for this job. Pass --app <id>, or add the job to the tracker first."
  );
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
