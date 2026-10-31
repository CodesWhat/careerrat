// linkedin-write-log.mjs: the knowledge_write entries for LinkedIn suggestions
// staged on their own. One entry per staged surface, so each gets its own Undo.
// Staging never writes to LinkedIn; undoing returns the surface to undecided
// (see revertLinkedinStaging in knowledge-write-log.mjs).

import { buildKnowledgeWriteEntry } from "./knowledge-write-log.mjs";

const LINKEDIN_STAGING_TARGET = "linkedin:proposal";
const WRITER = "linkedin.stage";

export function linkedinStagingEntries({ batchId, staged = [] } = {}) {
  return staged.map((item) =>
    buildKnowledgeWriteEntry({
      target: LINKEDIN_STAGING_TARGET,
      op: "set",
      path: batchId,
      id: item.surfaceId,
      before: "Not staged",
      after: { action: "approve", source: "automatic", decidedAt: item.decidedAt },
      source: { kind: WRITER, batchId },
      writer: WRITER,
      label: item.surface,
    })
  );
}
