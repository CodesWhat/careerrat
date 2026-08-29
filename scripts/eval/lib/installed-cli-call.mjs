// scripts/eval/lib/installed-cli-call.mjs — one-shot structured-output helper
// for the supported installed runtimes. It delegates process boundaries,
// schema projection, invocation, and provider output parsing to the same
// runInstalledRuntime() adapter production uses.
//
// Never fabricates a reply. A runtime failure or invalid structured result is
// a failed QA lane.

import { runInstalledRuntime } from "../../../src/core/ai/installed-runtimes.mjs";

export async function callInstalledRuntimeForJson({
  runRuntime = runInstalledRuntime,
  runtime,
  prompt,
  schema,
  timeoutMs,
}) {
  const result = await runRuntime({
    runtime,
    prompt,
    outputSchema: schema,
    tools: [],
    timeoutMs,
  });
  let structured;
  try {
    structured = JSON.parse(String(result?.text || ""));
  } catch {
    throw new Error(
      `Installed runtime returned invalid structured output: ${String(result?.text || "").slice(0, 300)}`
    );
  }
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error(
      `Installed runtime returned no structured object: ${String(result?.text || "").slice(0, 300)}`
    );
  }
  return {
    structured,
    costUsd: null,
    durationApiMs: null,
    usage: result.usage || null,
  };
}
