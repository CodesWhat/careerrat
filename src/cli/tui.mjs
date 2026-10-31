#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstalledExecutable } from "../core/ai/installed-runtimes.mjs";
import { readJobs, viewJobs } from "../core/tui/jobs.mjs";
import { runTerminalWorkspace } from "../core/tui/runtime.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export async function main(args = process.argv.slice(2), env = process.env) {
  let noAgent = false;
  let agentName;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-agent") noAgent = true;
    else if (arg === "--json") json = true;
    else if (arg === "--agent") {
      agentName = args[++index];
      if (!["claude", "codex"].includes(agentName))
        throw new Error("--agent must be claude or codex");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: careerrat tui [--agent claude|codex] [--no-agent] [--json]\n\nSaved jobs and a native agent pane. F6 switches focus; Ctrl+Q exits.\nThis explicit TUI entry is in development; start still uses the browser until retirement."
      );
      return 0;
    } else throw new Error(`Unknown TUI option: ${arg}`);
  }
  if (json) {
    console.log(JSON.stringify(viewJobs(readJobs({ repoRoot, env }))));
    return 0;
  }
  let agent = null;
  if (!noAgent) {
    for (const name of agentName ? [agentName] : ["claude", "codex"]) {
      const command = findInstalledExecutable([name], {
        env,
        homeDir: env.HOME || env.USERPROFILE,
      });
      if (command) {
        agent = { command, args: name === "codex" ? ["--no-daemon"] : [] };
        break;
      }
    }
    if (agent)
      spawnSync(process.execPath, [join(repoRoot, "scripts/install-skills.mjs"), "--soft"], {
        cwd: repoRoot,
        env,
        stdio: "ignore",
      });
  }
  return runTerminalWorkspace({ repoRoot, env, agent });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}
