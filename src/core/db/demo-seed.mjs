// demo-seed.mjs — `careerrat data init --demo`'s implementation. Imports
// examples/demo-workspace/ through the SAME importFromTracker code path as a
// real migration (no bespoke seeder — decision: "SAME code path"), then
// exports it straight back out so workspace/tracker.json exists immediately
// (the dashboard can render without a separate first write). The fixture's
// artifact tree is copied into the active workspace too. Any fictional demo
// row without a full fixture body gets an explicit partial capture, so the
// product never advertises a JD that its own preview route cannot read.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUserPaths, userPath } from "../paths/workspace.mjs";
import { atomicWriteFile } from "../profile/gate-writer.mjs";
import { stringifyYaml } from "../profile/yaml.mjs";
import { exportToTracker } from "./export-to-tracker.mjs";
import { importFromTracker } from "./import-from-tracker.mjs";

const DEMO_WORKSPACE_DIR = join(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "examples/demo-workspace"
);

function sourceLabel(row) {
  if (typeof row.source === "string") return row.source;
  return row.source?.name || row.source?.type || "fictional demo fixture";
}

function partialJobCapture(row) {
  const capturedAt = row.sourcedAt || row.appliedAt || row.updatedAt || "2026-06-25T17:30:00.000Z";
  const frontmatter = {
    company: row.company || "Unknown company",
    role: row.role || "Open role",
    source: row.link || row.url || "",
    sourceName: sourceLabel(row),
    capturedAt,
    partial: true,
  };
  const details = [
    row.loc || row.location ? `- Location: ${row.loc || row.location}` : "",
    row.base ? `- Base: ${row.base}` : "",
    row.tc ? `- Total compensation: ${row.tc}` : "",
    row.mode ? `- Work mode: ${row.mode}` : "",
  ].filter(Boolean);
  return [
    "---",
    stringifyYaml(frontmatter),
    "---",
    "",
    `# ${row.role || "Open role"} - ${row.company || "Unknown company"}`,
    "",
    "## Capture status",
    "",
    "This fictional demo record preserves a partial source snapshot. CareerRat labels it partial instead of pretending a complete posting was captured.",
    "",
    "## Captured details",
    "",
    ...(details.length ? details : ["- No structured posting details were available."]),
    "",
    "## Job description fragment",
    "",
    row.artifacts?.jdSummary || row.note || "No additional posting text was available.",
    "",
  ].join("\n");
}

function seedDemoArtifacts({ repoRoot, env }) {
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const fixtureWorkspace = join(DEMO_WORKSPACE_DIR, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  cpSync(fixtureWorkspace, workspaceDir, { recursive: true, force: true });

  const tracker = JSON.parse(
    readFileSync(userPath({ repoRoot, env }, "workspace/tracker.json"), "utf8")
  );
  let partialCreated = 0;
  for (const row of [...(tracker.applications || []), ...(tracker.sourced || [])]) {
    const relPath = String(row.artifacts?.jd || "");
    if (!/^workspace\/jobs\/.+\.md$/i.test(relPath)) continue;
    const fullPath = userPath({ repoRoot, env }, relPath);
    if (existsSync(fullPath)) continue;
    mkdirSync(dirname(fullPath), { recursive: true });
    atomicWriteFile(fullPath, partialJobCapture(row));
    partialCreated += 1;
  }
  return { partialCreated };
}

export function seedDemo({ repoRoot, env, today } = {}) {
  const { candidateDir } = resolveUserPaths({ repoRoot, env });
  mkdirSync(candidateDir, { recursive: true });
  cpSync(join(DEMO_WORKSPACE_DIR, "candidate"), candidateDir, {
    recursive: true,
    force: true,
  });
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
  const artifacts = seedDemoArtifacts({ repoRoot, env });
  return { ok: true, import: importResult, export: exportResult, artifacts };
}
