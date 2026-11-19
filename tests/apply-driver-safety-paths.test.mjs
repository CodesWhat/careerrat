import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApplyDriver } from "../src/core/apply/apply-driver.mjs";

const GREENHOUSE_URL = "https://job-boards.greenhouse.io/example/jobs/123";
const EVIL_URL = "https://evil.example.test/apply";

const CONFIG = {
  profile: { candidate: { full_name: "Sam Rivera", phone: "555-0100" } },
  honesty: {},
  "form-defaults": {},
};

function refsOf(entries) {
  const refs = {};
  for (const [ref, role, name, required = false, details = {}] of entries) {
    refs[ref] = { role, name, required, ...details };
  }
  return refs;
}

// Minimal copy of the tests/apply-driver.test.mjs fake ops: `snapshot` is
// overridable per test, every call lands in `log` in order.
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
      async focusTab(args) {
        log.push({ op: "focusTab", ...args });
      },
    },
  };
}

function makeDriver({ ops, repoRoot = "/repo" }) {
  return createApplyDriver({
    ops,
    providerLabel: "orca",
    repoRoot,
    env: {},
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => CONFIG,
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
    saveScreenshotImpl: () => "workspace/captures/fake-confirmation.png",
    confirmationTimeoutMs: 30,
    confirmationPollMs: 5,
    sleepImpl: async () => {},
  });
}

const SUBMIT_FORM = {
  origin: GREENHOUSE_URL,
  pageText: "Application form",
  refs: refsOf([
    ["e1", "textbox", "First Name", true],
    ["e2", "button", "Submit application", false],
  ]),
};
const STILL_FORM = { ...SUBMIT_FORM, pageText: "Application form (processing)" };
const CONFIRMATION = {
  origin: `${GREENHOUSE_URL}/confirmation`,
  pageText: "Thank you for applying",
  refs: refsOf([]),
};
const AUTO_REQUEST = {
  applicationId: "app-safety",
  application: { id: "app-safety" },
  postingUrl: GREENHOUSE_URL,
  questionCapture: { state: "captured" },
  submitMode: "auto",
  prepareOnly: false,
};
const submitClicks = (log) =>
  log.filter((entry) => entry.op === "clickButton" && entry.ref === "e2");

// The Submit click dispatches (the page advances) and then the browser command
// throws, the way a navigation tears down the CDP call.
function throwAfterSubmitDispatch(ops) {
  const baseClick = ops.clickButton;
  ops.clickButton = async (args) => {
    await baseClick(args);
    if (args.ref === "e2") throw new Error("Target closed during navigation");
  };
}

test("a Submit click that throws after dispatch with a confirmation shown is submitted, and no later run clicks again", async () => {
  const { ops, log } = createFakeOps([SUBMIT_FORM, CONFIRMATION]);
  throwAfterSubmitDispatch(ops);
  const execute = makeDriver({ ops });

  const first = await execute(AUTO_REQUEST);
  assert.equal(first.state, "submitted");
  assert.equal(first.verified, true);
  assert.equal(submitClicks(log).length, 1);

  await execute(AUTO_REQUEST);
  assert.equal(submitClicks(log).length, 1, "a later run never clicks Submit a second time");
});

test("a Submit click that throws with no confirmation is submitted-unverified, and no later run clicks again", async () => {
  const { ops, log } = createFakeOps([SUBMIT_FORM, STILL_FORM]);
  throwAfterSubmitDispatch(ops);
  const execute = makeDriver({ ops });

  const first = await execute(AUTO_REQUEST);
  assert.equal(first.state, "submitted-unverified");
  assert.equal(first.verified, false);
  assert.equal(submitClicks(log).length, 1);

  const second = await execute(AUTO_REQUEST);
  assert.equal(second.state, "submitted-unverified");
  assert.equal(submitClicks(log).length, 1, "a later run never clicks Submit a second time");
});

// A resume upload group plus a fillable field. The fill is what lets a test
// change the page between the first snapshot and the pre-upload re-snapshot.
const UPLOAD_FORM = (origin) => ({
  origin,
  pageText: 'Application form\n- button "Resume" [required, ref=e3]',
  refs: refsOf([
    ["e1", "textbox", "First Name", true],
    ["e3", "button", "Resume", true],
    ["e2", "button", "Submit application", false],
  ]),
});

async function runUploadFlow({ originAfterFill }) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-safety-paths-"));
  try {
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeFileSync(
      join(repoRoot, "workspace", "tailored", "resume.pdf"),
      "%PDF-1.4\nfake test document\n%%EOF\n"
    );
    const { ops, log } = createFakeOps([UPLOAD_FORM(GREENHOUSE_URL), CONFIRMATION]);
    ops.snapshot = async () => {
      log.push({ op: "snapshot" });
      const filled = log.some((entry) => entry.op === "fillField");
      return UPLOAD_FORM(filled ? originAfterFill : GREENHOUSE_URL);
    };
    const result = await makeDriver({ ops, repoRoot })({
      ...AUTO_REQUEST,
      applicationId: "app-upload-origin",
      application: {
        id: "app-upload-origin",
        link: GREENHOUSE_URL,
        artifacts: { resumePdf: "workspace/tailored/resume.pdf" },
      },
    });
    return { result, log };
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("a form that moves to an untrusted origin right before the resume upload gets no upload and no Submit", async () => {
  const { result, log } = await runUploadFlow({ originAfterFill: EVIL_URL });
  assert.equal(result.session.uploadedCount, 0);
  assert.equal(log.filter((entry) => entry.op === "upload").length, 0);
  assert.equal(submitClicks(log).length, 0);
  assert.notEqual(result.state, "submitted");
});

test("control: the same flow on the trusted origin uploads the resume once", async () => {
  const { result, log } = await runUploadFlow({ originAfterFill: GREENHOUSE_URL });
  assert.equal(log.filter((entry) => entry.op === "fillField").length, 1);
  assert.equal(log.filter((entry) => entry.op === "upload").length, 1);
  assert.equal(result.session.uploadedCount, 1);
});
