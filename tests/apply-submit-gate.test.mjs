import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { evaluateSubmitGate, runApplySubmit } from "../src/core/apply/submit-gate.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { getRow } from "../src/core/db/verbs/shared.mjs";
import { appUpsert, candidateSetupInitialize } from "../src/core/db/verbs.mjs";

const GREENHOUSE_URL = "https://job-boards.greenhouse.io/example/jobs/123";

function refsOf(entries) {
  const refs = {};
  for (const [ref, role, name, required = false, details = {}] of entries) {
    refs[ref] = { role, name, required, ...details };
  }
  return refs;
}

function readyForm(overrides = {}) {
  return {
    origin: GREENHOUSE_URL,
    pageText: "Apply for Engineer at Example. Review your application.",
    refs: refsOf([
      ["e1", "textbox", "Full name", true, { stateKnown: true, value: "Sam Rivera" }],
      ["e2", "textbox", "Email", true, { stateKnown: true, value: "sam@example.com" }],
      ["e3", "textbox", "Resume", true, { fileInput: true, fileAttached: true }],
      ["e4", "button", "Submit application"],
    ]),
    ...overrides,
  };
}

function confirmationPage() {
  return {
    origin: `${GREENHOUSE_URL}/confirmation`,
    pageText: "Thank you. Application received. We got your application.",
    refs: {},
  };
}

// Fake session browser: snapshots are served in order (the last one repeats);
// every call is logged so a test can prove Submit was or wasn't pressed.
function fakeOps(snapshots) {
  const log = [];
  let index = 0;
  let clicked = false;
  return {
    log,
    clicks: () => log.filter((entry) => entry.op === "clickButton"),
    ops: {
      async snapshot() {
        log.push({ op: "snapshot" });
        const step = clicked ? snapshots.after : snapshots.before;
        const current = Array.isArray(step) ? step[Math.min(index, step.length - 1)] : step;
        if (clicked) index += 1;
        return current;
      },
      async clickButton(args) {
        log.push({ op: "clickButton", ...args });
        clicked = true;
      },
    },
  };
}

describe("apply submit gate", () => {
  const cleanup = [];
  after(() => {
    closeAll();
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  function workspace(row = {}) {
    const dir = mkdtempSync(join(tmpdir(), "careerrat-submit-gate-"));
    cleanup.push(dir);
    mkdirSync(join(dir, "templates"), { recursive: true });
    const env = {
      ...process.env,
      CAREERRAT_HOME: join(dir, "home"),
      CAREERRAT_NO_UPDATE_CHECK: "1",
    };
    candidateSetupInitialize({ repoRoot: dir, env });
    appUpsert({
      repoRoot: dir,
      env,
      row: {
        id: "app-1",
        company: "Acme",
        role: "Engineer",
        status: "evaluated",
        link: GREENHOUSE_URL,
        evaluation: { gate: "keep", evaluatedAt: "2026-11-01T00:00:00.000Z" },
        ...row,
      },
    });
    return { dir, env };
  }

  function run(ctx, snapshots, extra = {}) {
    const fake = fakeOps(snapshots);
    const promise = runApplySubmit({
      repoRoot: ctx.dir,
      env: ctx.env,
      id: "app-1",
      pageId: "page-1",
      opsImpl: fake.ops,
      loadSubmitModeImpl: () => "auto",
      sleepImpl: async () => {},
      ...extra,
    });
    return { fake, promise };
  }

  function stored(ctx) {
    return getRow(openDb({ repoRoot: ctx.dir, env: ctx.env }), "applications", "app-1");
  }

  function assertRefused(result, fake, code) {
    assert.equal(result.ok, false);
    assert.equal(result.submitted, false);
    assert.equal(result.state, "refused");
    assert.ok(
      result.reasons.some((reason) => reason.code === code),
      `expected ${code}, got ${result.reasons.map((reason) => reason.code).join(",")}`
    );
    assert.equal(fake.clicks().length, 0, "Submit must not be pressed");
    assert.match(result.message, /\S/);
  }

  it("presses Submit once when every gate passes and sees the confirmation", async () => {
    const ctx = workspace();
    const { fake, promise } = run(ctx, { before: readyForm(), after: confirmationPage() });
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.state, "submitted");
    assert.equal(result.verified, true);
    assert.deepEqual(
      fake.clicks().map((click) => [click.pageId, click.ref]),
      [["page-1", "e4"]]
    );
    assert.ok(stored(ctx).submitAttemptedAt, "attempt marker is written before the click");
  });

  it("reports submitted-unverified when no confirmation page appears", async () => {
    const ctx = workspace();
    const { fake, promise } = run(ctx, { before: readyForm(), after: readyForm() });
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.state, "submitted-unverified");
    assert.equal(result.verified, false);
    assert.equal(fake.clicks().length, 1);
    assert.match(stored(ctx).statusNote, /no confirmation/i);
  });

  it("refuses and hands the job over when a required field is blank", async () => {
    const ctx = workspace();
    const form = readyForm({
      refs: refsOf([
        ["e1", "textbox", "Full name", true, { stateKnown: true, value: "" }],
        ["e3", "textbox", "Resume", true, { fileInput: true, fileAttached: true }],
        ["e4", "button", "Submit application"],
      ]),
    });
    const { fake, promise } = run(ctx, { before: form });
    const result = await promise;
    assertRefused(result, fake, "REQUIRED_FIELDS_BLANK");
    assert.equal(result.reasons[0].items[0].label, "Full name");
    assert.equal(result.handedToPerson, true);
    assert.equal(stored(ctx).status, "manual-apply");
    assert.match(stored(ctx).statusNote, /Full name/);
  });

  it("refuses when a required upload is not confirmed attached", async () => {
    const ctx = workspace();
    const form = readyForm({
      refs: refsOf([
        ["e1", "textbox", "Full name", true, { stateKnown: true, value: "Sam" }],
        ["e3", "textbox", "Resume", true, { fileInput: true, fileAttached: false }],
        ["e4", "button", "Submit application"],
      ]),
    });
    const { fake, promise } = run(ctx, { before: form });
    assertRefused(await promise, fake, "UPLOAD_MISSING");
  });

  it("refuses when there is no positively labelled submit button", async () => {
    const ctx = workspace();
    const form = readyForm({
      refs: refsOf([
        ["e1", "textbox", "Full name", true, { stateKnown: true, value: "Sam" }],
        ["e4", "button", "Send"],
      ]),
    });
    const { fake, promise } = run(ctx, { before: form });
    assertRefused(await promise, fake, "NO_SUBMIT_BUTTON");
  });

  it("refuses when two submit controls make the target ambiguous", async () => {
    const ctx = workspace();
    const form = readyForm({
      refs: refsOf([
        ["e1", "textbox", "Full name", true, { stateKnown: true, value: "Sam" }],
        ["e4", "button", "Submit application"],
        ["e5", "button", "Submit application"],
      ]),
    });
    const { fake, promise } = run(ctx, { before: form });
    assertRefused(await promise, fake, "NO_SUBMIT_BUTTON");
  });

  it("hands off on a captcha or verification step", async () => {
    const ctx = workspace();
    const { fake, promise } = run(ctx, {
      before: readyForm({ pageText: "Please verify you are human. Complete the captcha." }),
    });
    assertRefused(await promise, fake, "HUMAN_CHALLENGE");
  });

  it("refuses without a KEEP verdict", async () => {
    const ctx = workspace({ evaluation: { gate: "cut", evaluatedAt: "2026-11-01T00:00:00.000Z" } });
    const { fake, promise } = run(ctx, { before: readyForm() });
    assertRefused(await promise, fake, "GATE_NOT_CLEARED");
  });

  it("refuses while an application question still needs the person's answer", async () => {
    const ctx = workspace({
      packetManifest: {
        gaps: [
          {
            kind: "answers",
            code: "ANSWER_CONFIRMATION_REQUIRED",
            questionId: "q1",
            message: 'Answer "Why us?"',
          },
        ],
      },
    });
    const { fake, promise } = run(ctx, { before: readyForm() });
    assertRefused(await promise, fake, "ANSWER_NEEDED");
  });

  it("refuses in manual submit mode even when the form is complete", async () => {
    const ctx = workspace();
    const { fake, promise } = run(
      ctx,
      { before: readyForm() },
      { loadSubmitModeImpl: () => "manual" }
    );
    assertRefused(await promise, fake, "MANUAL_SUBMIT_MODE");
  });

  it("treats an unreadable submit setting as manual", async () => {
    const ctx = workspace();
    const { fake, promise } = run(
      ctx,
      { before: readyForm() },
      {
        loadSubmitModeImpl: () => {
          throw new Error("unreadable");
        },
      }
    );
    assertRefused(await promise, fake, "MANUAL_SUBMIT_MODE");
  });

  it("never submits on LinkedIn, whatever the page looks like", async () => {
    const ctx = workspace({ link: "https://www.linkedin.com/jobs/view/4123456789/" });
    const form = readyForm({ origin: "https://www.linkedin.com/jobs/view/4123456789/" });
    const { fake, promise } = run(ctx, { before: form });
    assertRefused(await promise, fake, "LINKEDIN_NEVER_AUTO_SUBMIT");
  });

  it("refuses a page on an unrelated site", async () => {
    const ctx = workspace();
    const { fake, promise } = run(ctx, {
      before: readyForm({ origin: "https://evil.example.test/apply" }),
    });
    assertRefused(await promise, fake, "UNTRUSTED_ORIGIN");
  });

  it("never presses Submit a second time", async () => {
    const ctx = workspace({ submitAttemptedAt: "2026-11-01T00:00:00.000Z" });
    const { fake, promise } = run(ctx, { before: readyForm() });
    const result = await promise;
    assertRefused(result, fake, "ALREADY_SUBMITTED");
    assert.equal(stored(ctx).status, "evaluated", "status is not walked to manual-apply");
  });

  it("refuses with SESSION_UNREACHABLE when the page can't be read", async () => {
    const ctx = workspace();
    const fake = fakeOps({ before: readyForm() });
    fake.ops.snapshot = async () => {
      throw new Error("no such page");
    };
    const result = await runApplySubmit({
      repoRoot: ctx.dir,
      env: ctx.env,
      id: "app-1",
      pageId: "page-1",
      opsImpl: fake.ops,
      loadSubmitModeImpl: () => "auto",
      sleepImpl: async () => {},
    });
    assertRefused(result, fake, "SESSION_UNREACHABLE");
  });

  it("refuses without a provider it can reach (no injected ops, no Orca)", async () => {
    const ctx = workspace();
    const result = await runApplySubmit({
      repoRoot: ctx.dir,
      env: { ...ctx.env, ORCA_WORKTREE_ID: "", ORCA_CLI_COMMAND: "" },
      id: "app-1",
      pageId: "page-1",
      loadSubmitModeImpl: () => "auto",
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.code === "SESSION_UNREACHABLE"));
  });

  it("evaluateSubmitGate reports every failed check, not just the first", () => {
    const verdict = evaluateSubmitGate({
      snapshot: readyForm({
        pageText: "Complete the captcha.",
        refs: refsOf([["e1", "textbox", "Name", true, { stateKnown: true, value: "" }]]),
      }),
      application: { link: GREENHOUSE_URL, evaluation: { gate: "keep" } },
      submitMode: "manual",
    });
    assert.equal(verdict.ok, false);
    const codes = verdict.refusals.map((reason) => reason.code);
    for (const code of [
      "MANUAL_SUBMIT_MODE",
      "HUMAN_CHALLENGE",
      "REQUIRED_FIELDS_BLANK",
      "NO_SUBMIT_BUTTON",
    ]) {
      assert.ok(codes.includes(code), `missing ${code}`);
    }
  });
});

describe("careerrat apply CLI", () => {
  it("prints help and routes through the main binary", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("node", ["bin/careerrat.mjs", "apply", "--help"], {
      encoding: "utf8",
      env: { ...process.env, CAREERRAT_NO_UPDATE_CHECK: "1" },
    });
    assert.match(out, /apply.mjs submit <job-id> --page/);
    assert.match(out, /MANUAL_SUBMIT_MODE/);
  });

  it("exits 2 with JSON when the job id is missing", async () => {
    const { spawnSync } = await import("node:child_process");
    const out = spawnSync("node", ["src/cli/apply.mjs", "submit", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CAREERRAT_NO_UPDATE_CHECK: "1" },
    });
    assert.equal(out.status, 2);
    assert.equal(JSON.parse(out.stdout).state, "error");
  });
});
