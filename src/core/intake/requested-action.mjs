const REQUESTED_ACTIONS = new Set(["evaluate", "prepare", "tailor"]);

export function normalizeIntakeRequestedAction(value) {
  if (value === undefined || value === null || value === "") return null;
  const action = String(value).trim().toLowerCase();
  if (!REQUESTED_ACTIONS.has(action)) {
    const error = new Error('requestedAction must be "evaluate", "prepare", or "tailor"');
    error.code = "BAD_REQUESTED_ACTION";
    throw error;
  }
  return action;
}
