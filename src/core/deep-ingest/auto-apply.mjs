// auto-apply.mjs: saves freshly built deep-ingest proposals that pass every
// check, and leaves the rest in review.
//
// Runs once after a build stores its proposals. Each proposal goes through the
// same confirm path a click would (deepIngestProposalAutoApply), so the privacy,
// grounding and evidence checks all run. What saved is logged to the thread with
// an Undo; what didn't stays in review with the reason on the proposal.

import { appendDeepIngestWriteLog } from "../agent/deep-ingest-write-log.mjs";
import { deepIngestProposalAutoApply } from "../db/verbs/deep-ingest.mjs";

export function autoApplyDeepIngestProposals({ repoRoot, env, proposals } = {}) {
  const applied = [];
  const held = [];
  const rows = [];
  for (const proposal of proposals || []) {
    let result;
    try {
      result = deepIngestProposalAutoApply({ repoRoot, env, proposalId: proposal.id });
    } catch {
      // The proposal went away or changed under us; it stays as stored.
      rows.push(proposal);
      continue;
    }
    rows.push(result.proposal);
    if (result.applied) {
      appendDeepIngestWriteLog({ repoRoot, env, proposal: result.proposal });
      applied.push(result.proposal);
    } else if (result.held) {
      // A proposal that saved some claims and held the rest still logs what saved.
      if (result.partial) appendDeepIngestWriteLog({ repoRoot, env, proposal: result.proposal });
      held.push(result.proposal);
    }
  }
  return { applied, held, proposals: rows };
}
