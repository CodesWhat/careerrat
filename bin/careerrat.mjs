#!/usr/bin/env node
// CareerRat launcher — the `npx careerrat <command>` entrypoint.
//
//   careerrat start [ai]  Open the terminal workspace (TUI) with Claude or Codex
//   careerrat init        Scaffold candidate/ + workspace dirs, print next steps
//   careerrat doctor      Environment health check
//   careerrat next        Show the next agent task
//   careerrat ingest      Guided candidate setup
//   careerrat searches    Build/curate the search-source config
//   careerrat companies   Manage tracked employer ATS boards
//   careerrat evaluate    Run the body-read gate on a saved job
//   careerrat questions   Fetch a job's real application-form questions (no browser)
//   careerrat tracker     One-shot tracker snapshot
//   careerrat restore     Recover workspace/tracker.json from a rolling snapshot
//   careerrat export      Render a tailored artifact / packet to PDF or DOCX
//   careerrat people      List or add people, one workspace each (see --for)
//   careerrat roundup     Email a person their job-search roundup (with --for)
//   careerrat help        Show this list
//
// Global: `--for <name>` runs any command in that person's workspace
// (<data root>/people/<name>/). CAREERRAT_PERSON=<name> does the same.
//
// Each subcommand delegates to the matching src/cli script, forwarding args.

// Node version guard. Refuses unpatched Node (CVE-2026-111497) and anything
// below the 24 floor in package.json#engines before any command runs.
import { requirePatchedNode } from "../src/core/runtime/node-floor.mjs";

requirePatchedNode();

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findInstalledExecutable,
  INSTALLED_RUNTIME_DEFINITIONS,
} from "../src/core/ai/installed-runtimes.mjs";
import { currentPerson, resolvePersonSelection } from "../src/core/paths/people.mjs";
import {
  displayPath,
  privateDataRoot,
  resolveUserPaths,
  strandedPackageDataDir,
  userPath,
} from "../src/core/paths/workspace.mjs";
import { borrowedAiWarning } from "../src/core/people/ai-route.mjs";
import { authorizationPath, recordAuthorization } from "../src/core/people/authorization.mjs";
import { migratePersonDocuments } from "../src/core/people/documents-migration.mjs";
import {
  extractOver,
  fetchTarball,
  findUserDataLeaks,
  installRuntimeDeps,
  isNewer,
  latestVersion,
  RUNTIME_DEPS_INSTALL_ARGS,
  readRuntimeDeps,
  readUpdateNotice,
  refreshUpdateCacheInBackground,
  runtimeDepsChanged,
} from "../src/core/update/update-core.mjs";
import { readVersion } from "../src/core/version.mjs";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const pathCtx = { repoRoot: root };
const {
  args: cliArgs,
  person: forPerson,
  create: createPerson,
} = extractForFlag(process.argv.slice(2));
const [command, ...rest] = cliArgs;

const CLIS = {
  doctor: "src/cli/doctor.mjs",
  next: "src/cli/next.mjs",
  ingest: "src/cli/ingest.mjs",
  searches: "src/cli/searches.mjs",
  search: "src/cli/search.mjs",
  companies: "src/cli/companies.mjs",
  evaluate: "src/cli/evaluate.mjs",
  questions: "src/cli/questions.mjs",
  tracker: "src/cli/tracker.mjs",
  tui: "src/cli/tui.mjs",
  people: "src/cli/people.mjs",
  roundup: "src/cli/roundup.mjs",
  data: "src/cli/data.mjs",
  comm: "src/cli/data.mjs", // shorthand: `careerrat comm ...` is `careerrat data comm ...`
  modes: "src/cli/modes.mjs",
  automation: "src/cli/automation.mjs",
  activity: "src/cli/activity.mjs",
  research: "src/cli/research.mjs",
  health: "src/cli/health.mjs",
  apply: "src/cli/apply.mjs",
  stories: "src/cli/stories.mjs",
  "strategy-review": "src/cli/strategy-review.mjs",
  analytics: "src/cli/analytics.mjs",
  outcomes: "src/cli/outcomes.mjs",
  rules: "src/cli/rules.mjs",
  "recruiter-check": "src/cli/recruiter-check.mjs",
  evidence: "src/cli/evidence.mjs",
  gate: "src/cli/gate.mjs",
  plugins: "src/cli/plugins.mjs",
  learnings: "src/cli/learnings.mjs",
  "status-map": "src/cli/status-map.mjs",
  "lint-placeholders": "src/cli/lint-placeholders.mjs",
  "fact-check": "src/cli/fact-check.mjs",
  export: "src/cli/export.mjs",
  restore: "src/cli/restore.mjs",
  "install-skills": "scripts/install-skills.mjs",
};

const WORKSPACE_DIRS = [
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

// The single starter message that hands a freshly-scaffolded workspace to the
// agent. It anchors every new session to doctor-driven next-step routing.
const STARTER_PROMPT =
  "Read AGENTS.md, run careerrat doctor, then guide me through the next unfinished CareerRat skill. Once setup is search-ready, inspect or reuse the baseline search while Paul continues, then expand it through setup-searches -> research-boards -> discover-companies -> search-jobs.";

const RETIRED_BROWSER_MESSAGE =
  "The browser workspace was retired in v0.26. Use `careerrat start` (terminal workspace).";

// Agent CLIs we know how to launch, in preference order. Each is started with
// the starter prompt as a single positional argument (the seed-a-session form
// both Claude Code and Codex accept). Declared above the command dispatch so
// runStart can read them on its synchronous (no-await) --no-dashboard path.
const AGENT_CANDIDATES = INSTALLED_RUNTIME_DEFINITIONS.filter(
  ({ supported }) => supported === true
).map(({ name, binaries }) => ({
  name,
  bin: binaries[0],
}));

if (command === "version" || command === "--version" || command === "-v") {
  console.log(readVersion());
  process.exit(0);
}

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(command ? 0 : 1);
}

if (command === "start" && (rest.includes("--help") || rest.includes("-h"))) {
  printHelp();
  process.exit(0);
}

// Select the person before anything resolves a path. Setting the env here is what
// makes every command, subcommand and child process inherit the same workspace.
applyPersonSelection();

if (command === "update") {
  process.exit(runUpdate(rest));
}

// Data left inside the package dir from before the ~/.careerrat anchor fix (an
// installed package used to default its data root inside itself, which a plain
// reinstall then silently deleted). `update` has its own hard-refuse check below;
// every other command just gets a loud, non-blocking heads-up.
warnIfStrandedPackageData();

// Background-cached "update available" notice for normal commands (never blocks).
notifyUpdateAvailable();

if (command === "init") {
  process.exit(runInit(rest));
}

if (command === "tracker-dev") {
  console.error(RETIRED_BROWSER_MESSAGE);
  process.exit(1);
}

if (command === "start") {
  runStart(rest).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message ? err.message : String(err));
      process.exit(1);
    }
  );
} else {
  const cli = CLIS[command];
  if (!cli) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
  process.exit(run(join(root, cli), command === "comm" ? ["comm", ...rest] : rest));
}

// ---------------------------------------------------------------------------

// Pulls a global `--for <name>` (or `--for=<name>`) out of argv so no command
// ever sees it. The last one wins. With a person selected, `--new` is global too:
// it creates that person's workspace if it doesn't exist yet, on any command.
function extractForFlag(argv) {
  const args = [];
  let person = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--for") {
      const value = argv[i + 1];
      if (!value?.trim() || value.startsWith("-")) {
        console.error("--for needs a person name. Try: careerrat --for <name> <command>");
        process.exit(1);
      }
      person = value;
      i++;
    } else if (arg.startsWith("--for=")) {
      person = arg.slice("--for=".length);
      if (!person.trim()) {
        console.error("--for needs a person name. Try: careerrat --for <name> <command>");
        process.exit(1);
      }
    } else {
      args.push(arg);
    }
  }
  if (person === null && !String(process.env.CAREERRAT_PERSON || "").trim()) {
    return { args, person, create: false };
  }
  const create = args.includes("--new");
  return { args: args.filter((arg) => arg !== "--new"), person, create };
}

// `--for <name>` or an inherited CAREERRAT_PERSON points CAREERRAT_HOME at
// <base>/people/<name>. The person has to exist, except where the command
// creates it: `people` (add) and `start --new`.
function applyPersonSelection() {
  let env;
  try {
    env = resolvePersonSelection({
      repoRoot: root,
      env: process.env,
      forName: forPerson,
      allowMissing: command === "people",
      createMissing: createPerson,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (env) Object.assign(process.env, env);
  if (env) {
    // Move a pre-namespace documents folder into the person namespace when it's
    // unambiguously theirs; otherwise leave it alone and say so.
    try {
      const moved = migratePersonDocuments({
        repoRoot: root,
        base: env.CAREERRAT_PEOPLE_BASE,
        name: env.CAREERRAT_PERSON,
      });
      if (moved.status === "moved") console.error(`Moved ${moved.from} to ${moved.to}`);
      else if (moved.status === "skipped") {
        console.error(
          `Left ${moved.from} where it is (${moved.reason}). Move it by hand if it's theirs.`
        );
      }
    } catch (error) {
      console.error(`Could not check the old documents folder: ${error.message}`);
    }
  }
  if (env && createPerson) {
    // --new made the workspace: leave the same authorization note `people add` does.
    const base = env.CAREERRAT_PEOPLE_BASE;
    const name = env.CAREERRAT_PERSON;
    if (!existsSync(authorizationPath(base, name))) {
      recordAuthorization({ base, name, env: process.env });
      console.error(
        `Created ${name}'s workspace. Record who authorized it: careerrat people add ${name} --authorized-by "<who>" --purpose "<what for>"`
      );
    }
  }
}

function runInit(extra) {
  for (const dir of WORKSPACE_DIRS) {
    const abs = userPath(pathCtx, dir);
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  }
  // ingest (default mode) copies candidate templates and prints status + next steps.
  const code = run(join(root, CLIS.ingest), extra);
  if (code === 0) {
    console.log("");
    console.log(`Data root: ${resolveUserPaths(pathCtx).dataRoot}`);
    console.log(`Workspace ready. Open your agent in ${agentStartDir()} and say:`);
    console.log(`    ${STARTER_PROMPT}`);
    console.log("Use `careerrat next` anytime to print the current next agent task.");
  }
  return code;
}

// Parse `start` args. The first bare word is the agent to launch
// (`careerrat start claude`); `--agent <name>` is an equivalent alias. Both
// accept either supported launcher by name.
function parseStartArgs(extra) {
  const out = {
    agent: null,
    noAgent: false,
    noDashboard: false,
    retiredBrowserFlag: false,
  };
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    if (a === "--no-agent") out.noAgent = true;
    else if (a === "--no-dashboard") out.noDashboard = true;
    else if (a === "--no-open" || a === "--browser") out.retiredBrowserFlag = true;
    else if (a === "--new") {
      // Consumed earlier by the --for resolver (createMissing); nothing to do here.
    } else if (a === "--agent") {
      if (!extra[i + 1]?.trim() || extra[i + 1].startsWith("-"))
        throw new Error("--agent needs a name. Try: careerrat start --agent claude");
      out.agent = extra[++i];
    } else if (a === "--port") {
      out.retiredBrowserFlag = true;
      i++;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option for start: ${a}. Run careerrat start --help for the list.`);
    } else if (!out.agent) out.agent = a; // first bare positional = agent name
  }
  return out;
}

// `careerrat start [agent]`, the one-command front door. It opens the Textual
// terminal workspace with a native Claude or Codex agent (same selection rules
// as `careerrat tui`). `--no-dashboard` launches a bare agent session instead.
// The browser workspace is retired: --browser, --port and --no-open (and the
// tracker-dev command) print the retired message and exit 1.
// Usage: careerrat start [claude|codex] [--agent <name>] [--no-agent]
//        careerrat start --no-dashboard [claude|codex] [--no-agent]
async function runTerminalWorkspace(opts) {
  const person = currentPerson(process.env);
  if (person) console.log(`• CareerRat for ${person}`);
  console.log(`• Data root: ${resolveUserPaths(pathCtx).dataRoot}`);
  for (const dir of WORKSPACE_DIRS) {
    const abs = userPath(pathCtx, dir);
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  }
  const args = opts.noAgent ? ["--no-agent"] : opts.agent ? ["--agent", opts.agent] : [];
  return run(join(root, CLIS.tui), args);
}

async function runStart(extra) {
  const opts = parseStartArgs(extra);
  if (opts.retiredBrowserFlag) {
    console.error(RETIRED_BROWSER_MESSAGE);
    return 1;
  }
  if (!opts.noDashboard) return runTerminalWorkspace(opts);
  const wantAgent = !opts.noAgent;
  const forcedAgent = opts.agent;

  const person = currentPerson(process.env);
  if (person) console.log(`• CareerRat for ${person}`);
  const aiWarning = borrowedAiWarning({ repoRoot: root, env: process.env });
  if (aiWarning) console.error(aiWarning);
  console.log(`• Data root: ${resolveUserPaths(pathCtx).dataRoot}`);

  // 1) Scaffold workspace dirs (idempotent).
  for (const dir of WORKSPACE_DIRS) {
    const abs = userPath(pathCtx, dir);
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  }

  // 2) Install skills so Claude Code sees /apply-job etc. Non-fatal: agents that
  //    read AGENTS.md natively (Codex) work without the shim.
  if (wantAgent) {
    console.log("• Installing skills…");
    const skillCode = run(join(root, "scripts/install-skills.mjs"), ["--soft"]);
    if (skillCode !== 0) {
      console.log("  (skill shim reported an issue, AGENTS.md-native agents still work)");
    }
  }

  // 3) Seed a tracker so the terminal workspace has something to open. Never clobber real data.
  const trackerJson = userPath(pathCtx, "workspace/tracker.json");
  if (!existsSync(trackerJson)) {
    try {
      mkdirSync(userPath(pathCtx, "workspace"), { recursive: true });
      if (person) {
        // A person's workspace starts empty: demo rows would mix into a real
        // person's job search.
        const seed = JSON.parse(readFileSync(join(root, "templates/tracker.json"), "utf8"));
        for (const key of Object.keys(seed)) if (Array.isArray(seed[key])) seed[key] = [];
        writeFileSync(trackerJson, `${JSON.stringify(seed, null, 2)}\n`);
        console.log(`• Started an empty tracker for ${person}`);
      } else {
        copyFileSync(join(root, "templates/tracker.json"), trackerJson);
        console.log(
          `• Seeded ${displayPath(pathCtx, "workspace/tracker.json")} (demo data, replaced as you add real roles)`
        );
      }
    } catch {
      /* non-fatal: the workspace simply starts without a tracker */
    }
  }

  // 4) Hand off to the agent.
  let exitCode = 0;
  if (wantAgent) {
    const agent = forcedAgent ? resolveForcedAgent(forcedAgent) : findAgent();
    if (agent) {
      console.log(`• Launching ${agent.name}…\n`);
      const res = spawnSync(agent.bin, [STARTER_PROMPT], { stdio: "inherit", cwd: root });
      if (res.error) {
        console.error(`Could not launch ${agent.name}: ${res.error.message}`);
        exitCode = 1;
      } else {
        exitCode = res.status == null ? 0 : res.status;
      }
    } else {
      console.log("");
      if (forcedAgent) {
        console.log(`Couldn't find "${forcedAgent}" on your PATH.`);
        exitCode = 1;
      } else {
        console.log("No agent CLI found on PATH (looked for: claude, codex).");
        console.log("");
        console.log("Install one:");
        console.log(
          "  Claude Code:  npm install -g @anthropic-ai/claude-code   (https://claude.com/claude-code)"
        );
        console.log(
          "  Codex:        npm install -g @openai/codex               (https://github.com/openai/codex)"
        );
      }
      printManualAgentHandoff();
    }
  } else {
    console.log("");
    printManualAgentHandoff();
  }
  return exitCode;
}

// The agent has to start where AGENTS.md and .agents/skills/ live, which is the
// install directory, not wherever the user happens to be standing. `careerrat start`
// already spawns it with cwd: root; this is the same instruction for the manual
// handoff. Says "this folder" only when that is actually where they are, since on a
// global npm install it never is.
function agentStartDir() {
  if (root === process.cwd()) return "this folder";
  return root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root;
}

function printManualAgentHandoff() {
  console.log(`Open your agent in ${agentStartDir()} and say:`);
  console.log("");
  console.log(`    ${STARTER_PROMPT}`);
  console.log("");
  console.log("For a terse CLI handoff, run `careerrat next`.");
}

function findAgent() {
  for (const cand of AGENT_CANDIDATES) {
    const bin = findOnPath(cand.bin);
    if (bin) return { name: cand.name, bin };
  }
  return null;
}

function resolveForcedAgent(name) {
  const known = AGENT_CANDIDATES.find(
    (c) => c.bin === name || c.name.toLowerCase() === String(name).toLowerCase()
  );
  if (!known) return null;
  const bin = findOnPath(known.bin);
  if (!bin) return null;
  return { name: known.name, bin };
}

// Resolve an executable on PATH without running it (no version probes).
function findOnPath(name) {
  return name ? findInstalledExecutable([name]) : null;
}

function run(scriptPath, extra) {
  const res = spawnSync(process.execPath, [scriptPath, ...extra], { stdio: "inherit" });
  if (res.error) {
    console.error(res.error.message);
    return 1;
  }
  return res.status == null ? 1 : res.status;
}

function parseUpdateArgs(extra) {
  const out = { tag: "latest", check: false, force: false, help: false, unknown: [] };
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    if (a === "--check") out.check = true;
    else if (a === "--force") out.force = true;
    else if (a === "--rc") out.tag = "rc";
    else if (a === "--tag") out.tag = extra[++i] || out.tag;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) out.unknown.push(a);
  }
  return out;
}

function printUpdateHelp() {
  console.log(`Usage: careerrat update [options]

Update this install to the latest published version.

Options:
  --check       Check for an update without installing it
  --force       Reinstall even if already up to date
  --rc          Update to the latest release-candidate tag instead of latest
  --tag <name>  Update to a specific npm dist-tag
  --help, -h    Show this help and exit`);
}

// `careerrat update` refreshes THIS install's code from the published npm package.
// Code only: candidate/ and workspace/ are never in the published package, and since
// the ~/.careerrat data-root fix, a fresh install anchors its private data at
// ~/.careerrat, never inside the package directory, so a plain reinstall can't touch
// it. An install that predates that fix can still have real data stranded inside its
// own package dir; runUpdate hard-refuses rather than silently extracting over it.
// A separate privacy guard refuses any tarball that carries user-data paths.
function runUpdate(extra) {
  const opts = parseUpdateArgs(extra);
  if (opts.help) {
    printUpdateHelp();
    return 0;
  }
  if (opts.unknown.length) {
    console.error(
      `Unknown option${opts.unknown.length > 1 ? "s" : ""} for update: ${opts.unknown.join(", ")}`
    );
    console.error("");
    printUpdateHelp();
    return 1;
  }
  const stranded = strandedDataWarning();
  if (stranded) {
    console.error(`REFUSING. ${stranded}`);
    return 1;
  }
  const current = readVersion();

  console.log(`• Checking npm for careerrat@${opts.tag}…`);
  const latest = latestVersion(opts.tag);
  if (!latest) {
    console.error(
      `Couldn't resolve careerrat@${opts.tag}: offline, no such dist-tag (e.g. no rc published yet), or npm not on PATH.`
    );
    return 1;
  }
  const newer = isNewer(current, latest);

  if (opts.check) {
    console.log(
      newer
        ? `Update available: ${current} → ${latest}. Run \`careerrat update\` to install.`
        : `Up to date (v${current}; latest@${opts.tag} = v${latest}).`
    );
    return 0;
  }
  if (!newer && !opts.force) {
    console.log(
      `Already up to date (v${current}; latest@${opts.tag} = v${latest}). Use --force to reinstall.`
    );
    return 0;
  }

  const depsBefore = readRuntimeDeps(root);

  console.log(`• Fetching careerrat@${latest}…`);
  let pkg;
  try {
    pkg = fetchTarball(`careerrat@${latest}`);
  } catch (err) {
    console.error(err?.message || String(err));
    return 1;
  }
  try {
    const leaks = findUserDataLeaks(pkg.entries);
    if (leaks.length) {
      console.error(
        "REFUSING. The published package contains user-data paths (a privacy leak):\n" +
          leaks
            .slice(0, 20)
            .map((p) => `    ${p}`)
            .join("\n")
      );
      return 1;
    }
    console.log(`• Privacy guard passed: code-only (${pkg.entries.length} files). Updating…`);
    extractOver(pkg.tgz, root);
  } catch (err) {
    console.error(err?.message || String(err));
    return 1;
  } finally {
    pkg.cleanup();
  }

  // extractOver only swaps package files; reconcile node_modules when the release
  // added or bumped a runtime dependency, or the new code can't import it.
  if (runtimeDepsChanged(depsBefore, readRuntimeDeps(root))) {
    console.log("• Runtime dependencies changed. Installing them…");
    const dep = installRuntimeDeps(root);
    if (dep.unreviewed?.length) {
      // "name@1.2.3 (bundled)" -> "name"; scoped names keep their leading "@".
      const pkgName = (entry) => {
        const spec = String(entry).replace(/\s*\(bundled\)$/, "");
        const at = spec.lastIndexOf("@");
        return at > 0 ? spec.slice(0, at) : spec;
      };
      const toRebuild = [...new Set([...(dep.approved || []), ...dep.unreviewed].map(pkgName))];
      const approvedCmd =
        `\nNothing was rebuilt. After you've reviewed and approved the packages above, run this to finish the install` +
        ` (a plain \`careerrat update\` won't redo it):\n    cd "${root}" && npm rebuild ${toRebuild.join(" ")}`;
      console.error(
        `Updated the files to ${readVersion()}, but stopped before rebuilding anything: ` +
          `${dep.unreviewed.join(", ")} declare an install script that isn't covered by the ` +
          "reviewed allowScripts policy in package.json, so no install scripts were run. " +
          "CareerRat may not start until this is sorted out. To trust a package, add it to " +
          `allowScripts (true to run, false to deny) in "${join(root, "package.json")}".` +
          approvedCmd
      );
      return 1;
    }
    if (dep.status !== 0) {
      console.error(
        `Updated the files to ${readVersion()}, but installing the new dependencies failed` +
          `${dep.error ? ` (${dep.error})` : ` (npm exited ${dep.status})`}. ` +
          "CareerRat may not start until they're installed. Run this by hand:\n" +
          `    cd "${root}" && npm ${RUNTIME_DEPS_INSTALL_ARGS.join(" ")}`
      );
      return 1;
    }
  }

  // Re-shim skills + health-check using the freshly extracted code.
  run(join(root, "scripts/install-skills.mjs"), ["--soft"]);
  console.log(`• Updated ${current} → ${readVersion()}. Running doctor…`);
  const doctorStatus = run(join(root, CLIS.doctor), []);
  if (doctorStatus !== 0) {
    console.error("Updated, but doctor reported problems: run careerrat doctor");
  }
  noticeRetiredBrowserWorkspace();
  return doctorStatus === 0 ? 0 : 1;
}

// A tracker-dev server started by an older version keeps running after the
// update. It is retired, so tell the user how to stop it. Never kill it here.
function noticeRetiredBrowserWorkspace() {
  const pid = recordedRetiredWorkspacePid();
  if (!pid) return;
  console.log(
    `• The retired browser workspace is still running (pid ${pid}). Stop it with: kill ${pid}`
  );
}

function recordedRetiredWorkspacePid() {
  try {
    const pidPath = join(resolveUserPaths(pathCtx).internalDir, "tracker-dev.pid");
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    // The pid file can outlive the process and the number can be reused, so
    // only report a process that is still a tracker-dev server.
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return ps.status === 0 && ps.stdout.includes("tracker-dev") ? pid : null;
  } catch {
    return null;
  }
}

// Builds the stranded-data message, or null when there is nothing stranded. Shared by
// the CLI-startup warning and update's hard refuse so both describe the same directory
// the same way.
function strandedDataWarning() {
  const stranded = strandedPackageDataDir(pathCtx);
  if (!stranded) return null;
  const target = privateDataRoot(pathCtx);
  if (existsSync(target)) {
    return (
      `Found user data still inside the package directory (${stranded}). CareerRat now ` +
      `keeps private data at ${target}, and that directory already exists too. Reconcile ` +
      `the two by hand, then remove the copy inside the package.`
    );
  }
  return (
    `Found user data still inside the package directory (${stranded}), left over from ` +
    `before CareerRat moved private data out of the package. Move it, then re-run:\n` +
    `    mv "${stranded}" "${target}"`
  );
}

// Cheap existsSync-based check at CLI startup (never a recursive scan). Loud, once per
// invocation, never auto-moves anything: an automatic move could silently clobber or
// merge-conflict with different or newer data already at the real root.
function warnIfStrandedPackageData() {
  const warning = strandedDataWarning();
  if (warning) console.error(`! ${warning}`);
}

// Print a cached "newer version available" notice (no network) and kick a detached,
// once-a-day background refresh of that cache. Never throws into the command path.
function notifyUpdateAvailable() {
  try {
    const notice = readUpdateNotice(pathCtx, readVersion());
    if (notice) console.error(notice);
    refreshUpdateCacheInBackground(pathCtx, root);
  } catch {
    /* a notifier must never break a command */
  }
}

function printHelp() {
  console.log(`careerrat: agentic job-search workspace

Usage: careerrat <command> [options]

Commands:
  start [ai]  Open the terminal workspace (TUI) with Claude or Codex; same as 'careerrat tui'
  init        Scaffold candidate/ + workspace dirs, print next steps
  install-skills  Create/repair the .claude/skills -> .agents/skills shim (--check to verify only)
  doctor      Environment health check
  next        Show the next agent task from doctor guidance
  ingest      Guided candidate setup (profile, targeting, evidence, ...)
  searches    Build and curate the search-source config
  search      Start, inspect or cancel a background configured-source scan
  companies   Manage tracked employer ATS boards
  evaluate    Run the body-read gate on a saved job (GATE/FIT/COMP/ACTION)
  questions   Fetch a job's real application-form questions, no browser (Greenhouse/Ashby, or --paste)
  tracker     One-shot tracker snapshot / summary / follow-ups
  people      List, add or remove (--purge --yes) people, one workspace each (run any command for them with --for)
  comm        Shorthand for "data comm": upsert, append-message, mark-sent, handoff [--deliver-to-person]
  roundup     With --for: print or email (--send) a person their job-search roundup
  data        sqlite-backed data layer: status/init/import/export/verify/backup/restore + per-domain verbs (M6)
  restore     Recover workspace/tracker.json from a rolling snapshot (list / restore by index or name)
  modes       Show/change optional usage and application modes
  automation  Show/toggle browser-automation config (everything defaults ON, including auto-submit)
  research    Read/record web-research artifacts
  health      Record the company-health skill's role-scoped companyHealth rating
  apply       Submit gate for agent-filled forms: checks the live form, presses Submit only if it passes
  gate        Safely update gate data such as comp floors and exclusions
  plugins     List/verify the bundled plugin layer (read-only; --help for options)
  learnings   Read/append per-role-family learnings
  stories     Read/validate/add STAR+R interview stories
  activity    Read/append/prune the Activity Pulse feed
  evidence    Read/validate/add evidence claims
  analytics   Refresh + inspect the persisted outcome-analytics block (--write)
  recruiter-check  Flag outreach that may not be a real recruiter (domain mismatch, no posting, run-code asks)
  rules       Corrections as proposed writing rules: propose (max 5/session), accept by id (undoable), dismiss
  outcomes    Honest outcome rates: in-flight excluded, sample floor, fit band vs outcome
  lint-placeholders  Check drafts for unfilled placeholders (exit 1 on a hit, 2 on a bad path)
  fact-check  Reject a draft with a number, tool or name missing from your material (exit 1)
  strategy-review  Stamp the "last reviewed" marker after a strategy review
  status-map  Normalize a raw ATS status label to the canonical tracker status
  export      Render a tailored artifact / packet to PDF or DOCX
  update      Update this install to the latest published version (--check, --rc, --force)
  version     Print the installed CareerRat version (also --version, -v)
  help        Show this list

start [ai]:
  Opens the terminal workspace: saved jobs plus a Claude or Codex chat.
  With no agent name it picks Claude, then Codex, whichever is installed.
  First run with no profile yet starts the agent on candidate setup.
  Needs Python 3.11+ (first launch builds a private environment) and a real terminal.
  --agent <name>      claude or codex; same as the positional, alternate spelling
  --no-agent          workspace only, don't launch an agent
  --no-dashboard      bare terminal agent session without the workspace

--for <name>:
  Works on every command. Runs it in that person's workspace
  (<data root>/people/<name>/). Create one with: careerrat people add <name>
  --new               with --for, create that person's workspace first (any command)
  careerrat doctor shows which AI route their work runs on; see "Running CareerRat for
  someone else" in the docs.

Run any command with --help for its own options.`);
}
