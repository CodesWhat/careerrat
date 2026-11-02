import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeAll } from "../core/db/connection.mjs";
import { sourcingRunLatest } from "../core/db/verbs/sourcing-runs.mjs";
import { startManualSearchRun } from "../core/onboarding/first-search-run.mjs";
import {
  cancelTerminalSearch,
  launchTerminalSearchWorker,
  runTerminalSearchWorker,
  terminalSearchStatus,
} from "../core/search/terminal-search-worker.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export async function main(args = process.argv.slice(2), env = process.env) {
  const [command = "status", ...rest] = args;
  let id;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--id" && rest[index + 1]) id = rest[++index];
    else if (rest[index] !== "--json") throw new Error(`Unknown search option: ${rest[index]}`);
  }
  const ctx = { repoRoot, env };
  let result;
  if (command === "--help" || command === "-h") {
    console.log(
      "Usage: careerrat search start|status|cancel [--id <run-id>] [--json]\nStarts a bounded background scan of configured sources. Results use the canonical workspace; completion saves a handoff. AI research remains agent-led."
    );
    return 0;
  }
  if (command === "_worker") {
    if (!process.send || !id)
      throw new Error("Search worker requires its parent IPC channel and run ID");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      const outcome = await runTerminalSearchWorker({
        ...ctx,
        runId: id,
        signal: controller.signal,
        onReady: (run) => process.send?.({ ready: true, run }),
      });
      return outcome.run.status === "completed" ? 0 : 1;
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  }
  if (command === "start") {
    if (id) throw new Error("start creates a new run; --id is for status or cancel");
    const started = await startManualSearchRun(ctx);
    result = started.reused
      ? { ...terminalSearchStatus({ ...ctx, id: started.run.id }), reused: true }
      : await launchTerminalSearchWorker({ ...ctx, runId: started.run.id });
  } else if (command === "status") {
    result = id
      ? terminalSearchStatus({ ...ctx, id })
      : sourcingRunLatest({ ...ctx, purpose: "manual-search" });
    if (result.run && !id) result = terminalSearchStatus({ ...ctx, id: result.run.id });
  } else if (command === "cancel") {
    if (!id) throw new Error("cancel requires --id <run-id>");
    result = cancelTerminalSearch({ ...ctx, id });
  } else throw new Error(`Unknown search command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = process.argv[2] === "_worker";
  main().then(
    (code) => {
      closeAll();
      if (worker) process.exit(code);
      process.exitCode = code;
    },
    (error) => {
      if (worker && process.connected)
        process.send?.({ error: error.message }, () => process.exit(1));
      else {
        console.error(error.message);
        closeAll();
        if (worker) process.exit(1);
        process.exitCode = 1;
      }
    }
  );
}
