// CR103: outreach / recruiter-reply drafts run the same fact check as every other artifact.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deliverDraftToPerson } from "../src/core/comms/deliver-draft.mjs";
import { checkDraftFacts } from "../src/core/comms/draft-facts.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { commUpsert } from "../src/core/db/verbs/comm.mjs";
import { candidateEvidenceMerge, candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import { createPersonRoot, personEnv } from "../src/core/paths/people.mjs";
import { optIn, setContact } from "../src/core/people/contact.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOON = new Date("2026-11-02T17:00:00Z");

const CLEAN = "Thanks Rae. I cut onboarding time by 30% at Northwind, and Tuesday works for me.";
const INVENTED = "Thanks Rae. I grew revenue 450% at Globex using Kubernetes, and Tuesday works.";

function fixture(t, body) {
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
  };
  commUpsert({ repoRoot: REPO_ROOT, env, row: comm });
  return { base, env, comm };
}

test("a clean draft passes the fact check", (t) => {
  const { env, comm } = fixture(t, CLEAN);
  const result = checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body: CLEAN });
  assert.equal(result.ok, true, result.messages.join("; "));
});

test("a draft with an invented metric, employer and tool is held with findings", (t) => {
  const { env, comm } = fixture(t, INVENTED);
  const result = checkDraftFacts({ repoRoot: REPO_ROOT, env, comm, body: INVENTED });
  assert.equal(result.ok, false);
  const text = result.messages.join("\n");
  assert.match(text, /450/);
  assert.match(text, /Globex/);
  assert.match(text, /Kubernetes/);
});

test("delivery holds an invented-fact draft and sends a clean one unchanged", async (t) => {
  const bad = fixture(t, INVENTED);
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
