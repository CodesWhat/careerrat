import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ingestAppleMail } from "../src/core/automation/apple-mail-ingest.mjs";
import { openDb, requireDb } from "../src/core/db/connection.mjs";
import { assembleTrackerObject } from "../src/core/db/export-to-tracker.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

test("ingestAppleMail captures bounded job-search messages and advances the source watermark", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apple-mail-"));
  const captures = [];
  const watermarks = [];
  try {
    const result = await ingestAppleMail({
      repoRoot,
      env: {},
      source: { id: "apple-mail", lastRunAt: "2026-08-23T12:00:00.000Z" },
      applications: [{ id: "app-acme", company: "Acme", role: "Product Engineer" }],
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      readMessagesImpl: async ({ since }) => {
        assert.equal(since, "2026-08-23T12:00:00.000Z");
        return [
          {
            id: "mail-123",
            subject: "Acme Product Engineer interview",
            sender: "Jordan Recruiter <jordan@acme.example>",
            receivedAt: "2026-08-24T09:30:00.000Z",
            body: "We would like to schedule your interview next week.",
          },
        ];
      },
      captureInboundImpl: (input) => {
        captures.push(input);
        return { duplicate: false };
      },
      watermarkImpl: (input) => {
        watermarks.push(input);
      },
    });

    assert.deepEqual(
      {
        scanned: result.scanned,
        captured: result.captured,
        duplicates: result.duplicates,
      },
      { scanned: 1, captured: 1, duplicates: 0 }
    );
    assert.equal(result.blocker, null);
    assert.equal(captures[0].applicationId, "app-acme");
    assert.equal(captures[0].channel, "email");
    assert.equal(captures[0].sourceId, "mail-123");
    assert.match(captures[0].summary, /schedule your interview/i);
    assert.match(
      readFileSync(userPath({ repoRoot, env: {} }, captures[0].artifactPath), "utf8"),
      /Acme Product Engineer interview/
    );
    assert.equal(watermarks[0].source.id, "apple-mail");
    assert.equal(watermarks[0].at, "2026-08-24T12:00:00.000Z");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("ingestAppleMail returns a visible blocker and does not advance state when Mail is unavailable", async () => {
  let captured = false;
  let watermarked = false;
  const result = await ingestAppleMail({
    repoRoot: "/repo",
    env: {},
    source: { id: "apple-mail" },
    readMessagesImpl: async () => {
      const error = new Error("Not authorized to send Apple events to Mail.");
      error.code = "EACCES";
      throw error;
    },
    captureInboundImpl: () => {
      captured = true;
    },
    watermarkImpl: () => {
      watermarked = true;
    },
  });

  assert.equal(result.blocker?.code, "APPLE_MAIL_ACCESS_REQUIRED");
  assert.match(result.blocker?.message, /allow CareerRat to read Apple Mail/i);
  assert.equal(captured, false);
  assert.equal(watermarked, false);
});

test("ingestAppleMail writes the communication and sweep through canonical DB owners", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apple-mail-db-"));
  try {
    openDb({ repoRoot, env: {} });
    appUpsert({
      repoRoot,
      env: {},
      row: {
        id: "app-acme",
        company: "Acme",
        role: "Product Engineer",
        status: "applied",
      },
    });

    await ingestAppleMail({
      repoRoot,
      env: {},
      applications: [{ id: "app-acme", company: "Acme", role: "Product Engineer" }],
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      readMessagesImpl: async () => [
        {
          id: "mail-db-1",
          subject: "Acme Product Engineer interview",
          sender: "Jordan <jordan@acme.example>",
          receivedAt: "2026-08-24T09:30:00.000Z",
          body: "Can you interview Tuesday?",
        },
      ],
    });

    const tracker = assembleTrackerObject(requireDb({ repoRoot, env: {} }));
    assert.equal(tracker.communications.length, 1);
    assert.equal(tracker.communications[0].applicationId, "app-acme");
    assert.equal(tracker.communications[0].status, "needs-reply");
    assert.equal(tracker.communications[0].messages[0].id, "intake:mail-db-1");
    assert.equal(
      tracker.sources.find((source) => source.id === "apple-mail")?.lastRunAt,
      "2026-08-24T12:00:00.000Z"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
