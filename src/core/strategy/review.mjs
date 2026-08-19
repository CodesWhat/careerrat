// strategy/review.mjs — the server-side compute for the native strategy-review
// Ask workflow (`strategy.review` / `strategy.apply` / `strategy.stamp` intents
// in workspace-agent.mjs). This is the HTTP-reachable sibling of the
// reevaluate-strategy SKILL.md flow: the skill's file-driven, multi-turn
// analysis (STEPS 0-9, subagent-fanned-out) is what a terminal session runs;
// this module is what the embedded chat workspace runs instead, in one
// request-response turn, through the SAME underlying primitives (gate-writer,
// learnings, buildStrategyReviewStamp, the DB verbs) so the two paths can never
// disagree about what a "keep-signal" write or a review stamp means.
//
// Four exports, one per intent-shaped step:
//   - buildStrategyReviewContext  — assemble the bounded local context (STEPS 1-4
//     analysis inputs, pre-computed, no AI).
//   - draftStrategyReview         — freshness-gate, then ask the model for a
//     grounded findings + recommendations block (mirrors SKILL.md STEP 4b's
//     synthesized recommendation block). Degrades to a manual/deterministic
//     result on any AI failure — never throws for "no AI route".
//   - applyStrategyRecommendation — validate + dispatch ONE accepted
//     recommendation to its owning write path (STEP 7's write-back table).
//   - stampStrategyReview         — the STEP 7(f)/STEP 8 review-stamp + Activity
//     Pulse log, as one atomic call (the CLI's `strategy-review stamp --write`
//     and the skill's separate `activity append` become one write here, since
//     there's no shell session to issue two commands).
//
// PRIVACY INVARIANT (AGENTS.md): current_base never appears in the context this
// module assembles, in any AI prompt built from it, or in any artifact/error it
// returns — compensation context below reads ONLY target_base/minimum_base.

import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { activityAppend } from "../db/verbs/activity.mjs";
import { appSetFields, appSetStatus } from "../db/verbs/app.mjs";
import { candidateConfigGet, candidateConfigPatch } from "../db/verbs/candidate.mjs";
import {
  bumpMeta,
  getRow,
  kvUpsert,
  logActivityEvent,
  NotFoundError,
  putRow,
  runVerb,
} from "../db/verbs/shared.mjs";
import { sourcedSetStatus } from "../db/verbs/sourced.mjs";
import { applyGateWrite } from "../profile/gate-apply.mjs";
import { appendLearning, readLearnings, slugifyFamily } from "../profile/learnings.mjs";
import { isKnownStatusLabel } from "../tracker/dashboard.mjs";
import {
  buildStrategyInsights,
  buildStrategyReviewStamp,
  STRATEGY_REVIEW_COOLDOWN_DAYS,
  STRATEGY_REVIEW_NEW_SIGNAL,
  strategyReviewSignal,
} from "../tracker/dashboard-data.js";
import { buildOutcomeSummary } from "../tracker/outcome-analysis.mjs";

const LABELS = Object.freeze({
  skill: "reevaluate-strategy",
  action: "draft-review",
  operation: "strategy:review",
});

// Gate-route types applyStrategyRecommendation dispatches through
// candidateConfigPatch (the DB-native sibling of `careerrat gate <type>
// --write` — see gate.mjs's computeDbGateEdit for the CLI's own copy of this
// same read-current/append-or-set/patch shape).
const GATE_APPLY_TYPES = new Set([
  "keep-signal",
  "cut-signal",
  "comp-target",
  "comp-floor",
  "exclude-company",
]);

const RECOMMENDATION_TYPES = [
  "rerank",
  "keep-signal",
  "cut-signal",
  "comp-target",
  "comp-floor",
  "exclude-company",
  "fit-bands",
  "learning",
  "writing-style",
  "other",
];

const MAX_RECOMMENDATIONS = 8;
const MAX_RERANK_ROWS = 5;
const MAX_LEARNING_ENTRIES_PER_FAMILY = 4;
const MAX_LEARNING_FAMILIES = 6;

function cleanText(value, max = 4000) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function applyError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Context assembly (no AI) — STEP 1-4's read-only inputs, bounded in size.
// ---------------------------------------------------------------------------

// Recent learning-file headings only (title + date), never full entry bodies —
// this is a compact steer for the model ("this pattern was already actioned"),
// not the full learning file text. Mirrors STEP 3's "check whether this
// rejection pattern was already logged" without inlining every past entry.
function compactLearnings({ repoRoot, targeting }) {
  const families = new Set();
  for (const bucket of Array.isArray(targeting?.role_buckets) ? targeting.role_buckets : []) {
    if (bucket?.name) families.add(slugifyFamily(bucket.name));
  }
  for (const family of Array.isArray(targeting?.role_families) ? targeting.role_families : []) {
    if (family?.name) families.add(slugifyFamily(family.name));
  }
  const out = [];
  for (const family of [...families].slice(0, MAX_LEARNING_FAMILIES)) {
    let text;
    try {
      text = readLearnings(family, { root: repoRoot });
    } catch {
      continue;
    }
    if (!text) continue;
    // Accepts both separators on purpose. formatEntry() writes `## <date>: <title>`
    // now, but it wrote `## <date> — <title>` before the em-dash copy sweep, and
    // learning files are append-only and live in the candidate's own gitignored
    // workspace. Matching only the new form would make every entry a real user
    // already has invisible here, silently: this returns headings, so a file that
    // parses to zero looks identical to a family with no learnings yet.
    //
    // The colon branch requires whitespace after the colon, and that is the whole
    // reason this parses correctly. `(.+?)` is lazy, so a bare `:` alternative
    // stops at the FIRST colon on the line, and computeAppend's date check is
    // prefix-anchored (`/^\d{4}-\d{2}-\d{2}/`, no `$`), so `--date
    // 2026-08-19T14:30:00Z` is accepted and written. That heading would then parse
    // as date `2026-08-19T14`, title `30:00Z: ...`, quietly feeding a mangled
    // title into strategy review. ISO times never put a space after their colons,
    // so `:\s+` walks past them to the real separator. The em-dash branch keeps
    // its old shape so nothing that parsed before stops parsing now.
    const headings = [...text.matchAll(/^## (.+?)(?:\s+—\s+|:\s+)(.+)$/gm)]
      .slice(-MAX_LEARNING_ENTRIES_PER_FAMILY)
      .map(([, date, title]) => ({ date, title: cleanText(title, 160) }));
    if (headings.length) out.push({ family, entries: headings });
  }
  return out;
}

// Compact application-limit exclusions — company + the blocking status only,
// never the full row (cooldowns/notes stay internal bookkeeping).
function compactApplicationLimits(applicationLimits) {
  const rows = Array.isArray(applicationLimits?.companies) ? applicationLimits.companies : [];
  return rows
    .filter((row) => row?.status && row.status !== "ok")
    .slice(0, 10)
    .map((row) => ({ company: row.company, status: row.status, scope: row.scope || "all-roles" }));
}

export function buildStrategyReviewContext({ repoRoot, env = process.env, now = new Date() } = {}) {
  const db = requireDb({ repoRoot, env });
  const trackerData = assembleTrackerObject(db);
  const config = candidateConfigGet({ repoRoot, env });
  const targeting = config.targeting || {};
  const compensation = config.profile?.compensation || {};
  const applications = trackerData.applications || [];
  const sourced = trackerData.sourced || [];

  const insights = buildStrategyInsights(trackerData, { now });
  const funnel = buildOutcomeSummary({ apps: applications, sourced, targeting });
  const reviewSignal = strategyReviewSignal(applications, trackerData.strategyReview, now);

  return {
    generatedAt: now.toISOString(),
    reviewSignal,
    reevaluation: trackerData.analytics?.reevaluation || null,
    funnel: {
      counts: funnel.counts,
      byStatus: funnel.byStatus,
      byRoleFamily: funnel.byRoleFamily,
      sourcedFamilies: funnel.sourcedFamilies,
    },
    strategy: {
      sources: insights.sources,
      roles: insights.roles,
      fitBands: insights.fitBands,
      staleCount: insights.stale.length,
      cadence: insights.cadence.slice(0, 8),
      deterministicRecommendation: insights.recommendation,
    },
    targeting: {
      keep_signals: targeting.keep_signals || [],
      cut_signals: targeting.cut_signals || [],
      excluded_companies: targeting.excluded_companies || [],
      fit_bands: targeting.fit_bands || {},
      reevaluation: targeting.reevaluation || {},
    },
    // PRIVACY: target_base/minimum_base only — current_base is never read here.
    compensation: {
      currency: compensation.currency || "USD",
      target_base: compensation.target_base ?? null,
      minimum_base: compensation.minimum_base ?? null,
    },
    learnings: compactLearnings({ repoRoot, targeting }),
    applicationLimitExclusions: compactApplicationLimits(config["application-limits"]),
  };
}

// ---------------------------------------------------------------------------
// draftStrategyReview — freshness gate, then the bounded-AI recommendation
// draft. Degrades to a manual/deterministic result on any AI failure.
// ---------------------------------------------------------------------------

// Mirrors buildStrategyReviewTrigger's `freshSignal` half exactly (dashboard-
// data.js) MINUS the rolling-30-day `meetsThreshold` gate — the user (or the
// dashboard CTA) already asked for a review, so only "is there anything NEW
// since the last stamp" gates it here, not "is there enough volume yet".
function hasFreshSignalSinceLastReview(reviewSignal) {
  if (!reviewSignal.reviewed) return true;
  const { newOutcomes, daysSince } = reviewSignal;
  return (
    newOutcomes >= STRATEGY_REVIEW_NEW_SIGNAL ||
    (newOutcomes >= 1 && (daysSince ?? 0) >= STRATEGY_REVIEW_COOLDOWN_DAYS)
  );
}

const strategyReviewProposalSchema = {
  type: "object",
  required: ["headline", "findings", "recommendations"],
  additionalProperties: false,
  properties: {
    headline: { type: "string", maxLength: 200 },
    findings: {
      type: "array",
      maxItems: MAX_RECOMMENDATIONS,
      items: {
        type: "object",
        required: ["id", "title", "evidence"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string", maxLength: 140 },
          evidence: { type: "string", maxLength: 300 },
        },
      },
    },
    recommendations: {
      type: "array",
      maxItems: MAX_RECOMMENDATIONS,
      items: {
        type: "object",
        required: ["id", "type", "title", "rationale", "evidenceCount", "proposal"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: RECOMMENDATION_TYPES },
          title: { type: "string", maxLength: 140 },
          rationale: { type: "string", maxLength: 300 },
          evidenceCount: { type: "integer", minimum: 0 },
          proposal: { type: "object" },
        },
      },
    },
  },
};

function promptFor(context) {
  return [
    "Review this candidate's job-search strategy using ONLY the context below.",
    "Return JSON matching strategyReviewProposalSchema.",
    "",
    "Rules:",
    "- Ground every finding and recommendation in the provided context only. Never invent a company, number, or outcome not present below.",
    "- Never reference private compensation — the context deliberately omits current_base; use target_base/minimum_base only if you mention comp at all.",
    "- evidenceCount must honestly reflect how many data points (rows, rejections, entries) actually support the recommendation — do not inflate it.",
    "- Prefer recommendations with evidenceCount >= 3; a lower count is fine but must be clearly a small-sample, directional call in the rationale.",
    "- Return at most 8 recommendations, ranked most important first.",
    "- proposal shape by type: rerank {id, toStatus?, priority?}; keep-signal/cut-signal {signal}; comp-target/comp-floor {amount}; exclude-company {company}; fit-bands {patch}; learning {family, title, body}; writing-style/other {text}.",
    "",
    "Context:",
    JSON.stringify(context),
  ].join("\n");
}

function manualDraftResult({ context, reason, code = null }) {
  const rec = context.strategy.deterministicRecommendation;
  return {
    state: "manual",
    generatedAt: context.generatedAt,
    reviewSignal: context.reviewSignal,
    reevaluation: context.reevaluation,
    headline: rec?.title || "Review manually",
    findings: [],
    recommendations: [],
    manual: {
      // reason is fixed copy: the raw provider error text stays in detail so
      // it never renders as if it were CareerRat's own words.
      reason: "No AI engine was available for this review.",
      code,
      detail: reason || null,
      surfaceSummary: rec || null,
    },
  };
}

function freshDraftResult({ context, lastReview }) {
  return {
    state: "fresh",
    generatedAt: context.generatedAt,
    reviewSignal: context.reviewSignal,
    reevaluation: context.reevaluation,
    headline: "Nothing new since your last review.",
    findings: [],
    recommendations: [],
    lastReview: lastReview || null,
  };
}

export async function draftStrategyReview({
  repoRoot,
  env = process.env,
  now = new Date(),
  force = false,
  runAI = runBoundedAI,
  buildContextImpl = buildStrategyReviewContext,
} = {}) {
  const context = buildContextImpl({ repoRoot, env, now });

  if (!force && !hasFreshSignalSinceLastReview(context.reviewSignal)) {
    const db = requireDb({ repoRoot, env });
    const trackerData = assembleTrackerObject(db);
    return freshDraftResult({ context, lastReview: trackerData.strategyReview || null });
  }

  const aiResult = await runAI({
    labels: LABELS,
    schema: strategyReviewProposalSchema,
    manual: {
      available: true,
      reason: "strategy-review-manual",
      action: "Review the funnel and recommend changes manually.",
    },
    structuredMode: "native-preferred",
    messages: [{ role: "user", content: promptFor(context) }],
    system:
      "You are CareerRat's strategy-review analyst. Ground every claim in the JSON context you are given; never invent a company, number, or outcome. Never surface a private compensation figure.",
    outputName: "strategy_review_proposal",
    maxTokens: 2600,
    root: repoRoot,
    env,
  });

  if (!aiResult.body?.ok) {
    return manualDraftResult({
      context,
      reason: aiResult.body?.error?.message || "AI unavailable; review manually",
      code: aiResult.body?.code ?? aiResult.body?.error?.code ?? null,
    });
  }

  const data = aiResult.body.data || {};
  const recommendations = (Array.isArray(data.recommendations) ? data.recommendations : [])
    .slice(0, MAX_RECOMMENDATIONS)
    .map((rec, index) => ({
      id: cleanText(rec.id, 80) || `rec-${index + 1}`,
      type: RECOMMENDATION_TYPES.includes(rec.type) ? rec.type : "other",
      title: cleanText(rec.title, 140),
      rationale: cleanText(rec.rationale, 300),
      evidenceCount: Number.isFinite(rec.evidenceCount) ? Math.max(0, rec.evidenceCount) : 0,
      proposal: rec.proposal && typeof rec.proposal === "object" ? rec.proposal : {},
    }));
  const findings = (Array.isArray(data.findings) ? data.findings : [])
    .slice(0, MAX_RECOMMENDATIONS)
    .map((finding, index) => ({
      id: cleanText(finding.id, 80) || `finding-${index + 1}`,
      title: cleanText(finding.title, 140),
      evidence: cleanText(finding.evidence, 300),
    }));

  return {
    state: "drafted",
    generatedAt: context.generatedAt,
    reviewSignal: context.reviewSignal,
    reevaluation: context.reevaluation,
    headline: cleanText(data.headline, 200) || "Strategy review",
    findings,
    recommendations,
    ai: aiResult.body.ai,
  };
}

// ---------------------------------------------------------------------------
// applyStrategyRecommendation — dispatch ONE accepted recommendation.
// ---------------------------------------------------------------------------

function findHostRow(db, id) {
  const app = getRow(db, "applications", id);
  if (app) return { table: "applications", row: app };
  const sourced = getRow(db, "sourced", id);
  if (sourced) return { table: "sourced", row: sourced };
  return null;
}

// No dedicated `sourcedSetFields`/priority verb exists yet (sourced.mjs only
// exposes sourcedSetStatus) — patch `priority` directly on the current row
// using the same primitives companyHealthSet (verbs/company-health.mjs) uses
// for its own whole-field replace, so this still goes through ONE
// runVerb() transaction + meta bump + activity event, matching decision 4.
function sourcedSetPriority({ repoRoot, env, id, priority, row }) {
  return runVerb({ repoRoot, env }, (db) => {
    const current = row || getRow(db, "sourced", id);
    if (!current) throw new NotFoundError(`no sourced role with id "${id}"`);
    const updated = { ...current, priority };
    putRow(db, "sourced", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "status_change",
      title: `${current.company || id}: Re-ranked via strategy review`,
      summary: `Priority set to ${JSON.stringify(priority)}.`,
      refs: { company: current.company, role: current.role },
      tags: ["operation:sourced:priority-update", "skill:reevaluate-strategy"],
    });
    return { id, meta, event };
  });
}

function rerankIds(proposal) {
  const ids = Array.isArray(proposal.ids) ? proposal.ids : proposal.id ? [proposal.id] : [];
  const cleaned = ids.map((id) => cleanText(id, 200)).filter(Boolean);
  if (!cleaned.length) {
    throw applyError(
      "A rerank recommendation needs at least one row id.",
      "STRATEGY_APPLY_INVALID"
    );
  }
  if (cleaned.length > MAX_RERANK_ROWS) {
    throw applyError(
      `Re-rank is capped at ${MAX_RERANK_ROWS} rows per apply (got ${cleaned.length}).`,
      "STRATEGY_APPLY_INVALID"
    );
  }
  return cleaned;
}

function applyRerank({ repoRoot, env, proposal }) {
  const toStatus = proposal.toStatus ? cleanText(proposal.toStatus, 60) : null;
  const hasPriority = proposal.priority !== undefined && proposal.priority !== null;
  if (!toStatus && !hasPriority) {
    throw applyError(
      "A rerank recommendation needs toStatus and/or priority.",
      "STRATEGY_APPLY_INVALID"
    );
  }
  // Status labels are free text by design, but a rerank proposal is model
  // output: require it to match a known stage keyword so an AI typo can't
  // write a status that classifies as nothing.
  if (toStatus && !isKnownStatusLabel(toStatus)) {
    throw applyError(
      `"${toStatus}" doesn't match any status CareerRat recognizes.`,
      "STRATEGY_APPLY_INVALID"
    );
  }
  if (
    hasPriority &&
    !(
      (typeof proposal.priority === "string" &&
        proposal.priority.trim() &&
        proposal.priority.length <= 40) ||
      (typeof proposal.priority === "number" && Number.isFinite(proposal.priority))
    )
  ) {
    throw applyError(
      "A rerank priority must be a short label or a number.",
      "STRATEGY_APPLY_INVALID"
    );
  }
  const ids = rerankIds(proposal);
  const db = requireDb({ repoRoot, env });
  // Resolve every id before writing any: a rerank proposal's ids were captured
  // at draft time and a row can be gone by the time the user clicks Apply.
  // Failing up front keeps this all-or-nothing instead of committing writes
  // for the first N-1 rows and then surfacing only an error for the batch.
  const hosts = new Map();
  for (const id of ids) {
    const host = findHostRow(db, id);
    if (!host) {
      throw applyError(
        `Row "${id}" is no longer on the board, so this recommendation is out of date.`,
        "STRATEGY_APPLY_STALE"
      );
    }
    hosts.set(id, host);
  }
  for (const id of ids) {
    const host = hosts.get(id);
    if (host.table === "applications") {
      if (toStatus) {
        appSetStatus({ repoRoot, env, id, to: toStatus, note: "Re-ranked via strategy review." });
      }
      if (hasPriority) {
        appSetFields({ repoRoot, env, id, patch: { priority: proposal.priority } });
      }
    } else {
      if (toStatus) {
        sourcedSetStatus({
          repoRoot,
          env,
          id,
          to: toStatus,
          note: "Re-ranked via strategy review.",
        });
      }
      if (hasPriority) {
        sourcedSetPriority({ repoRoot, env, id, priority: proposal.priority });
      }
    }
  }
  // The row verbs above return full row payloads (notes, comp fields on
  // sourced rows); keep this return scoped to what the card needs.
  const changes = [];
  if (toStatus) changes.push(`status "${toStatus}"`);
  if (hasPriority) changes.push(`priority "${proposal.priority}"`);
  return {
    rows: ids,
    count: ids.length,
    summary: `Re-ranked ${ids.length} ${ids.length === 1 ? "row" : "rows"} to ${changes.join(" and ")}.`,
  };
}

// Thin wrapper over gate-apply.mjs's shared applyGateWrite primitive (also
// used by settings.apply in workspace-agent.mjs) — translates its plain,
// code-less errors into this module's own STRATEGY_APPLY_INVALID /
// VALIDATION_FAILED vocabulary so callers and existing tests see identical
// behavior to when this logic lived here directly.
function applyGateType({ repoRoot, env, type, value }) {
  try {
    return applyGateWrite({ repoRoot, env, type, value });
  } catch (error) {
    // A coded error came from candidateConfigPatch (gate-apply.mjs's own
    // failures are plain, code-less errors) and keeps the pre-refactor
    // "could not save" wrapping; everything else (an unknown gate type, a
    // non-numeric comp amount, ...) is an invalid recommendation (400), not
    // a server fault (500).
    if (error.code) {
      throw applyError(
        `CareerRat could not save this change: ${error.message}`,
        error.code === "VALIDATION_FAILED" ? "VALIDATION_FAILED" : "STRATEGY_APPLY_INVALID"
      );
    }
    throw applyError(error.message, "STRATEGY_APPLY_INVALID");
  }
}

function applyFitBands({ repoRoot, env, proposal }) {
  const patch = proposal?.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw applyError(
      "A fit-bands recommendation needs a patch object (high_min/med_min/fit_floor).",
      "STRATEGY_APPLY_INVALID"
    );
  }
  const allowed = new Set(["high_min", "med_min", "fit_floor"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      throw applyError(
        `fit-bands patch may only set high_min/med_min/fit_floor (got "${key}").`,
        "STRATEGY_APPLY_INVALID"
      );
    }
  }
  try {
    candidateConfigPatch({
      repoRoot,
      env,
      name: "targeting",
      patch: { fit_bands: patch },
    });
  } catch (error) {
    throw applyError(
      `CareerRat could not save the fit-band change: ${error.message}`,
      error.code === "VALIDATION_FAILED" ? "VALIDATION_FAILED" : "STRATEGY_APPLY_INVALID"
    );
  }
  const described = Object.entries(patch)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return { patch, summary: `Updated fit bands: ${described}.` };
}

function applyLearning({ repoRoot, env, proposal }) {
  const family = cleanText(proposal?.family, 80);
  const title = cleanText(proposal?.title, 140);
  const body = cleanText(proposal?.body, 4000);
  if (!family || !title || !body) {
    throw applyError(
      "A learning recommendation needs family, title, and body.",
      "STRATEGY_APPLY_INVALID"
    );
  }
  const date = new Date().toISOString().slice(0, 10);
  const written = appendLearning({ family, date, title, body, root: repoRoot });
  if (!written.ok) {
    throw applyError(
      `CareerRat could not save this learning: ${written.error}`,
      "STRATEGY_APPLY_INVALID"
    );
  }
  try {
    activityAppend({
      repoRoot,
      env,
      event: {
        type: "system",
        actor: "agent",
        title: `Learning recorded: ${written.family}`,
        summary: title,
        refs: { family: written.family },
        tags: ["skill:reevaluate-strategy", "operation:learnings:append"],
      },
    });
  } catch {
    // non-fatal — mirrors research.record's best-effort activity log; the
    // durable write (appendLearning above) already succeeded.
  }
  return {
    ok: true,
    family: written.family,
    summary: `Recorded a learning for ${written.family}.`,
  };
}

export async function applyStrategyRecommendation({
  repoRoot,
  env = process.env,
  recommendation,
} = {}) {
  const type = String(recommendation?.type || "").trim();
  const proposal =
    recommendation?.proposal && typeof recommendation.proposal === "object"
      ? recommendation.proposal
      : {};
  if (!RECOMMENDATION_TYPES.includes(type)) {
    throw applyError(`Unknown recommendation type "${type}".`, "STRATEGY_APPLY_INVALID");
  }

  if (type === "writing-style" || type === "other") {
    throw applyError(
      "This kind of change has no automated writer yet. Edit candidate/writing-style.md yourself.",
      "STRATEGY_APPLY_UNSUPPORTED"
    );
  }

  let result;
  if (type === "rerank") {
    result = applyRerank({ repoRoot, env, proposal });
  } else if (GATE_APPLY_TYPES.has(type)) {
    const value = proposal.signal ?? proposal.company ?? proposal.amount;
    if (value === undefined || value === null || value === "") {
      throw applyError(
        `A ${type} recommendation needs a value to write.`,
        "STRATEGY_APPLY_INVALID"
      );
    }
    result = applyGateType({ repoRoot, env, type, value });
  } else if (type === "fit-bands") {
    result = applyFitBands({ repoRoot, env, proposal });
  } else if (type === "learning") {
    result = applyLearning({ repoRoot, env, proposal });
  } else {
    throw applyError(`Unknown recommendation type "${type}".`, "STRATEGY_APPLY_INVALID");
  }

  return { ok: true, type, title: recommendation?.title || null, result };
}

// ---------------------------------------------------------------------------
// stampStrategyReview — STEP 7(f)/STEP 8's review-stamp + Activity Pulse log,
// as one atomic call. The CLI (src/cli/strategy-review.mjs) shares the same
// buildStrategyReviewStamp() computation for its own DB-mode `stamp --write`;
// this adds the activity log the CLI leaves to a separate `activity append`
// call (SKILL.md STEP 8), since there is no shell session here to issue two.
// ---------------------------------------------------------------------------

export function stampStrategyReview({ repoRoot, env = process.env, now = () => new Date() } = {}) {
  const at = (typeof now === "function" ? now() : now).toISOString();
  const db = requireDb({ repoRoot, env });
  const trackerData = assembleTrackerObject(db);
  const config = candidateConfigGet({ repoRoot, env });
  const marker = buildStrategyReviewStamp(trackerData, at, config.targeting);

  const written = kvUpsert({ repoRoot, env, key: "strategyReview", value: marker });
  let event = null;
  try {
    const logged = activityAppend({
      repoRoot,
      env,
      event: {
        type: "system",
        actor: "agent",
        title: "Strategy review",
        summary: `Reviewed: ${marker.snapshot.outcomes} outcomes to date (${marker.snapshot.applied} applied, ${marker.snapshot.advanced} advanced, ${marker.snapshot.rejected} rejected).`,
        tags: ["skill:reevaluate-strategy", "operation:strategy:review"],
      },
    });
    event = logged.event;
  } catch {
    // non-fatal — the durable stamp write above already succeeded.
  }

  return { ok: true, strategyReview: marker, meta: written.meta, event };
}
