import { createDeepIngestProposalBuilder } from "./shared.mjs";

export const proposeStoriesFromSource = createDeepIngestProposalBuilder({
  lane: "story",
  operation: "deep_ingest.story.propose",
  maxTokens: 1800,
});
