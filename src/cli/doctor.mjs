#!/usr/bin/env node
// Node version guard — same minimum as bin/careerrat.mjs.
{
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    process.stderr.write(
      `careerrat requires Node.js >= 18 (you have ${process.versions.node}). Please upgrade.\n`
    );
    process.exit(1);
  }
}

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentGuidance,
  formatAgentGuidanceLines,
  readDiscoveryCompletions,
  readDiscoverySkips,
  readSetupState,
} from "../core/agent-guidance.mjs";
import { automationStatus, loadAutomation } from "../core/automation/consent.mjs";
import { detectSession } from "../core/automation/session.mjs";
import { sourceConfigGet } from "../core/db/verbs.mjs";
import { loadStories } from "../core/interview/story-bank.mjs";
import { displayPath, resolveUserPaths, userPath } from "../core/paths/workspace.mjs";
import { verifyBundledPlugins } from "../core/plugins/index.mjs";
import { checkTemplateLeftovers } from "../core/profile/candidate-setup.mjs";
import { candidateConfigSource, loadCandidateConfig } from "../core/profile/config-store.mjs";
import { loadEvidence } from "../core/profile/evidence-writer.mjs";
import { listLearnings } from "../core/profile/learnings.mjs";
import { loadModes } from "../core/profile/modes.mjs";
import { CAREER_OPS_UPSTREAM } from "../core/providers/provider-parity.mjs";
import { parseConfig } from "../core/providers/search-sources.mjs";
import { inferProvider, loadScannerConfig } from "../core/scoring/sourced-scanner.mjs";
import { pendingSourceLoginRequests } from "../core/search/source-login-preflight.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };
const userPaths = resolveUserPaths(pathCtx);
const args = process.argv.slice(2);
const json = args.includes("--json");
// Matches companies.mjs's PUBLIC_PROVIDER_COUNT: excludes local-parser, the
// one adopted id that is not a public network source adapter.
const PUBLIC_PROVIDER_COUNT = CAREER_OPS_UPSTREAM.providerCount - 1;

const userPrereqs = [
  {
    path: "candidate/profile.yml",
    fix: "Create candidate/profile.yml from templates/profile.example.yml.",
  },
  {
    path: "candidate/targeting.yml",
    fix: "Create candidate/targeting.yml from templates/targeting.example.yml.",
  },
  {
    path: "candidate/evidence.yml",
    fix: "Create candidate/evidence.yml from templates/evidence.example.yml.",
  },
  {
    path: "candidate/honesty.yml",
    fix: "Create candidate/honesty.yml from templates/honesty.example.yml.",
  },
  {
    path: "candidate/form-defaults.yml",
    fix: "Create candidate/form-defaults.yml from templates/form-defaults.example.yml.",
  },
];

const systemPrereqs = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/DATA_CONTRACT.md",
  ".agents/skills/ingest-profile/SKILL.md",
  ".agents/skills/evaluate-job/SKILL.md",
  ".agents/skills/email-comms/SKILL.md",
  "config/profile.schema.json",
  "config/targeting.schema.json",
  "config/evidence.schema.json",
  "config/stories.schema.json",
  "config/search-sources.schema.json",
  "config/tracker.schema.json",
  "config/automation.schema.json",
  "config/search-sources.example.yml",
  "templates/AGENTS.md",
  "templates/CLAUDE.md",
  "templates/email-thread.md",
];

const workspaceDirs = [
  "workspace/jobs",
  "workspace/tailored",
  "workspace/intake",
  "workspace/scan-results",
  "workspace/comms",
  "workspace/interview-prep",
  "workspace/writing-samples",
  "workspace/research",
  "workspace/network-leads",
];

function checkPath(path) {
  return existsSync(join(root, path));
}

function checkUserPath(path) {
  return existsSync(userPath(pathCtx, path));
}

function ensureUserDir(path) {
  const fullPath = userPath(pathCtx, path);
  if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true });
}

// .agents/skills is the runtime-neutral source of truth. Claude Code additionally
// needs the optional .claude/skills shim that `careerrat install-skills` repairs.
// A missing shim is useful diagnostics, but must not block Codex or other agents.
function skillNames() {
  const dir = join(root, ".agents", "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}
const sourceSkills = skillNames();
const skillsNotDiscoverable = sourceSkills.filter(
  (name) => !checkPath(join(".claude", "skills", name, "SKILL.md"))
);

const candidateSource = candidateConfigSource(pathCtx);
const candidateSetupReadiness = loadCandidateSetupReadiness();
const missingUser =
  candidateSource === "db" ? [] : userPrereqs.filter((item) => !checkUserPath(item.path));
const missingSystem = systemPrereqs.filter((path) => !checkPath(path));

// Personalization files that pass the missingUser existence check but still carry
// template content — e.g. candidate/profile.yml never edited from the "Jane
// Candidate" tech-demo persona it was copied from. Non-blocking by design (does
// NOT feed result.ok): doctor's job is to say the scaffold is present and valid,
// and an unedited personalization file must not make an otherwise-working
// CareerRat install look broken. It DOES need to be visible, since evaluations
// and tailored artifacts silently degrade when it's missed — surfaced as its own
// field an agent can branch on instead of a string it has to pattern-match out.
const templateLeftovers =
  candidateSource === "db"
    ? { clean: true, status: "clean", findings: [], files: [] }
    : checkTemplateLeftovers({ root });
for (const dir of workspaceDirs) ensureUserDir(dir);

// Per-role-family learning store (candidate/learnings/<family>.md). Informational
// only — an empty store is normal before any outcomes accrue, so it never fails.
const learnings = listLearnings({ root });

// STAR+R story bank (candidate/stories.yml). Informational only — an empty/absent
// bank is normal before any interview prep, so it never fails. `careerrat stories --
// check` is the dedicated validator.
const storyBank = loadStories({ root });

// Evidence truth bank (candidate/evidence.yml) claim count. Informational — presence
// is already a hard prereq above; `careerrat evidence check` is the validator.
const evidenceBank = loadEvidence({ root });

// Browser automation (candidate/automation.yml). Informational + opt-in — an
// absent file means everything is OFF, which is the normal, safe default, so it
// never fails doctor. Reports how many capability×platform pairs are actually live.
const automation = automationStatus({ root });
const modes = loadModes({ root });

// Session browser (config/automation.yml#session.provider). Informational — which
// provider drives the live "session browser" (Layer 3, docs/BROWSER.md) plus a
// best-effort, never-throwing presence probe. `mayRun()` is unaffected: provider is
// HOW a session runs, not WHETHER a capability is allowed. Never fails doctor.
const automationData = loadAutomation({ root }).data;
const sessionBrowser = detectSession({ data: automationData, repoRoot: root });

// Bundled plugins (plugins/<name>/). Informational: a plugin needing a
// consent capability is unaffected by this block, that's the automation
// block above. An invalid bundled manifest IS a defect in the shipped
// package though, so unlike the rest of this section it flips result.ok.
const pluginVerification = verifyBundledPlugins({ root });
const invalidPlugins = pluginVerification.filter((p) => !p.ok);

// Setup resume state (workspace/setup-state.json). Written by ingest-profile and
// the explicit discovery-skip helper; read-only here.
const setupState = readSetupState({ root });
const discoverySkips = readDiscoverySkips({ root });
const discoveryCompleted = readDiscoveryCompletions({ root });
const setup = setupState
  ? {
      present: true,
      mode: setupState.mode ?? null,
      depth: setupState.depth ?? null,
      complete: typeof setupState.complete === "boolean" ? setupState.complete : null,
      stepsRecorded: Array.isArray(setupState.completed) ? setupState.completed.length : 0,
      deferredCount: Array.isArray(setupState.deferred) ? setupState.deferred.length : 0,
      skippedDiscoverySteps: discoverySkips,
      completedDiscoverySteps: discoveryCompleted,
    }
  : {
      present: false,
      mode: null,
      depth: null,
      complete: null,
      stepsRecorded: 0,
      deferredCount: 0,
      skippedDiscoverySteps: discoverySkips,
      completedDiscoverySteps: discoveryCompleted,
    };

const searchReadiness = loadSearchReadiness();
const companyAtsReadiness = loadCompanyAtsReadiness();
const agentGuidance = buildAgentGuidance({
  missingUser,
  candidateConfigSource: candidateSource,
  missingSystem,
  modes,
  candidateSetupReadiness,
  searchReadiness,
  companyAtsReadiness,
  discoverySkips,
  discoveryCompleted,
});

const result = {
  ok:
    missingUser.length === 0 &&
    missingSystem.length === 0 &&
    modes.valid &&
    invalidPlugins.length === 0 &&
    (candidateSetupReadiness ? candidateSetupReadiness.readiness?.search_ready === true : true),
  missingUser,
  missingSystem,
  templateLeftovers,
  skillsNotDiscoverable,
  workspaceDirs,
  learnings: { count: learnings.length, families: learnings.map((l) => l.family) },
  storyBank: { exists: storyBank.exists, count: storyBank.stories.length },
  evidenceBank: { exists: evidenceBank.exists, count: evidenceBank.claims.length },
  automation: {
    configured: automation.exists,
    valid: automation.valid,
    liveCount: automation.liveCount,
    enabledCapabilities: automation.capabilities.filter((c) => c.enabled).map((c) => c.capability),
  },
  modes: {
    configured: modes.exists,
    valid: modes.valid,
    usageMode: modes.data.usage_mode,
    applicationMode: modes.data.application_mode,
    errors: modes.errors,
  },
  sessionBrowser: {
    provider: sessionBrowser.provider,
    preferred: sessionBrowser.descriptor?.preferred ?? false,
    configured: automation.exists,
    presence: sessionBrowser.presence.status,
    detail: sessionBrowser.presence.detail,
  },
  plugins: {
    bundled: pluginVerification.length,
    runnable: pluginVerification.length - invalidPlugins.length,
    invalid: invalidPlugins.map((p) => ({ name: p.name, errors: p.errors })),
  },
  setup,
  candidateSetup: candidateSetupReadiness,
  discovery: {
    broadSources: searchReadiness,
    companyAts: companyAtsReadiness,
    skippedSteps: discoverySkips,
    completedSteps: discoveryCompleted,
  },
  agentGuidance,
  dataRoot: userPaths.dataRoot,
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

console.log("careerrat doctor");
console.log("================");
console.log("");
console.log(`User data root: ${userPaths.dataRoot}`);
console.log("");

if (missingSystem.length > 0) {
  console.log("System files missing:");
  for (const path of missingSystem) console.log(`- ${path}`);
  console.log("");
}

if (skillsNotDiscoverable.length > 0) {
  console.log("Claude Code skill shim missing (CareerRat skills remain available):");
  for (const name of skillsNotDiscoverable) console.log(`- ${name}`);
  console.log("  fix: run `careerrat install-skills` (shims .claude/skills -> .agents/skills).");
  console.log("");
}

if (missingUser.length > 0) {
  console.log("User setup missing:");
  for (const item of missingUser) {
    console.log(`- ${displayPath(pathCtx, item.path)}`);
    console.log(`  fix: ${item.fix}`);
  }
  console.log("");
}

if (templateLeftovers.findings.length > 0) {
  console.log("Personalization incomplete (still has template content):");
  for (const finding of templateLeftovers.findings) {
    if (finding.key === "(whole file)") {
      console.log(
        `- ${finding.file}: ${finding.marker}, it doesn't look like it's been edited yet.`
      );
    } else {
      console.log(
        `- ${finding.file} ${finding.key}: still has template marker "${finding.marker}"`
      );
    }
  }
  console.log(
    "  fix: personalize these fields with your own information, or re-run `careerrat ingest --check`."
  );
  console.log("");
}

const unreadableTemplateFiles = templateLeftovers.files.filter((f) => f.status === "unreadable");
if (unreadableTemplateFiles.length > 0) {
  console.log("Could not check some files for leftover template content:");
  for (const file of unreadableTemplateFiles) console.log(`- ${file.file}`);
  console.log(
    "  fix: make sure the file is readable and is valid YAML, then run `careerrat doctor` again."
  );
  console.log("");
}

if (learnings.length > 0) {
  console.log(
    `Learning memory: ${learnings.length} role-family file(s), ${learnings.map((l) => l.family).join(", ")}.`
  );
  console.log("");
}

if (evidenceBank.exists) {
  console.log(
    `Evidence bank: ${evidenceBank.claims.length} claim${evidenceBank.claims.length === 1 ? "" : "s"} - validate with \`careerrat evidence check\`.`
  );
  console.log("");
}

if (storyBank.exists) {
  console.log(
    `Story bank: ${storyBank.stories.length} STAR+R stor${storyBank.stories.length === 1 ? "y" : "ies"} - validate with \`careerrat stories check\`.`
  );
  console.log("");
}

if (!modes.valid) {
  console.log("Modes: candidate/modes.yml is INVALID - run `careerrat modes status`.");
  console.log("");
} else {
  const source = modes.exists ? "configured" : "defaults";
  console.log(
    `Modes: usage ${modes.data.usage_mode}, application ${modes.data.application_mode} (${source}) - change with \`careerrat modes set <usage|application> <value> --write\`.`
  );
  console.log("");
}

if (!automation.exists) {
  console.log(
    "Browser automation: not configured - all capabilities OFF (opt-in; `careerrat automation status`)."
  );
  console.log("");
} else if (!automation.valid) {
  console.log(
    "Browser automation: candidate/automation.yml is INVALID against its schema - run `careerrat automation status`."
  );
  console.log("");
} else {
  const enabled = automation.capabilities.filter((c) => c.enabled).map((c) => c.capability);
  console.log(
    `Browser automation: ${automation.liveCount} live capability×platform pair(s)${enabled.length ? `, enabled: ${enabled.join(", ")}` : ", no capability enabled yet"}.`
  );
  console.log("");
}

{
  const pref = sessionBrowser.descriptor?.preferred ? " (preferred)" : "";
  const setNote = automation.exists ? "" : ", default (unset)";
  console.log(
    `Session browser: ${sessionBrowser.provider}${pref}${setNote}, ${sessionBrowser.presence.detail}.`
  );
  console.log(
    "  change with `careerrat automation session <auto|extension|orca|playwright> --write` (see docs/BROWSER.md)."
  );
  console.log("");
}

{
  const runnable = pluginVerification.length - invalidPlugins.length;
  console.log(`Plugins: ${pluginVerification.length} bundled, ${runnable} runnable.`);
  for (const p of invalidPlugins) {
    console.log(`- ${p.name}: ${p.errors.join("; ")}`);
  }
  if (invalidPlugins.length > 0) {
    console.log("  fix: run `careerrat plugins verify` for details.");
  }
  console.log("");
}

if (setup.present) {
  const modeDepth =
    setup.mode || setup.depth
      ? `(${[setup.mode ?? "unknown", setup.depth ?? "unknown"].join("/")})`
      : "";
  if (setup.complete) {
    console.log(`Setup: complete${modeDepth ? ` ${modeDepth}` : ""}.`);
  } else {
    const deferred = setup.deferredCount ? `, ${setup.deferredCount} deferred` : "";
    console.log(
      `Setup: in progress${modeDepth ? ` ${modeDepth}` : ""}, ${setup.stepsRecorded} step(s) recorded${deferred}; resume with \`ingest-profile\` (\`careerrat ingest\`).`
    );
  }
  console.log("");
}

if (candidateSetupReadiness) {
  const ready = candidateSetupReadiness.readiness || {};
  console.log(
    `Candidate setup readiness: search ${ready.search_ready ? "ready" : "needs setup"}, gate ${ready.gate_ready ? "ready" : "needs setup"}, apply ${ready.apply_ready ? "ready" : "needs setup"}.`
  );
  const missing = candidateSetupReadiness.missing?.search_ready || [];
  if (missing.length) console.log(`  Search-ready missing: ${missing.join(", ")}.`);
  console.log("");
}

console.log("Search readiness:");
printSearchReadiness(searchReadiness);
printCompanyAtsReadiness(companyAtsReadiness);
console.log("");

console.log("Discovery pipeline:");
printDiscoveryPipeline(searchReadiness, companyAtsReadiness, discoverySkips);
console.log("");

console.log("Agent guidance:");
printAgentGuidance(agentGuidance);
console.log("");

if (result.ok) {
  console.log("All required files are present and CareerRat skills are available.");
} else if (!modes.valid) {
  console.log("CareerRat scaffold is present, but candidate/modes.yml is invalid.");
  console.log("Run `careerrat modes status` for details.");
} else if (candidateSetupReadiness?.readiness?.search_ready === false) {
  console.log("CareerRat scaffold is present, but candidate setup is not search-ready yet.");
  console.log("Run the ingest-profile skill or continue onboarding.");
} else {
  console.log("CareerRat scaffold is present, but local candidate setup is incomplete.");
  console.log("Run the ingest-profile skill or copy templates into candidate/.");
}

process.exit(result.ok ? 0 : 1);

function loadCandidateSetupReadiness() {
  if (candidateSource !== "db") return null;
  try {
    return loadCandidateConfig(pathCtx).setup || null;
  } catch {
    return null;
  }
}

function loadSearchReadiness() {
  if (candidateSource === "db") {
    try {
      const stored = sourceConfigGet({ ...pathCtx, name: "search-sources" });
      return summarizeSearchReadiness(stored.data, { exists: stored.stored });
    } catch (err) {
      return {
        exists: false,
        valid: false,
        total: 0,
        enabled: 0,
        pendingLogin: 0,
        withLastRun: 0,
        providers: [],
        error: err.message,
      };
    }
  }

  const configPath = userPath(pathCtx, "config/search-sources.yml");
  if (!existsSync(configPath)) {
    return {
      exists: false,
      valid: true,
      total: 0,
      enabled: 0,
      pendingLogin: 0,
      withLastRun: 0,
      providers: [],
    };
  }
  try {
    const config = parseConfig(readFileSync(configPath, "utf8"));
    return summarizeSearchReadiness(config, { exists: true });
  } catch (err) {
    return {
      exists: true,
      valid: false,
      total: 0,
      enabled: 0,
      pendingLogin: 0,
      withLastRun: 0,
      providers: [],
      error: err.message,
    };
  }
}

function summarizeSearchReadiness(config, { exists }) {
  const searches = Array.isArray(config?.searches) ? config.searches : [];
  const enabled = searches.filter((search) => search.enabled !== false);
  return {
    exists,
    valid: true,
    total: searches.length,
    enabled: enabled.length,
    pendingLogin: pendingSourceLoginRequests(config).length,
    withLastRun: searches.filter((search) => search.recency?.lastRunAt).length,
    providers: [...new Set(enabled.map((search) => search.provider).filter(Boolean))].sort(),
  };
}

function loadCompanyAtsReadiness() {
  try {
    const config =
      candidateSource === "db"
        ? sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data
        : loadScannerConfig(userPath(pathCtx, "config/sourced-scan.json"));
    const companies = Array.isArray(config?.tracked_companies) ? config.tracked_companies : [];
    return {
      configured: companies.length > 0,
      valid: true,
      total: companies.length,
      providers: [
        ...new Set(companies.map((entry) => inferProvider(entry)).filter(Boolean)),
      ].sort(),
    };
  } catch (err) {
    return {
      configured: false,
      valid: false,
      total: 0,
      providers: [],
      error: err.message,
    };
  }
}

function printSearchReadiness(readiness) {
  if (!readiness.exists) {
    console.log("- Broad sources: no config yet - run `careerrat searches --from-targeting`.");
    return;
  }
  if (!readiness.valid) {
    console.log(
      `- Broad sources: config is invalid: fix ${displayPath(pathCtx, "config/search-sources.yml")}.`
    );
    if (readiness.error) console.log(`  error: ${readiness.error}`);
    return;
  }
  const searchWord = readiness.enabled === 1 ? "search" : "searches";
  const providerText = readiness.providers.length
    ? ` across ${readiness.providers.join(", ")}`
    : "";
  const runText =
    readiness.enabled > 0
      ? `; ${readiness.withLastRun}/${readiness.enabled} have run watermarks`
      : "";
  console.log(
    `- Broad sources: ${readiness.enabled} enabled ${searchWord}${providerText}${runText}.`
  );
  if (readiness.pendingLogin > 0) {
    const sourceWord = readiness.pendingLogin === 1 ? "source" : "sources";
    console.log(
      `  ${readiness.pendingLogin} saved ${sourceWord} waiting for a point-of-use login choice.`
    );
  }
}

function printCompanyAtsReadiness(readiness) {
  if (!readiness.valid) {
    console.log(
      `- Company ATS scans: config is invalid: fix ${displayPath(pathCtx, "config/sourced-scan.json")}.`
    );
    if (readiness.error) console.log(`  error: ${readiness.error}`);
    return;
  }
  if (!readiness.configured) {
    console.log(
      "- Company ATS scans: not configured - ask your agent to run discover-companies, or add boards with `careerrat companies --add`."
    );
    console.log(
      `  This wires employer boards through CareerRat's ${PUBLIC_PROVIDER_COUNT} public deterministic provider adapters.`
    );
    return;
  }
  const companyWord = readiness.total === 1 ? "company" : "companies";
  const providerText = readiness.providers.length ? ` (${readiness.providers.join(", ")})` : "";
  console.log(`- Company ATS scans: ${readiness.total} tracked ${companyWord}${providerText}.`);
}

function printDiscoveryPipeline(searches, companies, discoverySkips = []) {
  const skipped = new Set(discoverySkips);
  console.log(
    "- Order after onboarding: setup-searches -> research-boards -> discover-companies -> search-jobs."
  );
  if (searches.pendingLogin > 0) {
    console.log("  Next discovery step: search-jobs login handoff.");
    return;
  }
  if (!searches.exists || !searches.valid || searches.enabled === 0) {
    console.log("  Next discovery step: setup-searches.");
    return;
  }
  if (!companies.valid || !companies.configured) {
    if (!skipped.has("research-boards")) {
      console.log(
        "  Next discovery step: research-boards; then discover-companies before the first sweep."
      );
      return;
    }
    if (!skipped.has("discover-companies")) {
      console.log("  Next discovery step: discover-companies (research-boards skipped).");
      return;
    }
    console.log(
      "  Next discovery step: search-jobs first sweep (board and company discovery skipped)."
    );
    return;
  }
  if (searches.withLastRun === 0) {
    console.log("  Next discovery step: search-jobs first sweep.");
    return;
  }
  console.log("  Next discovery step: search-jobs refresh.");
}

function printAgentGuidance(guidance) {
  for (const line of formatAgentGuidanceLines(guidance)) console.log(line);
}
