// The optimize-linkedin skill's documented batch commands, run through the real
// data CLI. `--status` used to pass any string straight to the query ("null"
// matched no row, so the batch looked missing), and the skill had no verb to
// record a live approval before mark-applied.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const roots = [];
const env = { ...process.env };
delete env.CAREERRAT_HOME;
delete env.CAREERRAT_PERSON;
env.CAREERRAT_NO_UPDATE_CHECK = "1";

function cli(root, args, { ok = true } = {}) {
  const result = spawnSync(
    process.execPath,
    ["src/cli/data.mjs", "--root", root, "--json", ...args],
    { cwd: join(import.meta.dirname, ".."), env, encoding: "utf8" }
  );
  assert.equal(result.status, ok ? 0 : 1, result.stdout + result.stderr);
  return ok ? JSON.parse(result.stdout) : result;
}

after(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
});

function recorded() {
  const root = mkdtempSync(join(tmpdir(), "careerrat-li-cli-"));
  roots.push(root);
  cli(root, ["init"]);
  const batch = {
    surfaces: [
      {
        surfaceId: "headline",
        surface: "Headline",
        current: "Engineer",
        proposed: "Applied Engineer",
        rationale: "Matches the target role.",
        evidenceRef: "evidence/example.md",
      },
    ],
  };
  const out = cli(root, [
    "linkedin-proposals",
    "record",
    "--data",
    JSON.stringify(batch),
    "--write",
  ]);
  return { root, id: out.id ?? out.batch?.id ?? out.result?.id };
}

test("--status any and --status null return the newest batch of any status", () => {
  const { root } = recorded();
  for (const status of ["any", "null"]) {
    const out = cli(root, ["linkedin-proposals", "latest", "--status", status]);
    assert.ok(out.batch, `--status ${status} must find the recorded batch`);
  }
});

test("--status rejects an unknown value instead of quietly matching nothing", () => {
  const { root } = recorded();
  const result = cli(root, ["linkedin-proposals", "latest", "--status", "nope"], { ok: false });
  assert.match(result.stdout + result.stderr, /--status must be one of/);
});

test("approve then mark-applied works from the terminal with the printed versions", () => {
  const { root } = recorded();
  const latest = cli(root, ["linkedin-proposals", "latest"]).batch;
  const approved = cli(root, [
    "linkedin-proposals",
    "approve",
    "--batch",
    latest.id,
    "--surface",
    "headline",
    "--version",
    String(latest.version),
  ]).batch;
  assert.equal(approved.surfaces[0].decision.action, "approve");
  const applied = cli(root, [
    "linkedin-proposals",
    "mark-applied",
    "--batch",
    latest.id,
    "--surface",
    "headline",
    "--version",
    String(approved.version),
  ]).batch;
  assert.equal(applied.surfaces[0].decision.action, "applied");
});
