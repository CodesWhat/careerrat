// apps/web/src/jobs/useApplicationGates.js — reads the packet-gate verdict
// back onto Pipeline-tab rows.
//
// evaluatePacketGate (src/core/packet/gate.mjs) never persists its verdict
// onto the application row server-side, so PacketGateCard.jsx persists it
// itself via setAppFields as `app.packetGate`. But GET /api/data/dashboard's
// derived row shape (src/core/tracker/dashboard-data.js) doesn't map
// arbitrary application fields through to jobs.rows[] — only the specific
// fields that file already whitelists (fit, fitBasis, fitBucket, ...) — and
// this task's scope doesn't extend to editing that core file (server-side
// additions are limited to the sourced-status route). So Pipeline-tab gate
// badges read the RAW application list instead (GET /api/data/applications,
// already mounted, unwrapped by dashboard-data.js) and build their own
// id -> packetGate lookup here, refreshed on the same dashboard-changed bus
// every drawer write already fires (see dashboard-events.js).
import { useCallback, useEffect, useState } from "react";
import { getApplications } from "../lib/api.js";
import { subscribeDashboardChanged } from "../lib/dashboard-events.js";

export function useApplicationGates() {
  const [gates, setGates] = useState({});

  const load = useCallback(async () => {
    try {
      const res = await getApplications();
      const next = {};
      for (const app of res?.data || []) {
        const evaluation = app?.evaluation || app?.packetGate;
        if (app?.id && evaluation) next[app.id] = evaluation;
      }
      setGates(next);
    } catch (_err) {
      // Best-effort enrichment only — a failed read here must never block or
      // blank the Jobs page; rows just render without a gate badge/CTA.
    }
  }, []);

  useEffect(() => {
    load();
    return subscribeDashboardChanged(load);
  }, [load]);

  return gates;
}

const PRE_APPLIED_STATUSES = new Set(["reviewed-hold"]);

function hasResumeArtifact(row) {
  return (row.drawer?.artifacts || []).some((a) => a.kind === "Resume");
}

// Pure derivation from row state — no stored CTA field, so it's self-clearing
// by construction (AGENTS.md's "completed-action clears its CTA" invariant):
// once the condition that produced a CTA stops holding, the next render just
// doesn't produce one. Only meaningful for application-source rows — sourced
// rows have their own promote/skip flow (Phase A), not this apply ladder.
export function deriveJobCta(row, gate) {
  if (row?.source !== "application" || row.terminal) return null;
  if (!gate) return { label: "Evaluate", section: "evaluate" };
  const verdict = String(gate.gate || "").toLowerCase();
  if (verdict === "keep" && !hasResumeArtifact(row)) {
    return { label: "Generate documents", section: "documents" };
  }
  if (hasResumeArtifact(row) && PRE_APPLIED_STATUSES.has(row.status)) {
    return { label: "Mark applied", section: "status" };
  }
  return null;
}
