import { createDeepIngestProposalBuilder } from "./shared.mjs";

export const proposeWritingVoiceFromSource = createDeepIngestProposalBuilder({
  lane: "writing_voice",
  operation: "deep_ingest.voice.propose",
  maxTokens: 1400,
});
