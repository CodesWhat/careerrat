// scripts/eval/lib/installed-cli-call.mjs — one-shot "spawn the installed
// `claude` CLI with a prompt + schema, get the structured JSON back" helper,
// factored out of scripts/eval/phase2-ai-lane.mjs's own runInstalledClaude/
// parseClaudeEnvelope so scripts/eval/skill-shape-qa.mjs's four lanes share
// ONE spawn/parse implementation instead of four copies. phase2-ai-lane.mjs
// itself is left untouched — it keeps its own inline copy rather than being
// re-pointed at this file, to avoid risking its already-proven behavior for
// an unrelated harness.
//
// Mirrors buildInstalledRuntimeInvocation's own contract: shell:false, fixed
// argv, stdin-fed prompt, `--json-schema` for structured output. Never
// fabricates a reply — a spawn failure, non-zero exit, or a missing/invalid
// structured_output all reject with a clear Error.

import { spawn } from "node:child_process";

function parseClaudeEnvelope(stdout) {
  const envelope = JSON.parse(stdout);
  if (envelope?.is_error === true || envelope?.subtype === "error") {
    throw new Error(`Claude CLI reported an error: ${envelope?.result || "unknown"}`);
  }
  return envelope;
}

function runInstalledClaude({ command, args, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Installed CLI call timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        reject(new Error(`Installed CLI exited with status ${status}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(parseClaudeEnvelope(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

// callInstalledClaudeForJson({ runtime, prompt, schema, timeoutMs }) —
// invokes the resolved "claude" runtime once via
// buildInstalledRuntimeInvocation(schema, tools:[]) and returns
// { structured, costUsd, durationApiMs, usage }. Throws when the envelope
// carries no structured_output (a bad/empty reply is a failure, never a
// silently-accepted null shape).
export async function callInstalledClaudeForJson({
  buildInvocation,
  runtime,
  prompt,
  schema,
  timeoutMs,
}) {
  const invocation = buildInvocation({
    runtimeId: "claude",
    executablePath: runtime.path,
    schema,
    tools: [],
  });
  const envelope = await runInstalledClaude({
    command: invocation.command,
    args: invocation.args,
    prompt,
    timeoutMs,
  });
  const structured = envelope.structured_output;
  if (!structured || typeof structured !== "object") {
    throw new Error(`No structured_output in envelope: ${JSON.stringify(envelope).slice(0, 300)}`);
  }
  return {
    structured,
    costUsd: envelope.total_cost_usd ?? null,
    durationApiMs: envelope.duration_api_ms ?? null,
    usage: envelope.usage || null,
  };
}
