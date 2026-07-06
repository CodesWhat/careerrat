import { createDeepIngestProposalBuilder } from "./shared.mjs";

export const proposeEvidenceFromSource = createDeepIngestProposalBuilder({
  lane: "evidence",
  operation: "deep_ingest.evidence.propose",
  maxTokens: 1200,
});
