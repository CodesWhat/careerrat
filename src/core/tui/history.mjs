import { recordedKnowledgeChanges } from "../agent/knowledge-changes.mjs";
import { undoWorkspaceKnowledge } from "../agent/knowledge-history.mjs";
import {
  WORKSPACE_THREAD_ID,
  workspaceMessagesForDisplay,
  workspaceThreadRead,
} from "../agent/workspace-thread.mjs";

export function readHistorySnapshot(db) {
  const threads = new Map();
  const byId = new Map();
  for (const row of db.prepare("SELECT data FROM job_threads").all()) {
    const thread = { ...JSON.parse(row.data), messages: [] };
    threads.set(thread.applicationId, thread);
    byId.set(thread.id, thread);
  }
  for (const row of db
    .prepare("SELECT thread_id, data FROM job_thread_messages ORDER BY thread_id, sequence ASC")
    .all()) {
    byId.get(row.thread_id)?.messages.push(JSON.parse(row.data));
  }
  const workspaceMessages = workspaceMessagesForDisplay(
    db
      .prepare("SELECT data FROM workspace_messages WHERE thread_id = ? ORDER BY sequence ASC")
      .all(WORKSPACE_THREAD_ID)
      .map((row) => JSON.parse(row.data))
  );
  const jobMessages = new Map();
  for (const message of workspaceMessages) {
    const entity = message.entity;
    const jobId = ["job", "application", "sourced"].includes(entity?.type)
      ? entity.id
      : message.metadata?.jobId;
    if (!jobId) continue;
    if (!jobMessages.has(jobId)) jobMessages.set(jobId, []);
    jobMessages.get(jobId).push(message);
  }
  return {
    threads,
    jobMessages,
    workspaceMessages,
    changes: recordedKnowledgeChanges(workspaceMessages),
  };
}

export function applyTuiUndo({ repoRoot, env = process.env, preview } = {}) {
  const { messages } = workspaceThreadRead({ repoRoot, env });
  const entry = messages.find((message) => message.id === preview?.messageId)?.artifacts?.[
    preview?.index
  ];
  if (entry?.kind !== "knowledge_write" || JSON.stringify(entry) !== JSON.stringify(preview?.entry))
    throw new Error("Undo preview changed; refresh and review this change again.");
  return undoWorkspaceKnowledge({
    repoRoot,
    env,
    messageId: preview.messageId,
    index: preview.index,
  });
}
