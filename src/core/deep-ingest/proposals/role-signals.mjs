import { createDeepIngestProposalBuilder } from "./shared.mjs";

export const proposeRoleSignalsFromSource = createDeepIngestProposalBuilder({
  lane: "role_signal",
  operation: "deep_ingest.role_signal.propose",
  maxTokens: 1000,
});
