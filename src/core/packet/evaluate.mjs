import { appSetFields } from "../db/verbs/app.mjs";
import { evaluatePacketGate } from "./gate.mjs";

function formatBaseRange(compensation = {}) {
  const min = optionalNumber(compensation.minBase);
  const max = optionalNumber(compensation.maxBase);
  if (min === null && max === null) return null;
  const money = (value) => `$${Math.round(value).toLocaleString("en-US")}`;
  if (min !== null && max !== null) return `${money(min)} - ${money(max)}`;
  return money(min ?? max);
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function packetEvaluationProjection(evaluation) {
  const projection = {
    evaluation,
    // Delete the legacy duplicate when this row predates typed evaluation.
    packetGate: undefined,
  };
  if (evaluation?.manual?.required && optionalNumber(evaluation.fitScore) === null) {
    return projection;
  }

  const compensation = evaluation?.compensation || {};
  const min = optionalNumber(compensation.minBase);
  const max = optionalNumber(compensation.maxBase);
  const hasMin = min !== null;
  const hasMax = max !== null;
  const hasBand = hasMin || hasMax;
  return {
    ...projection,
    fitScore: evaluation.fitScore ?? null,
    fitBucket: evaluation.fitBucket ?? null,
    fitBasis: "evaluated",
    base: formatBaseRange(compensation),
    compNote: String(compensation.summary || "").slice(0, 140),
    compEstimate: {
      source:
        hasBand && compensation.source === "job-description"
          ? "posted"
          : hasBand && compensation.source === "market"
            ? "comparables"
            : "none",
      lowK: hasMin ? Math.round(min / 1000) : null,
      midpointK: hasMin && hasMax ? Math.round((min + max) / 2000) : null,
      highK: hasMax ? Math.round(max / 1000) : null,
      confidence: evaluation.confidence || null,
      basis: compensation.summary || null,
    },
    roleFit: {
      why: (evaluation.fitReasons || []).slice(0, 3),
      risks: (evaluation.fitRisks || []).slice(0, 3),
    },
  };
}

function persistenceFailure(error) {
  const status = error?.code === "NO_DATABASE" ? 409 : error?.code === "NOT_FOUND" ? 404 : 500;
  return {
    status,
    body: {
      ok: false,
      code: error?.code || "PACKET_GATE_PERSIST_ERROR",
      error: { message: error?.message || "typed evaluation could not be saved" },
    },
  };
}

// One owner for evaluate + typed persistence. Both the compatibility HTTP
// endpoint and workspace-main's job.evaluate intent call this operation.
export async function evaluateAndPersistPacketGate({
  repoRoot,
  env = process.env,
  body,
  invoke,
  runAI,
} = {}) {
  const result = await evaluatePacketGate({ repoRoot, env, body, invoke, runAI });
  const evaluation = result.body?.data;
  if (result.status !== 200 || !result.body?.ok || !evaluation?.applicationId) return result;

  try {
    appSetFields({
      repoRoot,
      env,
      id: evaluation.applicationId,
      patch: packetEvaluationProjection(evaluation),
    });
  } catch (error) {
    return persistenceFailure(error);
  }
  return result;
}
