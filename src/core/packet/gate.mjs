import { BOUNDED_AI_CODES, runBoundedAI } from "../ai/bounded-ai.mjs";
import { matchesExcluded, matchSignals } from "../evaluate/gate.mjs";
import { assessCompensationFloors } from "../profile/compensation.mjs";
import {
  buildPacketContext,
  capturePacketJobBody,
  hasReadableJobBody,
  packetPromptFromContext,
} from "./context.mjs";
import { deriveFitRisks, normalizeRequirements } from "./requirements.mjs";
import {
  packetGateAiVerdictSchema,
  validatePacketGateRequest,
  validatePacketGateVerdictQuality,
} from "./schemas/packet-schemas.mjs";

const LABELS = Object.freeze({
  skill: "packet-engine",
  action: "gate",
  operation: "packet:gate",
});

function boundedDisplayText(value, maxLength, fallback = "") {
  const raw = String(value ?? "").trim();
  const text = raw || String(fallback).trim();
  if (!text) return "";
  const looksBudgetClipped = text.length >= maxLength && !/[.!?…)}\]"']$/u.test(text);
  const danglingConnector = /\b(?:a|an|and|but|for|or|the|to|with)$/iu.test(text);
  if (text.length <= maxLength && !looksBudgetClipped && !danglingConnector) return text;

  const withoutDanglingConnector = danglingConnector
    ? text.replace(/\s+\b(?:a|an|and|but|for|or|the|to|with)$/iu, "")
    : text;
  let prefix = withoutDanglingConnector.slice(0, Math.max(1, maxLength - 1)).trimEnd();
  const comma = prefix.lastIndexOf(",");
  const commaBoundary =
    comma >= 0 &&
    /[A-Za-z]/u.test(prefix[comma - 1] || "") &&
    /[A-Za-z]/u.test(prefix[comma + 1] || "")
      ? comma
      : -1;
  const boundary = Math.max(
    prefix.lastIndexOf(" "),
    commaBoundary,
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf(":")
  );
  if (boundary >= Math.floor(maxLength * 0.6)) {
    prefix = prefix.slice(0, boundary).trimEnd();
  }
  prefix = prefix.replace(/[,:;–—-]+$/u, "").trimEnd();
  return `${prefix || text.slice(0, maxLength - 1)}…`;
}

function reviewData({ applicationId, code, reason, ai = { used: false }, source = null }) {
  return {
    appId: applicationId,
    applicationId,
    gate: "review",
    fitScore: null,
    fitBucket: null,
    fitSummary: "Needs manual review.",
    compensation: {
      status: "unknown",
      currency: null,
      minBase: null,
      maxBase: null,
      minAnnualEarnings: null,
      maxAnnualEarnings: null,
      basis: null,
      source: "unknown",
      summary: "Compensation needs manual review.",
    },
    action: "manual",
    fitReasons: [],
    fitRisks: [boundedDisplayText(reason, 72)],
    // Explicit empty array, not omitted: appPersistEvaluation's
    // shallowMergeOneLevel merges `evaluation` one level deep, so an omitted
    // key here would let a prior AI run's requirements table survive under
    // this deterministic verdict.
    requirements: [],
    confidence: "low",
    manual: {
      required: true,
      code,
      reason,
      action: "Review the job body and packet gate manually.",
    },
    ai,
    source,
    evaluatedAt: new Date().toISOString(),
  };
}

// Deterministic hard-cut/review checks, run BEFORE the AI call so a
// targeting.excluded_companies or targeting.cut_signals hit can never be
// silently overridden by the LLM's own KEEP/CUT/REVIEW judgment. Mirrors
// evaluate/gate.mjs's evaluateGate() checks (a)/(b) — the same deterministic
// hard-cut semantics the app already uses for the primary evaluate-job body
// gate, reusing its exported matchers for cut signals and exclusions.

function forcedCutData({ applicationId, reason, source }) {
  return {
    appId: applicationId,
    applicationId,
    gate: "cut",
    fitScore: 0,
    fitBucket: "stretch",
    fitSummary: boundedDisplayText(reason, 150),
    compensation: {
      status: "unknown",
      currency: null,
      minBase: null,
      maxBase: null,
      minAnnualEarnings: null,
      maxAnnualEarnings: null,
      basis: null,
      source: "unknown",
      summary: "Compensation not evaluated: excluded company.",
    },
    action: "cut",
    fitReasons: [],
    fitRisks: [boundedDisplayText(reason, 72)],
    requirements: [],
    confidence: "high",
    manual: { required: false },
    ai: { used: false },
    source,
    evaluatedAt: new Date().toISOString(),
  };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function completeBand(min, max, currency) {
  if (min === null || max === null) return null;
  return currency ? { min, max, currency } : { min, max };
}

function normalizeCompensation(rawComp = {}, profile = {}) {
  const minBase = optionalNumber(rawComp.minBase);
  const maxBase = optionalNumber(rawComp.maxBase);
  const minAnnualEarnings = optionalNumber(rawComp.minAnnualEarnings);
  const maxAnnualEarnings = optionalNumber(rawComp.maxAnnualEarnings);
  const minimumBase = positiveNumber(profile?.compensation?.minimum_base);
  const minimumAnnualEarningsFloor = positiveNumber(profile?.compensation?.minimum_annual_earnings);
  const currency = rawComp.currency
    ? String(rawComp.currency).trim().toUpperCase().slice(0, 12)
    : null;
  const standing = assessCompensationFloors({
    baseBand: completeBand(minBase, maxBase, currency),
    annualEarningsBand: completeBand(minAnnualEarnings, maxAnnualEarnings, currency),
    minimumBase,
    minimumAnnualEarnings: minimumAnnualEarningsFloor,
    floorCurrency: profile?.compensation?.currency,
  });
  const configuredStandings = [
    ...(minimumBase ? [{ basis: "base", standing: standing.base }] : []),
    ...(minimumAnnualEarningsFloor
      ? [{ basis: "annual-earnings", standing: standing.annualEarnings }]
      : []),
  ];
  const below = configuredStandings.find(({ standing: value }) => value === "below");
  const unresolved = below || configuredStandings.find(({ standing: value }) => value !== "clear");
  const floorConfigured = configuredStandings.length > 0;
  const status = floorConfigured
    ? below
      ? "below-floor"
      : unresolved
        ? "unknown"
        : "clears-floor"
    : ["clears-floor", "below-floor"].includes(rawComp.status)
      ? rawComp.status
      : "unknown";
  const rawBasis = ["base", "annual-earnings"].includes(rawComp.basis) ? rawComp.basis : null;
  const basis =
    unresolved?.basis ||
    (minimumAnnualEarningsFloor ? "annual-earnings" : null) ||
    (minimumBase ? "base" : null) ||
    rawBasis;

  return {
    floorConfigured,
    value: {
      status,
      currency,
      minBase,
      maxBase,
      minAnnualEarnings,
      maxAnnualEarnings,
      basis,
      source: ["job-description", "market"].includes(rawComp.source) ? rawComp.source : "unknown",
      summary: boundedDisplayText(rawComp.summary, 130, "Compensation needs review."),
    },
  };
}

function normalizeVerdict(verdict, { applicationId, ai, source, profile, jdText }) {
  const gate = String(verdict?.gate || "review").toLowerCase();
  const requestedGate = gate === "keep" || gate === "cut" ? gate : "review";
  const rawScore = Number(verdict?.fitScore);
  const fitScore = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  const fitBucket = fitScore >= 85 ? "high" : fitScore >= 65 ? "med" : "stretch";
  const normalizedCompensation = normalizeCompensation(verdict?.compensation, profile);
  const compensation = normalizedCompensation.value;
  const safeGate =
    requestedGate === "keep" &&
    normalizedCompensation.floorConfigured &&
    compensation.status !== "clears-floor"
      ? "review"
      : requestedGate;
  // Requirements table is the source of truth for fitRisks: normalize it
  // first (clamped enums, deduped, capped, and every jdSignal checked
  // against the saved JD text — an invented quote is blanked, not the row),
  // then derive fitRisks from the table's own missing/partial critical/high
  // rows, reusing the model's own fitRisks copy where it already names a row
  // and preserving any leftover risk only when the table itself is empty
  // (see requirements.mjs#normalizeRequirements / #deriveFitRisks).
  const requirements = normalizeRequirements(verdict?.requirements, { jdText });
  const derivedFitRisks = deriveFitRisks(
    requirements,
    Array.isArray(verdict?.fitRisks) ? verdict.fitRisks : []
  );
  return {
    appId: applicationId,
    applicationId,
    gate: safeGate,
    fitScore,
    fitBucket,
    fitSummary: boundedDisplayText(verdict?.fitSummary, 150, "Fit needs review."),
    compensation,
    action: String(verdict?.action || (safeGate === "keep" ? "generate-packet" : "manual")),
    fitReasons: (Array.isArray(verdict?.fitReasons) ? verdict.fitReasons : [])
      .map((value) => boundedDisplayText(value, 80))
      .slice(0, 3),
    fitRisks: derivedFitRisks.map((value) => boundedDisplayText(value, 80)).slice(0, 3),
    requirements,
    confidence: String(verdict?.confidence || "medium").toLowerCase(),
    manual: { required: safeGate === "review" },
    ai,
    source,
    evaluatedAt: new Date().toISOString(),
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function statusCodeForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (err?.code === "NOT_FOUND") return 404;
  if (err?.code === "BAD_REQUEST") return 400;
  return 500;
}

export async function evaluatePacketGate({
  repoRoot,
  env = process.env,
  body,
  invoke,
  runAI = runBoundedAI,
  executionPlan,
  signal,
} = {}) {
  let request;
  try {
    request = validatePacketGateRequest(body || {});
  } catch (err) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "BAD_REQUEST",
        error: { message: err?.message || "invalid packet gate request" },
      },
    };
  }

  try {
    let captured = null;
    if (request.jobBody) {
      captured = capturePacketJobBody({
        repoRoot,
        env,
        applicationId: request.applicationId,
        body: request.jobBody,
        sourceUrl: request.jobUrl,
      });
    }

    const context = buildPacketContext({
      repoRoot,
      env,
      applicationId: request.applicationId,
      capturedJobBody: captured?.body,
      capturedJobPath: captured?.path,
    });
    const source = {
      jd: context.job.path || captured?.path || null,
      captured: Boolean(captured),
    };

    // Hard cut: an excluded-company match is deterministic and decisive —
    // force the verdict without ever calling the AI, so it can't be
    // reasoned around. Runs before the job-body check since the company is
    // already known from the tracked application, independent of whether a
    // JD body was ever captured.
    const excludedCompanies = Array.isArray(context.targeting?.excluded_companies)
      ? context.targeting.excluded_companies
      : [];
    const matchedExcludedCompany = matchesExcluded({
      company: context.app.company,
      title: context.app.role,
      excludedCompanies,
    });
    if (matchedExcludedCompany) {
      return {
        status: 200,
        body: {
          ok: true,
          data: forcedCutData({
            applicationId: request.applicationId,
            reason: `Company matches the excluded list: "${matchedExcludedCompany}".`,
            source,
          }),
        },
      };
    }

    if (!hasReadableJobBody(context)) {
      return {
        status: 200,
        body: {
          ok: true,
          data: reviewData({
            applicationId: request.applicationId,
            code: "MISSING_JOB_BODY",
            reason: "A readable full job description is required before packet gate evaluation.",
            source,
          }),
        },
      };
    }

    // Hard cut_signal match, same matching semantics (case-insensitive
    // substring, checked against title + body) evaluateGate() already uses
    // for the primary evaluate-job body gate's hard-cut check (a). Surfaced
    // here as a forced REVIEW rather than a forced CUT — the deterministic
    // sourced-scanner treats a cut_signal as a strong down-weight, not the
    // outright disqualifier an excluded company is — so a human still signs
    // off, but the AI can never quietly wave the signal through to KEEP.
    const cutSignals = Array.isArray(context.targeting?.cut_signals)
      ? context.targeting.cut_signals
      : [];
    const cutSignalSearchText = [context.app.role, context.job.body].filter(Boolean).join("\n");
    const matchedCutSignals = matchSignals(cutSignalSearchText, cutSignals)
      .filter((r) => r.matched)
      .map((r) => r.signal);
    if (matchedCutSignals.length > 0) {
      return {
        status: 200,
        body: {
          ok: true,
          data: reviewData({
            applicationId: request.applicationId,
            code: "CUT_SIGNAL_MATCH",
            reason: `Cut signal(s) found in the job description: ${matchedCutSignals.join(", ")}.`,
            source,
          }),
        },
      };
    }

    const prompt = packetPromptFromContext(context);
    const aiResult = await runAI({
      labels: LABELS,
      schema: packetGateAiVerdictSchema,
      manual: {
        available: true,
        reason: "packet-gate-review",
        action: "Review this application before generating a packet.",
      },
      maxRetries: 1,
      validateData: validatePacketGateVerdictQuality,
      ...(typeof invoke === "function"
        ? {
            invoke: async ({ attempt, correction, labels }) =>
              invoke({ attempt, correction, labels, prompt, context }),
          }
        : {
            structuredMode: "native-preferred",
            messages: [{ role: "user", content: prompt }],
            system:
              "Return only JSON for a local application packet gate. Do not include raw prompt text.",
            outputName: "packet_gate_verdict",
            maxTokens: 4096,
            ...(executionPlan ? { executionPlan } : { aiOperation: "application.judgment" }),
            root: repoRoot,
            env,
            signal,
          }),
    });

    if (aiResult.body?.ok) {
      const qualityErrors = validatePacketGateVerdictQuality(aiResult.body.data);
      if (qualityErrors.length > 0) {
        return {
          status: 200,
          body: {
            ok: true,
            data: reviewData({
              applicationId: request.applicationId,
              code: "PACKET_GATE_COPY_INVALID",
              reason:
                "The evaluation copy contained drafting residue and needs manual review before use.",
              ai: aiResult.body.ai,
              source,
            }),
          },
        };
      }
      return {
        status: 200,
        body: {
          ok: true,
          data: normalizeVerdict(aiResult.body.data, {
            applicationId: request.applicationId,
            ai: aiResult.body.ai,
            source,
            profile: context.profile,
            jdText: context.job.body,
          }),
        },
      };
    }

    const code =
      aiResult.body?.code === BOUNDED_AI_CODES.NO_AI_ROUTE
        ? "NO_AI_ROUTE"
        : aiResult.body?.code || "PACKET_GATE_REVIEW";
    return {
      status: 200,
      body: {
        ok: true,
        data: reviewData({
          applicationId: request.applicationId,
          code,
          reason:
            aiResult.body?.error?.message ||
            "Packet gate output needs manual review before packet generation.",
          ai: aiResult.body?.ai || { used: false },
          source,
        }),
      },
    };
  } catch (err) {
    return {
      status: statusCodeForError(err),
      body: {
        ok: false,
        code: err?.code || "PACKET_GATE_ERROR",
        error: { message: err?.message || "packet gate failed" },
      },
    };
  }
}
