import { requireDb } from "../db/connection.mjs";
import { appSetFields } from "../db/verbs/app.mjs";
import { revertKnowledgeWrite } from "./knowledge-write-log.mjs";
import {
  workspaceIntentAppend,
  workspaceMessageAppend,
  workspaceThreadRead,
} from "./workspace-thread.mjs";

function invalidReference() {
  const error = new Error("A saved message and artifact index are required.");
  error.code = "KNOWLEDGE_REVERT_INVALID";
  return error;
}

export function revertSavedKnowledge({
  repoRoot,
  env,
  messageId,
  index,
  setFields = appSetFields,
}) {
  if (
    typeof messageId !== "string" ||
    !messageId.trim() ||
    messageId.length > 500 ||
    !Number.isSafeInteger(index) ||
    index < 0
  )
    throw invalidReference();
  const { messages } = workspaceThreadRead({ repoRoot, env });
  const stored = messages.find(
    (message) =>
      message.id === messageId &&
      (message.kind === "action_result" || message.kind === "action_error")
  );
  const entry = stored?.artifacts?.[index];
  if (entry?.kind !== "knowledge_write") throw invalidReference();
  return revertKnowledgeWrite({
    repoRoot,
    env,
    entry,
    messageId,
    index,
    existing: messages.flatMap((message) =>
      (message.artifacts || []).filter((artifact) => artifact?.kind === "knowledge_write")
    ),
    afterRevert: (done) =>
      done.target === "evidence" && done.source?.kind === "coaching"
        ? reopenCoachingGap({ repoRoot, env, entry: done, setFields })
        : undefined,
  });
}

export function undoWorkspaceKnowledge({ repoRoot, env, messageId, index, now } = {}) {
  if (
    typeof messageId !== "string" ||
    !messageId.trim() ||
    messageId.length > 500 ||
    !Number.isSafeInteger(index) ||
    index < 0
  )
    throw invalidReference();
  const intent = {
    type: "knowledge.revert",
    entity: { type: "workspace", id: "workspace-main" },
    input: { messageId: messageId.trim(), index },
  };
  const request = workspaceIntentAppend({ repoRoot, env, intent, now });
  let reverted;
  try {
    reverted = revertSavedKnowledge({ repoRoot, env, messageId: intent.input.messageId, index });
  } catch (error) {
    workspaceMessageAppend({
      repoRoot,
      env,
      role: "assistant",
      kind: "action_error",
      entity: intent.entity,
      text: error.message,
      error: { code: error.code || "KNOWLEDGE_REVERT_FAILED", message: error.message },
      metadata: { intentMessageId: request.message.id },
      now,
    });
    throw error;
  }
  workspaceMessageAppend({
    repoRoot,
    env,
    role: "assistant",
    kind: "action_result",
    entity: intent.entity,
    text: reverted.ok ? reverted.summary : reverted.note,
    ...(reverted.ok ? { artifacts: [reverted.entry] } : {}),
    metadata: {
      intentMessageId: request.message.id,
      state: reverted.ok ? "reverted" : "refused",
      ...(!reverted.ok ? { reason: reverted.reason } : {}),
    },
    now,
  });
  return {
    ...workspaceThreadRead({ repoRoot, env }),
    operationResult: reverted.ok ? { ok: true } : { ok: false, reason: reverted.reason },
  };
}

// After an Undo removed a coaching-saved claim: reopen its gap, but only a gap
// that is still the one this save closed. Returns a note for the undo summary.
function reopenCoachingGap({ repoRoot, env, entry, setFields = appSetFields }) {
  const applicationId = entry.source?.applicationId;
  let application;
  try {
    application = JSON.parse(
      requireDb({ repoRoot, env })
        .prepare("SELECT data FROM applications WHERE id = ?")
        .get(String(applicationId)).data
    );
  } catch {
    return "The job it came from is gone, so there was no gap to reopen.";
  }
  const plan = application.coachingPlan;
  const matching = (Array.isArray(plan?.gaps) ? plan.gaps : []).filter(
    (g) => g?.status === "closed" && g.savedClaimId === entry.id
  );
  if (!matching.length) {
    return "The coaching gap changed since, so it was left as it is.";
  }
  const ids = new Set(matching.map((g) => g.id));
  const many = matching.length > 1;
  const open = many ? "The coaching gaps are open again." : "The coaching gap is open again.";
  try {
    setFields({
      repoRoot,
      env,
      id: applicationId,
      patch: {
        coachingPlan: {
          ...plan,
          gaps: plan.gaps.map((g) => {
            if (!ids.has(g.id)) return g;
            const { savedClaimId: _saved, ...rest } = g;
            return { ...rest, status: "open" };
          }),
        },
      },
    });
  } catch (error) {
    // The claim is already gone, so the undo stands either way. An export
    // failure after the commit still reopened the gap.
    if (error?.committed === true) return open;
    return many
      ? "The coaching gaps stayed closed, so reopen them from the plan."
      : "The coaching gap stayed closed, so reopen it from the plan.";
  }
  return open;
}
