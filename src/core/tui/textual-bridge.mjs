import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findInstalledExecutable } from "../ai/installed-runtimes.mjs";
import { createTextualSession } from "./textual-session.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export async function serveTextualSession({ agent = null, env = process.env } = {}) {
  const session = await createTextualSession({
    repoRoot,
    env,
    agent,
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

async function main(args) {
  let names = ["claude", "codex"];
  if (args.length === 1 && args[0] === "--no-agent") names = [];
  else if (args.length === 2 && args[0] === "--agent" && names.includes(args[1])) names = [args[1]];
  else if (args.length) throw new Error("Use --agent claude|codex or --no-agent");
  let agent = null;
  for (const name of names) {
    const command = findInstalledExecutable([name]);
    if (command) {
      agent = { command, args: name === "codex" ? ["--no-daemon"] : [] };
      break;
    }
  }
  if (agent)
    spawnSync(process.execPath, [join(repoRoot, "scripts/install-skills.mjs"), "--soft"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  await serveTextualSession({ agent });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
