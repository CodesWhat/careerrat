import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { userPath } from "./paths/workspace.mjs";

export const DISCOVERY_PIPELINE = [
  "setup-searches",
  "research-boards",
  "discover-companies",
  "search-jobs",
];

export const SKIPPABLE_DISCOVERY_STEPS = ["research-boards", "discover-companies"];

function setupStatePath(root, env = process.env) {
  return userPath({ repoRoot: root, env }, "workspace/setup-state.json");
}

export function readSetupState({ root, env = process.env }) {
  try {
    const parsed = JSON.parse(readFileSync(setupStatePath(root, env), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function discoverySkipsFromState(setupState) {
  if (!setupState || !Array.isArray(setupState.skippedDiscoverySteps)) return [];
  const allowed = new Set(SKIPPABLE_DISCOVERY_STEPS);
  return [...new Set(setupState.skippedDiscoverySteps.filter((step) => allowed.has(step)))];
}

function discoveryCompletionsFromState(setupState) {
  if (!setupState || !Array.isArray(setupState.completedDiscoverySteps)) return [];
  const allowed = new Set(SKIPPABLE_DISCOVERY_STEPS);
  return [...new Set(setupState.completedDiscoverySteps.filter((step) => allowed.has(step)))];
}

export function readDiscoverySkips({ root, env = process.env }) {
  return discoverySkipsFromState(readSetupState({ root, env }));
}

export function readDiscoveryCompletions({ root, env = process.env }) {
  return discoveryCompletionsFromState(readSetupState({ root, env }));
}

export function recordDiscoverySkip({ root, step, now = new Date(), env = process.env }) {
  if (!SKIPPABLE_DISCOVERY_STEPS.includes(step)) {
    return {
      ok: false,
      error: `Unknown skippable discovery step: ${step}`,
      allowed: SKIPPABLE_DISCOVERY_STEPS,
    };
  }

  const path = setupStatePath(root, env);
  const existing = readSetupState({ root, env }) ?? {};
  const current = discoverySkipsFromState(existing);
  const added = !current.includes(step);
  const next = added ? [...current, step] : current;
  const updated = {
    ...existing,
    skippedDiscoverySteps: next,
    discoverySkipUpdatedAt: now.toISOString(),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return { ok: true, added, path, skippedDiscoverySteps: next };
}

export function recordDiscoveryCompletion({ root, step, now = new Date(), env = process.env }) {
  if (!SKIPPABLE_DISCOVERY_STEPS.includes(step)) {
    return {
      ok: false,
      error: `Unknown completable discovery step: ${step}`,
      allowed: SKIPPABLE_DISCOVERY_STEPS,
    };
  }

  const path = setupStatePath(root, env);
  const existing = readSetupState({ root, env }) ?? {};
  const current = discoveryCompletionsFromState(existing);
  const added = !current.includes(step);
  const next = added ? [...current, step] : current;
  const updated = {
    ...existing,
    completedDiscoverySteps: next,
    discoveryCompletedUpdatedAt: now.toISOString(),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return { ok: true, added, path, completedDiscoverySteps: next };
}

export function buildAgentGuidance({
  missingUser = [],
  missingSystem = [],
  modes = { valid: true },
  candidateSetupReadiness = null,
  searchReadiness = {},
  companyAtsReadiness = {},
  discoverySkips = [],
  discoveryCompleted = [],
} = {}) {
  const pipeline = DISCOVERY_PIPELINE;
  const skipped = new Set(discoverySkips);
  const completed = new Set(discoveryCompleted);
  const base = {
    agentLed: true,
    pipeline,
    skippedDiscoverySteps: [...skipped],
    completedDiscoverySteps: [...completed],
  };

  if (missingSystem.length > 0) {
    return {
      ...base,
      nextSkill: null,
      command: "careerrat doctor",
      message: "Fix the missing CareerRat scaffold files before running job-search skills.",
      reason: "System files are missing, so the agent cannot reliably route the workflow.",
    };
  }
  if (!modes.valid) {
    return {
      ...base,
      nextSkill: "configure",
      command: "careerrat modes status",
      message: "Ask your agent to fix candidate/modes.yml before continuing.",
      reason: "Invalid modes can make later skill-routing decisions ambiguous.",
    };
  }
  if (missingUser.length > 0) {
    return {
      ...base,
      nextSkill: "ingest-profile",
      command: "careerrat ingest",
      message: "Ask your agent to run ingest-profile next.",
      reason:
        "Candidate setup is incomplete, so searches and gates do not have full targeting context.",
    };
  }
  if (candidateSetupReadiness && candidateSetupReadiness.readiness?.search_ready !== true) {
    const missing = candidateSetupReadiness.missing?.search_ready || [];
    return {
      ...base,
      nextSkill: "ingest-profile",
      command: "careerrat ingest",
      message: "Ask your agent to continue onboarding with ingest-profile next.",
      reason: missing.length
        ? `Candidate setup is not search-ready yet; missing: ${missing.join(", ")}.`
        : "Candidate setup is not search-ready yet.",
    };
  }
  if (searchReadiness.pendingLogin > 0) {
    return {
      ...base,
      nextSkill: "search-jobs",
      command: null,
      message:
        "Ask your agent to run search-jobs. CareerRat will ask whether you want to log into the saved job site.",
      reason:
        "A saved job source is ready for its point-of-use login choice; it does not need another setup or permission gate.",
    };
  }
  if (!searchReadiness.exists || !searchReadiness.valid || searchReadiness.enabled === 0) {
    return {
      ...base,
      nextSkill: "setup-searches",
      command: "careerrat searches --from-targeting",
      message: "Ask your agent to run setup-searches next.",
      reason:
        "Broad search sources are missing or disabled, so there is nothing useful to sweep yet.",
    };
  }
  if (!companyAtsReadiness.valid) {
    return {
      ...base,
      nextSkill: "discover-companies",
      command: "careerrat companies",
      message: "Ask your agent to repair company ATS scans with discover-companies.",
      reason: "The company ATS scan config exists but is invalid.",
    };
  }
  if (!companyAtsReadiness.configured) {
    if (!skipped.has("research-boards") && !completed.has("research-boards")) {
      return {
        ...base,
        nextSkill: "research-boards",
        command: null,
        message:
          "Ask your agent to run research-boards next, then discover-companies before search-jobs.",
        reason: "Broad sources exist, but board discovery and company discovery are not complete.",
      };
    }
    if (!skipped.has("discover-companies") && !completed.has("discover-companies")) {
      return {
        ...base,
        nextSkill: "discover-companies",
        command: null,
        message: "Ask your agent to run discover-companies next before search-jobs.",
        reason: "Board discovery is resolved, but employer ATS discovery is still not configured.",
      };
    }
    return {
      ...base,
      nextSkill: "search-jobs",
      command: null,
      message: "Ask your agent to run search-jobs next for the first sweep.",
      reason:
        "Discovery skip recorded for board and company ATS discovery, so the sweep will rely on broad sources.",
    };
  }
  if (searchReadiness.withLastRun === 0) {
    return {
      ...base,
      nextSkill: "search-jobs",
      command: null,
      message: "Ask your agent to run search-jobs next for the first sweep.",
      reason: "Sources are configured, but none have run watermarks yet.",
    };
  }
  return {
    ...base,
    nextSkill: "search-jobs",
    command: null,
    message: "Ask your agent to run search-jobs next for a refresh.",
    reason: "Sources are configured and have prior run history.",
  };
}

export function formatAgentGuidanceLines(guidance) {
  if (!guidance) return ["- CareerRat is agent-led: run `careerrat doctor` for the next handoff."];
  const lines = [
    "- CareerRat is agent-led: ask the agent to run the next skill, then let that skill write durable state.",
    `- ${guidance.message}`,
  ];
  if (guidance.reason) lines.push(`  Why: ${guidance.reason}`);
  if (guidance.command) lines.push(`  CLI helper: ${guidance.command}`);
  if (guidance.skippedDiscoverySteps?.length) {
    lines.push(`  Discovery skips: ${guidance.skippedDiscoverySteps.join(", ")}`);
  }
  return lines;
}

export function formatAgentGuidanceSummary(guidance) {
  if (!guidance) return ["Next: run careerrat doctor."];
  const first = guidance.nextSkill
    ? `Next: ask your agent to run ${guidance.nextSkill}.`
    : guidance.command
      ? `Next: run ${guidance.command}.`
      : `Next: ${guidance.message}`;
  const lines = [first];
  if (guidance.message && guidance.message !== first) lines.push(guidance.message);
  if (guidance.reason) lines.push(`Why: ${guidance.reason}`);
  if (guidance.command) lines.push(`CLI helper: ${guidance.command}`);
  return lines;
}
