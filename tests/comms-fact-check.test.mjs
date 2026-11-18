// CR103: outreach / recruiter-reply drafts run the same fact check as every other artifact.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { deliverDraftToPerson } from "../src/core/comms/deliver-draft.mjs";
import { checkDraftFacts } from "../src/core/comms/draft-facts.mjs";
import { closeAll, openDb, requireDb } from "../src/core/db/connection.mjs";
import { commSetDraft, commUpsert } from "../src/core/db/verbs/comm.mjs";
import { putRow } from "../src/core/db/verbs/shared.mjs";
import { candidateEvidenceMerge, candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import { createPersonRoot, personEnv } from "../src/core/paths/people.mjs";
import { optIn, setContact } from "../src/core/people/contact.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOON = new Date("2026-11-02T17:00:00Z");

const CLEAN = "Thanks Rae. I cut onboarding time by 30% at Northwind, and Tuesday works for me.";
const INVENTED = "Thanks Rae. I grew revenue 450% at Globex using Kubernetes, and Tuesday works.";

// `legacy` writes the row straight to the table, the way a draft stored before the
// check existed (or by a path that skipped it) looks.
function fixture(t, body, extra = {}, { legacy = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-commfacts-")));
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
  candidateSetupInitialize({ repoRoot: REPO_ROOT, env });
  candidateEvidenceMerge({
    repoRoot: REPO_ROOT,
    env,
    claims: [{ claim: "Cut onboarding time by 30% at Northwind", evidence: "Resume" }],
  });
  setContact({ base, name: "david", email: "david@example.com", timezone: "America/Chicago" });
  optIn({ base, name: "david", channel: "email", evidence: "said yes" });
  const comm = {
    id: "comm-rae",
    company: "Acme",
    role: "Engineer",
    channel: "email",
    subject: "Interview availability",
    status: "drafted",
    participants: [{ name: "Rae", email: "rae@acme.com" }],
    draft: { subject: "Re: Interview availability", body },
    messages: [],
    ...extra,
  };
  if (legacy) putRow(requireDb({ repoRoot: REPO_ROOT, env }), "communications", comm.id, comm, {});
  else commUpsert({ repoRoot: REPO_ROOT, env, row: comm });
  return { base, env, comm };
}

test("a clean draft passes the fact check", (t) => {
  const { env, comm } = fixture(t, CLEAN);
  const result = checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body: CLEAN });
  assert.equal(result.ok, true, result.messages.join("; "));
});

test("a draft with an invented metric, employer and tool is held with findings", (t) => {
  const { env, comm } = fixture(t, INVENTED, {}, { legacy: true });
  const result = checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body: INVENTED });
  assert.equal(result.ok, false);
  const text = result.messages.join("\n");
  assert.match(text, /450/);
  assert.match(text, /Globex/);
  assert.match(text, /Kubernetes/);
});

test("delivery holds an invented-fact draft and sends a clean one unchanged", async (t) => {
  const bad = fixture(t, INVENTED, {}, { legacy: true });
  const sent = [];
  const transportOverride = {
    transport: {
      name: "fake",
      async send(message) {
        sent.push(message);
        return { id: "fake-1" };
      },
    },
  };
  await assert.rejects(
    deliverDraftToPerson({
      repoRoot: REPO_ROOT,
      env: bad.env,
      base: bad.base,
      name: "david",
      id: "comm-rae",
      now: NOON,
      transportOverride,
    }),
    (error) => error.code === "COMMUNICATION_DRAFT_FACTS" && /Globex/.test(error.message)
  );
  assert.equal(sent.length, 0);

  const ok = fixture(t, CLEAN);
  const result = await deliverDraftToPerson({
    repoRoot: REPO_ROOT,
    env: ok.env,
    base: ok.base,
    name: "david",
    id: "comm-rae",
    now: NOON,
    transportOverride,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /cut onboarding time by 30%/i);
  assert.ok(result.subject);
});

const KUBE_INBOUND = {
  direction: "inbound",
  at: "2026-11-01T10:00:00Z",
  from: "Rae",
  summary: "The role requires Kubernetes and 10 years of experience.",
  body: "The role requires Kubernetes and 10 years of experience. When can you talk?",
};
const KUBE_DRAFT = "Thanks Rae. I have 10 years of experience using Kubernetes.";

test("inbound recruiter text is not evidence for the candidate's own claims", (t) => {
  const { env, comm } = fixture(t, KUBE_DRAFT, { messages: [KUBE_INBOUND] }, { legacy: true });
  const result = checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body: KUBE_DRAFT });
  assert.equal(result.ok, false);
  assert.match(result.messages.join("\n"), /Kubernetes/);
  assert.match(result.messages.join("\n"), /10/);
});

test("a span quoted back from the inbound message and the thread company are allowed", (t) => {
  const body = 'Thanks Rae. On "requires Kubernetes" I\'d like to hear more about Acme.';
  const { env, comm } = fixture(t, body, { messages: [KUBE_INBOUND] });
  const result = checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body });
  assert.equal(result.ok, true, result.messages.join("; "));
});

test("inbound-supported claims are held at delivery", async (t) => {
  const { env, base } = fixture(t, KUBE_DRAFT, { messages: [KUBE_INBOUND] }, { legacy: true });
  await assert.rejects(
    deliverDraftToPerson({
      repoRoot: REPO_ROOT,
      env,
      base,
      name: "david",
      id: "comm-rae",
      now: NOON,
      transportOverride: { transport: { name: "fake", send: async () => ({ id: "x" }) } },
    }),
    (error) => error.code === "COMMUNICATION_DRAFT_FACTS"
  );
});

test("commSetDraft refuses an invented-fact draft at the storage point", (t) => {
  const { env } = fixture(t, CLEAN);
  assert.throws(
    () => commSetDraft({ repoRoot: REPO_ROOT, env, id: "comm-rae", draft: { body: INVENTED } }),
    (error) => error.code === "COMMUNICATION_DRAFT_FACTS" && /Globex/.test(error.message)
  );
  assert.doesNotThrow(() =>
    commSetDraft({ repoRoot: REPO_ROOT, env, id: "comm-rae", draft: { body: CLEAN } })
  );
});

test("compose-link handoff and send refuse a draft stored before the check existed", async (t) => {
  const { env } = fixture(t, INVENTED, {}, { legacy: true });
  for (const type of ["communication.handoff", "communication.send"]) {
    await assert.rejects(
      executeWorkspaceIntent({
        repoRoot: REPO_ROOT,
        env,
        intent: { type, entity: { type: "communication", id: "comm-rae" } },
        sendCommunicationImpl: async () => {
          throw new Error("must not send");
        },
      }),
      (error) => error.code === "COMMUNICATION_DRAFT_FACTS",
      type
    );
  }
});

test("availability replies with days, times, dates and durations pass; metrics still fail", (t) => {
  const { env, comm } = fixture(t, CLEAN);
  const check = (body) => checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body });
  for (const body of [
    "Tuesday at 3 works for me.",
    "I can do Wednesday at 2:30pm CT, or Nov 5th between 10 and 11 am. 30 minutes is fine.",
    "Thursday the 7th at 4 PST works.",
  ]) {
    const result = check(body);
    assert.equal(result.ok, true, `${body}: ${result.messages.join("; ")}`);
  }
  for (const body of [
    "Tuesday at 3 works. I grew revenue 40% last year.",
    "Friday works. I managed a $2M budget.",
    "Tuesday works. I led 12 engineers.",
  ]) {
    assert.equal(check(body).ok, false, body);
  }
});

test("achievement metrics are not scheduling: hours saved and ordinal finishes still fail", (t) => {
  const { env, comm } = fixture(t, CLEAN);
  const check = (body) => checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body });
  for (const body of [
    "I saved 900 hours annually.",
    "I finished 17th in the competition.",
    "I worked 40 hours per week on it.",
  ]) {
    assert.equal(check(body).ok, false, body);
  }
  for (const body of [
    "Tuesday at 3 works for me.",
    "Free Nov 21st 2-4pm ET.",
    "A 30 minute call works.",
    "How about the 3rd of December, or 12/3 at 15:00?",
    "I can do a 45-minute chat for 1 hour if needed.",
  ]) {
    const result = check(body);
    assert.equal(result.ok, true, `${body}: ${result.messages.join("; ")}`);
  }
});

test("a quoted inbound span is exempt only inside the quotes", (t) => {
  const inbound = {
    ...KUBE_INBOUND,
    summary: "Kubernetes and 10 years",
    body: "Kubernetes and 10 years",
  };
  const body = 'On "Kubernetes and 10 years" I have 10 years of experience with Kubernetes.';
  const { env, comm } = fixture(t, CLEAN, { messages: [inbound] });
  const result = checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body });
  assert.equal(result.ok, false);
  assert.match(result.messages.join("\n"), /Kubernetes/);
  assert.match(result.messages.join("\n"), /10/);
});

test("inbound terms are allowed in non-claim sentences, not in candidate-claim ones", (t) => {
  const { env, comm } = fixture(t, CLEAN, { messages: [KUBE_INBOUND] });
  const check = (body) => checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body });
  for (const body of [
    "I'd like to discuss Kubernetes.",
    "Happy to talk about the Kubernetes migration you mentioned.",
  ]) {
    const result = check(body);
    assert.equal(result.ok, true, `${body}: ${result.messages.join("; ")}`);
  }
  for (const body of [
    "I have 10 years of experience using Kubernetes.",
    "I built Kubernetes clusters.",
    "Thanks Rae. My 10 years with Kubernetes fit well.",
  ]) {
    assert.equal(check(body).ok, false, body);
  }
});

test("commUpsert fact-checks a new or changed draft but not unchanged drafts or inbound ingest", (t) => {
  const { env, comm } = fixture(t, CLEAN);
  const upsert = (row) => commUpsert({ repoRoot: REPO_ROOT, env, row });
  assert.throws(
    () => upsert({ ...comm, draft: { body: INVENTED } }),
    (error) => error.code === "COMMUNICATION_DRAFT_FACTS" && /Globex/.test(error.message)
  );
  assert.throws(
    () => upsert({ ...comm, id: "comm-new", draft: INVENTED }),
    (error) => error.code === "COMMUNICATION_DRAFT_FACTS"
  );
  // unchanged draft, and a row without a draft, still write
  assert.doesNotThrow(() => upsert({ ...comm, summary: "touched" }));
  const { draft: _draft, ...noDraft } = comm;
  assert.doesNotThrow(() => upsert({ ...noDraft, id: "comm-none" }));
  // inbound text carrying facts the candidate lacks is not treated as a draft
  assert.doesNotThrow(() => upsert({ ...comm, summary: "inbound", messages: [KUBE_INBOUND] }));
});
