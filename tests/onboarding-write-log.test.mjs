import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendOnboardingWriteLog,
  onboardingConfigEntries,
  onboardingEvidenceEntries,
} from "../src/core/agent/onboarding-write-log.mjs";
import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { WORKSPACE_THREAD_ID, workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";
import { computeEvidenceWrite } from "../src/core/profile/evidence-writer.mjs";
import { classifyConfigChange } from "../src/core/profile/loosening.mjs";

const cleanupRoots = [];
const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-onboarding-write-log-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "templates"), { recursive: true });
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  for (const entry of [...CANDIDATE_FILES, ...OPTIONAL_CANDIDATE_FILES]) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(repoRoot, entry.templatePath));
    copyFileSync(join(REAL_ROOT, entry.schemaPath), join(repoRoot, entry.schemaPath));
  }
  for (const entry of COPY_ONLY_CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(repoRoot, entry.templatePath));
  }
  for (const file of [
    "templates/AGENTS.md",
    "templates/automation.example.yml",
    "config/automation.schema.json",
    "config/resume-extract.schema.json",
  ]) {
    copyFileSync(join(REAL_ROOT, file), join(repoRoot, file));
  }
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

// The same sequence the retired onboarding route ran for a tracked save:
// read the doc, patch it (plus an optional mirror doc), then log one entry set.
function saveOnboardingConfig(repoRoot, name, patch, { mirror } = {}) {
  const ctx = { repoRoot, env: {} };
  const before = candidateConfigGet(ctx)[name];
  const mirrorBefore = mirror ? candidateConfigGet(ctx)[mirror.doc] : undefined;
  candidateConfigPatch({ ...ctx, name, patch });
  if (mirror) candidateConfigPatch({ ...ctx, name: mirror.doc, patch: mirror.patch });
  const docs = candidateConfigGet(ctx);
  return appendOnboardingWriteLog({
    ...ctx,
    entries: onboardingConfigEntries({
      name,
      patch,
      before,
      after: docs[name],
      mirror: mirror
        ? {
            name: mirror.doc,
            patch: mirror.patch,
            before: mirrorBefore,
            after: docs[mirror.doc],
          }
        : undefined,
    }),
  });
}

function saveOnboardingEvidence(repoRoot, claims) {
  const ctx = { repoRoot, env: {} };
  const beforeClaims = candidateConfigGet(ctx).evidence?.claims || [];
  const result = candidateEvidenceMerge({ ...ctx, claims });
  const logged =
    result.added > 0
      ? appendOnboardingWriteLog({
          ...ctx,
          entries: onboardingEvidenceEntries({
            beforeClaims,
            afterClaims: candidateConfigGet(ctx).evidence?.claims || [],
          }),
        })
      : undefined;
  return { ...result, logged };
}

function threadMessages(repoRoot) {
  return workspaceThreadRead({ repoRoot, env: {} }).messages;
}

function logged(repoRoot) {
  return threadMessages(repoRoot).filter((message) => message.metadata?.writer === "onboarding");
}

function undoIntent(message, index) {
  return {
    type: "knowledge.revert",
    entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    input: { messageId: message.id, index },
  };
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an onboarding config save appends one action_result with an entry per value and an Undo", async () => {
  const repoRoot = tempRepo();
  const before = candidateConfigGet({ repoRoot, env: {} }).profile.candidate;
  const loggedId = saveOnboardingConfig(repoRoot, "profile", {
    candidate: { full_name: "Ada Lovelace", email: "ada@example.test" },
  });
  assert.ok(loggedId);

  const messages = logged(repoRoot);
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.kind, "action_result");
  assert.equal(message.id, loggedId);
  assert.equal(message.artifacts.length, 2);
  assert.ok(message.artifacts.every((entry) => entry.kind === "knowledge_write"));
  assert.ok(message.artifacts.every((entry) => entry.source.kind === "onboarding"));
  assert.deepEqual(message.artifacts.map((entry) => entry.path).sort(), [
    "candidate.email",
    "candidate.full_name",
  ]);
  assert.equal(message.metadata.nextActions.length, 2);
  assert.equal(message.metadata.nextActions[0].intent.type, "knowledge.revert");

  // Undo through knowledge.revert puts the earlier value back.
  const index = message.artifacts.findIndex((entry) => entry.path === "candidate.full_name");
  await executeWorkspaceIntent({ repoRoot, env: {}, intent: undoIntent(message, index) });
  const after = candidateConfigGet({ repoRoot, env: {} }).profile.candidate;
  assert.equal(after.full_name, before.full_name);
  assert.equal(after.email, "ada@example.test");
});

test("the evidence firewall rejects a placeholder claim and an accepted seed logs with an Undo", async () => {
  const repoRoot = tempRepo();
  const plan = computeEvidenceWrite({
    newClaim: { claim: "Led the [Company] migration", evidence: "Stated during setup" },
    currentClaims: [],
  });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /placeholder/i);

  const good = computeEvidenceWrite({
    newClaim: {
      claim: "Cut deploy time from 40 minutes to 8",
      evidence: "Stated during setup",
    },
    currentClaims: [],
  });
  assert.equal(good.ok, true);
  const result = saveOnboardingEvidence(repoRoot, [good.claim]);
  assert.equal(result.added, 1);
  const claims = candidateConfigGet({ repoRoot, env: {} }).evidence.claims;
  assert.deepEqual(
    claims.map((claim) => claim.claim),
    ["Cut deploy time from 40 minutes to 8"]
  );

  const [message] = logged(repoRoot);
  assert.equal(message.artifacts.length, 1);
  assert.equal(message.artifacts[0].target, "evidence");
  assert.equal(message.artifacts[0].op, "add");
  assert.equal(message.artifacts[0].id, claims[0].id);

  await executeWorkspaceIntent({ repoRoot, env: {}, intent: undoIntent(message, 0) });
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).evidence.claims.length, 0);
});

test("lowering the pay floor loosens a boundary; a first value or a raise does not", () => {
  const verdict = (before, minimum) =>
    classifyConfigChange(
      "profile",
      { compensation: before },
      { compensation: { minimum_base: minimum } }
    );
  assert.equal(verdict({}, 150000).loosens, false);
  assert.equal(verdict({ minimum_base: 150000 }, 160000).loosens, false);
  const lowered = verdict({ minimum_base: 160000 }, 120000);
  assert.equal(lowered.loosens, true);
  assert.equal(lowered.reasons.length, 1);
});

test("removing a do-not-claim entry loosens the honesty boundary, adding one does not", () => {
  const tools = (doNotClaim) => ({ tools: { do_not_claim: doNotClaim } });
  assert.equal(classifyConfigChange("honesty", tools([]), tools(["Rust"])).loosens, false);
  assert.equal(
    classifyConfigChange("honesty", tools(["Rust"]), tools(["Rust", "Go"])).loosens,
    false
  );
  assert.equal(classifyConfigChange("honesty", tools(["Rust", "Go"]), tools(["Go"])).loosens, true);
});

test("the first confirmed tools on a fresh workspace do not loosen anything", () => {
  const { honesty } = candidateConfigGet({ repoRoot: tempRepo(), env: {} });
  const after = { ...honesty, tools: { ...honesty.tools, confirmed: ["Postgres", "Kafka"] } };
  assert.equal(classifyConfigChange("honesty", honesty, after).loosens, false);
});

test("a location save logs mode_preferences_confirmed as a companion and Undo restores both", async () => {
  const repoRoot = tempRepo();
  const before = candidateConfigGet({ repoRoot, env: {} }).profile.location;
  assert.notEqual(before.mode_preferences_confirmed, true);
  saveOnboardingConfig(repoRoot, "profile", { location: { remote: false } });
  const [message] = logged(repoRoot);
  assert.equal(message.artifacts.length, 1);
  const [entry] = message.artifacts;
  assert.equal(entry.path, "location.remote");
  assert.equal(entry.companions[0].path, "location.mode_preferences_confirmed");
  assert.equal(
    candidateConfigGet({ repoRoot, env: {} }).profile.location.mode_preferences_confirmed,
    true
  );

  await executeWorkspaceIntent({ repoRoot, env: {}, intent: undoIntent(message, 0) });
  const restored = candidateConfigGet({ repoRoot, env: {} }).profile.location;
  assert.equal(restored.remote, before.remote);
  assert.notEqual(restored.mode_preferences_confirmed, true);
});

const AUTHORIZATION_MIRROR = {
  doc: "form-defaults",
  patch: { work_authorization: "Yes" },
};

test("work authorization with a mirror logs one entry spanning both docs; Undo restores both", async () => {
  const repoRoot = tempRepo();
  const docs = () => candidateConfigGet({ repoRoot, env: {} });
  const before = {
    profile: structuredClone(docs().profile.authorization),
    form: structuredClone(docs()["form-defaults"]),
  };
  saveOnboardingConfig(
    repoRoot,
    "profile",
    { authorization: { work_authorized: true } },
    { mirror: AUTHORIZATION_MIRROR }
  );
  assert.equal(docs().profile.authorization.work_authorized, true);
  assert.equal(docs()["form-defaults"].work_authorization, "Yes");

  const messages = logged(repoRoot);
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.artifacts.length, 1);
  assert.equal(message.artifacts[0].companions[0].name, "form-defaults");

  await executeWorkspaceIntent({ repoRoot, env: {}, intent: undoIntent(message, 0) });
  assert.equal(docs().profile.authorization.work_authorized, before.profile.work_authorized);
  assert.equal(docs()["form-defaults"].work_authorization, before.form.work_authorization);
});

test("a mirrored authorization Undo refuses when either doc changed since", async () => {
  for (const stale of ["profile", "form-defaults"]) {
    const repoRoot = tempRepo();
    saveOnboardingConfig(
      repoRoot,
      "profile",
      { authorization: { work_authorized: true } },
      { mirror: AUTHORIZATION_MIRROR }
    );
    const [message] = logged(repoRoot);
    const name = stale === "profile" ? "profile" : "form-defaults";
    const patch =
      stale === "profile"
        ? { authorization: { work_authorized: false } }
        : { work_authorization: "No" };
    candidateConfigPatch({ repoRoot, env: {}, name, patch });
    const result = await executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: undoIntent(message, 0),
    });
    assert.equal(JSON.stringify(result).includes("changed again"), true, stale);
    const docs = candidateConfigGet({ repoRoot, env: {} });
    // Neither doc was touched by the refused Undo.
    assert.equal(docs.profile.authorization.work_authorized, stale === "profile" ? false : true);
    assert.equal(docs["form-defaults"].work_authorization, stale === "profile" ? "Yes" : "No");
  }
});
