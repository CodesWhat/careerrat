// demo-seed.mjs — `careerrat data init --demo`'s implementation. Imports
// examples/demo-workspace/ through the SAME importFromTracker code path as a
// real migration (no bespoke seeder — decision: "SAME code path"), then
// exports it straight back out so workspace/tracker.json exists immediately
// (the dashboard can render without a separate first write).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportToTracker } from "./export-to-tracker.mjs";
import { importFromTracker } from "./import-from-tracker.mjs";

const DEMO_WORKSPACE_DIR = join(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "examples/demo-workspace"
);

export function seedDemo({ repoRoot, env, today } = {}) {
  // Rebase the fixture's evergreen dates to real-today on every seed so the live dev
  // dashboard always reads as current, without mutating the committed (anchored)
  // fixture. `today` is overridable for deterministic tests.
  const rebaseToday = today || new Date().toISOString().slice(0, 10);
  const importResult = importFromTracker({
    repoRoot,
    env,
    sourceDir: DEMO_WORKSPACE_DIR,
    rebaseToday,
  });
  const exportResult = exportToTracker({ repoRoot, env });
  return { ok: true, import: importResult, export: exportResult };
}
