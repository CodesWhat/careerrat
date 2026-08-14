import { createDeepIngestProposalBuilder } from "./shared.mjs";

export const proposeHonestyFromSource = createDeepIngestProposalBuilder({
  lane: "honesty",
  operation: "deep_ingest.honesty.propose",
  maxTokens: 1000,
});
