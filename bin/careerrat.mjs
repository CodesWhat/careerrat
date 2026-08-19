#!/usr/bin/env node
// CareerRat launcher — the `npx careerrat <command>` entrypoint.
//
//   careerrat start [ai]  One command: scaffold + skills + local app + agent
//   careerrat init        Scaffold candidate/ + workspace dirs, print next steps
//   careerrat doctor      Environment health check
//   careerrat next        Show the next agent task
//   careerrat ingest      Guided candidate setup
//   careerrat searches    Build/curate the search-source config
//   careerrat companies   Manage tracked employer ATS boards
//   careerrat evaluate    Run the body-read gate on a saved job
//   careerrat questions   Fetch a job's real application-form questions (no browser)
//   careerrat tracker     One-shot tracker snapshot (use `start` for the live dev server)
//   careerrat restore     Recover workspace/tracker.json from a rolling snapshot
//   careerrat export      Render a tailored artifact / packet to PDF or DOCX
//   careerrat help        Show this list
//
// Each subcommand delegates to the matching src/cli script, forwarding args.

// Node version guard — must run before any ESM import that requires >=24
// features (M6: node:sqlite is a builtin from Node 22.5, but only stable
// without a flag from 24 — see package.json#engines).
{
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 24) {
    process.stderr.write(
      `careerrat requires Node.js >= 24 (you have ${process.versions.node}). Please upgrade.\n`
    );
    process.exit(1);
  }
}

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findInstalledExecutable,
  INSTALLED_RUNTIME_DEFINITIONS,
} from "../src/core/ai/installed-runtimes.mjs";
import { displayPath, resolveUserPaths, userPath } from "../src/core/paths/workspace.mjs";
import {
  classifyLocalAppRuntime,
  commandMatchesTrackerScript,
  findAvailableLoopbackPort,
  parseRecordedPid,
  readLocalAppHealth,
  trackerCommandPort,
} from "../src/core/update/local-app-runtime.mjs";
import {
  extractOver,
  fetchTarball,
  findUserDataLeaks,
  isNewer,
  latestVersion,
  readUpdateNotice,
  refreshUpdateCacheInBackground,
} from "../src/core/update/update-core.mjs";
import { readVersion } from "../src/core/version.mjs";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const pathCtx = { repoRoot: root };
const [command, ...rest] = process.argv.slice(2);

const CLIS = {
  doctor: "src/cli/doctor.mjs",
  next: "src/cli/next.mjs",
  ingest: "src/cli/ingest.mjs",
  searches: "src/cli/searches.mjs",
  companies: "src/cli/companies.mjs",
  evaluate: "src/cli/evaluate.mjs",
  questions: "src/cli/questions.mjs",
  tracker: "src/cli/tracker.mjs",
  "tracker-dev": "src/cli/tracker-dev.mjs",
  data: "src/cli/data.mjs",
  modes: "src/cli/modes.mjs",
  automation: "src/cli/automation.mjs",
  activity: "src/cli/activity.mjs",
  research: "src/cli/research.mjs",
  health: "src/cli/health.mjs",
  stories: "src/cli/stories.mjs",
  "strategy-review": "src/cli/strategy-review.mjs",
  analytics: "src/cli/analytics.mjs",
  evidence: "src/cli/evidence.mjs",
  gate: "src/cli/gate.mjs",
  learnings: "src/cli/learnings.mjs",
  "status-map": "src/cli/status-map.mjs",
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

// Agent CLIs we know how to launch, in preference order. Each is started with
// the starter prompt as a single positional argument (the seed-a-session form
// both Claude Code and Codex accept). Declared above the command dispatch so
// runStart can read them on its synchronous (no-await) --no-dashboard path.
const AGENT_CANDIDATES = INSTALLED_RUNTIME_DEFINITIONS.map(({ name, binaries }) => ({
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

if (command === "update") {
  process.exit(runUpdate(rest));
}

// Background-cached "update available" notice for normal commands (never blocks).
notifyUpdateAvailable();

if (command === "init") {
  process.exit(runInit(rest));
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
  process.exit(run(join(root, cli), rest));
}

// ---------------------------------------------------------------------------

function runInit(extra) {
  for (const dir of WORKSPACE_DIRS) {
    const abs = userPath(pathCtx, dir);
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  }
  // ingest (default mode) copies candidate templates and prints status + next steps.
  const code = run(join(root, CLIS.ingest), extra);
  if (code === 0) {
    console.log("");
    console.log("Workspace ready. Open your agent in this folder and say:");
    console.log(`    ${STARTER_PROMPT}`);
    console.log("Use `careerrat next` anytime to print the current next agent task.");
  }
  return code;
}

// Parse `start` args. The first bare word is the agent to launch
// (`careerrat start claude`); `--agent <name>` is an equivalent alias. Both
// accept an explicitly named compatible command on PATH, in addition to the
// automatically detected Claude and Codex launchers.
function parseStartArgs(extra) {
  const out = { agent: null, port: null, noAgent: false, noDashboard: false };
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    if (a === "--no-agent") out.noAgent = true;
    else if (a === "--no-dashboard") out.noDashboard = true;
    else if (a === "--agent") out.agent = extra[++i] || out.agent;
    else if (a === "--port") out.port = extra[++i] || out.port;
    else if (a.startsWith("-")) {
      /* unknown flag — ignore */
    } else if (!out.agent) out.agent = a; // first bare positional = agent name
  }
  return out;
}

// `careerrat start [agent]` — the one-command front door:
//   scaffold workspace → install skills → boot the local app (:7777) →
//   hand off to the named agent (or first found on PATH) with the starter prompt.
// Usage: careerrat start [claude|codex|<compatible-command>]
//        [--agent <name>] [--no-agent] [--no-dashboard] [--port <n>]
async function runStart(extra) {
  const opts = parseStartArgs(extra);
  const wantDashboard = !opts.noDashboard;
  const wantAgent = !opts.noAgent;
  const forcedAgent = opts.agent;

  // 1) Scaffold workspace dirs (idempotent).
  for (const dir of WORKSPACE_DIRS) {
    const abs = userPath(pathCtx, dir);
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  }

  // 2) Install skills so Claude Code sees /apply-job etc. Non-fatal: agents that
  //    read AGENTS.md natively (Codex) work without the shim.
  console.log("• Installing skills…");
  const skillCode = run(join(root, "scripts/install-skills.mjs"), ["--soft"]);
  if (skillCode !== 0) {
    console.log("  (skill shim reported an issue, AGENTS.md-native agents still work)");
  }

  // 3) Seed a tracker so the local app can boot. Never clobber real data.
  const trackerJson = userPath(pathCtx, "workspace/tracker.json");
  if (!existsSync(trackerJson)) {
    try {
      mkdirSync(userPath(pathCtx, "workspace"), { recursive: true });
      copyFileSync(join(root, "templates/tracker.json"), trackerJson);
      console.log(
        `• Seeded ${displayPath(pathCtx, "workspace/tracker.json")} (demo data, replaced as you add real roles)`
      );
    } catch {
      /* non-fatal: the local app simply won't boot until a tracker exists */
    }
  }

  // 4) Boot the live local app as a durable service.
  let dash = null;
  if (wantDashboard && existsSync(trackerJson)) {
    dash = await startDashboard(opts.port);
  }

  // 5) Hand off to the agent.
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
      printManualAgentHandoff(dash);
    }
  } else {
    console.log("");
    printManualAgentHandoff(dash);
  }
  return exitCode;
}

function printManualAgentHandoff(dash) {
  console.log("Open your agent in this folder and say:");
  console.log("");
  console.log(`    ${STARTER_PROMPT}`);
  console.log("");
  console.log("For a terse CLI handoff, run `careerrat next`.");
  if (dash) {
    console.log(
      `The local app is running separately; stop it with the PID in ${displayPath(pathCtx, ".internal/tracker-dev.pid")}.`
    );
  }
}

// Spawn the tracker dev server as a detached local process. The PID/log live in
// .internal/ so a future agent can tell whether CareerRat already has a server.
async function startDashboard(port) {
  const portCandidate = port ?? process.env.CAREERRAT_DEV_PORT ?? 7777;
  const parsedPort = Number(portCandidate);
  let resolvedPort = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 7777;
  let url = `http://localhost:${resolvedPort}`;
  const installedVersion = readVersion();
  const trackerScript = join(root, "src/cli/tracker-dev.mjs");
  const internalDir = resolveUserPaths(pathCtx).internalDir;
  mkdirSync(internalDir, { recursive: true });
  const pidPath = join(internalDir, "tracker-dev.pid");
  const logPath = join(internalDir, "tracker-dev.log");
  const recordedPid = readRecordedDashboardPid(pidPath);
  const recordedCommand = recordedTrackerProcessCommand(recordedPid);
  const recordedProcessIsTracker =
    commandMatchesTrackerScript(recordedCommand, trackerScript) &&
    trackerCommandPort(recordedCommand) === resolvedPort;
  const health = await readLocalAppHealth(url);
  const runtime = classifyLocalAppRuntime({
    health,
    installedVersion,
    recordedPid,
    recordedProcessIsTracker,
  });

  if (runtime.state === "current") {
    console.log(`• Local app already live → ${url}`);
    return { url, existing: true };
  }

  if (runtime.state === "stale-owned") {
    console.log(
      `• Replacing stale local app v${runtime.runningVersion || "unknown"} with v${installedVersion}…`
    );
    try {
      process.kill(runtime.pid, "SIGTERM");
    } catch {
      console.log("• Stale local app could not be stopped safely; continuing without replacing it");
      return null;
    }
    if (!(await waitForUrlToStop(url, 5000))) {
      console.log("• Stale local app did not stop cleanly; continuing without replacing it");
      return null;
    }
  } else if (runtime.state === "foreign" || runtime.state === "stale-unowned") {
    const fallbackPort = await findAvailableLoopbackPort({ startPort: resolvedPort + 1 });
    if (!fallbackPort) {
      console.log("• Local app could not find a safe loopback port; continuing without it");
      return null;
    }
    if (runtime.state === "foreign") {
      console.log(
        `• Port ${resolvedPort} belongs to another process; leaving it untouched and using ${fallbackPort}`
      );
    } else {
      console.log(
        `• Stale unowned CareerRat v${runtime.runningVersion || "unknown"} is using port ${resolvedPort}; leaving it untouched and using ${fallbackPort}`
      );
    }
    resolvedPort = fallbackPort;
    url = `http://localhost:${resolvedPort}`;
  }

  const args = [trackerScript];
  if (resolvedPort !== 7777 || port != null) args.push("--port", String(resolvedPort));

  let logFd;
  try {
    logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    logFd = null;
    child.unref();
    writeFileSync(pidPath, `${child.pid}\n`);

    const ready = await waitForUrl(url, installedVersion, 8000);
    const relLog = displayPath(pathCtx, ".internal/tracker-dev.log");
    if (ready) {
      console.log(`• Local app live → ${url} (pid ${child.pid}, log ${relLog})`);
    } else {
      console.log(`• Local app starting → ${url} (pid ${child.pid}, log ${relLog})`);
    }
    return { url, pid: child.pid, logPath };
  } catch {
    if (logFd != null) {
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
    console.log("• Local app could not start; continuing without it");
    return null;
  }
}

function readRecordedDashboardPid(pidPath) {
  try {
    return parseRecordedPid(readFileSync(pidPath, "utf8"));
  } catch {
    return null;
  }
}

function recordedTrackerProcessCommand(pid) {
  if (!pid) return "";
  try {
    process.kill(pid, 0);
  } catch {
    return "";
  }
  const inspected =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
          ],
          { encoding: "utf8" }
        )
      : spawnSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
        });
  return inspected.status === 0 ? inspected.stdout : "";
}

async function waitForUrl(url, installedVersion, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await readLocalAppHealth(url);
    if (health.careerrat && health.version === installedVersion) return true;
    await delay(150);
  }
  return false;
}

async function waitForUrlToStop(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await readLocalAppHealth(url);
    if (!health.responding) return true;
    await delay(100);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const bin = findOnPath(name) || (known && findOnPath(known.bin));
  if (!bin) return null;
  return { name: known?.name || name, bin };
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
  const out = { tag: "latest", check: false, force: false };
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    if (a === "--check") out.check = true;
    else if (a === "--force") out.force = true;
    else if (a === "--rc") out.tag = "rc";
    else if (a === "--tag") out.tag = extra[++i] || out.tag;
    else if (a.startsWith("-")) {
      /* ignore unknown flag */
    }
  }
  return out;
}

// `careerrat update` — refresh THIS install's code from the published npm package.
// Code only: candidate/ and workspace/ are never in the package, so a user's real
// data is preserved; a privacy guard refuses any tarball that carries user data.
function runUpdate(extra) {
  const opts = parseUpdateArgs(extra);
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

  const runningDashboard = activeRecordedDashboard();

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

  // Re-shim skills + health-check using the freshly extracted code.
  run(join(root, "scripts/install-skills.mjs"), ["--soft"]);
  console.log(`• Updated ${current} → ${readVersion()}. Running doctor…`);
  run(join(root, CLIS.doctor), []);
  if (runningDashboard && restartDashboardAfterUpdate(runningDashboard) !== 0) {
    console.error("CareerRat updated, but the running local app could not be refreshed.");
    return 1;
  }
  return 0;
}

function activeRecordedDashboard() {
  const internalDir = resolveUserPaths(pathCtx).internalDir;
  const pid = readRecordedDashboardPid(join(internalDir, "tracker-dev.pid"));
  const trackerScript = join(root, "src/cli/tracker-dev.mjs");
  const command = recordedTrackerProcessCommand(pid);
  if (!commandMatchesTrackerScript(command, trackerScript)) return null;
  const port = trackerCommandPort(command, {
    defaultPort: Number(process.env.CAREERRAT_DEV_PORT || 7777),
  });
  if (port == null) return null;
  return {
    pid,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 7777,
  };
}

function restartDashboardAfterUpdate({ port }) {
  console.log("• Refreshing the running local app with the updated code…");
  const result = spawnSync(
    process.execPath,
    [join(root, "bin/careerrat.mjs"), "start", "--no-agent", "--port", String(port)],
    { cwd: root, stdio: "inherit", env: process.env }
  );
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status == null ? 1 : result.status;
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
  start [ai]  Scaffold + install skills + local app + launch your agent
  init        Scaffold candidate/ + workspace dirs, print next steps
  install-skills  Create/repair the .claude/skills -> .agents/skills shim (--check to verify only)
  doctor      Environment health check
  next        Show the next agent task from doctor guidance
  ingest      Guided candidate setup (profile, targeting, evidence, ...)
  searches    Build and curate the search-source config
  companies   Manage tracked employer ATS boards
  evaluate    Run the body-read gate on a saved job (GATE/FIT/COMP/ACTION)
  questions   Fetch a job's real application-form questions, no browser (Greenhouse/Ashby, or --paste)
  tracker     One-shot tracker snapshot / summary / follow-ups (for the live hot-reloading dev server, use 'careerrat start')
  tracker-dev  Serve the live local app without launching an agent
  data        sqlite-backed data layer: status/init/import/export/verify + per-domain verbs (M6)
  restore     Recover workspace/tracker.json from a rolling snapshot (list / restore by index or name)
  modes       Show/change optional usage and application modes
  automation  Show/toggle opt-in browser-automation config (defaults OFF)
  research    Read/record web-research artifacts
  health      Record the company-health skill's role-scoped companyHealth rating
  gate        Safely update gate data such as comp floors and exclusions
  learnings   Read/append per-role-family learnings
  stories     Read/validate/add STAR+R interview stories
  activity    Read/append/prune the local app Activity Pulse feed
  evidence    Read/validate/add evidence claims
  analytics   Refresh + inspect the persisted outcome-analytics block (--write)
  strategy-review  Stamp the "last reviewed" marker after a strategy review
  status-map  Normalize a raw ATS status label to the canonical tracker status
  export      Render a tailored artifact / packet to PDF or DOCX
  update      Update this install to the latest published version (--check, --rc, --force)
  version     Print the installed CareerRat version (also --version, -v)
  help        Show this list

start [ai]:
  the first bare word picks the agent to launch. Claude and Codex are detected
  automatically; an explicitly named compatible command is also accepted.
  --agent <name>      same as the positional, alternate spelling
  --no-agent          scaffold + local app only, don't launch an agent
  --no-dashboard      skip the local app
  --port <n>          local app port (default 7777)

Run any command with --help for its own options.`);
}
