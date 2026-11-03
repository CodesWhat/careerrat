// CR122: operator-run roundup. Fake transports only; nothing here touches the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readNotificationLog } from "../src/core/comms/person-notify.mjs";
import { runRoundup } from "../src/core/comms/roundup.mjs";
import {
  buildRfc822,
  MailNotSetUpError,
  resendTransport,
  resolveTransport,
  smtpTransport,
} from "../src/core/comms/transports.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appRecordOutcome, appUpsert } from "../src/core/db/verbs.mjs";
import { createPersonRoot, personEnv } from "../src/core/paths/people.mjs";
import { optIn, setContact } from "../src/core/people/contact.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(REPO_ROOT, "bin/careerrat.mjs");
const NOON = new Date("2026-11-02T17:00:00Z"); // 11:00 in Chicago
const LATE = new Date("2026-11-03T03:30:00Z"); // 21:30 in Chicago

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-roundup-")));
  t.after(() => {
    closeAll();
    rmSync(base, { recursive: true, force: true });
  });
  createPersonRoot(base, "david");
  const env = {
    ...personEnv({ repoRoot: REPO_ROOT, env: { CAREERRAT_PEOPLE_BASE: base }, name: "david" }),
  };
  openDb({ repoRoot: REPO_ROOT, env });
  setContact({ base, name: "david", email: "david@example.com", timezone: "America/Chicago" });
  optIn({ base, name: "david", channel: "email", evidence: "said yes" });
  const row = (id, company, role, extra = {}) =>
    appUpsert({
      repoRoot: REPO_ROOT,
      env,
      row: { id, company, role, status: "interested", ...extra },
    });
  row("a1", "Acme", "Staff Engineer", { compensation: { current_base: 250000, floor: 200000 } });
  row("a2", "Globex", "Platform Lead");
  row("a3", "Old Co", "Dev");
  row("a4", "Initech", "Engineer", {
    packetManifest: {
      gaps: [
        {
          kind: "answers",
          code: "ANSWER_CONFIRMATION_REQUIRED",
          questionId: "q1",
          message: 'Answer "Are you authorized to work in the US?"',
        },
        {
          kind: "answers",
          code: "ANSWER_CONFIRMATION_REQUIRED",
          questionId: "q2",
          message: 'Answer "What is your current salary?"',
        },
        {
          kind: "answers",
          code: "ANSWER_CONFIRMATION_REQUIRED",
          questionId: "q3",
          message: 'Answer "Enter your SSN for the background check at checkr.com/abc"',
        },
      ],
    },
  });
  appRecordOutcome({
    repoRoot: REPO_ROOT,
    env,
    id: "a3",
    to: "applied",
    at: "2026-10-01T15:00:00Z",
  });
  appRecordOutcome({
    repoRoot: REPO_ROOT,
    env,
    id: "a1",
    to: "applied",
    at: "2026-10-30T15:00:00Z",
  });
  appRecordOutcome({
    repoRoot: REPO_ROOT,
    env,
    id: "a2",
    to: "applied",
    at: "2026-10-31T15:00:00Z",
  });
  appRecordOutcome({
    repoRoot: REPO_ROOT,
    env,
    id: "a2",
    to: "interview",
    at: "2026-11-01T15:00:00Z",
  });
  return { base, env };
}

function fakeTransport() {
  const sent = [];
  return {
    sent,
    resolved: {
      from: "updates@mail.example.com",
      transport: {
        name: "fake",
        async send(message) {
          sent.push(message);
          return { id: `fake-${sent.length}` };
        },
      },
    },
  };
}

const common = (base, env) => ({
  repoRoot: REPO_ROOT,
  env,
  base,
  name: "david",
  since: "2026-10-25",
});

test("dry run lists the verified submissions in the window, status changes and numbered questions", async (t) => {
  const { base, env } = fixture(t);
  const result = await runRoundup({ ...common(base, env), now: NOON });
  assert.equal(result.sent, false);
  assert.match(result.text, /Applied \(2\)/);
  assert.match(result.text, /- Acme, Staff Engineer/);
  assert.match(result.text, /- Globex, Platform Lead/);
  assert.doesNotMatch(result.text, /Old Co/);
  assert.match(result.text, /Status changes \(1\)/);
  assert.match(result.text, /Globex: Status changed to Interview/);
  assert.match(result.text, /Waiting on you \(3\)/);
  assert.match(result.text, /1\. Initech, Engineer: Are you authorized to work in the US\?/);
  assert.match(result.text, /CareerRat, run by /);
  assert.match(result.text, /Reply STOP to pause these\./);
});

test("the roundup never carries pay, SSN, date of birth or background-check links", async (t) => {
  const { base, env } = fixture(t);
  const { text } = await runRoundup({ ...common(base, env), now: NOON });
  assert.doesNotMatch(text, /250000|200000|current_base|floor|salary|SSN|checkr|background|\$/i);
  assert.doesNotMatch(text, /date of birth|DOB/i);
  assert.match(text, /A question about personal details is waiting/);
});

test("--send delivers once to the registered address and records it; a repeat does nothing", async (t) => {
  const { base, env } = fixture(t);
  const fake = fakeTransport();
  const args = { ...common(base, env), send: true, now: NOON, transportOverride: fake.resolved };
  const first = await runRoundup(args);
  assert.equal(first.sent, true);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].to, "david@example.com");
  assert.equal(fake.sent[0].from, "updates@mail.example.com");
  assert.equal(readNotificationLog(base, "david").length, 1);
  const again = await runRoundup(args);
  assert.equal(again.sent, false);
  assert.match(again.skipped, /already sent/);
  assert.equal(fake.sent.length, 1);
  // A defaulted window the same day is the same window too.
  const defaulted = await runRoundup({
    ...args,
    since: undefined,
    now: new Date(NOON.getTime() + 3600_000),
  });
  assert.equal(defaulted.sent, false);
  assert.equal(fake.sent.length, 1);
});

test("--send refuses in quiet hours unless --now, and with no opt-in", async (t) => {
  const { base, env } = fixture(t);
  const fake = fakeTransport();
  const args = { ...common(base, env), send: true, transportOverride: fake.resolved };
  await assert.rejects(runRoundup({ ...args, now: LATE }), (error) => {
    assert.equal(error.code, "NOTIFY_QUIET_HOURS");
    assert.match(
      error.message,
      /quiet hours for david \(America\/Chicago\); rerun after 08:00 or pass --now/
    );
    return true;
  });
  assert.equal(fake.sent.length, 0);
  const forced = await runRoundup({ ...args, now: LATE, ignoreQuietHours: true });
  assert.equal(forced.sent, true);

  const other = fixture(t);
  const { optOut } = await import("../src/core/people/contact.mjs");
  optOut({ base: other.base, name: "david", channel: "email" });
  await assert.rejects(
    runRoundup({
      ...common(other.base, other.env),
      send: true,
      now: NOON,
      transportOverride: fake.resolved,
    }),
    (error) => error.code === "NOTIFY_NO_OPT_IN"
  );
});

test("with no mail provider configured it says what to set up", () => {
  assert.throws(
    () => resolveTransport({}),
    (error) => {
      assert.ok(error instanceof MailNotSetUpError);
      for (const needle of [
        "RESEND_API_KEY",
        "CAREERRAT_MAIL_FROM",
        "CAREERRAT_SMTP_HOST",
        "SPF",
        "DKIM",
        "DMARC",
      ]) {
        assert.match(error.message, new RegExp(needle));
      }
      return true;
    }
  );
  assert.throws(() => resolveTransport({ RESEND_API_KEY: "re_x" }), /CAREERRAT_MAIL_FROM/);
});

test("the Resend transport posts to the Resend API with the key", async () => {
  const calls = [];
  const transport = resendTransport({
    apiKey: "re_secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: "msg_1" }) };
    },
  });
  const result = await transport.send({
    from: "a@mail.example.com",
    to: "b@example.com",
    subject: "s",
    text: "t",
  });
  assert.equal(result.id, "msg_1");
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.headers.authorization, "Bearer re_secret");
  assert.deepEqual(JSON.parse(calls[0].init.body).to, ["b@example.com"]);
  const failing = resendTransport({
    apiKey: "k",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: "domain not verified" }),
    }),
  });
  await assert.rejects(
    failing.send({ from: "a", to: "b", subject: "s", text: "t" }),
    /domain not verified/
  );
});

test("the SMTP transport speaks SMTP to a local relay", async (t) => {
  const received = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let data = "";
    let buffer = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push({ data });
            socket.write("250 queued\r\n");
          } else data += `${line}\n`;
          continue;
        }
        received.push({ line });
        if (line.startsWith("EHLO")) socket.write("250 fake\r\n");
        else if (line.startsWith("AUTH")) socket.write("235 ok\r\n");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) socket.write("250 ok\r\n");
        else if (line === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const transport = smtpTransport({
    host: "127.0.0.1",
    port: server.address().port,
    user: "u",
    pass: "p",
    secure: "none",
  });
  const result = await transport.send({
    from: "CareerRat <updates@mail.example.com>",
    to: "david@example.com",
    subject: "Your roundup",
    text: "Hi David\n.dot line\n",
  });
  assert.match(result.id, /^<.+@careerrat\.local>$/);
  const lines = received.map((entry) => entry.line).filter(Boolean);
  assert.ok(lines.includes("MAIL FROM:<updates@mail.example.com>"));
  assert.ok(lines.includes("RCPT TO:<david@example.com>"));
  assert.ok(lines.some((line) => line.startsWith("AUTH PLAIN ")));
  const body = received.find((entry) => entry.data)?.data ?? "";
  assert.match(body, /Subject: Your roundup/);
  const encoded = body.split("\n\n")[1].replace(/\s+/g, "");
  assert.equal(Buffer.from(encoded, "base64").toString(), "Hi David\r\n.dot line\r\n");
});

test("message headers can't be injected through the subject", () => {
  const message = buildRfc822({
    from: "a@x.com",
    to: "b@x.com",
    subject: "hi\r\nBcc: evil@x.com",
    text: "t",
    messageId: "<1@x>",
  });
  assert.doesNotMatch(message, /^Bcc:/m);
});

test("roundup CLI: dry run prints, --send without a provider names the setup", (t) => {
  const { base } = fixture(t);
  const env = { ...process.env, CAREERRAT_HOME: base, USER: "scott" };
  for (const key of [
    "CAREERRAT_PERSON",
    "CAREERRAT_PEOPLE_BASE",
    "RESEND_API_KEY",
    "CAREERRAT_MAIL_FROM",
    "CAREERRAT_SMTP_HOST",
  ])
    delete env[key];
  const run = (...args) =>
    spawnSync(process.execPath, [BIN, "--for", "david", "roundup", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });
  const dry = run("--since", "2026-10-25");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Applied \(2\)/);
  assert.match(dry.stdout, /Dry run/);
  const send = run("--since", "2026-10-25", "--send", "--now");
  assert.notEqual(send.status, 0);
  assert.match(send.stderr, /RESEND_API_KEY/);
  assert.match(send.stderr, /DMARC/);
  const bare = spawnSync(process.execPath, [BIN, "roundup"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /--for/);
});
