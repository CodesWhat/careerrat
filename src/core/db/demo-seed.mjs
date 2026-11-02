// demo-seed.mjs — `careerrat data init --demo`'s implementation. Imports
// examples/demo-workspace/ through the SAME importFromTracker code path as a
// real migration (no bespoke seeder — decision: "SAME code path"), then
// exports it straight back out so workspace/tracker.json exists immediately
// (the dashboard can render without a separate first write). The fixture's
// artifact tree is copied into the active workspace too. Any fictional demo
// row without a full fixture body gets an explicit partial capture, so the
// product never advertises a JD that its own preview route cannot read.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUserPaths, userPath } from "../paths/workspace.mjs";
import { CANDIDATE_DEFAULTS } from "../profile/candidate-defaults.mjs";
import { atomicWriteFile } from "../profile/gate-writer.mjs";
import { stringifyYaml } from "../profile/yaml.mjs";
import { dbExists, openDb } from "./connection.mjs";
import { exportToTracker } from "./export-to-tracker.mjs";
import { hasNonDefaultCandidateRow, importFromTracker } from "./import-from-tracker.mjs";

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

const DATA_TABLES = ["applications", "sourced", "communications", "candidate_evidence_claims"];

// What would the demo seed overwrite? Anything here means this is somebody's
// workspace: candidate YAML on disk, or rows in the tables the seed patches.
// Returns a short list of what it found (empty when the workspace is blank).
function existingWorkspaceData({ repoRoot, env } = {}) {
  const found = [];
  const { candidateDir } = resolveUserPaths({ repoRoot, env });
  if (existsSync(candidateDir)) {
    const files = readdirSync(candidateDir).filter((name) => /\.ya?ml$/i.test(name));
    if (files.length) found.push(`${files.length} candidate file(s)`);
  }
  if (dbExists({ repoRoot, env })) {
    const db = openDb({ repoRoot, env });
    for (const table of DATA_TABLES) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      if (n > 0) found.push(`${n} row(s) in ${table}`);
    }
    // `careerrat init` seeds an empty default profile row; only a changed one is real data.
    if (hasNonDefaultCandidateRow(db, "candidate_profile", CANDIDATE_DEFAULTS.profile)) {
      found.push("1 row(s) in candidate_profile");
    }
  }
  return found;
}

export function seedDemo({ repoRoot, env, today, force = false } = {}) {
  if (!force) {
    const found = existingWorkspaceData({ repoRoot, env });
    if (found.length) {
      const { dataRoot } = resolveUserPaths({ repoRoot, env });
      throw new Error(
        `refusing to seed demo data over an existing workspace at ${dataRoot} (found ${found.join(", ")}). ` +
          "The demo would replace your profile and mix sample jobs into your tracker. " +
          "Point CAREERRAT_HOME at an empty folder to try the demo, or pass --force if you really mean it."
      );
    }
  }
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
    forceCandidate: true,
  });
  const exportResult = exportToTracker({ repoRoot, env });
  const artifacts = seedDemoArtifacts({ repoRoot, env });
  return { ok: true, import: importResult, export: exportResult, artifacts };
}
