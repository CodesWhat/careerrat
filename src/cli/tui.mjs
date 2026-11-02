#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJobs, viewJobs } from "../core/tui/jobs.mjs";
import { ensureTextualPython } from "../core/tui/python-runtime.mjs";
import { runTextualWorkspace } from "../core/tui/textual-runtime.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === "setup") {
    const python = await ensureTextualPython({ repoRoot, env, progress: console.error });
    console.log(`Textual ready: ${python}`);
    return 0;
  }
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
        "Usage: careerrat tui [--agent claude|codex] [--no-agent] [--json]\n       careerrat tui setup\n\nTextual workspace with saved jobs and native agent chat. Click jobs and actions; F6 switches focus; Ctrl+Q exits.\nFirst launch installs locked dependencies in a private environment. Python 3.11+ with venv is required.\nThe browser start entry remains available during TUI acceptance."
      );
      return 0;
    } else throw new Error(`Unknown TUI option: ${arg}`);
  }
  if (json) {
    console.log(JSON.stringify(viewJobs(readJobs({ repoRoot, env }))));
    return 0;
  }
  return runTextualWorkspace({
    repoRoot,
    env,
    args: noAgent ? ["--no-agent"] : agentName ? ["--agent", agentName] : [],
  });
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
