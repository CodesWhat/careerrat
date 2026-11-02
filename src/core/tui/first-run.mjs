import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Handed to the agent as its opening message when setup is not finished, so a
// first launch lands in onboarding instead of an empty chat.
export const FIRST_RUN_PROMPT =
  "Read AGENTS.md, run careerrat doctor, then run the ingest-profile skill to set me up. Ask me one thing at a time.";

// The agent's opening message when candidate setup still needs doing, else null.
// Asks doctor so this follows the same routing as `careerrat next`. Any failure
// means "no seeded message": the agent still starts and AGENTS.md routes it.
export function firstRunPrompt({
  repoRoot,
  env = process.env,
  run = spawnSync,
  execPath = process.execPath,
} = {}) {
  try {
    const result = run(execPath, [join(repoRoot, "bin/careerrat.mjs"), "doctor", "--json"], {
      cwd: repoRoot,
      env: { ...env, CAREERRAT_NO_UPDATE_CHECK: "1" },
      encoding: "utf8",
      timeout: 30000,
    });
    const report = JSON.parse(result.stdout);
    return report?.agentGuidance?.nextSkill === "ingest-profile" ? FIRST_RUN_PROMPT : null;
  } catch {
    return null;
  }
}
