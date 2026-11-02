// CR121: per-person contact and consent. Everything runs against a temp base directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertCanNotify, NotifyError, notifyPerson } from "../src/core/comms/person-notify.mjs";
import { createPersonRoot } from "../src/core/paths/people.mjs";
import { authorizationPath, recordAuthorization } from "../src/core/people/authorization.mjs";
import {
  activeOptIn,
  applyStopKeyword,
  optIn,
  optOut,
  readContact,
  setContact,
} from "../src/core/people/contact.mjs";
import { purgePerson } from "../src/core/people/purge.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(REPO_ROOT, "bin/careerrat.mjs");

function tempBase(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-contact-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function cli(base, args) {
  const env = { ...process.env, CAREERRAT_HOME: base };
  for (const key of ["CAREERRAT_PERSON", "CAREERRAT_PEOPLE_BASE"]) delete env[key];
  return spawnSync(process.execPath, [BIN, ...args], { cwd: REPO_ROOT, encoding: "utf8", env });
}

function fakeTransport() {
  const sent = [];
  return {
    name: "fake",
    sent,
    async send(message) {
      sent.push(message);
      return { id: `fake-${sent.length}` };
    },
  };
}

const NOON_UTC = new Date("2026-11-02T17:00:00Z"); // 11:00 in Chicago, outside quiet hours
const LATE_UTC = new Date("2026-11-03T03:30:00Z"); // 21:30 in Chicago, quiet

function ready(base, name = "david") {
  createPersonRoot(base, name);
  setContact({ base, name, email: "david@example.com", timezone: "America/Chicago" });
  optIn({ base, name, channel: "email", evidence: "said yes on a call" });
}

test("contact defaults to quiet hours 21:00-08:00 and stores email, phone, timezone", (t) => {
  const base = tempBase(t);
  createPersonRoot(base, "david");
  assert.deepEqual(readContact(base, "david").quietHours, { start: "21:00", end: "08:00" });
  const contact = setContact({
    base,
    name: "david",
    email: "david@example.com",
    phone: "+15555550100",
    timezone: "America/Chicago",
  });
  assert.equal(contact.email, "david@example.com");
  assert.equal(contact.phone, "+15555550100");
  assert.equal(contact.timezone, "America/Chicago");
  assert.throws(() => setContact({ base, name: "david", timezone: "Mars/Base" }), /not a timezone/);
  assert.throws(() => setContact({ base, name: "david", email: "nope" }), /not an email/);
  assert.throws(() => setContact({ base, name: "david", quietHours: "9pm-8am" }), /Quiet hours/);
});

test("opt-in needs evidence and an address, and opt-out revokes it", (t) => {
  const base = tempBase(t);
  createPersonRoot(base, "david");
  assert.throws(
    () => optIn({ base, name: "david", channel: "email", evidence: "x" }),
    /Set their email/
  );
  setContact({ base, name: "david", email: "david@example.com" });
  assert.throws(() => optIn({ base, name: "david", channel: "email", evidence: " " }), /evidence/);
  const entry = optIn({
    base,
    name: "david",
    channel: "email",
    evidence: "texted yes",
    now: NOON_UTC,
  });
  assert.equal(entry.optedInAt, NOON_UTC.toISOString());
  assert.ok(activeOptIn(readContact(base, "david"), "email"));
  const revoked = optOut({ base, name: "david", channel: "email", now: LATE_UTC });
  assert.equal(revoked.revokedAt, LATE_UTC.toISOString());
  assert.equal(activeOptIn(readContact(base, "david"), "email"), null);
});

test("notify with no opt-in fails closed with a named error and sends nothing", async (t) => {
  const base = tempBase(t);
  createPersonRoot(base, "david");
  setContact({ base, name: "david", email: "david@example.com", timezone: "America/Chicago" });
  const transport = fakeTransport();
  await assert.rejects(
    notifyPerson({
      base,
      name: "david",
      to: "david@example.com",
      subject: "s",
      text: "t",
      transport,
      now: NOON_UTC,
    }),
    (error) => error instanceof NotifyError && error.code === "NOTIFY_NO_OPT_IN"
  );
  assert.equal(transport.sent.length, 0);
});

test("notify refuses an address that isn't in the person's contact record", async (t) => {
  const base = tempBase(t);
  ready(base);
  const transport = fakeTransport();
  await assert.rejects(
    notifyPerson({
      base,
      name: "david",
      to: "recruiter@acme.com",
      subject: "s",
      text: "t",
      transport,
      now: NOON_UTC,
    }),
    (error) => error.code === "NOTIFY_ADDRESS_NOT_REGISTERED"
  );
  assert.equal(transport.sent.length, 0);
  const sent = await notifyPerson({
    base,
    name: "david",
    to: "DAVID@example.com",
    subject: "s",
    text: "t",
    transport,
    now: NOON_UTC,
  });
  assert.equal(sent.messageId, "fake-1");
  assert.equal(transport.sent.length, 1);
});

test("notify respects quiet hours unless told to skip them", async (t) => {
  const base = tempBase(t);
  ready(base);
  assert.throws(
    () => assertCanNotify({ base, name: "david", to: "david@example.com", now: LATE_UTC }),
    (error) => error.code === "NOTIFY_QUIET_HOURS" && error.resumesAt === "08:00"
  );
  assert.doesNotThrow(() =>
    assertCanNotify({
      base,
      name: "david",
      to: "david@example.com",
      now: LATE_UTC,
      ignoreQuietHours: true,
    })
  );
});

test("a STOP reply revokes the opt-in; other text does not", (t) => {
  const base = tempBase(t);
  ready(base);
  assert.equal(
    applyStopKeyword({ base, name: "david", channel: "email", text: "sounds good" }),
    null
  );
  assert.ok(activeOptIn(readContact(base, "david"), "email"));
  assert.ok(applyStopKeyword({ base, name: "david", channel: "email", text: " Stop. " }));
  assert.equal(activeOptIn(readContact(base, "david"), "email"), null);
});

test("recording another authorization note keeps the contact record", (t) => {
  const base = tempBase(t);
  ready(base);
  recordAuthorization({ base, name: "david", authorizedBy: "David", purpose: "job search" });
  assert.equal(readContact(base, "david").email, "david@example.com");
  assert.ok(activeOptIn(readContact(base, "david"), "email"));
});

test("purge removes the contact record with the person", (t) => {
  const base = tempBase(t);
  ready(base);
  const file = authorizationPath(base, "david");
  assert.ok(existsSync(file));
  purgePerson({
    base,
    name: "david",
    env: { ...process.env, CAREERRAT_DOWNLOADS_DIR: join(base, "dl") },
  });
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(join(base, "people", "david")), false);
});

test("people contact CLI shows, sets, opts in and out", (t) => {
  const base = tempBase(t);
  assert.equal(cli(base, ["people", "add", "david"]).status, 0);
  const set = cli(base, [
    "--for",
    "david",
    "people",
    "contact",
    "set",
    "--email",
    "david@example.com",
    "--timezone",
    "America/Chicago",
  ]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /david@example\.com/);
  assert.match(set.stdout, /email opt-in: no/);
  const noEvidence = cli(base, ["--for", "david", "people", "contact", "opt-in", "email"]);
  assert.notEqual(noEvidence.status, 0);
  assert.match(noEvidence.stderr, /evidence/);
  const yes = cli(base, [
    "--for",
    "david",
    "people",
    "contact",
    "opt-in",
    "email",
    "--evidence",
    "told me on a call",
  ]);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /email opt-in: yes/);
  assert.match(yes.stdout, /told me on a call/);
  const out = cli(base, ["--for", "david", "people", "contact", "opt-out", "email"]);
  assert.match(out.stdout, /email opt-in: no/);
  const show = cli(base, ["--for", "david", "people", "contact", "show", "--json"]);
  assert.equal(JSON.parse(show.stdout).contact.optIns[0].revokedAt !== null, true);
  const bare = cli(base, ["people", "contact", "show"]);
  assert.notEqual(bare.status, 0);
});
