import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findInstalledExecutable } from "../ai/installed-runtimes.mjs";
import { claudeLaunchArgs } from "./claude-launch.mjs";
import { firstRunPrompt } from "./first-run.mjs";
import { createTextualSession } from "./textual-session.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export async function serveTextualSession({
  agent = null,
  agentIssue = null,
  env = process.env,
} = {}) {
  const session = await createTextualSession({
    repoRoot,
    env,
    agent,
    agentIssue,
    emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    input.close();
    process.stdin.destroy();
    await session.close();
  }
  const signal = () => {
    stop().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", signal);
  process.on("SIGHUP", signal);
  process.on("SIGINT", signal);
  try {
    for await (const line of input) {
      if (stopping) break;
      try {
        const message = JSON.parse(line);
        if (message.op === "quit") break;
        await session.dispatch(message);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ type: "error", message: error.message })}\n`);
      }
    }
  } finally {
    await stop();
    process.off("SIGTERM", signal);
    process.off("SIGHUP", signal);
    process.off("SIGINT", signal);
  }
}

// Without --soft, so a failed install is visible here instead of exiting 0.
export function skillsInstallIssue(root = repoRoot) {
  const result = spawnSync(process.execPath, [join(root, "scripts/install-skills.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // Not JSON: treated as a failure below.
  }
  if (result.status === 0 && report?.ok !== false) return null;
  const detail = report?.missing?.length
    ? ` Missing: ${report.missing.join(", ")}.`
    : report?.error
      ? ` ${report.error}`
      : "";
  return `The agent started, but CareerRat skills could not be installed.${detail} Run careerrat install-skills for details.`;
}

async function main(args) {
  let names = ["claude", "codex"];
  if (args.length === 1 && args[0] === "--no-agent") names = [];
  else if (args.length === 2 && args[0] === "--agent" && names.includes(args[1])) names = [args[1]];
  else if (args.length) throw new Error("Use --agent claude|codex or --no-agent");
  let agent = null;
  let agentIssue = null;
  for (const name of names) {
    const command = findInstalledExecutable([name]);
    if (command) {
      agent = { command, args: name === "codex" ? ["--no-daemon"] : claudeLaunchArgs(repoRoot) };
      const opening = firstRunPrompt({ repoRoot });
      if (opening) agent.args.push(opening);
      break;
    }
  }
  if (!agent && names.length)
    agentIssue =
      names.length === 1
        ? `Couldn't find ${names[0]} on your PATH, so no agent started. Saved jobs still work.`
        : "Couldn't find claude or codex on your PATH, so no agent started. Saved jobs still work.";
  if (agent) agentIssue = skillsInstallIssue();
  await serveTextualSession({ agent, agentIssue });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
