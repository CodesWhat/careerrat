import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendMessage,
  createThread,
  findThread,
  renderThreadNote,
  setStatus,
  slugifyThreadId,
  summarizeThread,
  upsertCommunication,
} from "../src/core/comms/threads.mjs";

import { validate } from "../src/core/profile/schema-validator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const trackerSchema = JSON.parse(
  readFileSync(join(__dirname, "../config/tracker.schema.json"), "utf8")
);

// Helper: wrap a thread in a minimal tracker object and validate against schema
function validateThread(thread) {
  return validate(
    { applications: [], sourced: [], sources: [], communications: [thread] },
    trackerSchema
  );
}

// ---------------------------------------------------------------------------
// slugifyThreadId
// ---------------------------------------------------------------------------

describe("slugifyThreadId", () => {
  it("produces comm-<co>-<role>-<channel>", () => {
    assert.equal(
      slugifyThreadId({ company: "Acme Corp", role: "Software Engineer", channel: "email" }),
      "comm-acme-corp-software-engineer-email"
    );
  });

  it("collapses consecutive dashes", () => {
    const id = slugifyThreadId({ company: "A  B", role: "C--D", channel: "linkedin" });
    assert.match(id, /^comm-a-b-c-d-linkedin$/);
  });

  it("lowercases everything", () => {
    const id = slugifyThreadId({ company: "BIGCO", role: "VP Sales", channel: "phone" });
    assert.equal(id, "comm-bigco-vp-sales-phone");
  });
});

// ---------------------------------------------------------------------------
// createThread — schema validation
// ---------------------------------------------------------------------------

describe("createThread — schema validation", () => {
  it("produces a schema-valid communication object", () => {
    const thread = createThread({
      company: "Acme Corp",
      role: "Software Engineer",
      channel: "email",
      summary: "Initial outreach",
    });
    const result = validateThread(thread);
    assert.equal(
      result.valid,
      true,
      result.errors.map((e) => `${e.path}: ${e.message}`).join("; ")
    );
  });

  it("default id equals slugifyThreadId output", () => {
    const thread = createThread({ company: "Beta", role: "Dev", channel: "linkedin" });
    assert.equal(thread.id, slugifyThreadId({ company: "Beta", role: "Dev", channel: "linkedin" }));
  });

  it("accepts an explicit id override", () => {
    const thread = createThread({ company: "X", role: "Y", channel: "email", id: "my-custom-id" });
    assert.equal(thread.id, "my-custom-id");
  });

  it("messages is initialised to an empty array", () => {
    const thread = createThread({ company: "X", role: "Y", channel: "email" });
    assert.deepEqual(thread.messages, []);
  });

  it("throws when channel is invalid", () => {
    assert.throws(
      () => createThread({ company: "X", role: "Y", channel: "carrier-pigeon" }),
      /invalid channel/i
    );
  });

  it("throws when company+role+channel are all empty", () => {
    assert.throws(() => createThread({ company: "", role: "", channel: "" }), /channel/i);
  });

  it("does not emit undefined keys", () => {
    const thread = createThread({ company: "X", role: "Y", channel: "email" });
    const keys = Object.keys(thread);
    assert.ok(!keys.some((k) => thread[k] === undefined), "No undefined values");
  });
});

// ---------------------------------------------------------------------------
// appendMessage — direction → status / timestamp table
// ---------------------------------------------------------------------------

describe("appendMessage — direction→status/timestamp", () => {
  const base = createThread({
    company: "Acme",
    role: "Engineer",
    channel: "email",
    status: "waiting",
    summary: "base",
  });
  const AT = "2025-01-15T10:00:00.000Z";

  it("inbound sets lastInboundAt and status needs-reply", () => {
    const updated = appendMessage(base, { direction: "inbound", summary: "They replied", at: AT });
    assert.equal(updated.status, "needs-reply");
    assert.equal(updated.lastInboundAt, AT);
  });

  it("outbound-sent sets lastOutboundAt and status waiting", () => {
    const updated = appendMessage(base, {
      direction: "outbound-sent",
      summary: "Sent follow-up",
      at: AT,
    });
    assert.equal(updated.status, "waiting");
    assert.equal(updated.lastOutboundAt, AT);
  });

  it("outbound-draft sets status drafted", () => {
    const updated = appendMessage(base, { direction: "outbound-draft", summary: "Draft" });
    assert.equal(updated.status, "drafted");
  });

  it("note does not change status or timestamps", () => {
    const updated = appendMessage(base, { direction: "note", summary: "Internal note" });
    assert.equal(updated.status, base.status);
    assert.equal(updated.lastInboundAt, base.lastInboundAt);
    assert.equal(updated.lastOutboundAt, base.lastOutboundAt);
  });

  it("timestamp can come from now Date parameter", () => {
    const nowDate = new Date(AT);
    const updated = appendMessage(
      base,
      { direction: "inbound", summary: "Via now" },
      { now: nowDate }
    );
    assert.equal(updated.lastInboundAt, AT);
    assert.equal(updated.messages[updated.messages.length - 1].at, AT);
  });

  it("closed thread stays closed when inbound arrives", () => {
    const closed = setStatus(base, "closed");
    const updated = appendMessage(closed, { direction: "inbound", summary: "Late reply" });
    assert.equal(updated.status, "closed");
  });

  it("blocked thread stays blocked when inbound arrives", () => {
    const blocked = setStatus(base, "blocked");
    const updated = appendMessage(blocked, { direction: "inbound", summary: "Blocker msg" });
    assert.equal(updated.status, "blocked");
  });

  it("throws when direction is missing", () => {
    assert.throws(() => appendMessage(base, { summary: "Oops" }), /direction/i);
  });

  it("throws when summary is missing", () => {
    assert.throws(() => appendMessage(base, { direction: "inbound" }), /summary/i);
  });

  it("original thread object is NOT mutated", () => {
    const before = JSON.stringify(base);
    appendMessage(base, { direction: "inbound", summary: "Check immutability", at: AT });
    assert.equal(JSON.stringify(base), before);
  });

  it("message.nextAction is carried to thread.nextAction", () => {
    const updated = appendMessage(base, {
      direction: "inbound",
      summary: "Next step message",
      nextAction: "Schedule call",
    });
    assert.equal(updated.nextAction, "Schedule call");
  });

  it("appended message appears in messages array", () => {
    const updated = appendMessage(base, { direction: "note", summary: "A note" });
    assert.equal(updated.messages.length, 1);
    assert.equal(updated.messages[0].summary, "A note");
  });
});

// ---------------------------------------------------------------------------
// findThread
// ---------------------------------------------------------------------------

describe("findThread", () => {
  const t1 = createThread({ company: "Acme", role: "Engineer", channel: "email", summary: "s" });
  const t2 = createThread({
    company: "Beta Corp",
    role: "PM",
    channel: "linkedin",
    summary: "s",
    applicationId: "app-42",
    sourcedId: "pro-7",
    subject: "Exciting opportunity at Beta",
  });
  const comms = [t1, t2];

  it("matches by id", () => {
    const found = findThread(comms, { id: t1.id });
    assert.equal(found, t1);
  });

  it("matches by threadId", () => {
    const found = findThread(comms, { threadId: t2.threadId });
    assert.equal(found, t2);
  });

  it("matches by applicationId", () => {
    const found = findThread(comms, { applicationId: "app-42" });
    assert.equal(found, t2);
  });

  it("matches by sourcedId", () => {
    const found = findThread(comms, { sourcedId: "pro-7" });
    assert.equal(found, t2);
  });

  it("matches by company+role (case-insensitive)", () => {
    const found = findThread(comms, { company: "ACME", role: "engineer" });
    assert.equal(found, t1);
  });

  it("matches by subject contains (case-insensitive)", () => {
    const found = findThread(comms, { subject: "exciting" });
    assert.equal(found, t2);
  });

  it("returns null when nothing matches", () => {
    const found = findThread(comms, { id: "nonexistent-id" });
    assert.equal(found, null);
  });

  it("returns null for empty array", () => {
    assert.equal(findThread([], { id: "x" }), null);
  });
});

// ---------------------------------------------------------------------------
// upsertCommunication
// ---------------------------------------------------------------------------

describe("upsertCommunication", () => {
  const thread = createThread({ company: "Acme", role: "Dev", channel: "email", summary: "x" });

  it("appends a new thread when not present", () => {
    const tracker = { applications: [], sourced: [], sources: [], communications: [] };
    const updated = upsertCommunication(tracker, thread);
    assert.equal(updated.communications.length, 1);
    assert.equal(updated.communications[0].id, thread.id);
  });

  it("replaces an existing thread by id (length stays 1)", () => {
    const tracker = { applications: [], sourced: [], sources: [], communications: [thread] };
    const updated1 = upsertCommunication(tracker, thread);
    assert.equal(updated1.communications.length, 1);

    const modified = Object.assign({}, thread, { summary: "updated summary" });
    const updated2 = upsertCommunication(updated1, modified);
    assert.equal(updated2.communications.length, 1);
    assert.equal(updated2.communications[0].summary, "updated summary");
  });

  it("tolerates trackerData without a communications array", () => {
    const tracker = { applications: [], sourced: [], sources: [] };
    const updated = upsertCommunication(tracker, thread);
    assert.equal(updated.communications.length, 1);
  });

  it("does not mutate the original trackerData", () => {
    const tracker = { applications: [], sourced: [], sources: [], communications: [] };
    const before = JSON.stringify(tracker);
    upsertCommunication(tracker, thread);
    assert.equal(JSON.stringify(tracker), before);
  });
});

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

describe("setStatus", () => {
  const thread = createThread({ company: "X", role: "Y", channel: "email", summary: "s" });

  it("sets a valid status", () => {
    const updated = setStatus(thread, "closed");
    assert.equal(updated.status, "closed");
  });

  it("sets nextAction and nextActionDue when provided", () => {
    const updated = setStatus(thread, "scheduled", {
      nextAction: "Interview call",
      nextActionDue: "2025-02-01",
    });
    assert.equal(updated.nextAction, "Interview call");
    assert.equal(updated.nextActionDue, "2025-02-01");
  });

  it("rejects an invalid status", () => {
    assert.throws(() => setStatus(thread, "snooze"), /invalid status/i);
  });

  it("does not mutate the original thread", () => {
    const before = JSON.stringify(thread);
    setStatus(thread, "closed");
    assert.equal(JSON.stringify(thread), before);
  });
});

// ---------------------------------------------------------------------------
// renderThreadNote
// ---------------------------------------------------------------------------

describe("renderThreadNote", () => {
  const thread = createThread({
    company: "Acme",
    role: "Engineer",
    channel: "email",
    status: "needs-reply",
    summary: "Recruiter reached out",
    nextAction: "Reply with availability",
  });

  const AT = "2025-01-10T08:00:00.000Z";
  const withMsgs = appendMessage(
    appendMessage(thread, { direction: "inbound", summary: "Hi there!", at: AT }),
    { direction: "outbound-draft", summary: "Draft reply" }
  );

  it("includes company name in output", () => {
    const md = renderThreadNote(withMsgs);
    assert.ok(md.includes("Acme"), "should include company");
  });

  it("includes status in output", () => {
    const md = renderThreadNote(withMsgs);
    assert.ok(md.includes("needs-reply") || md.includes("drafted"), "should include status");
  });

  it("includes each message summary", () => {
    const md = renderThreadNote(withMsgs);
    assert.ok(md.includes("Hi there!"), "should include inbound summary");
    assert.ok(md.includes("Draft reply"), "should include draft summary");
  });

  it("includes role", () => {
    const md = renderThreadNote(withMsgs);
    assert.ok(md.includes("Engineer"), "should include role");
  });

  it("includes nextAction", () => {
    const md = renderThreadNote(thread);
    assert.ok(md.includes("Reply with availability"), "should include nextAction");
  });

  it("renders frontmatter block", () => {
    const md = renderThreadNote(thread);
    assert.ok(md.startsWith("---"), "should start with frontmatter");
  });
});

// ---------------------------------------------------------------------------
// summarizeThread
// ---------------------------------------------------------------------------

describe("summarizeThread", () => {
  const thread = createThread({
    company: "Acme",
    role: "Engineer",
    channel: "email",
    status: "waiting",
    summary: "Sent application",
    nextAction: "Wait for response",
  });

  it("includes status", () => {
    const s = summarizeThread(thread);
    assert.ok(s.includes("[waiting]"), "should include [status]");
  });

  it("includes company", () => {
    const s = summarizeThread(thread);
    assert.ok(s.includes("Acme"), "should include company");
  });

  it("includes role", () => {
    const s = summarizeThread(thread);
    assert.ok(s.includes("Engineer"), "should include role");
  });

  it("includes nextAction", () => {
    const s = summarizeThread(thread);
    assert.ok(s.includes("Wait for response"), "should include nextAction");
  });

  it("shows N/A when nextAction is absent", () => {
    const t = createThread({ company: "X", role: "Y", channel: "email", summary: "s" });
    const s = summarizeThread(t);
    assert.ok(s.includes("N/A"), "should show N/A for missing nextAction");
  });
});
