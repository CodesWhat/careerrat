import { isDeepStrictEqual } from "node:util";
import { candidateEvidenceMerge } from "../db/verbs/candidate.mjs";
import { buildKnowledgeWriteEntry } from "./knowledge-write-log.mjs";
import { workspaceMessageAppendInDb } from "./workspace-thread.mjs";

export function mergeRecordedCandidateEvidence({ repoRoot, env, claims, writer } = {}) {
  return candidateEvidenceMerge({
    repoRoot,
    env,
    claims,
    onWrite: ({ db, before, after }) => {
      const prior = new Map(before.map((claim) => [claim.id, claim]));
      const entries = after
        .filter((claim) => !isDeepStrictEqual(prior.get(claim.id), claim))
        .map((claim) =>
          buildKnowledgeWriteEntry({
            target: "evidence",
            op: prior.has(claim.id) ? "set" : "add",
            id: claim.id,
            before: prior.get(claim.id),
            after: claim,
            source: { kind: "cli", command: writer },
            writer,
            label: "Evidence claim",
          })
        );
      if (!entries.length) return null;
      const { message } = workspaceMessageAppendInDb(db, {
        role: "assistant",
        kind: "action_result",
        text: `Saved ${entries.length} evidence ${entries.length === 1 ? "change" : "changes"}.`,
        artifacts: entries,
        metadata: { source: "cli", command: writer },
      });
      return {
        messageId: message.id,
        changes: entries.map((entry, index) => ({ index, revertible: entry.revertible })),
      };
    },
  });
}
