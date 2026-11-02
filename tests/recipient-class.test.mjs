// CR120: employer-facing mail stays draft-only; agent-to-person notifications are a
// separate class with their own gate. Neither path may open a network connection to
// anyone who isn't the person.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import tls from "node:tls";
import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { notifyPerson } from "../src/core/comms/person-notify.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { commUpsert } from "../src/core/db/verbs/comm.mjs";
import { createPersonRoot } from "../src/core/paths/people.mjs";
import { optIn, setContact } from "../src/core/people/contact.mjs";

let connections;

beforeEach(() => {
  connections = [];
  const record =
    (kind) =>
    (...args) => {
      connections.push([kind, ...args]);
      throw new Error(`unexpected ${kind} connection`);
    };
  mock.method(globalThis, "fetch", record("fetch"));
  mock.method(net, "connect", record("net.connect"));
  mock.method(net, "createConnection", record("net.createConnection"));
  mock.method(tls, "connect", record("tls.connect"));
});

afterEach(() => {
  mock.restoreAll();
  closeAll();
});

test("communication.send to a recruiter makes no network connection", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-recipient-class-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  openDb({ repoRoot, env: {} });
  commUpsert({
    repoRoot,
    env: {},
    row: {
      id: "comm-recruiter",
      company: "Acme",
      role: "Engineer",
      channel: "email",
      status: "drafted",
      participants: [{ name: "Rae Recruiter", email: "rae@acme.com" }],
      draft: { subject: "Re: Interview", body: "Tuesday works for me." },
      messages: [],
    },
  });
  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "communication.send",
        entity: { type: "communication", id: "comm-recruiter" },
      },
    }),
    (error) => error.code === "COMMUNICATION_EXECUTOR_UNAVAILABLE"
  );
  assert.deepEqual(connections, []);
});

test("a person notification to a non-person address is refused before any connection", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-recipient-class-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  createPersonRoot(base, "david");
  setContact({ base, name: "david", email: "david@example.com", timezone: "America/Chicago" });
  optIn({ base, name: "david", channel: "email", evidence: "said yes" });
  const transport = {
    name: "network",
    send: () => fetch("https://api.resend.com/emails", { method: "POST" }),
  };
  await assert.rejects(
    notifyPerson({
      base,
      name: "david",
      to: "rae@acme.com",
      subject: "hi",
      text: "hi",
      transport,
      now: new Date("2026-11-02T17:00:00Z"),
    }),
    (error) => error.code === "NOTIFY_ADDRESS_NOT_REGISTERED"
  );
  assert.deepEqual(connections, []);
});
