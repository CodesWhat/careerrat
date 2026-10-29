// strategy-auto-apply.mjs: applies strategy-review recommendations directly and
// builds the reversible log entries for them.
//
// A recommendation applies on its own when it rests on at least three data
// points (`evidenceCount`), isn't a lower comp floor or target, and has an
// automated writer. Everything else stays a suggestion with an explicit Apply.
// Writes go through the same applyStrategyRecommendation a manual Apply uses.

import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { coerceValue, resolveRoute } from "../profile/gate-writer.mjs";
import { classifyConfigChange } from "../profile/loosening.mjs";
import { buildKnowledgeWriteEntry, configWriteEntries } from "./knowledge-write-log.mjs";

const STRATEGY_AUTO_APPLY_MIN_EVIDENCE = 3;

const GATE_TYPES = new Set([
  "keep-signal",
  "cut-signal",
  "exclude-company",
  "comp-target",
  "comp-floor",
]);
const COMP_TYPES = new Set(["comp-target", "comp-floor"]);
export const STRATEGY_NO_WRITER_TYPES = new Set(["writing-style", "other"]);

const LABELS = {
  "keep-signal": "Keep signal",
  "cut-signal": "Cut signal",
  "exclude-company": "Excluded company",
  "comp-target": "Target base",
  "comp-floor": "Minimum base",
  "fit-bands": "Fit bands",
  rerank: "Re-rank",
  learning: "Learning",
};

function gateValue(recommendation) {
  const proposal = recommendation?.proposal || {};
  return proposal.signal ?? proposal.company ?? proposal.amount;
}

function setPath(doc, path, value) {
  const out = JSON.parse(JSON.stringify(doc || {}));
  const parts = path.split(".");
  let cursor = out;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return out;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// suggestionReason: why a recommendation is only a suggestion, or null when it
// can apply directly. Never carries a pay figure.
function suggestionReason({ recommendation, config }) {
  const type = String(recommendation?.type || "");
  if (STRATEGY_NO_WRITER_TYPES.has(type)) return "This kind of change has no automated writer yet.";
  const count = Number(recommendation?.evidenceCount) || 0;
  if (count < STRATEGY_AUTO_APPLY_MIN_EVIDENCE) {
    return `Only ${plural(count, "data point")} behind it, so it stays a suggestion until you apply it.`;
  }
  if (COMP_TYPES.has(type)) {
    const value = gateValue(recommendation);
    if (value === undefined || value === null || value === "") return null;
    try {
      const route = resolveRoute(type);
      const next = setPath(config?.[route.file], route.path, coerceValue(route, value));
      const verdict = classifyConfigChange(route.file, config?.[route.file], next);
      if (verdict.loosens)
        return `${verdict.reasons[0]} Lowering pay needs your OK, so apply it yourself.`;
    } catch {
      return null;
    }
  }
  return null;
}

function rerankEntry({ result, source, writer }) {
  const changed = (result.previous || []).filter((row, index) => {
    const now = result.current?.[index];
    return now && (row.status !== now.status || row.priority !== now.priority);
  });
  if (!changed.length) return [];
  const ids = new Set(changed.map((row) => row.id));
  return [
    buildKnowledgeWriteEntry({
      target: "rows:rerank",
      op: "set",
      before: changed,
      after: result.current.filter((row) => ids.has(row.id)),
      source,
      writer,
      label: LABELS.rerank,
    }),
  ];
}

function entriesFor({ recommendation, operation, before, after, source, writer }) {
  const type = operation.type;
  const label = LABELS[type] || "Strategy change";
  if (GATE_TYPES.has(type)) {
    const route = resolveRoute(type);
    return configWriteEntries({
      before,
      after,
      writes: [{ name: route.file, path: route.path, label }],
      source,
      writer,
    });
  }
  if (type === "fit-bands") {
    return configWriteEntries({
      before,
      after,
      writes: Object.keys(operation.result?.patch || {}).map((key) => ({
        name: "targeting",
        path: `fit_bands.${key}`,
        label,
      })),
      source,
      writer,
    });
  }
  if (type === "rerank") return rerankEntry({ result: operation.result, source, writer });
  if (type === "learning") {
    return [
      buildKnowledgeWriteEntry({
        target: "learning",
        op: "add",
        id: operation.result?.family,
        before: undefined,
        after: { family: operation.result?.family, title: recommendation?.proposal?.title },
        source,
        writer,
        label,
        revertible: false,
        revertNote: "A recorded learning is append-only, so it can't be undone from the thread.",
      }),
    ];
  }
  return [];
}

// applyStrategyRecommendationLogged: apply one recommendation through
// `applyImpl` and return the operation plus the knowledge_write entries.
export async function applyStrategyRecommendationLogged({
  repoRoot,
  env,
  recommendation,
  applyImpl,
  source,
  writer,
}) {
  const before = candidateConfigGet({ repoRoot, env });
  const operation = await applyImpl({ repoRoot, env, recommendation });
  const after = candidateConfigGet({ repoRoot, env });
  return {
    operation,
    entries: entriesFor({ recommendation, operation, before, after, source, writer }),
  };
}

// autoApplyStrategyRecommendations: sorts a drafted review into applied and
// suggested. A recommendation whose writer fails lands as a suggestion with the
// reason instead of failing the whole review.
export async function autoApplyStrategyRecommendations({
  repoRoot,
  env,
  recommendations,
  applyImpl,
  source,
  writer,
}) {
  const applied = [];
  const suggested = [];
  for (const recommendation of recommendations || []) {
    const config = candidateConfigGet({ repoRoot, env });
    const reason = suggestionReason({ recommendation, config });
    if (reason) {
      suggested.push({ recommendation, reason });
      continue;
    }
    try {
      const logged = await applyStrategyRecommendationLogged({
        repoRoot,
        env,
        recommendation,
        applyImpl,
        source,
        writer,
      });
      applied.push({ recommendation, ...logged });
    } catch (error) {
      suggested.push({
        recommendation,
        reason: `Couldn't apply it automatically: ${error.message}`,
      });
    }
  }
  return { applied, suggested };
}
