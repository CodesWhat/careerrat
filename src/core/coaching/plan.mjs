// plan.mjs — the coach-gaps skill's engine: buildCoachingPlan({applicationId}).
//
// Modeled directly on src/core/packet/gate.mjs's evaluatePacketGate — same
// runBoundedAI usage, same NO_AI_ROUTE degradation to a reviewable (never
// invented) result. Where it differs: the input is not a fresh JD read, it's
// the fitRisks[] a PRIOR job.evaluate already persisted (evaluatePacketGate's
// own output), plus the confirmed evidence bank and JD context
// buildPacketContext already assembles for packet generation.
//
// Trigger contract (owned by the caller, src/core/agent/workspace-agent.mjs's
// coaching.plan intent — this module does not re-derive it): gate === "review"
// with a non-empty fitRisks[]. Never fires on "cut" (nothing to coach toward)
// or "keep" (no named gap to close).
import { BOUNDED_AI_CODES, runBoundedAI } from "../ai/bounded-ai.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { buildPacketContext, hasReadableJobBody } from "../packet/context.mjs";
import { slugifyClaimId } from "../profile/evidence-writer.mjs";
import { coachingPlanSchema } from "./schemas.mjs";

const LABELS = Object.freeze({
  skill: "coach-gaps",
  action: "plan",
  operation: "coaching:plan",
});

const MAX_GAPS = 3;

function boundedText(value, maxLength, fallback = "") {
  const raw = String(value ?? "").trim();
  const text = raw || String(fallback).trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

// One slug rule (evidence-writer.mjs) reused verbatim so a gap id and a claim
// id derived from the same text always agree — never a second slug algorithm
// invented for this module.
function gapId(riskText, used) {
  const base = slugifyClaimId(riskText) || "gap";
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function findApplication(tracker, applicationId) {
  const apps = Array.isArray(tracker.applications) ? tracker.applications : [];
  return apps.find((app) => String(app?.id) === String(applicationId)) || null;
}

function basedOnFromEvaluation(evaluation) {
  return {
    gate: evaluation?.gate ?? null,
    fitScore: evaluation?.fitScore ?? null,
    fitBucket: evaluation?.fitBucket ?? null,
    evaluatedAt: evaluation?.evaluatedAt ?? null,
  };
}

// A suggestion the model returned for kind "evidence-claim" without a usable
// draftClaim is never trusted as an evidence-claim gap — it is downgraded to
// an honest no-close-path rather than persisting a claim CareerRat can't
// ground. Mirrors gate.mjs's "never fabricate" posture at the normalization
// boundary, not just in the prompt.
function normalizeSuggestion(rawSuggestion) {
  const kind = rawSuggestion?.kind === "evidence-claim" ? "evidence-claim" : "no-close-path";
  const rawDraft = rawSuggestion?.draftClaim;
  const draftClaim =
    kind === "evidence-claim" &&
    rawDraft &&
    String(rawDraft.claim || "").trim() &&
    String(rawDraft.evidence || "").trim()
      ? {
          claim: boundedText(rawDraft.claim, 200),
          evidence: boundedText(rawDraft.evidence, 300),
        }
      : null;
  return {
    kind: draftClaim ? "evidence-claim" : "no-close-path",
    draftClaim,
    rationale: boundedText(rawSuggestion?.rationale, 160),
  };
}

// Lenient equality for the model's echoed gapText vs. the verbatim risk it
// was asked to address: trimmed, case-insensitive. This is an alignment
// check only — the OUTPUT gapText is always the verbatim fitRisks string
// (see schemas.mjs's header comment), never what the model echoed back.
function gapTextAligned(riskText, echoedGapText) {
  const a = String(riskText || "")
    .trim()
    .toLowerCase();
  const b = String(echoedGapText || "")
    .trim()
    .toLowerCase();
  return Boolean(a) && a === b;
}

// The model is asked for gaps in the same order as the numbered risks in the
// prompt; matched positionally rather than by re-parsing the model's own
// gapText, so gapText in the OUTPUT is always the verbatim fitRisks string —
// never what the model echoed back (see schemas.mjs's header comment). But a
// positional match is only trusted when the model's own echo lines up with
// the risk at that index — a mismatch means the model's array likely
// reordered, dropped, or merged gaps, and attaching that suggestion to the
// wrong risk would be worse than an honest no-close-path.
function normalizeGaps(fitRisks, aiGaps) {
  const used = new Set();
  return fitRisks.slice(0, MAX_GAPS).map((riskText, index) => {
    const aiGap = Array.isArray(aiGaps) ? aiGaps[index] : null;
    const aligned = aiGap && gapTextAligned(riskText, aiGap.gapText);
    const suggestion = aligned
      ? normalizeSuggestion(aiGap.suggestion)
      : {
          kind: "no-close-path",
          draftClaim: null,
          rationale: aiGap
            ? "The AI's response did not line up with this gap; review it manually."
            : "No suggestion was returned for this gap; review it manually.",
        };
    return {
      id: gapId(riskText, used),
      gapText: riskText,
      suggestion,
      status: "open",
    };
  });
}

function manualGaps(fitRisks, reason) {
  const used = new Set();
  return fitRisks.slice(0, MAX_GAPS).map((riskText) => ({
    id: gapId(riskText, used),
    gapText: riskText,
    suggestion: {
      kind: "no-close-path",
      draftClaim: null,
      rationale: boundedText(reason, 160, "Needs manual review."),
    },
    status: "open",
  }));
}

function coachingPlanResult({ evaluation, gaps, manual, ai, now = new Date() }) {
  return {
    generatedAt: now.toISOString(),
    basedOn: basedOnFromEvaluation(evaluation),
    gaps,
    ...(manual ? { manual } : {}),
    ...(ai ? { ai } : {}),
  };
}

function coachingPrompt({ context, fitRisks }) {
  const candidateContext = {
    evidence: context.evidence || { claims: [] },
    honesty: context.honesty || {},
  };
  const numbered = fitRisks.map((risk, i) => `${i + 1}. ${risk}`).join("\n");
  return [
    `Company: ${context.app.company || ""}`,
    `Role: ${context.app.role || ""}`,
    "",
    "Job Description:",
    String(context.job.body || "").trim(),
    "",
    "Fit gaps a prior evaluation named (address every one, in this exact order):",
    numbered,
    "",
    "Candidate context (private, local — confirmed evidence claims and honesty boundaries only):",
    JSON.stringify(candidateContext, null, 2),
    "",
    "For EACH numbered gap above, in the same order, return one suggestion:",
    '- "evidence-claim": ONLY when the candidate context already contains evidence that honestly closes the gap. Draft the claim using nothing beyond what is in the evidence/conversation already on record — never invent a fact, metric, or tool the candidate never confirmed.',
    '- "no-close-path": when nothing on record honestly closes the gap. This is a normal, expected, correct answer for a real gap — never force an evidence-claim suggestion just to fill a slot.',
    "Return one typed coaching plan matching the given schema. Keep rationale under 160 characters, draftClaim.claim under 200 characters, draftClaim.evidence under 300 characters.",
  ].join("\n");
}

function statusCodeForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (err?.code === "NOT_FOUND") return 404;
  if (err?.code === "COACHING_NOT_APPLICABLE") return 409;
  if (err?.code === "BAD_REQUEST") return 400;
  return 500;
}

export async function buildCoachingPlan({
  repoRoot,
  env = process.env,
  applicationId,
  invoke,
  runAI = runBoundedAI,
  executionPlan,
  signal,
  now = () => new Date(),
} = {}) {
  const id = String(applicationId || "").trim();
  if (!id) {
    return {
      status: 400,
      body: { ok: false, code: "BAD_REQUEST", error: { message: "applicationId is required" } },
    };
  }

  try {
    const db = requireDb({ repoRoot, env });
    const tracker = assembleTrackerObject(db);
    const app = findApplication(tracker, id);
    if (!app) {
      const err = new Error(`no application with id "${id}"`);
      err.code = "NOT_FOUND";
      throw err;
    }

    const evaluation = app.evaluation || null;
    const gate = String(evaluation?.gate || "").toLowerCase();
    const fitRisks = (Array.isArray(evaluation?.fitRisks) ? evaluation.fitRisks : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, MAX_GAPS);

    if (gate !== "review" || fitRisks.length === 0) {
      const err = new Error(
        "Coaching only runs on a review verdict with named fit gaps. Run Evaluate first."
      );
      err.code = "COACHING_NOT_APPLICABLE";
      throw err;
    }

    const context = buildPacketContext({ repoRoot, env, applicationId: id });
    if (!hasReadableJobBody(context)) {
      return {
        status: 200,
        body: {
          ok: true,
          data: coachingPlanResult({
            evaluation,
            gaps: manualGaps(
              fitRisks,
              "A readable full job description is required before coaching."
            ),
            manual: {
              required: true,
              code: "MISSING_JOB_BODY",
              reason: "A readable full job description is required before coaching.",
            },
            ai: { used: false },
            now: now(),
          }),
        },
      };
    }

    const prompt = coachingPrompt({ context, fitRisks });
    const aiResult = await runAI({
      labels: LABELS,
      schema: coachingPlanSchema,
      manual: {
        available: true,
        reason: "coaching-plan-review",
        action: "Review these gaps manually.",
      },
      maxRetries: 1,
      ...(typeof invoke === "function"
        ? {
            invoke: async ({ attempt, correction, labels }) =>
              invoke({ attempt, correction, labels, prompt, context, fitRisks }),
          }
        : {
            structuredMode: "native-preferred",
            messages: [{ role: "user", content: prompt }],
            system:
              "Return only JSON for a local fit-gap coaching plan. Do not include raw prompt text.",
            outputName: "coaching_plan",
            maxTokens: 2048,
            ...(executionPlan ? { executionPlan } : { aiOperation: "coach.deep" }),
            root: repoRoot,
            env,
            signal,
          }),
    });

    if (aiResult.body?.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          data: coachingPlanResult({
            evaluation,
            gaps: normalizeGaps(fitRisks, aiResult.body.data?.gaps),
            ai: aiResult.body.ai,
            now: now(),
          }),
        },
      };
    }

    const code =
      aiResult.body?.code === BOUNDED_AI_CODES.NO_AI_ROUTE
        ? "NO_AI_ROUTE"
        : aiResult.body?.code || "COACHING_PLAN_REVIEW";
    const reason = aiResult.body?.error?.message || "Coaching plan output needs manual review.";
    return {
      status: 200,
      body: {
        ok: true,
        data: coachingPlanResult({
          evaluation,
          gaps: manualGaps(fitRisks, reason),
          manual: { required: true, code, reason },
          ai: aiResult.body?.ai || { used: false },
          now: now(),
        }),
      },
    };
  } catch (err) {
    return {
      status: statusCodeForError(err),
      body: {
        ok: false,
        code: err?.code || "COACHING_PLAN_ERROR",
        error: { message: err?.message || "coaching plan failed" },
      },
    };
  }
}
