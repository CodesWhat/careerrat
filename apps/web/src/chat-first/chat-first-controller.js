export function resolveComposerCommit(preview, text) {
  if (preview?.action?.intent) {
    if (preview.action.intent.type === "job.apply") {
      return {
        kind: "mission",
        mode: "prepare-to-submit",
        jobs: [preview.action.intent.entity],
      };
    }
    return {
      kind: "intent",
      label: preview.action.label || "Run action",
      intent: preview.action.intent,
    };
  }
  return { kind: "message", text: String(text || "").trim() };
}

export function buildMissionPayload(selection, rows, mode = "draft") {
  const selected = new Set(Array.isArray(selection) ? selection : []);
  const jobs = (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!row?.id || !selected.has(row.id)) return [];
    selected.delete(row.id);
    return [
      {
        id: row.id,
        type: row.source === "sourced" ? "sourced" : "application",
        company: row.company || "",
        role: row.role || "",
        fit: Number.isFinite(row.fit) ? row.fit : null,
      },
    ];
  });
  if (jobs.length === 0) throw new Error("Select at least one current job");
  const normalizedMode = mode === "prepare-to-submit" ? "prepare-to-submit" : "draft";
  return {
    title: `Prepare ${jobs.length} application${jobs.length === 1 ? "" : "s"}`,
    mode: normalizedMode,
    requiresUserSubmit: true,
    jobs,
  };
}

export function workspaceMessages(response) {
  const messages = response?.data?.messages;
  return Array.isArray(messages) ? messages : [];
}
