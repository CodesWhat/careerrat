// apps/web/src/app-shell/ask-terminal.js
//
// Shared "is this action message actually done" check. Two callers need the
// exact same answer and must never drift apart:
//   - AskBar.jsx's pollForTerminalAction, deciding when to stop polling a
//     live action turn.
//   - ask-rehydrate.js's deriveLastCompletedTurn, deciding on mount whether a
//     persisted action_result counts as a completed turn to rehydrate.
// Both used to carry their own hand-copied version of this function; this is
// the one copy.

export function isTerminalActionMessage(message) {
  if (!message) return false;
  if (message.kind === "action_error") return true;
  if (message.kind !== "action_result") return false;
  if (
    message.metadata?.companyReview === true &&
    message.artifacts?.some(
      (artifact) => artifact.kind === "company_proposals" && artifact.proposals?.length
    )
  ) {
    return true;
  }
  // search.run starts in the background — recordWorkspaceSearchCompletion
  // (workspace-agent.mjs) appends a later terminal message once it finishes;
  // every other intent type is awaited fully server-side, so its first
  // action_result is already terminal (searchTerminal is simply absent).
  return message.metadata?.searchTerminal !== false;
}
