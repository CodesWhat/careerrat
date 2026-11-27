import { callAI, resolveAIRoute } from "./call-ai.mjs";
import { buildChildEnv, mapSdkMessage, writeByokUsage } from "./skill-runtime.mjs";

// ---------------------------------------------------------------------------
// The bare one-shot driver — no skill, no tools, maxTurns 1. Buffers every
// `assistant` event's text blocks in order (same convention as
// onboard-route.mjs's resume-ai invoke callback / skill-runtime.mjs's own
// "buffer, don't stream" rationale).
// ---------------------------------------------------------------------------

export async function runBareOneshot({
  prompt,
  repoRoot,
  env,
  labels,
  skillLabel,
  loadSdk,
  call = callAI,
}) {
  const route = resolveAIRoute(env, { repoRoot });
  if (route.type === "none") {
    const err = new Error(route.error);
    err.code = "NO_AI_ROUTE";
    throw err;
  }

  const usageLabels = labels || { skill: skillLabel };
  if (route.type === "installed") {
    const response = await call({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
      skill: usageLabels.skill,
      action: usageLabels.action,
      operation: usageLabels.operation,
      root: repoRoot,
      env,
    });
    return (response?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("");
  }

  const { query } = await loadSdk();
  const childEnv = buildChildEnv({
    route,
    skill: usageLabels.skill,
    action: usageLabels.action,
    operation: usageLabels.operation,
    baseEnv: env,
    repoRoot,
  });
  const controller = new AbortController();

  const q = query({
    prompt,
    options: {
      cwd: repoRoot,
      env: childEnv,
      abortController: controller,
      tools: [],
      maxTurns: 1,
      permissionMode: "default",
    },
  });

  let rawText = "";
  try {
    for await (const msg of q) {
      const events = mapSdkMessage(msg, { env });
      for (const evt of events) {
        if (evt.type === "assistant") {
          for (const block of evt.data?.message?.content ?? []) {
            if (block?.type === "text" && typeof block.text === "string") {
              rawText += block.text;
            }
          }
        }
      }
      if (msg.type === "result") {
        if (route.type === "byok") {
          writeByokUsage({
            msg,
            skill: usageLabels.skill,
            action: usageLabels.action,
            operation: usageLabels.operation,
            repoRoot,
            env,
          });
        }
        break;
      }
    }
  } finally {
    try {
      await q.return?.();
    } catch {
      // best-effort cleanup only
    }
  }

  return rawText;
}
