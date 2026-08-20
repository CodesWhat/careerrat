import assert from "node:assert/strict";
import { test } from "node:test";

import { createApplyDriver } from "../src/core/apply/apply-driver.mjs";
import { EASY_APPLY_STEPS, findAdvanceButtonRef } from "../src/core/apply/form-fill.mjs";

const GREENHOUSE_URL = "https://job-boards.greenhouse.io/example/jobs/123";
const EASY_APPLY_URL = "https://www.linkedin.com/jobs/view/4123456789/?easyApplyModal=true";
const WORKDAY_URL = "https://acme.wd5.myworkdayjobs.com/en-US/External/job/req-123";

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

function makeDriver({ ops, maxFormSteps, captureQuestionsImpl, saveScreenshotImpl } = {}) {
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
    maxFormSteps,
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

test("SSO/social-login and bare sign-in controls are never returned as an advance button, even though 'continue'/'sign in' read as advance-ish vocabulary", () => {
  // Direction 1 of the coordinator's SSO-click-risk fix: the loop now calls
  // findAdvanceButtonRef unconditionally for every provider (previously
  // LinkedIn Easy Apply only), which means a single-page Greenhouse/Ashby/
  // Lever form's own "Continue with LinkedIn" / "Sign in with Google" control
  // is now visible to it too. None of these may ever be treated as a page
  // advance: that would drive the browser onto a real third-party auth page.
  const ssoOrAccountLabels = [
    "Continue with LinkedIn",
    "Sign in with Google",
    "Sign up with Facebook",
    "Log in with Apple",
    "Register with Okta",
    "Sign In",
    "Sign Up",
    "Log In",
    "Register",
  ];
  for (const label of ssoOrAccountLabels) {
    assert.equal(
      findAdvanceButtonRef({ refs: refsOf([["e1", "button", label, false]]) }),
      null,
      `"${label}" must never be treated as an advance button`
    );
  }
});

test("'Continue with your application' is not caught by the SSO guard: the provider-name match is specific, not the bare preposition", () => {
  // Direction 2: the fix the coordinator flagged as wrong (disqualifying on
  // "continue with" alone) would have broken this real advance label just
  // because it shares a preposition with a real SSO button. The guard must
  // match on a KNOWN PROVIDER NAME after the preposition, not the preposition
  // itself.
  assert.equal(
    findAdvanceButtonRef({
      refs: refsOf([["e1", "button", "Continue with your application", false]]),
    }),
    "e1"
  );
});

test("a page mixing a legit advance button with an SSO control picks the legit one, never the SSO one", () => {
  assert.equal(
    findAdvanceButtonRef({
      refs: refsOf([
        ["e1", "button", "Continue with LinkedIn", false],
        ["e2", "button", "Next", false],
      ]),
    }),
    "e2"
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

test("step cap: more steps than maxFormSteps blocks and the cap is respected", async () => {
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
  const execute = makeDriver({ ops, maxFormSteps: 3 });

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

test("step cap after real fills reports cumulative counts, not zero", async () => {
  const stepOne = {
    origin: EASY_APPLY_URL,
    pageText: "Contact info",
    refs: refsOf([
      ["e1", "textbox", "First Name", false],
      ["e2", "button", "Next", false],
    ]),
  };
  const stepTwo = {
    origin: EASY_APPLY_URL,
    pageText: "More contact info",
    refs: refsOf([
      ["e3", "textbox", "Phone Number", false],
      ["e4", "button", "Continue", false],
    ]),
  };
  const { ops } = createFakeOps([stepOne, stepTwo]);
  const execute = makeDriver({ ops, maxFormSteps: 2 });

  const result = await execute({
    applicationId: "app-cap-counts",
    application: { id: "app-cap-counts" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /more steps than CareerRat will advance automatically/);
  assert.equal(result.session.filledCount, 2, "both steps' fills are reported at the cap");
  assert.equal(result.session.uploadedCount, 0);
});

test("a dead cached tab is dropped and reopened instead of poisoning every later run", async () => {
  const snapshot = {
    origin: GREENHOUSE_URL,
    pageText: "Application form",
    refs: refsOf([["e1", "textbox", "First Name", false]]),
  };
  const log = [];
  let pageCounter = 0;
  const deadPages = new Set();
  const ops = {
    async openTab() {
      pageCounter += 1;
      const pageId = `page-${pageCounter}`;
      log.push({ op: "openTab", pageId });
      return { pageId };
    },
    async snapshot({ pageId }) {
      if (deadPages.has(pageId)) throw new Error("This application's browser tab was closed.");
      log.push({ op: "snapshot", pageId });
      return snapshot;
    },
    async fillField(args) {
      log.push({ op: "fillField", ...args });
    },
    async selectOption() {},
    async toggleField() {},
    async clickButton() {},
    async upload() {},
    async screenshot() {
      return { data: "", format: "png" };
    },
  };
  const execute = makeDriver({ ops });
  const intent = {
    applicationId: "app-heal",
    application: { id: "app-heal" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  };

  const first = await execute(intent);
  assert.equal(first.state, "awaiting-submit");

  deadPages.add("page-1");
  const second = await execute(intent);
  assert.equal(second.state, "awaiting-submit", "the dead tab is replaced, not fatal");
  assert.equal(
    log.filter((entry) => entry.op === "openTab").length,
    2,
    "a fresh tab was opened for the retry"
  );
  assert.ok(
    log.some((entry) => entry.op === "snapshot" && entry.pageId === "page-2"),
    "the retry ran against the fresh tab"
  );
});

// ---------------------------------------------------------------------------
// Generalized multi-step advancement: the loop above is no longer gated to
// LinkedIn Easy Apply by URL. These fixtures drive it over a plain
// job-boards.greenhouse.io host and a myworkdayjobs.com host to prove the
// mechanism (advance-button detection, real-advance verification via
// snapshotFingerprint, and the NEEDS-YOU required-field gate) is genuinely
// portal-agnostic, not a second LinkedIn-only code path wearing a different
// hostname.
// ---------------------------------------------------------------------------

test("generic (non-LinkedIn) multi-step ATS: advances across pages exactly like Easy Apply, ending awaiting-submit with a numeric stepIndex but no LinkedIn stepKey", async () => {
  const pageOne = {
    origin: GREENHOUSE_URL,
    pageText: "Basic info",
    refs: refsOf([
      ["e1", "textbox", "First Name", true],
      ["e2", "button", "Next", false],
    ]),
  };
  const pageTwo = {
    origin: `${GREENHOUSE_URL}?step=2`,
    pageText: "Review your application",
    refs: refsOf([
      ["e3", "textbox", "Phone Number", false],
      ["e4", "button", "Submit application", false],
    ]),
  };
  const { ops, log } = createFakeOps([pageOne, pageTwo]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-generic-multistep",
    application: { id: "app-generic-multistep" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(
    result.session.filledCount,
    2,
    "sums page one's First Name and page two's Phone Number, not just the final page"
  );
  assert.equal(result.session.stepIndex, 2, "stepIndex is portal-agnostic: it advanced once");
  assert.equal(
    result.session.stepKey,
    null,
    "stepKey is LinkedIn Easy Apply's own section vocabulary; a generic ATS never borrows it"
  );
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e2" }],
    "only the legit Next ref is clicked: Submit application is disqualified same as on LinkedIn"
  );
});

test("generic multi-step ATS: a page that fails validation and doesn't advance blocks via the fingerprint stall guard, same as Easy Apply", async () => {
  const stepA = {
    origin: GREENHOUSE_URL,
    pageText: "Basic info",
    refs: refsOf([
      ["e1", "textbox", "Notes", false],
      ["e2", "button", "Continue", false],
    ]),
  };
  // A re-render of the SAME page after a rejected click (validation failure,
  // or a plain no-op), different refs but the same fingerprint-relevant
  // shape (one textbox, one button) would still be a genuine stall; here the
  // fixture reuses the exact ref set to make the "nothing actually changed"
  // case unambiguous.
  const stepAAgain = {
    origin: GREENHOUSE_URL,
    pageText: "Basic info (unchanged)",
    refs: refsOf([
      ["e1", "textbox", "Notes", false],
      ["e2", "button", "Continue", false],
    ]),
  };
  const { ops, log } = createFakeOps([stepA, stepAAgain]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-generic-stall",
    application: { id: "app-generic-stall" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /did not advance after clicking "Continue"/);
  assert.equal(
    log.filter((entry) => entry.op === "clickButton").length,
    1,
    "no retry loop: the stall guard isn't LinkedIn-specific, it fires on the fingerprint alone"
  );
});

test("generic multi-step ATS: a page-specific required field with no resolvable answer is a NEEDS YOU handoff, not a guessed advance", async () => {
  const pageOne = {
    origin: GREENHOUSE_URL,
    pageText: "Custom screening",
    refs: refsOf([
      ["e1", "textbox", "Describe a time you debugged a distributed system at 3am", true],
      ["e2", "button", "Next", false],
    ]),
  };
  const { ops, log } = createFakeOps([pageOne]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-generic-unresolved",
    application: { id: "app-generic-unresolved" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /Describe a time you debugged a distributed system at 3am/);
  assert.deepEqual(result.session.unresolved, [
    {
      label: "Describe a time you debugged a distributed system at 3am",
      required: true,
    },
  ]);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "Next is never clicked past a blank required field, even off LinkedIn"
  );
});

test("generic multi-step ATS: a review-page ending with only a disqualified Submit control reaches awaiting-submit instead of looping or guessing a click", async () => {
  const pageOne = {
    origin: WORKDAY_URL,
    pageText: "Contact information",
    refs: refsOf([
      ["e1", "textbox", "First Name", true],
      ["e2", "button", "Next", false],
    ]),
  };
  const reviewPage = {
    origin: `${WORKDAY_URL}?step=review`,
    pageText: "Review your application before submitting",
    refs: refsOf([["e3", "button", "Submit", false]]),
  };
  const { ops, log } = createFakeOps([pageOne, reviewPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-workday-review",
    application: { id: "app-workday-review" },
    postingUrl: WORKDAY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.stepIndex, 2);
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e2" }],
    "the review page's own Submit is disqualified vocabulary, never clicked"
  );
});

test("Workday-shaped multi-step flow: the account-creation blocker fires on whichever page introduces it, not just the entry page", async () => {
  const landingPage = {
    origin: WORKDAY_URL,
    pageText: "Get started",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const accountPage = {
    origin: `${WORKDAY_URL}?step=account`,
    pageText: "Create your candidate account",
    refs: refsOf([
      ["e2", "textbox", "Email", true],
      ["e3", "textbox", "Password", true],
      ["e4", "button", "Create Account", false],
    ]),
  };
  const { ops, log } = createFakeOps([landingPage, accountPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-workday-account",
    application: { id: "app-workday-account" },
    postingUrl: WORKDAY_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /account creation or password entry/);
  assert.equal(
    log.filter((entry) => entry.op === "fillField").length,
    0,
    "the account page's fields are never filled: the blocker fires before fillStep runs for that page"
  );
  assert.equal(
    log.filter((entry) => entry.op === "clickButton").length,
    1,
    "only the first page's Next was ever clicked; nothing on the account page was"
  );
});

test("a single-page ATS form with a social-login control blocks with an honest sign-in reason instead of clicking through to a third-party auth page", async () => {
  // The exact risk the generalized loop introduced: this GREENHOUSE_URL page
  // has both a fillable field and a "Continue with LinkedIn" control. Before
  // the SSO guard, findAdvanceButtonRef would have matched "continue" and the
  // loop would have clicked through to thirdPartyAuthPage and started trying
  // to fill a real identity provider's page. Two independent fixture pages
  // (rather than one reused snapshot) are used specifically so a regression
  // that DID click through would show up as a genuine page-2 fill attempt,
  // not just a fingerprint-stall false pass.
  const formPage = {
    origin: GREENHOUSE_URL,
    pageText: "Apply to this role",
    refs: refsOf([
      ["e1", "textbox", "First Name", true],
      ["e2", "button", "Continue with LinkedIn", false],
    ]),
  };
  const thirdPartyAuthPage = {
    origin: "https://www.linkedin.com/oauth/authorize?client_id=example",
    pageText: "Sign in to LinkedIn",
    refs: refsOf([]),
  };
  const { ops, log } = createFakeOps([formPage, thirdPartyAuthPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-sso-risk",
    application: { id: "app-sso-risk" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /third-party or account sign-in/);
  assert.equal(result.currentUrl, GREENHOUSE_URL, "never navigated to the third-party auth page");
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "the SSO control is never clicked"
  );
  assert.equal(
    log.some((entry) => entry.op === "fillField"),
    false,
    "the flow halts before even attempting to fill First Name: same over-blocking bias as the password/account-creation field gate"
  );
});

// ---------------------------------------------------------------------------
// Cross-origin advance detection: label matching cannot see where a click
// actually lands. "Continue" is legitimate wizard vocabulary, but it is also
// what "Continue browsing jobs", a consent wall, or an unrelated redirect
// says, and the fingerprint check alone cannot tell that apart from a real
// advance, since a navigation off the application changes the fingerprint
// too. These tests exercise apply-driver.mjs's hostname comparison between
// preAdvanceSnapshot.origin and nextSnapshot.origin, ordered after the
// existing post-advance confirmation check.
// ---------------------------------------------------------------------------

test("an advance click that lands on a different hostname blocks, names the destination, and never fills the wrong page", async () => {
  const pageOne = {
    origin: GREENHOUSE_URL,
    pageText: "Basic info",
    refs: refsOf([
      ["e1", "textbox", "Phone Number", false],
      ["e2", "button", "Continue", false],
    ]),
  };
  // A different host entirely, standing in for the risk the coordinator
  // flagged: an innocuous "Continue" label whose destination is wrong
  // ("Continue browsing jobs", an interstitial, an unrelated redirect). Its
  // own Phone Number field is a plant: if the loop wrongly proceeded to a
  // second iteration, this is the field it would fill.
  const crossHostPage = {
    origin: "https://careers.partner-portal.example/redirect",
    pageText: "Explore more open roles",
    refs: refsOf([["e3", "textbox", "Phone Number", false]]),
  };
  const { ops, log } = createFakeOps([pageOne, crossHostPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-cross-origin",
    application: { id: "app-cross-origin" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /left the application/);
  assert.match(result.reason, /job-boards\.greenhouse\.io/);
  assert.match(result.reason, /careers\.partner-portal\.example/);
  assert.deepEqual(
    log.filter((entry) => entry.op === "fillField"),
    [{ op: "fillField", pageId: "page-1", ref: "e1", value: "555-0100" }],
    "only page one's own Phone Number is ever filled: the cross-host page's field is never touched"
  );
});

test("a same-host advance with a changed path still advances normally", async () => {
  // The regression guard: proves the hostname check isn't blocking every
  // advance, only ones that leave the host. Path and query differ (a real
  // wizard's normal behavior); the host does not.
  const pageOne = {
    origin: GREENHOUSE_URL,
    pageText: "Basic info",
    refs: refsOf([
      ["e1", "textbox", "Phone Number", false],
      ["e2", "button", "Continue", false],
    ]),
  };
  const pageTwo = {
    origin: "https://job-boards.greenhouse.io/example/jobs/123/step-2",
    pageText: "Review your application",
    refs: refsOf([["e3", "button", "Submit application", false]]),
  };
  const { ops, log } = createFakeOps([pageOne, pageTwo]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-same-host",
    application: { id: "app-same-host" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.stepIndex, 2);
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e2" }],
    "the advance click still happens: same host, different path, is a normal wizard step"
  );
});

test("a post-advance confirmation on a different host still reports confirmed, not blocked as a wrong destination", async () => {
  // The ordering guard from the coordinator's point 1: a legitimate
  // submit-and-confirm can land on a different host (an embedded form
  // completing on the ATS's own board host, for one), and confirmationCheck
  // must get first look so that case is never mistaken for a wrong
  // destination. Uses a real "Continue" click, not a disqualified Submit
  // button, so the cross-host page is actually reached and this exercises
  // the ordering, not just the click-disqualification guard.
  const pageOne = {
    origin: GREENHOUSE_URL,
    pageText: "Additional questions",
    refs: refsOf([["e1", "button", "Continue", false]]),
  };
  const confirmationOnOtherHost = {
    origin: "https://boards.greenhouse.io/confirmation",
    pageText: "Thank you for applying",
    refs: refsOf([]),
  };
  const { ops, log } = createFakeOps([pageOne, confirmationOnOtherHost]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-confirm-cross-host-real",
    application: { id: "app-confirm-cross-host-real" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.available, true);
  assert.equal(result.verified, true);
  assert.equal(result.state, "submitted");
  // confirmationCheck matches the URL path segment before it ever reads
  // pageText, and this fixture's origin ends in "/confirmation" (one of
  // CONFIRMATION_URL_SEGMENTS), so that is the signal it reports.
  assert.equal(result.confirmation, "/confirmation");
  assert.equal(
    log.some((entry) => entry.op === "screenshot"),
    true,
    "the confirmation path still captures evidence even though the host changed"
  );
});

test("a snapshot with a malformed or missing origin does not throw and does not spuriously block", async () => {
  const pageOne = {
    origin: undefined,
    pageText: "Basic info",
    refs: refsOf([["e1", "button", "Continue", false]]),
  };
  const pageTwo = {
    origin: "not a valid url at all",
    pageText: "More info",
    refs: refsOf([["e2", "textbox", "Notes", false]]),
  };
  const { ops, log } = createFakeOps([pageOne, pageTwo]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-malformed-origin",
    application: { id: "app-malformed-origin" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(
    result.state,
    "awaiting-submit",
    "unparseable origins fall through to the fingerprint check, not a spurious block"
  );
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e1" }],
    "the advance click still happens: an unparseable origin is not evidence of anything, so it never blocks on its own"
  );
});
