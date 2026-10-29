// cost-gate-auto.mjs — the automatic triggers for the two cost-bearing skills
// (CR72 slice 72d). company-health fires when an application reaches
// `modes.yml#company_health.fire_at_stage`; coach-gaps fires when an
// evaluation lands at gate "review" with named fitRisks.
//
// This module only decides. It never runs the skill: workspace-agent.mjs runs
// the existing company.health / coaching.plan intents detached from the write
// that triggered them, so a status change or evaluation never waits on, or
// fails because of, the follow-up.
import { resolveAIRoute } from "../ai/call-ai.mjs";
import { requireDb } from "../db/connection.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { isStale } from "../research/research-store.mjs";
import { classifyStage } from "../tracker/dashboard.mjs";
import { workspaceMessageAppend, workspaceThreadRead } from "./workspace-thread.mjs";

const COMPANY_HEALTH_RECHECK_DAYS_DEFAULT = 14;

// Earliest classifyStage order that counts as having reached each coarse stage.
// `interview` is the screen band or deeper (company-health SKILL.md STEP 1: a
// recruiter or phone screen counts). Terminal stages (rejected 90, withdrawn
// 91) never fire.
const FIRE_STAGE_ORDER = Object.freeze({ applied: 1, interview: 2, offer: 5 });
const TERMINAL_ORDER = 90;
const EMPTY_STATE = Object.freeze({ status: null, evaluatedAt: null });

// candidate/modes.yml#company_health.recheck_days (SKILL.md's freshness
// contract) — candidateConfigGet's DB-first accessor already returns the
// raw modes doc whole (readSingleton stores/reads the JSON blob as-is), so
// the company_health block just falls out of the same call this file
// already makes elsewhere; no new config machinery needed.
export function companyHealthRecheckDays({ repoRoot, env }) {
  const modes = candidateConfigGet({ repoRoot, env }).modes || {};
  const days = Number(modes.company_health?.recheck_days);
  return Number.isFinite(days) && days > 0 ? days : COMPANY_HEALTH_RECHECK_DAYS_DEFAULT;
}

// id -> { status, evaluatedAt } for every application. Null when there is no
// database yet, which turns the whole auto path off for that call.
export function snapshotApplicationState({ repoRoot, env }) {
  try {
    const db = requireDb({ repoRoot, env });
    const rows = db
      .prepare(
        "SELECT id, json_extract(data, '$.status') AS status, json_extract(data, '$.evaluation.evaluatedAt') AS evaluatedAt FROM applications"
      )
      .all();
    return new Map(
      rows.map((row) => [
        row.id,
        { status: row.status ?? null, evaluatedAt: row.evaluatedAt ?? null },
      ])
    );
  } catch {
    return null;
  }
}

function loadApplications(repoRoot, env, ids) {
  const db = requireDb({ repoRoot, env });
  const select = db.prepare("SELECT data FROM applications WHERE id = ?");
  return ids.flatMap((id) => {
    const row = select.get(id);
    return row ? [JSON.parse(row.data)] : [];
  });
}

// A follow-up is handled once the thread holds either its intent or a skip
// note carrying the same key. A failed run leaves its intent behind, so it is
// never retried silently.
function followUpHandled(messages, applicationId, key) {
  return messages.some((message) => {
    if (message?.entity?.id !== applicationId) return false;
    if (message.kind === "intent") return message.intent?.input?.autoKey === key;
    return message.metadata?.autoFollowUp?.key === key;
  });
}

function companyHealthTrigger({ row, before, modes, repoRoot, env, now }) {
  const policy = modes.company_health || {};
  if (policy.auto === false) return null;
  if (before.status === (row.status ?? null)) return null;
  const threshold = FIRE_STAGE_ORDER[policy.fire_at_stage] ?? FIRE_STAGE_ORDER.interview;
  const stage = classifyStage(row.status);
  if (stage.order < threshold || stage.order >= TERMINAL_ORDER) return null;
  if (
    row.companyHealth?.asOf &&
    !isStale(row.companyHealth.asOf, companyHealthRecheckDays({ repoRoot, env }), now)
  ) {
    return null;
  }
  return {
    key: `company-health:${stage.id}`,
    label: "company-health check",
    intent: {
      type: "company.health",
      entity: { type: "application", id: row.id },
    },
  };
}

function coachingTrigger({ row, before }) {
  const evaluation = row.evaluation;
  const evaluatedAt = String(evaluation?.evaluatedAt || "");
  if (!evaluatedAt || evaluatedAt === (before.evaluatedAt ?? "")) return null;
  if (String(evaluation.gate || "").toLowerCase() !== "review") return null;
  if (!Array.isArray(evaluation.fitRisks) || evaluation.fitRisks.length === 0) return null;
  if (row.coachingPlan?.basedOn?.evaluatedAt === evaluatedAt) return null;
  return {
    key: `coaching:${evaluatedAt}`,
    label: "coaching plan",
    intent: {
      type: "coaching.plan",
      entity: { type: "application", id: row.id },
    },
  };
}

// Records that an automatic follow-up was skipped because no AI is set up.
// Called from inside the detached run, so the AI-route probe (which can run a
// CLI --version check) never holds up the write that triggered it.
export function noteSkippedFollowUp({ repoRoot, env, followUp }) {
  workspaceMessageAppend({
    repoRoot,
    env,
    role: "assistant",
    kind: "status",
    text: `Skipped the automatic ${followUp.label} for ${followUp.company || "this job"}: no AI is set up yet. Connect one in Settings and run it from this job.`,
    entity: { type: "application", id: followUp.intent.entity.id },
    metadata: { autoFollowUp: { key: followUp.key, skipped: "no-ai-route" } },
  });
}

export function aiRouteAvailable({ repoRoot, env }) {
  return resolveAIRoute(env, { repoRoot }).type !== "none";
}

// Compare the application state `before` a write with what is stored now and
// return the follow-up intents that are due. Pure decision: no AI probe and no
// writes, so it stays cheap on the request path.
export function planAutoFollowUps({
  repoRoot,
  env,
  before,
  startCompanyHealthImpl,
  now = Date.now(),
}) {
  const after = snapshotApplicationState({ repoRoot, env });
  if (!before || !after) return [];
  const changedIds = [...after.entries()]
    .filter(([id, state]) => {
      // An application created inside the same intent (a pasted URL promoted
      // and evaluated) has no prior state; treat it as new, not as unchanged.
      const prior = before.get(id) || EMPTY_STATE;
      return prior.status !== state.status || prior.evaluatedAt !== state.evaluatedAt;
    })
    .map(([id]) => id);
  if (!changedIds.length) return [];

  const modes = candidateConfigGet({ repoRoot, env }).modes || {};
  const messages = workspaceThreadRead({ repoRoot, env }).messages;
  const due = [];
  for (const row of loadApplications(repoRoot, env, changedIds)) {
    const prior = before.get(row.id) || EMPTY_STATE;
    const triggers = [
      typeof startCompanyHealthImpl === "function"
        ? companyHealthTrigger({ row, before: prior, modes, repoRoot, env, now })
        : null,
      coachingTrigger({ row, before: prior }),
    ].filter(Boolean);
    for (const trigger of triggers) {
      if (followUpHandled(messages, row.id, trigger.key)) continue;
      due.push({
        key: trigger.key,
        label: trigger.label,
        company: row.company || "",
        intent: {
          ...trigger.intent,
          input: { auto: true, autoKey: trigger.key },
        },
      });
    }
  }
  return due;
}
