import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApplyDriver } from "../src/core/apply/apply-driver.mjs";
import { EASY_APPLY_STEPS, findAdvanceButtonRef } from "../src/core/apply/form-fill.mjs";

const GREENHOUSE_URL = "https://job-boards.greenhouse.io/example/jobs/123";
const ASHBY_URL = "https://jobs.ashbyhq.com/curri/d616afe4-311f-4c73-8dc9-87c40f8c7ea8";
const EASY_APPLY_URL = "https://www.linkedin.com/jobs/view/4123456789/?easyApplyModal=true";
const WORKDAY_URL = "https://acme.wd5.myworkdayjobs.com/en-US/External/job/req-123";

const CONFIG = {
  profile: { candidate: { full_name: "Sam Rivera", phone: "555-0100" } },
  honesty: {},
  "form-defaults": { work_authorization: "Yes" },
};

function refsOf(entries) {
  const refs = {};
  for (const [ref, role, name, required = false, details = {}] of entries) {
    refs[ref] = { role, name, required, ...details };
  }
  return refs;
}

function writeTestPdf(path) {
  writeFileSync(path, "%PDF-1.4\nfake test document\n%%EOF\n");
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
      async selectDeclineOption(args) {
        log.push({ op: "selectDeclineOption", ...args });
        return { selectedValue: "Prefer not to answer" };
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

function makeDriver({
  ops,
  maxFormSteps,
  captureQuestionsImpl,
  candidateConfigGetImpl,
  loadAnswerMapImpl,
  saveScreenshotImpl,
  mayRunImpl,
  repoRoot = "/repo",
  env = {},
} = {}) {
  return createApplyDriver({
    ops,
    providerLabel: "orca",
    repoRoot,
    env,
    mayRunImpl: mayRunImpl ?? (() => ({ allowed: true })),
    candidateConfigGetImpl: candidateConfigGetImpl ?? (() => CONFIG),
    loadAnswerMapImpl: loadAnswerMapImpl ?? (async () => new Map()),
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

test("native radio groups use default and reviewed answers, select only their intended options, and verify filled state", async () => {
  const log = [];
  const selected = { workAuthorization: "", sponsorship: "" };
  const snapshot = () => ({
    origin: GREENHOUSE_URL,
    pageText:
      "Work authorization\nWill you now or in the future require sponsorship?\nSubmit application",
    refs: {
      e1: {
        role: "radio-group",
        name: "Work authorization",
        required: true,
        options: [
          { label: "Yes", ref: "e1" },
          { label: "No", ref: "e2" },
        ],
        stateKnown: true,
        value: selected.workAuthorization,
      },
      e2: { role: "radio", name: "No", required: true, field: false },
      e3: {
        role: "radio-group",
        name: "Will you now or in the future require sponsorship?",
        required: true,
        options: [
          { label: "Yes", ref: "e3" },
          { label: "No", ref: "e4" },
        ],
        stateKnown: true,
        value: selected.sponsorship,
      },
      e4: { role: "radio", name: "No", required: true, field: false },
      e5: { role: "button", name: "Submit application", required: false },
    },
  });
  const ops = {
    async openTab() {
      return { pageId: "page-radio" };
    },
    async snapshot() {
      return snapshot();
    },
    async clickButton({ ref }) {
      log.push(ref);
      if (ref === "e1") selected.workAuthorization = "Yes";
      if (ref === "e4") selected.sponsorship = "No";
      if (ref === "e5") throw new Error("Submit must remain untouched");
    },
    async screenshot() {
      throw new Error("No confirmation screenshot is expected before submit");
    },
  };
  const execute = makeDriver({
    ops,
    loadAnswerMapImpl: async () =>
      new Map([["will you now or in the future require sponsorship", "No"]]),
  });

  const result = await execute({
    applicationId: "app-native-radios",
    application: { id: "app-native-radios", link: GREENHOUSE_URL },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.verified, false);
  assert.equal(result.session.filledCount, 2);
  assert.deepEqual(result.session.unresolved, []);
  assert.deepEqual(log, ["e1", "e4"]);
  assert.deepEqual(selected, { workAuthorization: "Yes", sponsorship: "No" });
});

test("a confirmed canonical select option remains resolved when the widget displays a compact value", async () => {
  let selectedCountry = "";
  const snapshot = () => ({
    origin: GREENHOUSE_URL,
    pageText: "Application form\nSubmit application",
    refs: {
      e1: { role: "textbox", name: "First Name", required: true },
      e2: {
        role: "combobox",
        name: "Country",
        required: true,
        typeahead: true,
        stateKnown: true,
        value: selectedCountry,
      },
      e3: { role: "button", name: "Submit application", required: false },
    },
  });
  const log = [];
  const execute = makeDriver({
    ops: {
      async openTab() {
        return { pageId: "page-compact-select" };
      },
      async snapshot() {
        return snapshot();
      },
      async fillField({ ref }) {
        log.push({ op: "fillField", ref });
      },
      async selectOption({ ref, value }) {
        log.push({ op: "selectOption", ref, value });
        selectedCountry = "+1";
        return { selectedValue: "United States +1" };
      },
      async clickButton() {
        throw new Error("Submit must remain untouched");
      },
      async screenshot() {
        throw new Error("No confirmation screenshot is expected before submit");
      },
    },
    loadAnswerMapImpl: async () => new Map([["country", "United States."]]),
  });

  const result = await execute({
    applicationId: "app-compact-select",
    application: { id: "app-compact-select", link: GREENHOUSE_URL },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.filledCount, 2);
  assert.deepEqual(result.session.unresolved, []);
  assert.deepEqual(log, [
    { op: "fillField", ref: "e1" },
    { op: "selectOption", ref: "e2", value: "United States." },
  ]);
});

test("Ashby detail pages open the Application tab before filling and uploading, then stop before submit", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apply-driver-"));
  try {
    const resumePath = join(repoRoot, "workspace", "tailored", "resume.pdf");
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeTestPdf(resumePath);
    const detailPage = {
      origin: ASHBY_URL,
      pageText: "Overview\nApply for this Job",
      refs: refsOf([
        ["e1", "tab", "Overview", false],
        ["e2", "tab", "Application", false],
        ["e3", "link", "Apply for this Job", false],
        ["e4", "button", "Apply for this Job", false],
      ]),
    };
    const formPage = {
      origin: `${ASHBY_URL}/application`,
      pageText:
        '- textbox "Full Name" [required, ref=e5]\n- button "Resume" [required, ref=e6]\n- button "Submit Application" [ref=e7]',
      refs: refsOf([
        ["e5", "textbox", "Full Name", true],
        ["e6", "button", "Resume", true],
        ["e7", "button", "Submit Application", false],
      ]),
    };
    const { ops, log } = createFakeOps([detailPage, formPage]);
    const execute = makeDriver({ ops, repoRoot });

    const result = await execute({
      applicationId: "app-ashby-detail",
      application: {
        id: "app-ashby-detail",
        link: ASHBY_URL,
        artifacts: { resumePdf: "workspace/tailored/resume.pdf" },
      },
      postingUrl: ASHBY_URL,
      questionCapture: { state: "captured" },
      prepareOnly: true,
    });

    assert.equal(result.state, "awaiting-submit");
    assert.equal(result.currentUrl, `${ASHBY_URL}/application`);
    assert.equal(result.session.filledCount, 1);
    assert.equal(result.session.uploadedCount, 1);
    assert.deepEqual(
      log.filter((entry) => entry.op === "clickButton"),
      [{ op: "clickButton", pageId: "page-1", ref: "e2" }],
      "the portal transition clicks only the exact Application tab, never either apply or submit control"
    );
    assert.deepEqual(
      log.filter((entry) => entry.op === "upload"),
      [{ op: "upload", pageId: "page-1", ref: "e6", files: resumePath }]
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a text file disguised as a PDF is never uploaded to a required resume control", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apply-driver-"));
  try {
    const resumePath = join(repoRoot, "workspace", "tailored", "resume.pdf");
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeFileSync(resumePath, "# Resume\n\nThis is markdown, not a PDF.\n");
    const snapshot = {
      origin: GREENHOUSE_URL,
      pageText: 'Application form\n- button "Resume" [required, ref=e1]\nSubmit application',
      refs: refsOf([
        ["e1", "button", "Resume", true],
        ["e2", "button", "Submit Application", false],
      ]),
    };
    const { ops, log } = createFakeOps([snapshot]);
    const execute = makeDriver({ ops, repoRoot });

    const result = await execute({
      applicationId: "app-invalid-pdf",
      application: {
        id: "app-invalid-pdf",
        link: GREENHOUSE_URL,
        artifacts: { resumePdf: "workspace/tailored/resume.pdf" },
      },
      postingUrl: GREENHOUSE_URL,
      questionCapture: { state: "captured" },
      prepareOnly: true,
    });

    assert.equal(result.session.uploadedCount, 0);
    assert.equal(
      log.some((entry) => entry.op === "upload"),
      false
    );
    assert.equal(
      result.session.unresolved.some((entry) => entry.label === "Resume"),
      true
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a .txt source with no PDF or DOCX is never auto-uploaded to a required resume control", async () => {
  // Regression: uploadArtifacts falls back to artifacts.resume (the raw
  // stored source) whenever no PDF or DOCX exists. That source is
  // frequently a well-formed, non-corrupt .txt Markdown file — a valid
  // export/registration artifact per validDocumentArtifact — but it was
  // never meant to be handed to an ATS upload control directly.
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apply-driver-"));
  try {
    const resumePath = join(repoRoot, "workspace", "tailored", "resume.txt");
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeFileSync(resumePath, "# Resume\n\nMarkdown source body.\n", "utf8");
    const snapshot = {
      origin: GREENHOUSE_URL,
      pageText: 'Application form\n- button "Resume" [required, ref=e1]\nSubmit application',
      refs: refsOf([
        ["e1", "button", "Resume", true],
        ["e2", "button", "Submit Application", false],
      ]),
    };
    const { ops, log } = createFakeOps([snapshot]);
    const execute = makeDriver({ ops, repoRoot });

    const result = await execute({
      applicationId: "app-txt-source-only",
      application: {
        id: "app-txt-source-only",
        link: GREENHOUSE_URL,
        artifacts: { resume: "workspace/tailored/resume.txt" },
      },
      postingUrl: GREENHOUSE_URL,
      questionCapture: { state: "captured" },
      prepareOnly: true,
    });

    assert.equal(result.session.uploadedCount, 0);
    assert.equal(
      log.some((entry) => entry.op === "upload"),
      false
    );
    assert.equal(
      result.session.unresolved.some((entry) => entry.label === "Resume"),
      true
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a text file disguised as a DOCX is never uploaded to a required Workday resume control", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apply-driver-"));
  try {
    const resumePath = join(repoRoot, "workspace", "tailored", "resume.docx");
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeFileSync(resumePath, "# Resume\n\nThis is markdown, not a DOCX package.\n");
    const snapshot = {
      origin: WORKDAY_URL,
      pageText: 'Application form\n- button "Resume" [required, ref=e1]\nSubmit application',
      refs: refsOf([
        ["e1", "button", "Resume", true],
        ["e2", "button", "Submit Application", false],
      ]),
    };
    const { ops, log } = createFakeOps([snapshot]);
    const execute = makeDriver({ ops, repoRoot });

    const result = await execute({
      applicationId: "app-invalid-docx",
      application: {
        id: "app-invalid-docx",
        link: WORKDAY_URL,
        artifacts: { resumeDocx: "workspace/tailored/resume.docx" },
      },
      postingUrl: WORKDAY_URL,
      questionCapture: { state: "captured" },
      prepareOnly: true,
    });

    assert.equal(result.session.uploadedCount, 0);
    assert.equal(
      log.some((entry) => entry.op === "upload"),
      false
    );
    assert.equal(
      result.session.unresolved.some((entry) => entry.label === "Resume"),
      true
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("job-board listings open the explicit application form before reporting a supervised handoff", async () => {
  const listingUrl = "https://jobs.example.test/jobs/platform-engineer";
  const applicationUrl = "https://ats.example.test/apply/platform-engineer";
  const listingPage = {
    origin: listingUrl,
    pageText: "Platform Engineer\nSmart Apply with profile\nApply for this position",
    refs: refsOf([
      ["e1", "link", "Smart Apply with profile", false],
      ["e2", "link", "Apply for this position", false, { href: applicationUrl }],
    ]),
  };
  const formPage = {
    origin: applicationUrl,
    pageText: "Application form\nSubmit application",
    refs: refsOf([
      ["e3", "textbox", "Full name", true],
      ["e4", "button", "Submit application", false],
    ]),
  };
  const { ops, log } = createFakeOps([listingPage, formPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-job-board-listing",
    application: { id: "app-job-board-listing", link: listingUrl },
    postingUrl: listingUrl,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.currentUrl, applicationUrl);
  assert.equal(result.session.filledCount, 1);
  assert.deepEqual(
    log.filter(({ op }) => op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e2" }]
  );
  assert.equal(
    log.some(({ op, ref }) => op === "clickButton" && ["e1", "e4"].includes(ref)),
    false
  );
});

test("a generic Apply button is a manual handoff because it could submit immediately", async () => {
  const listingUrl = "https://jobs.example.test/jobs/platform-engineer";
  const confirmationPage = {
    origin: `${listingUrl}/confirmation`,
    pageText: "Thank you for applying",
    refs: {},
  };
  const listingPage = {
    origin: listingUrl,
    pageText: "Platform Engineer\nApply now",
    refs: refsOf([["e1", "button", "Apply now", false]]),
  };
  const { ops, log } = createFakeOps([listingPage, confirmationPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-one-click-apply",
    application: { id: "app-one-click-apply", link: listingUrl },
    postingUrl: listingUrl,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /use the site's Apply button, then resume preparation/i);
  assert.equal(result.verified, false);
  assert.equal(
    log.some(({ op }) => op === "clickButton"),
    false,
    "CareerRat never clicks an Apply button whose result cannot be validated before the click"
  );
  assert.equal(
    log.some(({ op }) => ["fillField", "selectOption", "toggleField", "upload"].includes(op)),
    false
  );
});

test("a listing with no application-form entry never reports awaiting submit", async () => {
  const listingUrl = "https://jobs.example.test/jobs/platform-engineer";
  const listingPage = {
    origin: listingUrl,
    pageText: "Platform Engineer\nShare\nSimilar jobs",
    refs: refsOf([
      ["e1", "button", "Share", false],
      ["e2", "link", "Similar jobs", false],
    ]),
  };
  const { ops } = createFakeOps([listingPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-listing-without-form",
    application: { id: "app-listing-without-form", link: listingUrl },
    postingUrl: listingUrl,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /couldn't find the application form/i);
  assert.equal(result.session.filledCount, 0);
});

test("LinkedIn form preparation uses the supervised-preparation consent capability", async () => {
  const seen = [];
  const { ops } = createFakeOps([]);
  const execute = makeDriver({
    ops,
    mayRunImpl: (request) => {
      seen.push(request);
      return { allowed: false, reasons: ["permission off"] };
    },
  });

  const result = await execute({
    applicationId: "app-consent",
    application: { id: "app-consent" },
    postingUrl: EASY_APPLY_URL,
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.code, "APPLICATION_PREPARATION_PERMISSION_REQUIRED");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].capability, "authenticated_apply_preparation");
  assert.equal(seen[0].platform, "linkedin");
});

test("external ATS preparation checks consent before opening the application", async () => {
  const seen = [];
  const { ops, log } = createFakeOps([]);
  const execute = makeDriver({
    ops,
    mayRunImpl: (request) => {
      seen.push(request);
      return {
        allowed: false,
        reasons: [
          'capability "authenticated_apply_preparation" is disabled (enable: `careerrat automation enable authenticated_apply_preparation --write`)',
          'platform "greenhouse" is off for authenticated_apply_preparation',
        ],
      };
    },
  });

  const result = await execute({
    applicationId: "app-greenhouse-consent",
    application: { id: "app-greenhouse-consent" },
    postingUrl: GREENHOUSE_URL,
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.code, "APPLICATION_PREPARATION_PERMISSION_REQUIRED");
  assert.equal(
    result.reason,
    "Application preparation for Greenhouse is off. Turn it on in Settings before CareerRat opens the form."
  );
  assert.doesNotMatch(result.reason, /authenticated_apply_preparation|careerrat automation|`/i);
  assert.deepEqual(result.session.blockers, [result.reason]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].capability, "authenticated_apply_preparation");
  assert.equal(seen[0].platform, "greenhouse");
  assert.equal(
    log.some((entry) => entry.op === "openTab"),
    false
  );
});

test("a generic Apply redirect blocks an unexpected destination before touching its form", async () => {
  const listingUrl = "https://jobs.example.test/jobs/platform-engineer";
  const listingPage = {
    origin: listingUrl,
    pageText: "Platform Engineer\nApply now",
    refs: refsOf([
      [
        "e1",
        "link",
        "Apply now",
        false,
        { href: "https://apply-redirect.example.test/platform-engineer" },
      ],
    ]),
  };
  const greenhouseForm = {
    origin: GREENHOUSE_URL,
    pageText: "Application form\nNext",
    refs: refsOf([
      ["e2", "textbox", "Full name", true],
      ["e3", "button", "Resume", true],
      ["e4", "button", "Next", false],
    ]),
  };
  const seen = [];
  const { ops, log } = createFakeOps([listingPage, greenhouseForm]);
  const execute = makeDriver({
    ops,
    mayRunImpl: (request) => {
      seen.push(request);
      return { allowed: request.platform === "external_ats" };
    },
  });

  const result = await execute({
    applicationId: "app-destination-consent",
    application: { id: "app-destination-consent", link: listingUrl },
    postingUrl: listingUrl,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.equal(
    result.reason,
    "CareerRat followed Apply to an unexpected application site (https://job-boards.greenhouse.io instead of https://apply-redirect.example.test). It stopped before filling the form."
  );
  assert.equal(result.currentUrl, GREENHOUSE_URL);
  assert.deepEqual(
    seen.map(({ capability, platform }) => ({ capability, platform })),
    [
      { capability: "authenticated_apply_preparation", platform: "external_ats" },
      { capability: "authenticated_apply_preparation", platform: "external_ats" },
    ]
  );
  assert.deepEqual(
    log.filter(({ op }) => ["fillField", "selectOption", "toggleField", "upload"].includes(op)),
    []
  );
  assert.deepEqual(
    log.filter(({ op }) => op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e1" }],
    "the driver clicks only the listing's Apply link and never advances the destination form"
  );
});

test("a generic Apply redirect never fills a different origin in the same external ATS bucket", async () => {
  const listingUrl = "https://jobs.example.test/jobs/platform-engineer";
  const advertisedApplicationUrl = "https://expected-ats.example.test/apply/platform-engineer";
  const attackerUrl = "https://evil.example.test/collect-candidate-data";
  const listingPage = {
    origin: listingUrl,
    pageText: "Platform Engineer\nApply now",
    refs: refsOf([["e1", "link", "Apply now", false, { href: advertisedApplicationUrl }]]),
  };
  const attackerForm = {
    origin: attackerUrl,
    pageText: "Application form\nSubmit application",
    refs: refsOf([
      ["e2", "textbox", "Full name", true],
      ["e3", "button", "Submit application", false],
    ]),
  };
  const { ops, log } = createFakeOps([listingPage, attackerForm]);
  const execute = makeDriver({
    ops,
    mayRunImpl: () => ({ allowed: true }),
  });

  const result = await execute({
    applicationId: "app-unexpected-external-origin",
    application: { id: "app-unexpected-external-origin", link: listingUrl },
    postingUrl: listingUrl,
    questionCapture: {
      state: "captured",
      answerableIds: ["rendered-full-name"],
      excludedIds: [],
    },
    prepareOnly: true,
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.currentUrl, attackerUrl);
  assert.match(result.reason, /unexpected application site/i);
  assert.deepEqual(
    log.filter(({ op }) => ["fillField", "selectOption", "toggleField", "upload"].includes(op)),
    []
  );
  assert.deepEqual(
    log.filter(({ op }) => op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e1" }]
  );
});

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

test("a mid-run cancellation stops before any later browser mutation", async () => {
  const controller = new AbortController();
  const cancellation = new Error("application preparation cancelled");
  const mutations = [];
  let forwardedSignal = null;
  const snapshot = {
    origin: GREENHOUSE_URL,
    pageText: "Application form",
    refs: refsOf([
      ["e1", "textbox", "First Name", true],
      ["e2", "textbox", "Phone Number", false],
      ["e3", "button", "Submit application", false],
    ]),
  };
  const execute = makeDriver({
    ops: {
      async openTab({ signal }) {
        mutations.push({ op: "openTab" });
        forwardedSignal = signal;
        return { pageId: "page-cancelled" };
      },
      async snapshot() {
        return snapshot;
      },
      async fillField({ ref, signal }) {
        mutations.push({ op: "fillField", ref });
        forwardedSignal = signal;
        controller.abort(cancellation);
      },
      async selectOption({ ref }) {
        mutations.push({ op: "selectOption", ref });
      },
      async toggleField({ ref }) {
        mutations.push({ op: "toggleField", ref });
      },
      async clickButton({ ref }) {
        mutations.push({ op: "clickButton", ref });
      },
      async upload({ ref }) {
        mutations.push({ op: "upload", ref });
      },
      async screenshot() {
        mutations.push({ op: "screenshot" });
        return { data: "", format: "png" };
      },
    },
  });

  await assert.rejects(
    () =>
      execute({
        applicationId: "app-cancelled-mid-fill",
        application: { id: "app-cancelled-mid-fill" },
        postingUrl: GREENHOUSE_URL,
        questionCapture: { state: "captured" },
        signal: controller.signal,
      }),
    (error) => error === cancellation
  );

  assert.equal(forwardedSignal, controller.signal);
  assert.deepEqual(mutations, [{ op: "openTab" }, { op: "fillField", ref: "e1" }]);
});

test("a Greenhouse captcha is the final handoff after safe fields and the resume are prepared", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apply-driver-"));
  try {
    const resumePath = join(repoRoot, "workspace", "tailored", "resume.pdf");
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeTestPdf(resumePath);
    const snapshot = {
      origin: GREENHOUSE_URL,
      pageText:
        'Application form\nProtected by reCAPTCHA\n- button "Resume" [required, ref=e3]\nSubmit application',
      refs: refsOf([
        ["e1", "textbox", "Full Name", true],
        ["e2", "textbox", "Race / Ethnicity", false],
        ["e3", "button", "Resume", true],
        ["e4", "button", "Submit Application", false],
      ]),
    };
    const { ops, log } = createFakeOps([snapshot]);
    const execute = makeDriver({ ops, repoRoot });

    const result = await execute({
      applicationId: "app-greenhouse-captcha",
      application: {
        id: "app-greenhouse-captcha",
        link: GREENHOUSE_URL,
        artifacts: { resumePdf: "workspace/tailored/resume.pdf" },
      },
      postingUrl: GREENHOUSE_URL,
      questionCapture: { state: "captured" },
      prepareOnly: true,
    });

    assert.equal(result.state, "blocked");
    assert.match(result.reason, /complete the captcha/i);
    assert.equal(result.session.filledCount, 1);
    assert.equal(result.session.uploadedCount, 1);
    assert.deepEqual(result.session.blockers, ["captcha"]);
    assert.deepEqual(
      log.filter((entry) => entry.op === "fillField"),
      [{ op: "fillField", pageId: "page-1", ref: "e1", value: "Sam Rivera" }],
      "the demographic field stays untouched"
    );
    assert.deepEqual(
      log.filter((entry) => entry.op === "upload"),
      [{ op: "upload", pageId: "page-1", ref: "e3", files: resumePath }]
    );
    assert.equal(
      log.some((entry) => entry.op === "clickButton"),
      false,
      "CareerRat never tries to solve the captcha or click Submit"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("explicit decline_when_available uses the strict decline selector for self-identification", async () => {
  const snapshot = {
    origin: GREENHOUSE_URL,
    pageText: "Application form\nSubmit application",
    refs: refsOf([
      ["e1", "combobox", "Race / Ethnicity", false],
      ["e2", "button", "Submit application", false],
    ]),
  };
  const { ops, log } = createFakeOps([snapshot]);
  const execute = makeDriver({
    ops,
    candidateConfigGetImpl: () => ({
      ...CONFIG,
      "form-defaults": {
        ...CONFIG["form-defaults"],
        eeo_default: "White",
        voluntary_self_identification: {
          enabled: true,
          default_action: "decline_when_available",
          confirmed_at: "2026-08-26T12:00:00Z",
          answers: {},
        },
      },
    }),
  });

  const result = await execute({
    applicationId: "app-voluntary-decline",
    application: { id: "app-voluntary-decline", link: GREENHOUSE_URL },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.filledCount, 1);
  assert.deepEqual(
    log.filter(({ op }) => op === "selectDeclineOption"),
    [
      {
        op: "selectDeclineOption",
        pageId: "page-1",
        ref: "e1",
        label: "Race / Ethnicity",
        typeahead: false,
      },
    ]
  );
  assert.equal(
    log.some(({ op }) => op === "selectOption"),
    false
  );
  assert.equal(
    log.some(({ op }) => op === "clickButton"),
    false
  );
});

test("a provider without strict decline selection leaves the voluntary field cleanly unresolved", async () => {
  const snapshot = {
    origin: GREENHOUSE_URL,
    pageText: "Application form\nSubmit application",
    refs: refsOf([
      ["e1", "combobox", "Race / Ethnicity", false],
      ["e2", "button", "Submit application", false],
    ]),
  };
  const { ops } = createFakeOps([snapshot]);
  delete ops.selectDeclineOption;
  const execute = makeDriver({
    ops,
    candidateConfigGetImpl: () => ({
      ...CONFIG,
      "form-defaults": {
        ...CONFIG["form-defaults"],
        voluntary_self_identification: {
          enabled: true,
          default_action: "decline_when_available",
          confirmed_at: "2026-08-26T12:00:00Z",
          answers: {},
        },
      },
    }),
  });

  const result = await execute({
    applicationId: "app-voluntary-decline-unsupported",
    application: { id: "app-voluntary-decline-unsupported", link: GREENHOUSE_URL },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.deepEqual(result.session.unresolved, [
    {
      label: "Race / Ethnicity",
      required: false,
      reason: "The field changed before it could be filled.",
    },
  ]);
});

test("a required checkbox with an honest No answer is explicitly left unchecked", async () => {
  const snapshot = {
    origin: GREENHOUSE_URL,
    pageText: "Application form",
    refs: refsOf([
      ["e1", "checkbox", "I agree to relocate", true],
      ["e2", "button", "Submit Application", false],
    ]),
  };
  const { ops, log } = createFakeOps([snapshot]);
  const execute = makeDriver({
    ops,
    candidateConfigGetImpl: () => ({
      ...CONFIG,
      "form-defaults": {
        ...CONFIG["form-defaults"],
        screening_answers: { "I agree to relocate": false },
      },
    }),
  });

  const result = await execute({
    applicationId: "app-negative-checkbox",
    application: { id: "app-negative-checkbox" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.deepEqual(result.session.unresolved, []);
  assert.deepEqual(
    log.filter((entry) => entry.op === "toggleField"),
    [{ op: "toggleField", pageId: "page-1", ref: "e1", checked: false }]
  );
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

test("saved question capture is refreshed when a newly rendered required field is missing from its IDs", async () => {
  const step = {
    origin: ASHBY_URL,
    pageText: "Application questions",
    refs: refsOf([
      ["e1", "textbox", "Why this role?", true],
      ["e2", "radio-group", "Are you willing to travel?", true],
    ]),
  };
  const { ops } = createFakeOps([step]);
  const captures = [];
  const execute = makeDriver({
    ops,
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return { questions: input.questions, excluded: [], demographicSectionPresent: false };
    },
  });

  const result = await execute({
    applicationId: "app-stale-question-capture",
    application: { id: "app-stale-question-capture" },
    postingUrl: ASHBY_URL,
    questionCapture: {
      state: "captured",
      answerableCount: 1,
      excludedCount: 0,
      answerableIds: ["rendered-why-this-role"],
      excludedIds: [],
    },
  });

  assert.equal(result.state, "questions-captured");
  assert.equal(captures.length, 1);
  assert.deepEqual(
    captures[0].questions.map(({ id }) => id),
    ["rendered-why-this-role", "rendered-are-you-willing-to-travel"]
  );
});

test("saved question capture is refreshed when an answerable field is now demographic", async () => {
  const step = {
    origin: ASHBY_URL,
    pageText: "Application questions",
    refs: refsOf([
      ["e1", "textbox", "Why this role?", true],
      ["e2", "radio-group", "Are you a person of transgender experience?", false],
    ]),
  };
  const { ops } = createFakeOps([step]);
  const captures = [];
  const execute = makeDriver({
    ops,
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return {
        questions: input.questions.filter(
          (question) => !/transgender experience/i.test(question.label)
        ),
        excluded: input.questions.filter((question) =>
          /transgender experience/i.test(question.label)
        ),
        demographicSectionPresent: true,
      };
    },
  });

  const result = await execute({
    applicationId: "app-upgraded-demographic-capture",
    application: { id: "app-upgraded-demographic-capture" },
    postingUrl: ASHBY_URL,
    questionCapture: {
      state: "captured",
      answerableCount: 2,
      excludedCount: 0,
      answerableIds: [
        "rendered-why-this-role",
        "rendered-are-you-a-person-of-transgender-experience",
      ],
      excludedIds: [],
    },
  });

  assert.equal(result.state, "questions-captured");
  assert.equal(captures.length, 1);
  assert.deepEqual(
    captures[0].questions.map(({ id }) => id),
    ["rendered-why-this-role", "rendered-are-you-a-person-of-transgender-experience"]
  );
});

test("saved question capture is refreshed when an excluded field is now answerable", async () => {
  const step = {
    origin: ASHBY_URL,
    pageText: "Application questions",
    refs: refsOf([["e1", "textbox", "Why this role?", true]]),
  };
  const { ops } = createFakeOps([step]);
  const captures = [];
  const execute = makeDriver({
    ops,
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return { questions: input.questions, excluded: [], demographicSectionPresent: false };
    },
  });

  const result = await execute({
    applicationId: "app-upgraded-answerable-capture",
    application: { id: "app-upgraded-answerable-capture" },
    postingUrl: ASHBY_URL,
    questionCapture: {
      state: "captured",
      answerableCount: 0,
      excludedCount: 1,
      answerableIds: [],
      excludedIds: ["rendered-why-this-role"],
    },
  });

  assert.equal(result.state, "questions-captured");
  assert.equal(captures.length, 1);
});

test("saved question capture without ID arrays uses its persisted counts to detect new fields", async () => {
  const step = {
    origin: ASHBY_URL,
    pageText: "Application questions",
    refs: refsOf([
      ["e1", "textbox", "Why this role?", true],
      ["e2", "radio-group", "Are you willing to travel?", true],
    ]),
  };
  const { ops } = createFakeOps([step]);
  const captures = [];
  const execute = makeDriver({
    ops,
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return { questions: input.questions, excluded: [], demographicSectionPresent: false };
    },
  });

  const result = await execute({
    applicationId: "app-legacy-question-capture",
    application: { id: "app-legacy-question-capture" },
    postingUrl: ASHBY_URL,
    questionCapture: {
      state: "captured",
      answerableCount: 1,
      excludedCount: 0,
    },
  });

  assert.equal(result.state, "questions-captured");
  assert.equal(captures.length, 1);
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

test("a retained tab that leaves the trusted application origin is reopened before confirmation or fill", async () => {
  const trustedPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application form",
    refs: refsOf([["e1", "button", "Submit Application", false]]),
  };
  const unrelatedConfirmation = {
    origin: "https://unrelated.example.test/confirmation",
    pageText: "Your application has been submitted",
    refs: {},
  };
  const log = [];
  let pageCounter = 0;
  let retainedPage = trustedPage;
  const ops = {
    async openTab({ url }) {
      pageCounter += 1;
      const pageId = `page-${pageCounter}`;
      log.push({ op: "openTab", pageId, url });
      return { pageId };
    },
    async snapshot({ pageId }) {
      log.push({ op: "snapshot", pageId });
      return pageId === "page-1" ? retainedPage : trustedPage;
    },
    async screenshot() {
      log.push({ op: "screenshot" });
      return { data: "", format: "png" };
    },
    async fillField() {},
    async selectOption() {},
    async toggleField() {},
    async clickButton() {},
    async upload() {},
  };
  const execute = makeDriver({ ops });
  const intent = {
    applicationId: "app-origin-recovery",
    application: { id: "app-origin-recovery", link: GREENHOUSE_URL },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  };

  const first = await execute(intent);
  assert.equal(first.state, "awaiting-submit");

  retainedPage = unrelatedConfirmation;
  const second = await execute(intent);

  assert.equal(second.state, "awaiting-submit");
  assert.equal(second.currentUrl, GREENHOUSE_URL);
  assert.equal(
    log.filter((entry) => entry.op === "openTab").length,
    2,
    "an untrusted retained tab is replaced from the saved posting URL"
  );
  assert.equal(
    log.some((entry) => entry.op === "screenshot"),
    false,
    "confirmation copy on an unrelated origin is never accepted"
  );
});

test("a fresh tab that redirects off the requested posting origin blocks before any browser mutation", async () => {
  const log = [];
  const ops = {
    async openTab({ url }) {
      log.push({ op: "openTab", url });
      return { pageId: "page-redirected" };
    },
    async snapshot({ pageId }) {
      log.push({ op: "snapshot", pageId });
      return {
        origin: "https://untrusted.example.test/apply",
        pageText: "Full name\nResume\nSubmit application",
        refs: refsOf([
          ["e1", "textbox", "Full name", true],
          ["e2", "button", "Resume", true],
          ["e3", "button", "Submit application", false],
        ]),
      };
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
    async screenshot(args) {
      log.push({ op: "screenshot", ...args });
      return { data: "", format: "png" };
    },
  };
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-fresh-redirect",
    application: { id: "app-fresh-redirect", link: GREENHOUSE_URL },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /unexpected application site/i);
  assert.deepEqual(
    log.map(({ op }) => op),
    ["openTab", "snapshot"],
    "the redirected origin is observed but never receives candidate data or uploads"
  );
});

test("a trusted form that navigates away before a field mutation blocks without filling", async () => {
  const log = [];
  let snapshotCount = 0;
  const ops = {
    async openTab() {
      log.push({ op: "openTab" });
      return { pageId: "page-late-redirect" };
    },
    async snapshot() {
      snapshotCount += 1;
      log.push({ op: "snapshot" });
      return {
        origin: snapshotCount === 1 ? GREENHOUSE_URL : "https://untrusted.example.test/apply",
        pageText: "Full name\nSubmit application",
        refs: refsOf([
          ["e1", "textbox", "Full name", true],
          ["e2", "button", "Submit application", false],
        ]),
      };
    },
    async fillField(args) {
      log.push({ op: "fillField", ...args });
    },
    async screenshot(args) {
      log.push({ op: "screenshot", ...args });
      return { data: "", format: "png" };
    },
  };
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-late-redirect",
    application: { id: "app-late-redirect", link: GREENHOUSE_URL },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.equal(
    result.reason,
    "The application moved to an untrusted site (https://untrusted.example.test) before CareerRat could continue."
  );
  assert.deepEqual(result.session.blockers, ["untrusted application site"]);
  assert.equal(
    log.some(({ op }) => op === "fillField"),
    false,
    "the second snapshot is revalidated before the field receives candidate data"
  );
});

test("a trusted form that navigates away before an advance blocks without clicking", async () => {
  const log = [];
  let snapshotCount = 0;
  const trustedPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application step 1 of 2\nNext",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const ops = {
    async openTab() {
      log.push({ op: "openTab" });
      return { pageId: "page-pre-advance-redirect" };
    },
    async snapshot() {
      snapshotCount += 1;
      log.push({ op: "snapshot" });
      if (snapshotCount < 3) return trustedPage;
      return { ...trustedPage, origin: "https://untrusted.example.test/apply" };
    },
    async clickButton(args) {
      log.push({ op: "clickButton", ...args });
    },
  };
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-pre-advance-redirect",
    application: { id: "app-pre-advance-redirect", link: GREENHOUSE_URL },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.equal(
    result.reason,
    "The application moved to an untrusted site (https://untrusted.example.test) before CareerRat could continue."
  );
  assert.deepEqual(result.session.blockers, ["untrusted application site"]);
  assert.equal(
    log.some(({ op }) => op === "clickButton"),
    false,
    "the fresh pre-advance snapshot is revalidated before Next is clicked"
  );
});

test("concurrent preparation requests for one application share one live browser run", async () => {
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  const log = [];
  const snapshot = {
    origin: GREENHOUSE_URL,
    pageText: "Application form",
    refs: refsOf([["e1", "button", "Submit Application", false]]),
  };
  const ops = {
    async openTab() {
      log.push("openTab");
      return { pageId: "page-1" };
    },
    async snapshot() {
      log.push("snapshot:start");
      await snapshotGate;
      log.push("snapshot:end");
      return snapshot;
    },
    async fillField() {},
    async selectOption() {},
    async toggleField() {},
    async clickButton() {},
    async upload() {},
  };
  const execute = makeDriver({ ops });
  const request = {
    applicationId: "app-concurrent",
    application: { id: "app-concurrent" },
    postingUrl: GREENHOUSE_URL,
    prepareOnly: true,
  };

  const first = execute(request);
  await new Promise((resolve) => setImmediate(resolve));
  const second = execute(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(log.filter((entry) => entry === "openTab").length, 1);
  assert.equal(log.filter((entry) => entry === "snapshot:start").length, 1);

  releaseSnapshot();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.state, "awaiting-submit");
  assert.deepEqual(secondResult, firstResult);
  assert.equal(log.filter((entry) => entry === "openTab").length, 1);
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

test("a public ATS form ignores optional social login, fills normal fields, and still stops before submit", async () => {
  // The SSO control is never a form-advance target, but it also must not stop
  // the ordinary public form beside it from being prepared. Two independent
  // fixture pages make any accidental OAuth click observable as navigation.
  const formPage = {
    origin: GREENHOUSE_URL,
    pageText: "Apply to this role",
    refs: refsOf([
      ["e1", "textbox", "First Name", true],
      ["e2", "button", "Continue with LinkedIn", false],
      ["e3", "button", "Submit Application", false],
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

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.filledCount, 1);
  assert.deepEqual(result.session.blockers, []);
  assert.equal(result.currentUrl, GREENHOUSE_URL, "never navigated to the third-party auth page");
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "the SSO control is never clicked"
  );
  assert.equal(
    log.some((entry) => entry.op === "fillField"),
    true,
    "the public application field is filled even though an optional social-login control exists"
  );
});

test("a social-login wall with no usable application form blocks without clicking OAuth", async () => {
  const loginPage = {
    origin: GREENHOUSE_URL,
    pageText: "Sign in to continue your application",
    refs: refsOf([
      ["e0", "textbox", "Email", true],
      ["e1", "link", "Continue with LinkedIn", false],
      ["e2", "link", "Sign in with Google", false],
    ]),
  };
  const { ops, log } = createFakeOps([loginPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-sso-wall",
    application: { id: "app-sso-wall" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /third-party or account sign-in/);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "CareerRat never clicks a social-login control"
  );
  assert.equal(
    log.some((entry) => entry.op === "fillField"),
    false,
    "an email-only account wall is not mistaken for a public application form"
  );
});

test("a passwordless sign-in wall does not treat Remember me as application-form evidence", async () => {
  const loginPage = {
    origin: GREENHOUSE_URL,
    pageText: "Sign in to continue your application",
    refs: refsOf([
      ["e0", "textbox", "Email", true],
      ["e1", "checkbox", "Remember me", false],
      ["e2", "button", "Continue with Google", false],
      ["e3", "button", "Sign in", false],
    ]),
  };
  const { ops, log } = createFakeOps([loginPage]);
  const execute = makeDriver({
    ops,
    candidateConfigGetImpl: () => ({
      ...CONFIG,
      profile: { candidate: { ...CONFIG.profile.candidate, email: "sam@example.com" } },
    }),
  });

  const result = await execute({
    applicationId: "app-passwordless-wall",
    application: { id: "app-passwordless-wall" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /third-party or account sign-in/);
  assert.equal(
    log.some((entry) => entry.op === "fillField" || entry.op === "toggleField"),
    false,
    "CareerRat never fills account-gate fields"
  );
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "CareerRat never clicks passwordless sign-in controls"
  );
});

test("a passwordless gate without named SSO is not mistaken for a ready application form", async () => {
  const loginPage = {
    origin: GREENHOUSE_URL,
    pageText: "Enter your email to continue",
    refs: refsOf([
      ["e0", "textbox", "Email", true],
      ["e1", "checkbox", "Remember me", false],
      ["e2", "link", "Continue", false],
    ]),
  };
  const { ops, log } = createFakeOps([loginPage]);
  const execute = makeDriver({
    ops,
    candidateConfigGetImpl: () => ({
      ...CONFIG,
      profile: { candidate: { ...CONFIG.profile.candidate, email: "sam@example.com" } },
    }),
  });

  const result = await execute({
    applicationId: "app-passwordless-continue-wall",
    application: { id: "app-passwordless-continue-wall" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /couldn't find the application form/);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "a generic passwordless Continue link is never clicked"
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

test("an advance click that downgrades HTTPS to HTTP blocks before touching the downgraded page", async () => {
  const pageOne = {
    origin: GREENHOUSE_URL,
    pageText: "Basic info",
    refs: refsOf([
      ["e1", "textbox", "Phone Number", false],
      ["e2", "button", "Continue", false],
    ]),
  };
  const downgradedPage = {
    origin: "http://job-boards.greenhouse.io/example/jobs/123/step-2",
    pageText: "More information",
    refs: refsOf([["e3", "textbox", "Phone Number", false]]),
  };
  const { ops, log } = createFakeOps([pageOne, downgradedPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-scheme-downgrade",
    application: { id: "app-scheme-downgrade" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /left the application/);
  assert.match(result.reason, /https:\/\/job-boards\.greenhouse\.io/);
  assert.match(result.reason, /http:\/\/job-boards\.greenhouse\.io/);
  assert.deepEqual(
    log.filter(({ op }) => op === "fillField"),
    [{ op: "fillField", pageId: "page-1", ref: "e1", value: "555-0100" }]
  );
});

test("an advance click that changes ports blocks before touching the new origin", async () => {
  const pageOne = {
    origin: GREENHOUSE_URL,
    pageText: "Basic info",
    refs: refsOf([
      ["e1", "textbox", "Phone Number", false],
      ["e2", "button", "Continue", false],
    ]),
  };
  const changedPortPage = {
    origin: "https://job-boards.greenhouse.io:8443/example/jobs/123/step-2",
    pageText: "More information",
    refs: refsOf([["e3", "textbox", "Phone Number", false]]),
  };
  const { ops, log } = createFakeOps([pageOne, changedPortPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-port-change",
    application: { id: "app-port-change" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /left the application/);
  assert.match(result.reason, /https:\/\/job-boards\.greenhouse\.io:8443/);
  assert.deepEqual(
    log.filter(({ op }) => op === "fillField"),
    [{ op: "fillField", pageId: "page-1", ref: "e1", value: "555-0100" }]
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

test("prepare-only stops before a misleading Continue to Review control that submits", async () => {
  const reviewPage = {
    origin: GREENHOUSE_URL,
    pageText: "Review your application",
    refs: refsOf([["e1", "button", "Continue to Review", false]]),
  };
  const confirmationPage = {
    origin: `${GREENHOUSE_URL}/confirmation`,
    pageText: "Thank you for applying",
    refs: refsOf([]),
  };
  const { ops, log } = createFakeOps([reviewPage, confirmationPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-submit-risk",
    application: { id: "app-prepare-only-submit-risk" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.verified, false);
  assert.equal(result.currentUrl, GREENHOUSE_URL);
  assert.equal(result.session.prepareOnly, true);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "prepare-only never clicks an ambiguous advance control that could submit"
  );
});

test("prepare-only advances a proven non-final wizard step and stops at final Submit", async () => {
  const detailsPage = {
    origin: GREENHOUSE_URL,
    pageText: "Step 1 of 2\nApplication details",
    refs: refsOf([["e1", "button", "Next", false, { advanceSafe: true }]]),
  };
  const reviewPage = {
    origin: `${GREENHOUSE_URL}?step=review`,
    pageText: "Step 2 of 2\nReview your application",
    refs: refsOf([["e2", "button", "Submit application", false]]),
  };
  const { ops, log } = createFakeOps([detailsPage, reviewPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-wizard",
    application: { id: "app-prepare-only-wizard" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.verified, false);
  assert.equal(result.session.prepareOnly, true);
  assert.equal(result.session.stepIndex, 2);
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e1" }]
  );
});

test("prepare-only chooses the proven Next control over an earlier unrelated Continue control", async () => {
  const detailsPage = {
    origin: GREENHOUSE_URL,
    pageText: "Step 1 of 2\nApplication details",
    refs: refsOf([
      ["e1", "button", "Continue browsing jobs", false],
      ["e2", "button", "Next", false, { advanceSafe: true }],
    ]),
  };
  const reviewPage = {
    origin: `${GREENHOUSE_URL}?step=review`,
    pageText: "Step 2 of 2\nReview your application",
    refs: refsOf([["e3", "button", "Submit application", false]]),
  };
  const { ops, log } = createFakeOps([detailsPage, reviewPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-exact-advance",
    application: { id: "app-prepare-only-exact-advance" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.stepIndex, 2);
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e2" }]
  );
});

test("prepare-only advances a LinkedIn Easy Apply Next step and stops at final Submit", async () => {
  const contactPage = {
    origin: EASY_APPLY_URL,
    pageText: "Contact information",
    refs: refsOf([["e1", "button", "Next", false, { advanceSafe: true }]]),
  };
  const reviewPage = {
    origin: EASY_APPLY_URL,
    pageText: "Review your application",
    refs: refsOf([["e2", "button", "Submit application", false]]),
  };
  const { ops, log } = createFakeOps([contactPage, reviewPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-easy-apply",
    application: { id: "app-prepare-only-easy-apply" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.session.prepareOnly, true);
  assert.equal(result.session.stepIndex, 2);
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [{ op: "clickButton", pageId: "page-1", ref: "e1" }]
  );
});

test("prepare-only does not trust a LinkedIn Easy Apply Next button without structured progress evidence", async () => {
  const applicationPage = {
    origin: EASY_APPLY_URL,
    pageText: "Application details",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const confirmationPage = {
    origin: `${EASY_APPLY_URL}&submitted=true`,
    pageText: "Thank you for applying",
    refs: refsOf([]),
  };
  const { ops, log } = createFakeOps([applicationPage, confirmationPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-easy-apply-unknown",
    application: { id: "app-prepare-only-easy-apply-unknown" },
    postingUrl: EASY_APPLY_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.currentUrl, EASY_APPLY_URL);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false
  );
});

test("prepare-only ignores unrelated step copy that is not structural form progress", async () => {
  const applicationPage = {
    origin: GREENHOUSE_URL,
    pageText: "Our interview process: Step 1 of 4\nApplication details",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const confirmationPage = {
    origin: `${GREENHOUSE_URL}/confirmation`,
    pageText: "Thank you for applying",
    refs: refsOf([]),
  };
  const { ops, log } = createFakeOps([applicationPage, confirmationPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-unrelated-steps",
    application: { id: "app-prepare-only-unrelated-steps" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false
  );
});

test("prepare-only stops when a new required field appears in the fresh pre-click snapshot", async () => {
  const readyPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application details",
    refs: refsOf([["e1", "button", "Next", false, { advanceSafe: true }]]),
  };
  const changedPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application details\nNew required question",
    refs: refsOf([
      ["e1", "button", "Next", false, { advanceSafe: true }],
      ["e2", "textbox", "New required question", true],
    ]),
  };
  const { ops, log } = createFakeOps([readyPage]);
  let snapshotCalls = 0;
  ops.snapshot = async () => {
    snapshotCalls += 1;
    log.push({ op: "snapshot" });
    return snapshotCalls <= 2 ? readyPage : changedPage;
  };
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-fresh-required",
    application: { id: "app-prepare-only-fresh-required" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /New required question/);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false
  );
});

test("prepare-only stops when a required field appears during fill and remains in the pre-click snapshot", async () => {
  const readyPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application details",
    refs: refsOf([["e1", "button", "Next", false, { advanceSafe: true }]]),
  };
  const changedPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application details\nLate required question",
    refs: refsOf([
      ["e1", "button", "Next", false, { advanceSafe: true }],
      ["e2", "textbox", "Late required question", true],
    ]),
  };
  const { ops, log } = createFakeOps([readyPage]);
  let snapshotCalls = 0;
  ops.snapshot = async () => {
    snapshotCalls += 1;
    log.push({ op: "snapshot" });
    return snapshotCalls === 1 ? readyPage : changedPage;
  };
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-mid-fill-required",
    application: { id: "app-prepare-only-mid-fill-required" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /Late required question/);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false
  );
});

test("prepare-only stops before an explicit Next step because its submit behavior is unknown", async () => {
  const detailsPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application details",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const { ops, log } = createFakeOps([detailsPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-next",
    application: { id: "app-prepare-only-next" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.verified, false);
  assert.equal(result.currentUrl, GREENHOUSE_URL);
  assert.equal(result.session.prepareOnly, true);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false
  );
});

test("prepare-only never clicks a sole Next control that submits the application", async () => {
  const applicationPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application details",
    refs: refsOf([["e1", "button", "Next", false]]),
  };
  const confirmationPage = {
    origin: `${GREENHOUSE_URL}/confirmation`,
    pageText: "Thank you for applying",
    refs: refsOf([]),
  };
  const { ops, log } = createFakeOps([applicationPage, confirmationPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-next-submits",
    application: { id: "app-prepare-only-next-submits" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.verified, false);
  assert.equal(result.currentUrl, GREENHOUSE_URL);
  assert.equal(result.session.prepareOnly, true);
  assert.equal(
    log.some(({ op }) => op === "clickButton"),
    false,
    "prepare-only cannot discover that Next submits after the irreversible click"
  );
});

test("prepare-only verifies an already-confirmed page after the user submits", async () => {
  const confirmationPage = {
    origin: `${GREENHOUSE_URL}/confirmation`,
    pageText: "Thank you for applying",
    refs: refsOf([]),
  };
  const { ops, log } = createFakeOps([confirmationPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-prepare-only-confirmed",
    application: { id: "app-prepare-only-confirmed" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "submitted");
  assert.equal(result.verified, true);
  assert.equal(result.confirmation, "/confirmation");
  assert.equal(result.currentUrl, confirmationPage.origin);
  assert.equal(
    log.some(({ op }) => op === "screenshot"),
    true
  );
});

test("focusSession returns to the exact retained prepared page without opening or filling another tab", async () => {
  const reviewPage = {
    origin: `${GREENHOUSE_URL}?step=review`,
    pageText: "Review your application",
    refs: refsOf([["e1", "button", "Submit application", false]]),
  };
  const { ops, log } = createFakeOps([reviewPage]);
  const execute = makeDriver({ ops });

  await execute({
    applicationId: "app-focus",
    application: { id: "app-focus" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });
  const focused = await execute({
    applicationId: "app-focus",
    application: { id: "app-focus" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
    focusSession: true,
  });

  assert.equal(focused.state, "awaiting-submit");
  assert.equal(focused.verified, false);
  assert.equal(focused.session.focused, true);
  assert.equal(
    log.filter((entry) => entry.op === "openTab").length,
    1,
    "the handoff reuses the retained page instead of opening the URL again"
  );
  assert.deepEqual(
    log.filter((entry) => entry.op === "focusTab"),
    [{ op: "focusTab", pageId: "page-1" }]
  );
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false
  );
});

test("focusSession verifies the retained page after the user presses Submit", async () => {
  let retainedPage = {
    origin: `${GREENHOUSE_URL}?step=review`,
    pageText: "Review your application",
    refs: refsOf([["e1", "button", "Submit application", false]]),
  };
  const log = [];
  const ops = {
    async openTab() {
      log.push({ op: "openTab" });
      return { pageId: "page-user-submit" };
    },
    async snapshot() {
      log.push({ op: "snapshot" });
      return retainedPage;
    },
    async focusTab(args) {
      log.push({ op: "focusTab", ...args });
    },
    async screenshot() {
      log.push({ op: "screenshot" });
      return { data: "", format: "png" };
    },
  };
  const execute = makeDriver({ ops });
  const request = {
    applicationId: "app-user-submit",
    application: { id: "app-user-submit" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  };

  const prepared = await execute(request);
  assert.equal(prepared.state, "awaiting-submit");

  retainedPage = {
    origin: `${GREENHOUSE_URL}/confirmation`,
    pageText: "Thank you for applying",
    refs: {},
  };
  const verified = await execute({ ...request, focusSession: true });

  assert.equal(verified.state, "submitted");
  assert.equal(verified.verified, true);
  assert.equal(verified.confirmation, "/confirmation");
  assert.equal(verified.artifacts[0].kind, "submission_confirmation");
  assert.equal(
    log.filter((entry) => entry.op === "openTab").length,
    1,
    "verification reuses the retained tab"
  );
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false,
    "CareerRat never clicks Submit"
  );
});

test("cancelling a focus request preserves the retained page for the next review request", async () => {
  const reviewPage = {
    origin: `${GREENHOUSE_URL}?step=review`,
    pageText: "Review your application",
    refs: refsOf([["e1", "button", "Submit application", false]]),
  };
  const { ops, log } = createFakeOps([reviewPage]);
  const execute = makeDriver({ ops });
  const controller = new AbortController();
  const cancellation = new Error("focus cancelled");
  let cancelFocus = true;
  ops.focusTab = async ({ pageId, signal }) => {
    log.push({ op: "focusTab", pageId });
    if (cancelFocus) {
      cancelFocus = false;
      controller.abort(cancellation);
      assert.equal(signal, controller.signal);
    }
  };

  const request = {
    applicationId: "app-focus-cancelled",
    application: { id: "app-focus-cancelled" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  };
  await execute(request);
  await assert.rejects(
    () => execute({ ...request, focusSession: true, signal: controller.signal }),
    (error) => error === cancellation
  );
  const focused = await execute({ ...request, focusSession: true });

  assert.equal(focused.state, "awaiting-submit");
  assert.equal(focused.session.focused, true);
  assert.equal(
    log.filter((entry) => entry.op === "openTab").length,
    1,
    "cancellation must not discard and reopen the prepared page"
  );
});

test("focusSession refuses a retained tab that left the trusted application origin", async () => {
  const trustedPage = {
    origin: GREENHOUSE_URL,
    pageText: "Review your application",
    refs: refsOf([["e1", "button", "Submit application", false]]),
  };
  let retainedPage = trustedPage;
  const log = [];
  const ops = {
    async openTab() {
      log.push({ op: "openTab" });
      return { pageId: "page-focus-origin" };
    },
    async snapshot() {
      log.push({ op: "snapshot" });
      return retainedPage;
    },
    async focusTab(args) {
      log.push({ op: "focusTab", ...args });
    },
  };
  const execute = makeDriver({ ops });

  const prepared = await execute({
    applicationId: "app-focus-origin",
    application: { id: "app-focus-origin" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });
  assert.equal(prepared.state, "awaiting-submit");

  retainedPage = {
    origin: "https://unrelated.example.test/confirmation",
    pageText: "Your application has been submitted",
    refs: {},
  };
  const focused = await execute({
    applicationId: "app-focus-origin",
    application: { id: "app-focus-origin" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
    focusSession: true,
  });

  assert.equal(focused.state, "unavailable");
  assert.equal(focused.verified, false);
  assert.match(focused.reason, /left the trusted application site/i);
  assert.equal(
    log.filter((entry) => entry.op === "openTab").length,
    1,
    "focus never reopens or accepts the unrelated page"
  );
});

test("focusSession returns to a retained manual-review page after automation consent is turned off", async () => {
  const reviewPage = {
    origin: `${GREENHOUSE_URL}?step=review`,
    pageText: "Review your application",
    refs: refsOf([["e1", "button", "Submit application", false]]),
  };
  const { ops, log } = createFakeOps([reviewPage]);
  let allowed = true;
  const execute = makeDriver({
    ops,
    mayRunImpl: () => ({ allowed }),
  });

  const prepared = await execute({
    applicationId: "app-focus-consent-off",
    application: { id: "app-focus-consent-off" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });
  assert.equal(prepared.state, "awaiting-submit");

  allowed = false;
  const focused = await execute({
    applicationId: "app-focus-consent-off",
    application: { id: "app-focus-consent-off" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
    focusSession: true,
  });

  assert.equal(focused.state, "awaiting-submit");
  assert.equal(focused.session.focused, true);
  assert.deepEqual(
    log.filter((entry) => entry.op === "focusTab"),
    [{ op: "focusTab", pageId: "page-1" }]
  );
  assert.equal(
    log.filter((entry) => entry.op === "openTab").length,
    1,
    "focusing the retained page must not start new automation"
  );
});

test("focusSession refuses to manufacture a new browser tab when no prepared page is retained", async () => {
  const { ops, log } = createFakeOps([]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-not-prepared",
    application: { id: "app-not-prepared" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
    focusSession: true,
  });

  assert.equal(result.state, "unavailable");
  assert.match(result.reason, /no prepared browser session/i);
  assert.equal(
    log.some((entry) => entry.op === "openTab"),
    false
  );
});

test("prepare-only never clicks a plain Continue control that turns out to submit", async () => {
  const formPage = {
    origin: GREENHOUSE_URL,
    pageText: "Application details",
    refs: refsOf([["e1", "button", "Continue", false]]),
  };
  const confirmationPage = {
    origin: `${GREENHOUSE_URL}/confirmation`,
    pageText: "Thank you for applying",
    refs: {},
  };
  const { ops, log } = createFakeOps([formPage, confirmationPage]);
  const execute = makeDriver({ ops });

  const result = await execute({
    applicationId: "app-continue-submits",
    application: { id: "app-continue-submits" },
    postingUrl: GREENHOUSE_URL,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.state, "awaiting-submit");
  assert.equal(result.verified, false);
  assert.equal(
    log.some((entry) => entry.op === "clickButton"),
    false
  );
});

test("a fresh snapshot with an unverifiable origin blocks before advancing", async () => {
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

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /couldn't verify where the application opened/i);
  assert.deepEqual(
    log.filter((entry) => entry.op === "clickButton"),
    [],
    "an unverifiable origin never receives an advance click"
  );
});
