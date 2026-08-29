import { createHash } from "node:crypto";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedJobBody(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function packetProvenanceForContext(context = {}) {
  const app = context.app || context.application || {};
  const evaluation = app.evaluation;
  const evaluatedAt = String(evaluation?.evaluatedAt || "").trim();
  const jdPath = String(context.job?.path || app.artifacts?.jd || "").trim();
  const body = normalizedJobBody(context.job?.body);
  if (!jdPath || !body || !evaluation || !evaluatedAt) return null;
  return {
    jd: { path: jdPath, sha256: sha256(body) },
    evaluation: {
      evaluatedAt,
      sha256: sha256(JSON.stringify(stableValue(evaluation))),
    },
  };
}

export function packetProvenanceMatches(saved, current) {
  return Boolean(
    saved &&
      current &&
      saved.jd?.path === current.jd.path &&
      saved.jd?.sha256 === current.jd.sha256 &&
      saved.evaluation?.evaluatedAt === current.evaluation.evaluatedAt &&
      saved.evaluation?.sha256 === current.evaluation.sha256
  );
}
