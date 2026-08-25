import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDb, requireDb } from "../src/core/db/connection.mjs";
import { assembleTrackerObject } from "../src/core/db/export-to-tracker.mjs";
import { appApplySyncedStatus, appUpsert } from "../src/core/db/verbs/app.mjs";
import { commUpsert } from "../src/core/db/verbs/comm.mjs";

test("appApplySyncedStatus atomically updates the app and clears only matching portal CTAs", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-status-sync-"));
  try {
    openDb({ repoRoot, env: {} });
    appUpsert({
      repoRoot,
      env: {},
      row: {
        id: "app-acme",
        company: "Acme",
        role: "Engineer",
        status: "applied",
        nextAction: "Check application portal status",
        nextActionDue: "2026-08-25",
      },
    });
    commUpsert({
      repoRoot,
      env: {},
      row: {
        id: "comm-portal",
        applicationId: "app-acme",
        company: "Acme",
        role: "Engineer",
        channel: "portal",
        status: "needs-reply",
        nextAction: "Check portal status",
        nextActionDue: "2026-08-25",
        draft: { body: "stale" },
        messages: [],
      },
    });
    commUpsert({
      repoRoot,
      env: {},
      row: {
        id: "comm-portal-form",
        applicationId: "app-acme",
        company: "Acme",
        role: "Engineer",
        channel: "portal",
        status: "needs-reply",
        nextAction: "Upload the requested work sample",
        nextActionDue: "2026-08-26",
        draft: { body: "keep this portal task" },
        messages: [],
      },
    });
    commUpsert({
      repoRoot,
      env: {},
      row: {
        id: "comm-recruiter",
        applicationId: "app-acme",
        company: "Acme",
        role: "Engineer",
        channel: "email",
        status: "needs-reply",
        nextAction: "Reply to recruiter",
        draft: { body: "keep me" },
        messages: [],
      },
    });

    const result = appApplySyncedStatus({
      repoRoot,
      env: {},
      id: "app-acme",
      to: "interview",
      rawStatus: "Interview requested",
      round: "recruiter screen",
      at: "2026-08-24T16:00:00.000Z",
    });
    assert.deepEqual(result.clearedCommunicationIds, ["comm-portal"]);

    const tracker = assembleTrackerObject(requireDb({ repoRoot, env: {} }));
    const app = tracker.applications.find((row) => row.id === "app-acme");
    assert.equal(app.status, "interview");
    assert.equal(app.nextAction, null);
    assert.equal(app.nextActionDue, null);
    assert.equal(app.conversations.at(-1).kind, "recruiter screen");

    const portal = tracker.communications.find((row) => row.id === "comm-portal");
    assert.equal(portal.status, "waiting");
    assert.equal(portal.nextAction, null);
    assert.equal(portal.nextActionDue, null);
    assert.equal(portal.draft, null);
    assert.match(portal.messages.at(-1).summary, /Interview requested/);

    const recruiter = tracker.communications.find((row) => row.id === "comm-recruiter");
    assert.equal(recruiter.nextAction, "Reply to recruiter");
    assert.deepEqual(recruiter.draft, { body: "keep me" });

    const portalForm = tracker.communications.find((row) => row.id === "comm-portal-form");
    assert.equal(portalForm.nextAction, "Upload the requested work sample");
    assert.equal(portalForm.nextActionDue, "2026-08-26");
    assert.deepEqual(portalForm.draft, { body: "keep this portal task" });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
