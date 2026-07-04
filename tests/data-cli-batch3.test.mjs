import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-data-cli-batch3-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function dataCli(repoRoot, args) {
  const out = execFileSync(
    process.execPath,
    ["src/cli/data.mjs", "--root", repoRoot, "--json", ...args],
    {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    }
  );
  return JSON.parse(out);
}

function readTracker(repoRoot) {
  return JSON.parse(readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8"));
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolester data calendar write records calendarWrites[] through the CLI", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["init"]);

  const result = dataCli(repoRoot, [
    "calendar",
    "write",
    "--data",
    JSON.stringify({
      provider: "google_calendar",
      eventId: "evt-1",
      title: "Interview hold",
      eventIso: "2030-01-02T14:00:00.000Z",
    }),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.key, "calendarWrites");
  const tracker = readTracker(repoRoot);
  assert.equal(tracker.calendarWrites.length, 1);
  assert.equal(tracker.calendarWrites[0].provider, "google_calendar");
});

test("rolester data source watermark updates sources[] and lastSweepAt without bumping version", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["init"]);

  const result = dataCli(repoRoot, [
    "source",
    "watermark",
    "--at",
    "2030-01-02T00:00:00.000Z",
    "--data",
    JSON.stringify({
      id: "gmail-webmail",
      kind: "webmail",
      name: "Gmail webmail",
      lastRunAt: "2030-01-02T00:00:00.000Z",
    }),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.meta.version, 0);
  const tracker = readTracker(repoRoot);
  assert.equal(tracker.meta.version, 0);
  assert.equal(tracker.meta.lastSweepAt, "2030-01-02T00:00:00.000Z");
  assert.equal(tracker.sources[0].id, "gmail-webmail");
});

test("rolester data relationship leads upsert and lead set-status update relationshipLeads[] and linked app CTA", () => {
  const repoRoot = tempRepo();
  dataCli(repoRoot, ["init"]);
  dataCli(repoRoot, [
    "app",
    "upsert",
    "--data",
    JSON.stringify({
      id: "app-1",
      company: "Initech",
      role: "Analyst",
      status: "awaiting",
      nextAction: "Find recruiter contact",
      nextActionDue: "2030-01-01",
    }),
  ]);

  const upsert = dataCli(repoRoot, [
    "relationship",
    "leads",
    "upsert",
    "--data",
    JSON.stringify([
      {
        applicationId: "app-1",
        company: "Initech",
        role: "Analyst",
        name: "Jordan Lee",
        type: "Recruiter",
        platform: "linkedin",
      },
    ]),
  ]);
  assert.equal(upsert.ok, true);

  let tracker = readTracker(repoRoot);
  assert.equal(tracker.relationshipLeads[0].status, "review");
  assert.equal(tracker.applications[0].nextActionDue, null);

  const approved = dataCli(repoRoot, [
    "relationship",
    "lead",
    "set-status",
    "lead-initech-jordan-lee-linkedin",
    "approved",
    "--at",
    "2030-01-03T00:00:00.000Z",
    "--follow-up-due",
    "2030-01-06",
  ]);
  assert.equal(approved.ok, true);

  tracker = readTracker(repoRoot);
  assert.equal(tracker.relationshipLeads[0].status, "approved");
  assert.equal(tracker.applications[0].nextAction, "Send outreach to Jordan Lee via email-comms");
  assert.equal(tracker.applications[0].nextActionDue, "2030-01-06");
});
