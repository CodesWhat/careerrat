import assert from "node:assert/strict";
import { test } from "node:test";

import { createApplyDriver } from "../src/core/apply/apply-driver.mjs";
import { EASY_APPLY_STEPS, findAdvanceButtonRef } from "../src/core/apply/form-fill.mjs";

const GREENHOUSE_URL = "https://job-boards.greenhouse.io/example/jobs/123";
const EASY_APPLY_URL = "https://www.linkedin.com/jobs/view/4123456789/?easyApplyModal=true";

const CONFIG = {
  profile: { candidate: { full_name: "Sam Rivera", phone: "555-0100" } },
  honesty: {},
  "form-defaults": { work_authorization: "Yes" },
};

function refsOf(entries) {
  const refs = {};
  for (const [ref, role, name, required = false] of entries) refs[ref] = { role, name, required };
  return refs;
}

// Fake ops: `steps` is the sequence of NormalizedSnapshot fixtures ops.snapshot()
// cycles through. clickButton advances the cursor (wrapping, so short fixture
// lists can be reused across a longer step cap test) and every call — in
// call order — is appended to `log`, mirroring the ordered-command-log style
// the orca executor tests already use.
function createFakeOps(steps) {
  const log = [];
  let idx = 0;
  return {
    log,
    ops: {
      async openTab() {
        log.push({ op: "openTab" });
        return { pageId: "page-1" };
      },
      async snapshot() {
        log.push({ op: "snapshot" });
        return steps[idx];
      },
      async fillField(args) {
        log.push({ op: "fillField", ...args });
      },
      async selectOption(args) {
        log.push({ op: "selectOption", ...args });
      },
      async toggleField(args) {
        log.push({ op: "toggleField", ...args });
      },
      async clickButton(args) {
        log.push({ op: "clickButton", ...args });
        idx = (idx + 1) % steps.length;
      },
      async upload(args) {
        log.push({ op: "upload", ...args });
      },
      async screenshot() {
        log.push({ op: "screenshot" });
        return { data: "", format: "png" };
      },
    },
  };
}

function makeDriver({ ops, maxEasyApplySteps, captureQuestionsImpl, saveScreenshotImpl } = {}) {
  return createApplyDriver({
    ops,
    providerLabel: "orca",
    repoRoot: "/repo",
    env: {},
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => CONFIG,
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl:
      captureQuestionsImpl ??
      (async ({ questions }) => ({
        questions,
        excluded: [],
        demographicSectionPresent: false,
      })),
    saveScreenshotImpl: saveScreenshotImpl ?? (() => "workspace/captures/fake-confirmation.png"),
    maxEasyApplySteps,
  });
}

test("single-page flow fills resolvable fields and stops awaiting-submit, same as today", async () => {
  const snapshot = {
    origin: GREENHOUSE_URL,
    pageText: "Application form",
    refs: refsOf([
      ["e1", "textbox", "First Name", true],
      ["e2", "textbox", "Phone Number", false],
      ["e3", "combobox", "Work authorization", false],
    ]),
  };
  const { ops, log } = createFakeOps([snapshot]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-1",
    application: { id: "app-1" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.available, true);
  assert.equal(result.verified, false);
  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.provider, "orca");
  assert.equal(result.session.filledCount, 3);
  assert.deepEqual(result.session.unresolved, []);
  assert.deepEqual(result.session.blockers, []);
  assert.equal("stepIndex" in result.session, false);
  assert.equal("stepKey" in result.session, false);

  const fillIndexes = log
    .map((entry, index) =>
      ["fillField", "selectOption", "toggleField"].includes(entry.op) ? index : -1
    )
    .filter((index) => index >= 0);
  assert.equal(fillIndexes.length, 3, "every resolvable field is filled or selected");
  for (const index of fillIndexes) {
    assert.equal(log[index - 1].op, "snapshot", "every field action re-snapshots first");
  }
});

test("LinkedIn Easy Apply: fills step 1, advances, fills step 2, ends awaiting-submit", async () => {
  const contactStep = {
    origin: EASY_APPLY_URL,
    pageText: "Contact info",
    refs: refsOf([
      ["e1", "textbox", "First Name", true],
      ["e2", "button", "Continue", false],
    ]),
  };
  const reviewStep = {
    origin: EASY_APPLY_URL,
    pageText: "Review your application",
    refs: refsOf([
      ["e3", "textbox", "Phone Number", true],
      ["e4", "button", "Submit application", false],
    ]),
  };
  const { ops, log } = createFakeOps([contactStep, reviewStep]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-linkedin",
    application: { id: "app-linkedin" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(
    result.session.filledCount,
    2,
    "sums step 1's fill pass (First Name) and step 2's fill pass (Phone Number), not just the last step"
  );
  assert.equal(result.session.stepIndex, 2);
  assert.equal(result.session.stepKey, EASY_APPLY_STEPS[1].key);
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e2" }]
  );
});

test("adversarial submit-label variant: 'Submit and continue' is disqualified even though it also reads as an advance label, so the legit Next is clicked instead", async () => {
  // Pre-fix, EASY_APPLY_SUBMIT_LABELS is scanned as an exact-needle list
  // (["submit application"]) — "submit and continue" doesn't contain that
  // needle, so it falls through to the advance-label check and matches
  // "continue". The token-based guard must disqualify it on "submit" alone.
  assert.equal(
    findAdvanceButtonRef({
      refs: refsOf([
        ["e1", "button", "Submit and continue", false],
        ["e2", "button", "Next", false],
      ]),
    }),
    "e2"
  );

  const step = {
    origin: EASY_APPLY_URL,
    pageText: "Additional questions",
    refs: refsOf([
      ["e1", "button", "Submit and continue", false],
      ["e2", "button", "Next", false],
    ]),
  };
  const { ops, log } = createFakeOps([step, step]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-submit-and-continue",
    application: { id: "app-submit-and-continue" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(
    result.state,
    "blocked",
    "same fixture both steps: stall guard trips, not a submit click"
  );
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e2" }],
    "only the legit Next ref is ever clicked, never the submit-flavored one"
  );
});

test("adversarial submit-label variant: 'Review and submit' is disqualified even though it also reads as an advance label ('review'), so nothing is clicked", async () => {
  // Pre-fix, "review and submit" doesn't contain the exact needle "submit
  // application" either, so it falls through and matches "review" — the
  // token-based guard must disqualify it on "submit" alone.
  assert.equal(
    findAdvanceButtonRef({
      refs: refsOf([["e1", "button", "Review and submit", false]]),
    }),
    null
  );

  const step = {
    origin: EASY_APPLY_URL,
    pageText: "Review your application",
    refs: refsOf([["e1", "button", "Review and submit", false]]),
  };
  const { ops, log } = createFakeOps([step]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-review-and-submit",
    application: { id: "app-review-and-submit" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "the only advance-vocabulary button on the page is submit-flavored, so nothing was clicked"
  );
});

test("advance button vanishes between the fill pass and the fresh pre-click snapshot: no click, terminal state from the fresh snapshot", async () => {
  const withButton = {
    origin: EASY_APPLY_URL,
    pageText: "Additional questions",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const withoutButton = {
    origin: `${EASY_APPLY_URL}&step=stale`,
    pageText: "Additional questions (button removed)",
    refs: refsOf([]),
  };
  const log = [];
  let snapshotCalls = 0;
  const ops = {
    async openTab() {
      log.push({ op: "openTab" });
      return { pageId: "page-1" };
    },
    async snapshot() {
      snapshotCalls += 1;
      log.push({ op: "snapshot" });
      // Entry snapshot and fillStep's internal finalSnapshot both still see
      // the button; the fresh pre-click snapshot taken right before the
      // advance decision sees it gone.
      return snapshotCalls <= 2 ? withButton : withoutButton;
    },
    async fillField(args) {
      log.push({ op: "fillField", ...args });
    },
    async selectOption(args) {
      log.push({ op: "selectOption", ...args });
    },
    async toggleField(args) {
      log.push({ op: "toggleField", ...args });
    },
    async clickButton(args) {
      log.push({ op: "clickButton", ...args });
    },
    async upload(args) {
      log.push({ op: "upload", ...args });
    },
    async screenshot() {
      log.push({ op: "screenshot" });
      return { data: "", format: "png" };
    },
  };
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-vanish",
    application: { id: "app-vanish" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(
    result.currentUrl,
    withoutButton.origin,
    "terminal state reports the fresh snapshot"
  );
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "the advance button vanished before the click, so nothing was clicked"
  );
});

test("cumulative counts across Easy Apply steps: fillStep totals sum, not overwrite", async () => {
  const stepOne = {
    origin: EASY_APPLY_URL,
    pageText: "Contact info",
    refs: refsOf([
      ["e1", "textbox", "First Name", false],
      ["e2", "textbox", "Phone Number", false],
      ["e3", "button", "Continue", false],
    ]),
  };
  const stepTwo = {
    origin: EASY_APPLY_URL,
    pageText: "Work authorization & sponsorship",
    refs: refsOf([
      ["e4", "combobox", "Work authorization", false],
      ["e5", "button", "Submit application", false],
    ]),
  };
  const { ops, log } = createFakeOps([stepOne, stepTwo]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-cumulative",
    application: { id: "app-cumulative" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(
    result.session.filledCount,
    3,
    "sums step one's 2 fields (First Name, Phone Number) and step two's 1 field (Work authorization)"
  );
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e3" }]
  );
});

test("mid-loop confirmation: a post-advance snapshot that reads as a confirmation page returns submitted/verified, not awaiting-submit", async () => {
  const stepA = {
    origin: EASY_APPLY_URL,
    pageText: "Additional questions",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const confirmationStep = {
    origin: `${EASY_APPLY_URL}&submitted=true`,
    pageText: "Your application has been submitted",
    refs: refsOf([]),
  };
  const { ops, log } = createFakeOps([stepA, confirmationStep]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-midconfirm",
    application: { id: "app-midconfirm" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.available, true);
  assert.equal(result.verified, true);
  assert.equal(result.state, "submitted");
  assert.equal(result.confirmation, "your application has been submitted");
  assert.equal(
    log.some((entry) => entry.op === "screenshot"),
    true,
    "the submitted path captures a confirmation screenshot instead of treating the page as a form step"
  );
});

test("stall guard: unchanged snapshot fingerprint after the advance click blocks instead of looping", async () => {
  const stepA = {
    origin: EASY_APPLY_URL,
    pageText: "Step A",
    refs: refsOf([
      ["e1", "textbox", "Notes", false],
      ["e2", "button", "Next", false],
    ]),
  };
  const stepAAgain = {
    origin: EASY_APPLY_URL,
    pageText: "Step A again",
    refs: refsOf([
      ["e5", "textbox", "Notes", false],
      ["e6", "button", "Next", false],
    ]),
  };
  const { ops, log } = createFakeOps([stepA, stepAAgain]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-stall",
    application: { id: "app-stall" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /did not advance after clicking "Next"/);
  assert.equal(log.filter((entry) => entry.op === "clickButton").length, 1, "no retry loop");
});

test("step cap: more steps than maxEasyApplySteps blocks and the cap is respected", async () => {
  const stepP = {
    origin: EASY_APPLY_URL,
    pageText: "P",
    refs: refsOf([["eP", "button", "Next", false]]),
  };
  const stepQ = {
    origin: EASY_APPLY_URL,
    pageText: "Q",
    refs: refsOf([["eQ", "button", "Continue", false]]),
  };
  const { ops } = createFakeOps([stepP, stepQ]);
  const execute = makeDriver({ ops, maxEasyApplySteps: 3 });

  const result = await execute({
    applicationId: "app-cap",
    application: { id: "app-cap" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /more steps than CareerRat will advance automatically/);
  assert.equal(result.session.stepIndex, 4);
  assert.equal(result.session.stepKey, null);
});

test("unresolved required field on an intermediate step blocks immediately without clicking advance", async () => {
  const step = {
    origin: EASY_APPLY_URL,
    pageText: "Additional questions",
    refs: refsOf([
      ["e1", "textbox", "Favorite existential dread", true],
      ["e2", "button", "Next", false],
    ]),
  };
  const { ops, log } = createFakeOps([step]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-unresolved",
    application: { id: "app-unresolved" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /Favorite existential dread/);
  assert.deepEqual(result.session.unresolved, [
    { label: "Favorite existential dread", required: true },
  ]);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "advance is never clicked past a blank required field"
  );
});

test("question capture is re-evaluated per step: a later step's custom questions trigger capture even after earlier steps had none", async () => {
  const step1 = {
    origin: EASY_APPLY_URL,
    pageText: "Contact info",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const step2 = {
    origin: EASY_APPLY_URL,
    pageText: "Resume",
    refs: refsOf([["e2", "button", "Continue", false]]),
  };
  const step3 = {
    origin: EASY_APPLY_URL,
    pageText: "Additional questions",
    refs: refsOf([["e3", "textbox", "Why do you want this role?", false]]),
  };
  const { ops } = createFakeOps([step1, step2, step3]);
  const captures = [];
  const execute = makeDriver({
    ops,
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return { questions: input.questions, excluded: [], demographicSectionPresent: false };
    },
  });

  const result = await execute({
    applicationId: "app-questions",
    application: { id: "app-questions" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "site-required" },
  });

  assert.equal(result.state, "questions-captured");
  assert.equal(result.session.stepIndex, 3);
  assert.equal(result.session.stepKey, EASY_APPLY_STEPS[2].key);
  assert.equal(captures.length, 1);
  assert.deepEqual(
    captures[0].questions.map(({ label }) => label),
    ["Why do you want this role?"]
  );
});
