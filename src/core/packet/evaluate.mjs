import { appSetFields } from "../db/verbs/app.mjs";
import { evaluatePacketGate } from "./gate.mjs";

function formatBaseRange(compensation = {}) {
  const min = Number(compensation.minBase);
  const max = Number(compensation.maxBase);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
  const money = (value) => `$${Math.round(value).toLocaleString("en-US")}`;
  if (Number.isFinite(min) && Number.isFinite(max)) return `${money(min)} - ${money(max)}`;
  return money(Number.isFinite(min) ? min : max);
}

export function packetEvaluationProjection(evaluation) {
  const compensation = evaluation?.compensation || {};
  const min = Number(compensation.minBase);
  const max = Number(compensation.maxBase);
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  return {
    evaluation,
    // Delete the legacy duplicate when this row predates typed evaluation.
    packetGate: undefined,
    fitScore: evaluation.fitScore ?? null,
    fitBucket: evaluation.fitBucket ?? null,
    fitBasis: "evaluated",
    base: formatBaseRange(compensation),
    compNote: String(compensation.summary || "").slice(0, 140),
    compEstimate: {
      source:
        compensation.source === "job-description"
          ? "posted"
          : compensation.source === "market"
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
