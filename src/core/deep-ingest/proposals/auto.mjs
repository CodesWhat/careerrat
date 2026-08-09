import { extractExplicitMarkdownProposals } from "./explicit-markdown.mjs";
import { createDeepIngestProposalBuilder } from "./shared.mjs";

// Auto is one bounded classification/extraction call. The model assigns each
// supported item to a real Deep ingest proposal lane; only genuine unknowns or
// failures use the gap lane/manual fallback.
const proposeAutoWithAI = createDeepIngestProposalBuilder({
  lane: "gap",
  promptLane: "auto",
  outputName: "auto",
  operation: "deep_ingest.auto.propose",
  // Auto fans one source into proposals across five lanes in a single strict-
  // JSON response; 1800 tokens truncated mid-string on a ~1.4k-word paste
  // (QA 2026-07-20), and a truncated response parses as a provider failure.
  maxTokens: 8000,
});

export async function proposeAutoFromSource(options = {}) {
  const built = await proposeAutoWithAI(options);
  const explicit = extractExplicitMarkdownProposals(options.source);
  if (!explicit.length) return built;

  // Candidate-authored headings such as `Keep signals` and `Evidence and
  // honesty boundaries` are already typed declarations. Prefer their exact,
  // deterministic rows over model interpretations in the same lanes, while
  // retaining AI-authored evidence, stories, voice, and genuine gaps.
  const explicitLanes = new Set(explicit.map((row) => row.lane));
  const aiRows = (Array.isArray(built.proposals) ? built.proposals : []).filter(
    (row) => !explicitLanes.has(row.lane)
  );
  return {
    ...built,
    status: "proposal_ready",
    proposals: [...explicit, ...aiRows],
  };
}
