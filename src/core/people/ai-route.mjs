import { existsSync, readFileSync } from "node:fs";
import { AI_ENV_RELPATH } from "../ai/ai-env.mjs";
import { currentPerson } from "../paths/people.mjs";
import { userPath } from "../paths/workspace.mjs";

// CR100: which AI access does work in this workspace run on? For someone else's
// workspace the answer matters: their own key is theirs, but a key exported in the
// operator's shell or the operator's signed-in AI CLI is the operator's account doing
// the person's work. This only ever reports the kind, never a key value.

function storedLines(ctx) {
  const path = userPath(ctx, AI_ENV_RELPATH);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

function storedValue(ctx, name) {
  for (const line of storedLines(ctx)) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    const eq = trimmed.indexOf("=");
    if (eq > 0 && !trimmed.startsWith("#") && trimmed.slice(0, eq).trim() === name) {
      return trimmed.slice(eq + 1).trim();
    }
  }
  return "";
}

// runtimeAvailable: true/false when the caller has already detected installed AI CLIs,
// null when it hasn't (detection hashes executables, so cheap callers skip it).
export function describeAiRoute({ repoRoot, env = process.env, runtimeAvailable = null } = {}) {
  const ctx = { repoRoot, env };
  const person = currentPerson(env);
  const who = person || "this workspace";
  const storedKey = storedValue(ctx, "ANTHROPIC_API_KEY");
  const storedProxy = storedValue(ctx, "CAREERRAT_AI_PROXY_URL");
  const envKey = String(env.ANTHROPIC_API_KEY || "").trim();
  const envProxy = String(env.CAREERRAT_AI_PROXY_URL || "").trim();

  let kind;
  let label;
  if ((storedKey && (!envKey || envKey === storedKey)) || (storedProxy && !envKey && !envProxy)) {
    kind = "own-key";
    label = `${who}'s own AI key (stored in the workspace)`;
  } else if (envKey || envProxy) {
    kind = "operator-key";
    label = "an AI key from the operator's shell environment";
  } else if (runtimeAvailable === true) {
    kind = "operator-subscription";
    label = "the operator's installed AI CLI (their subscription)";
  } else if (runtimeAvailable === false) {
    kind = "none";
    label = "none (no key and no signed-in AI CLI)";
  } else {
    kind = "no-own-key";
    label = "whatever AI access the operator has (their shell key or installed AI CLI)";
  }
  return { kind, label, person, borrowed: Boolean(person) && kind !== "own-key" };
}

// The warning to print before background AI work in someone else's workspace, or
// null when there's nothing to warn about. Never blocks.
export function borrowedAiWarning({ repoRoot, env = process.env, runtimeAvailable = null } = {}) {
  const route = describeAiRoute({ repoRoot, env, runtimeAvailable });
  if (!route.borrowed) return null;
  return (
    `Warning: ${route.person} has no AI key of their own. AI steps in their workspace will run on ` +
    `${route.label}, not theirs. Check that's allowed, or give them a key (careerrat --for ${route.person} doctor shows the route).`
  );
}
