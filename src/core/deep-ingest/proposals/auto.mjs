import { createDeepIngestProposalBuilder } from "./shared.mjs";

// Auto is one bounded classification/extraction call. The model assigns each
// supported item to a real Deep ingest proposal lane; only genuine unknowns or
// failures use the gap lane/manual fallback.
export const proposeAutoFromSource = createDeepIngestProposalBuilder({
  lane: "gap",
  promptLane: "auto",
  outputName: "auto",
  operation: "deep_ingest.auto.propose",
  // Auto fans one source into proposals across five lanes in a single strict-
  // JSON response; 1800 tokens truncated mid-string on a ~1.4k-word paste
  // (QA 2026-07-20), and a truncated response parses as a provider failure.
  maxTokens: 8000,
});
