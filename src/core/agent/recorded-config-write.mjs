import { candidateConfigPatch } from "../db/verbs/candidate.mjs";
import { configWriteEntries } from "./knowledge-write-log.mjs";
import { workspaceMessageAppendInDb } from "./workspace-thread.mjs";

export function patchRecordedCandidateConfig({
  repoRoot,
  env = process.env,
  name,
  patch,
  writes,
  writer,
} = {}) {
  const result = candidateConfigPatch({
    repoRoot,
    env,
    name,
    patch,
    onWrite: ({ db, before, after }) => {
      const entries = configWriteEntries({
        before: { [name]: before },
        after: { [name]: after },
        writes: writes.map((write) => ({ ...write, name })),
        source: { kind: "cli", command: writer },
        writer,
      });
      if (!entries.length) return null;
      const { message } = workspaceMessageAppendInDb(db, {
        role: "assistant",
        kind: "action_result",
        text: `Saved ${writes[0]?.label || "candidate settings"}.`,
        artifacts: entries,
        metadata: { source: "cli", command: writer },
      });
      return {
        messageId: message.id,
        changes: entries.map((entry, index) => ({ index, revertible: entry.revertible })),
      };
    },
  });
  return { ok: true, history: result.history };
}
