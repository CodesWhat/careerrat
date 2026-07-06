import { createDeepIngestProposalBuilder } from "./shared.mjs";

export const proposeGapsFromSource = createDeepIngestProposalBuilder({
  lane: "gap",
  operation: "deep_ingest.gap.propose",
  maxTokens: 800,
});
