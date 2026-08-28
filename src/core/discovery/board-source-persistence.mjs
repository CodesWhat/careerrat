import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceConfigGet, sourceConfigPut } from "../db/verbs/source-config.mjs";
import { addSearchFromUrl, listSearches, validateConfig } from "../providers/search-sources.mjs";
import { normalizeSourceReviewArtifact } from "./source-review-artifact.mjs";

function configSchema(repoRoot, schema) {
  if (schema) return schema;
  const workspacePath = join(repoRoot, "config/search-sources.schema.json");
  if (existsSync(workspacePath)) {
    return JSON.parse(readFileSync(workspacePath, "utf8"));
  }
  const packagePath = fileURLToPath(
    new URL("../../../config/search-sources.schema.json", import.meta.url)
  );
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function assertValidConfig(config, schema) {
  const result = validateConfig(config, schema);
  if (result.valid) return;
  const error = new Error(
    result.errors
      .map((item) => item.message)
      .filter(Boolean)
      .join("; ") || "Invalid source config"
  );
  error.code = "BAD_REQUEST";
  throw error;
}

export function persistValidatedBoardSources({
  repoRoot,
  env = process.env,
  artifact,
  schema,
} = {}) {
  const review = normalizeSourceReviewArtifact(artifact);
  if (!review) {
    const error = new Error("source review artifact is invalid");
    error.code = "BAD_ARTIFACT";
    throw error;
  }

  let next = sourceConfigGet({ repoRoot, env, name: "search-sources" }).data;
  const added = [];
  const decisions = new Map();
  for (const candidate of review.candidates) {
    if (candidate.status !== "proposed" || candidate.confidence !== "high") continue;
    const before = listSearches(next);
    const updated = addSearchFromUrl(next, candidate.url, { label: candidate.label });
    const after = listSearches(updated);
    const source = after.find((entry) => !before.some((prior) => prior.target === entry.target));
    next = updated;
    if (source) added.push(source);
    decisions.set(candidate.id, {
      action: "save",
      status: "completed",
      resultText: source ? `Added ${candidate.label}.` : `${candidate.label} was already added.`,
    });
  }

  if (decisions.size) {
    assertValidConfig(next, configSchema(repoRoot, schema));
    sourceConfigPut({ repoRoot, env, name: "search-sources", data: next });
  }

  return {
    artifact: {
      ...review,
      candidates: review.candidates.map((candidate) => ({
        ...candidate,
        ...(decisions.has(candidate.id) ? { decision: decisions.get(candidate.id) } : {}),
      })),
    },
    added,
  };
}
