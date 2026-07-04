// discovery-route.mjs — supervised app orchestration for the post-onboarding
// discovery pipeline. This is deliberately not a hidden batch runner:
// research-boards and discover-companies are confirm-first skills, and
// search-jobs must stop at sourced/review state before gate/apply flows.

import { DISCOVERY_PIPELINE } from "../core/agent-guidance.mjs";
import { dbExists } from "../core/db/connection.mjs";
import { candidateConfigGet } from "../core/db/verbs.mjs";
import { loadAgentGuidanceSnapshot } from "../core/tracker/agent-guidance-snapshot.mjs";
import { prepareQuickStartSourcing } from "./onboard-route.mjs";
import { sendJson } from "./skill-run-route.mjs";

export const DISCOVERY_CHAT_SKILLS = ["research-boards", "discover-companies", "search-jobs"];

const DISCOVERY_STEP_NOTES = {
  "research-boards":
    "Run research-boards, propose useful boards, and stop at the skill's confirm-first write gate.",
  "discover-companies":
    "Run discover-companies, propose employer ATS boards, and stop at the skill's confirm-first write gate.",
  "search-jobs":
    "Run search-jobs for the first sweep or refresh, save sourced roles, capture reachable JD bodies, and queue sourced roles that still need setup answers.",
};

function readReadinessLocks({ repoRoot, env }) {
  const pathCtx = { repoRoot, env };
  if (!dbExists(pathCtx)) {
    return {
      readiness: null,
      missing: null,
      locks: { gateReady: false, applyReady: false },
    };
  }
  const setup = candidateConfigGet(pathCtx).setup || {};
  const readiness = setup.readiness || {};
  return {
    readiness,
    missing: setup.missing || {},
    locks: {
      gateReady: readiness.gate_ready === true,
      applyReady: readiness.apply_ready === true,
    },
  };
}

export function normalizeDiscoveryGuidance(guidance) {
  const nextSkill = String(guidance?.nextSkill || "").trim();
  if (!DISCOVERY_CHAT_SKILLS.includes(nextSkill)) return null;
  return {
    nextSkill,
    message: guidance?.message || `Ask your agent to run ${nextSkill} next.`,
    ctaLabel: guidance?.ctaLabel || `Run ${nextSkill}`,
  };
}

export function findActiveDiscoveryChat(chatRuntime, skillFilter = null) {
  if (skillFilter) return chatRuntime.findBySkill(skillFilter) || null;
  for (const skill of DISCOVERY_CHAT_SKILLS) {
    const session = chatRuntime.findBySkill(skill);
    if (session) return session;
  }
  return null;
}

export function buildDiscoveryKickoff({ skill, message, source = "Continue discovery" } = {}) {
  return [
    source,
    `Current next discovery skill: ${skill}.`,
    message || "Continue the Rolester discovery pipeline from the current workspace state.",
    `Pipeline order: ${DISCOVERY_PIPELINE.join(" -> ")}.`,
    DISCOVERY_STEP_NOTES[skill] || "Run only the current discovery step.",
    "Keep confirm-first prompts visible. Do not auto-approve board or company writes.",
    "Do not run evaluate-job, tailor-application, apply-job, fill forms, or submit applications from this handoff.",
    "If gate/apply setup is incomplete, stop with sourced or review items queued instead of guessing.",
  ].join("\n\n");
}

function statusForStartError(err) {
  switch (err?.code) {
    case "SKILL_REQUIRED":
    case "SKILL_NOT_ALLOWED":
      return 400;
    case "NO_AI_ROUTE":
    case "SDK_NOT_INSTALLED":
      return 501;
    case "DUPLICATE_SESSION":
      return 409;
    case "MAX_SESSIONS":
      return 429;
    default:
      return 500;
  }
}

async function startOrReuseDiscoveryChat({ chatRuntime, guidance, source }) {
  const normalized = normalizeDiscoveryGuidance(guidance);
  if (!normalized) {
    return {
      chat: null,
      activeDiscoveryChat: null,
      locked: true,
      message: "No supervised discovery step is ready.",
    };
  }

  const active = findActiveDiscoveryChat(chatRuntime, normalized.nextSkill);
  if (active) {
    return {
      chat: { ...active, reused: true },
      activeDiscoveryChat: active,
      reused: true,
    };
  }

  try {
    const chat = await chatRuntime.startSession({
      skill: normalized.nextSkill,
      input: buildDiscoveryKickoff({
        skill: normalized.nextSkill,
        message: normalized.message,
        source,
      }),
    });
    return { chat, activeDiscoveryChat: chat, reused: false };
  } catch (err) {
    if (err?.code === "DUPLICATE_SESSION" && err.chatId) {
      const chat = {
        chatId: err.chatId,
        skill: normalized.nextSkill,
        state: "running",
        reused: true,
      };
      return { chat, activeDiscoveryChat: chat, reused: true };
    }
    err.status = statusForStartError(err);
    throw err;
  }
}

function quickStartGuidance(body) {
  return normalizeDiscoveryGuidance({
    nextSkill: body?.nextSkill,
    message: body?.nextMessage,
    ctaLabel: body?.nextSkill ? `Run ${body.nextSkill}` : null,
  });
}

function locksFromPrepared(body) {
  return (
    body?.locks || {
      gateReady: body?.readiness?.gate_ready === true,
      applyReady: body?.readiness?.apply_ready === true,
    }
  );
}

export function mountDiscoveryRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  chatRuntime,
  prepareQuickStart = prepareQuickStartSourcing,
  loadAgentGuidance = loadAgentGuidanceSnapshot,
}) {
  addRoute("GET", "/api/discovery/state", (_req, res) => {
    let locks = { readiness: null, missing: null, locks: { gateReady: false, applyReady: false } };
    try {
      locks = readReadinessLocks({ repoRoot, env });
    } catch {
      // Discovery state is a UI affordance; no-DB and corrupt setup degrade to
      // locks rather than making the whole app page fail.
    }
    const guidance = normalizeDiscoveryGuidance(loadAgentGuidance({ root: repoRoot, env }));
    const activeDiscoveryChat = findActiveDiscoveryChat(chatRuntime);
    sendJson(res, 200, {
      ok: true,
      pipeline: DISCOVERY_PIPELINE,
      guidance,
      activeDiscoveryChat,
      ...locks,
    });
  });

  addRoute("POST", "/api/discovery/quick-start", async (_req, res) => {
    const prepared = prepareQuickStart({ repoRoot, env });
    if (prepared.status !== 200) {
      sendJson(res, prepared.status, prepared.body);
      return;
    }

    const guidance = quickStartGuidance(prepared.body);
    try {
      const handoff = await startOrReuseDiscoveryChat({
        chatRuntime,
        guidance,
        source: [
          "Quick Start prepared source config from DB-backed onboarding.",
          prepared.body.nextMessage,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      sendJson(res, 200, {
        ...prepared.body,
        locks: locksFromPrepared(prepared.body),
        pipeline: DISCOVERY_PIPELINE,
        guidance,
        ...handoff,
      });
    } catch (err) {
      if ((err.status || 500) === 501) {
        sendJson(res, 501, { ok: false, error: err.message });
        return;
      }
      sendJson(res, 200, {
        ...prepared.body,
        locks: locksFromPrepared(prepared.body),
        pipeline: DISCOVERY_PIPELINE,
        guidance,
        chat: null,
        activeDiscoveryChat: null,
        chatError: err.message,
      });
    }
  });

  addRoute("POST", "/api/discovery/next", async (_req, res) => {
    const rawGuidance = loadAgentGuidance({ root: repoRoot, env });
    const guidance = normalizeDiscoveryGuidance(rawGuidance);
    if (!guidance) {
      sendJson(res, 200, {
        ok: true,
        locked: true,
        pipeline: DISCOVERY_PIPELINE,
        guidance: rawGuidance || null,
        chat: null,
        activeDiscoveryChat: findActiveDiscoveryChat(chatRuntime),
      });
      return;
    }

    try {
      const handoff = await startOrReuseDiscoveryChat({
        chatRuntime,
        guidance,
        source: "Continue discovery from the app.",
      });
      sendJson(res, 200, {
        ok: true,
        pipeline: DISCOVERY_PIPELINE,
        guidance,
        ...handoff,
      });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, error: err.message });
    }
  });
}
