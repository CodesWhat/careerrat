// CR123: a recruiter-reply draft goes to the person, never the recruiter, and their
// later "sent" records the supervised tier.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deliverDraftToPerson } from "../src/core/comms/deliver-draft.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { commUpsert } from "../src/core/db/verbs/comm.mjs";
import { createPersonRoot, personEnv } from "../src/core/paths/people.mjs";
import { optIn, setContact } from "../src/core/people/contact.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(REPO_ROOT, "bin/careerrat.mjs");
const NOON = new Date("2026-11-02T17:00:00Z");

function fixture(t, { optedIn = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-draft-")));
  t.after(() => {
    closeAll();
    rmSync(base, { recursive: true, force: true });
  });
  createPersonRoot(base, "david");
  const env = personEnv({
    repoRoot: REPO_ROOT,
    env: { CAREERRAT_PEOPLE_BASE: base },
    name: "david",
  });
  openDb({ repoRoot: REPO_ROOT, env });
  setContact({ base, name: "david", email: "david@example.com", timezone: "America/Chicago" });
  if (optedIn) optIn({ base, name: "david", channel: "email", evidence: "said yes" });
  commUpsert({
    repoRoot: REPO_ROOT,
    env,
    row: {
      id: "comm-rae",
      company: "Acme",
      role: "Engineer",
      channel: "email",
      subject: "Interview availability",
      status: "drafted",
      participants: [{ name: "Rae Recruiter", email: "rae@acme.com" }],
      draft: { subject: "Re: Interview availability", body: "Tuesday afternoon works for me." },
      messages: [],
    },
  });
  return { base, env };
}

function fakeResolved() {
  const sent = [];
  return {
    sent,
    resolved: {
      from: "updates@mail.example.com",
      transport: {
        name: "fake",
        async send(message) {
          sent.push(message);
          return { id: "fake-1" };
        },
      },
    },
  };
}

test("the draft goes to the person's opted-in address, never the recruiter", async (t) => {
  const { base, env } = fixture(t);
  const fake = fakeResolved();
  const result = await deliverDraftToPerson({
    repoRoot: REPO_ROOT,
    env,
    base,
    name: "david",
    id: "comm-rae",
    now: NOON,
    transportOverride: fake.resolved,
  });
  assert.equal(result.subject, "Draft reply to Rae Recruiter for you to send");
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].to, "david@example.com");
  assert.equal(fake.sent[0].subject, "Draft reply to Rae Recruiter for you to send");
  assert.match(fake.sent[0].text, /Tuesday afternoon works for me\./);
  assert.match(fake.sent[0].text, /To: rae@acme\.com/);
  assert.ok(fake.sent.every((message) => message.to !== "rae@acme.com"));
});

test("no opt-in means no delivery", async (t) => {
  const { base, env } = fixture(t, { optedIn: false });
  const fake = fakeResolved();
  await assert.rejects(
    deliverDraftToPerson({
      repoRoot: REPO_ROOT,
      env,
      base,
      name: "david",
      id: "comm-rae",
      now: NOON,
      transportOverride: fake.resolved,
    }),
    (error) => error.code === "NOTIFY_NO_OPT_IN"
  );
  assert.equal(fake.sent.length, 0);
});

test("a thread with no draft is not delivered", async (t) => {
  const { base, env } = fixture(t);
  commUpsert({
    repoRoot: REPO_ROOT,
    env,
    row: {
      id: "comm-none",
      company: "Acme",
      channel: "email",
      status: "needs-reply",
      messages: [],
    },
  });
  const fake = fakeResolved();
  await assert.rejects(
    deliverDraftToPerson({
      repoRoot: REPO_ROOT,
      env,
      base,
      name: "david",
      id: "comm-none",
      now: NOON,
      transportOverride: fake.resolved,
    }),
    (error) => error.code === "COMMUNICATION_DRAFT_REQUIRED"
  );
});

function cliAsync(base, smtpPort, args) {
  const env = { ...process.env, CAREERRAT_HOME: base, USER: "scott" };
  for (const key of ["CAREERRAT_PERSON", "CAREERRAT_PEOPLE_BASE", "RESEND_API_KEY"])
    delete env[key];
  if (smtpPort) {
    Object.assign(env, {
      CAREERRAT_MAIL_FROM: "updates@mail.example.com",
      CAREERRAT_SMTP_HOST: "127.0.0.1",
      CAREERRAT_SMTP_PORT: String(smtpPort),
      CAREERRAT_SMTP_SECURE: "none",
    });
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: REPO_ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CLI: deliver over SMTP reaches only the person, then mark-sent records supervised", async (t) => {
  const { base } = fixture(t);
  const commands = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    socket.write("220 fake\r\n");
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
            socket.write("250 queued\r\n");
          }
          continue;
        }
        commands.push(line);
        if (line === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const outside = await cliAsync(base, port, [
    "comm",
    "handoff",
    "comm-rae",
    "--deliver-to-person",
    "--now",
  ]);
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /person's workspace/);

  const delivered = await cliAsync(base, port, [
    "--for",
    "david",
    "comm",
    "handoff",
    "comm-rae",
    "--deliver-to-person",
    "--now",
  ]);
  assert.equal(delivered.status, 0, delivered.stderr);
  assert.match(delivered.stdout, /Draft reply to Rae Recruiter for you to send/);
  const rcpts = commands.filter((line) => line.startsWith("RCPT TO:"));
  assert.deepEqual(rcpts, ["RCPT TO:<david@example.com>"]);

  const marked = await cliAsync(base, null, ["--for", "david", "comm", "mark-sent", "comm-rae"]);
  assert.equal(marked.status, 0, marked.stderr);
  assert.equal(JSON.parse(marked.stdout).verification, "supervised");
});
