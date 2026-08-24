import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConfiguredApplyExecutor } from "../src/core/apply/apply-executor-factory.mjs";
import {
  createOrcaApplyExecutor,
  renderedFieldsFromSnapshot,
  uploadTargetsFromSnapshot,
} from "../src/core/apply/orca-executor.mjs";
import { createOrcaOps } from "../src/core/apply/orca-ops.mjs";

const FORM_SNAPSHOT = {
  origin: "https://careers.example.test/jobs/staff-ai/apply",
  refs: {
    e1: { name: "First Name", role: "textbox" },
    e2: { name: "Why Example?", role: "textbox" },
    e3: { name: "Work authorization", role: "combobox" },
    e4: { name: "Gender", role: "combobox" },
    e5: { name: "Submit application", role: "button" },
    e6: { name: "Choose one", role: "option" },
    e7: { name: "Yes, authorized to work", role: "option" },
    e8: { name: "No, I need sponsorship", role: "option" },
  },
  snapshot: [
    '- textbox "First Name" [required, ref=e1]',
    '- textbox "Why Example?" [required, ref=e2]',
    '- combobox "Work authorization" [expanded=false, required, ref=e3]',
    '  - option "Choose one" [selected, ref=e6]',
    '  - option "Yes, authorized to work" [ref=e7]',
    '  - option "No, I need sponsorship" [ref=e8]',
    '- combobox "Gender" [expanded=false, ref=e4]',
    '- button "Submit application" [ref=e5]',
  ].join("\n"),
  browserPageId: "page-123",
};

test("Orca focusTab switches to the retained supervised page", async () => {
  const commands = [];
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      return {};
    },
  });

  await ops.focusTab({ pageId: "page-123" });

  assert.deepEqual(commands, [["tab", "switch", "--page", "page-123", "--json"]]);
});

const UPLOAD_SNAPSHOT = {
  origin: "https://job-boards.greenhouse.io/example/jobs/123",
  refs: {
    e20: { name: "Resume/CV*", role: "group" },
    e21: { name: "Attach", role: "button" },
    e22: { name: "Cover Letter", role: "group" },
    e23: { name: "Attach", role: "button" },
    e24: { name: "Autofill with MyGreenhouse", role: "button" },
  },
  snapshot: [
    '- group "Resume/CV*" [required, ref=e20]',
    '  - button "Attach" [ref=e21]',
    '- group "Cover Letter" [ref=e22]',
    '  - button "Attach" [ref=e23]',
    '- button "Autofill with MyGreenhouse" [ref=e24]',
  ].join("\n"),
  browserPageId: "page-123",
};

const NATIVE_FILE_UPLOAD_SNAPSHOT = {
  origin: "https://careers.example.test/jobs/staff-ai/apply",
  refs: {
    e6: { name: "Resume/CV", role: "button" },
    e7: { name: "Submit application", role: "button" },
  },
  snapshot: [
    '- button "Resume/CV" [ref=e6]: No file chosen',
    '- button "Submit application" [ref=e7]',
  ].join("\n"),
  browserPageId: "page-123",
};

const ASHBY_CUSTOM_CONTROLS_SNAPSHOT = {
  origin: "https://jobs.ashbyhq.com/curri/18588740-4f80-4a40-b3c0-fed97517a3c4/application",
  refs: {
    e1: {
      name: "Senior Software Engineer LocationRemote - United StatesEmployment TypeFull time",
      role: "checkbox",
    },
    e14: { name: "Full Name*", role: "textbox" },
    e27: { name: "Submit Application", role: "button" },
    e32: { name: "Start typing...", role: "combobox" },
    e33: { name: "", role: "button" },
    e34: { name: "Yes", role: "button" },
    e35: { name: "No", role: "button" },
    e36: { name: "Yes", role: "button" },
    e37: { name: "No", role: "button" },
  },
  snapshot: [
    '- checkbox "Senior Software Engineer LocationRemote - United StatesEmployment TypeFull time" [checked=true, ref=e1]',
    ...[
      "- LabelText",
      '  - StaticText "Full Name"',
      '  - StaticText "*"',
      '- textbox "Full Name*" [required, ref=e14]: Riley Chen',
      "- LabelText",
      '  - StaticText "Location"',
      '  - StaticText "*"',
      "- generic",
      '  - combobox "Start typing..." [expanded=false, ref=e32]',
      "  - button [ref=e33]",
      "- LabelText",
      '  - StaticText "Will you now or in the future require sponsorship for employment visa status"',
      '  - StaticText "*"',
      "- generic",
      '  - button "Yes" [ref=e34]',
      '  - button "No" [ref=e35]',
      "- LabelText",
      '  - StaticText "Would you be willing to travel to Ventura, CA to meet with our team as part of the interview process?"',
      '  - StaticText "*"',
      "- generic",
      '  - button "Yes" [ref=e36]',
      '  - button "No" [ref=e37]',
      '- button "Submit Application" [ref=e27]',
    ].map((line) => `  ${line}`),
  ].join("\n"),
  browserPageId: "page-ashby",
};

const ASHBY_LOCATION_OPTIONS_SNAPSHOT = {
  origin: ASHBY_CUSTOM_CONTROLS_SNAPSHOT.origin,
  refs: {
    e10: { name: "Start typing...", role: "combobox" },
    e50: { name: "New York City, New York, United States", role: "option" },
    e51: { name: "West New York, New Jersey, United States", role: "option" },
  },
  snapshot: [
    '- combobox "Start typing..." [expanded=true, ref=e10]: New York, NY',
    "- listbox",
    '  - option "New York City, New York, United States" [selected, ref=e50]',
    '  - option "West New York, New Jersey, United States" [ref=e51]',
  ].join("\n"),
  browserPageId: "page-ashby",
};

test("renderedFieldsFromSnapshot keeps live form metadata and excludes non-fields", () => {
  assert.deepEqual(renderedFieldsFromSnapshot(FORM_SNAPSHOT), [
    { ref: "e1", id: "rendered-first-name", label: "First Name", type: "text", required: true },
    {
      ref: "e2",
      id: "rendered-why-example",
      label: "Why Example?",
      type: "text",
      required: true,
    },
    {
      ref: "e3",
      id: "rendered-work-authorization",
      label: "Work authorization",
      type: "select",
      required: true,
    },
    {
      ref: "e4",
      id: "rendered-gender",
      label: "Gender",
      type: "select",
      required: false,
    },
  ]);
});

test("Orca executor captures Ashby custom controls by their visible required labels", async () => {
  const captures = [];
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    runOrcaImpl: async (args) => {
      if (args[0] === "tab") return { browserPageId: "page-ashby" };
      if (args[0] === "snapshot") return ASHBY_CUSTOM_CONTROLS_SNAPSHOT;
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return {
        questions: input.questions,
        excluded: [],
        demographicSectionPresent: false,
      };
    },
  });

  const result = await execute({
    applicationId: "app-ashby",
    application: { id: "app-ashby" },
    postingUrl: ASHBY_CUSTOM_CONTROLS_SNAPSHOT.origin,
    questionCapture: { state: "site-required" },
  });

  assert.equal(result.state, "questions-captured");
  assert.deepEqual(
    captures[0].questions.map(({ label, type, required }) => ({ label, type, required })),
    [
      { label: "Full Name*", type: "text", required: true },
      { label: "Location", type: "select", required: true },
      {
        label: "Will you now or in the future require sponsorship for employment visa status",
        type: "radio",
        required: true,
      },
      {
        label:
          "Would you be willing to travel to Ventura, CA to meet with our team as part of the interview process?",
        type: "radio",
        required: true,
      },
    ]
  );
});

test("Orca executor fills Ashby required custom controls and blocks on required unknowns", async () => {
  const commands = [];
  let locationOptionsOpen = false;
  let locationValue = "";
  let hideCommittedLocationOnce = false;
  let sponsorshipValue = "";
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "tab") return { browserPageId: "page-ashby" };
      if (args[0] === "snapshot") {
        return locationOptionsOpen
          ? ASHBY_LOCATION_OPTIONS_SNAPSHOT
          : ASHBY_CUSTOM_CONTROLS_SNAPSHOT;
      }
      if (args[0] === "eval") {
        const visibleLocation = hideCommittedLocationOnce ? "" : locationValue;
        hideCommittedLocationOnce = false;
        return {
          result: JSON.stringify([
            { label: "Location", stateKnown: true, value: visibleLocation },
            {
              label: "Will you now or in the future require sponsorship for employment visa status",
              yesNo: [
                { text: "Yes", pressed: false, className: "ashby-option" },
                {
                  text: "No",
                  pressed: false,
                  className: sponsorshipValue === "No" ? "ashby-option _active_1svni_57" : "",
                },
              ],
            },
            {
              label:
                "Would you be willing to travel to Ventura, CA to meet with our team as part of the interview process?",
              yesNo: [
                { text: "Yes", pressed: false, className: "ashby-option" },
                { text: "No", pressed: false, className: "ashby-option" },
              ],
            },
          ]),
        };
      }
      if (args[0] === "fill" && args.includes("@e32")) {
        locationOptionsOpen = true;
        return {};
      }
      if (args[0] === "wait") return {};
      if (args[0] === "click" && args.includes("@e50")) {
        locationOptionsOpen = false;
        locationValue = "New York City, New York, United States";
        hideCommittedLocationOnce = true;
        return {};
      }
      if (args[0] === "focus") return {};
      if (args[0] === "keypress") {
        sponsorshipValue = "No";
        return {};
      }
      if (["fill", "select", "click"].includes(args[0])) return {};
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
    candidateConfigGetImpl: () => ({
      profile: {
        candidate: { full_name: "Riley Chen", location: "New York, NY" },
        location: { travel_tolerance: "" },
        authorization: { requires_sponsorship: false },
      },
      honesty: {},
      "form-defaults": { requires_sponsorship: "No" },
    }),
    loadAnswerMapImpl: () => new Map(),
  });

  const result = await execute({
    applicationId: "app-ashby",
    application: { id: "app-ashby" },
    postingUrl: ASHBY_CUSTOM_CONTROLS_SNAPSHOT.origin,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /Would you be willing to travel to Ventura/);
  assert.deepEqual(result.session.unresolved, [
    {
      label:
        "Would you be willing to travel to Ventura, CA to meet with our team as part of the interview process?",
      required: true,
    },
  ]);
  assert.deepEqual(
    commands.filter(
      (args) =>
        (["@e32", "@e50", "@e35"].some((ref) => args.includes(ref)) || args[0] === "keypress") &&
        ["fill", "click", "focus", "keypress"].includes(args[0])
    ),
    [
      ["fill", "--page", "page-ashby", "--element", "@e32", "--value", "New York, NY", "--json"],
      ["click", "--page", "page-ashby", "--element", "@e50", "--json"],
      ["focus", "--page", "page-ashby", "--element", "@e35", "--json"],
      ["keypress", "--page", "page-ashby", "--key", "Enter", "--json"],
    ]
  );
  assert.equal(
    commands.some((args) => args[0] === "wait" && args.includes("--text")),
    false,
    "post-selection verification stays snapshot-bounded instead of starting an open text wait"
  );
  assert.equal(
    commands.some((args) => args.includes("@e27")),
    false,
    "Submit Application is never clicked"
  );
});

test("uploadTargetsFromSnapshot maps only explicit resume and cover-letter controls", () => {
  assert.deepEqual(uploadTargetsFromSnapshot(UPLOAD_SNAPSHOT), [
    { ref: "e21", kind: "resume", label: "Resume/CV*", required: true },
    { ref: "e23", kind: "coverLetter", label: "Cover Letter", required: false },
  ]);
});

test("uploadTargetsFromSnapshot maps a native file input exposed by Orca as its label", () => {
  assert.deepEqual(uploadTargetsFromSnapshot(NATIVE_FILE_UPLOAD_SNAPSHOT), [
    { ref: "e6", kind: "resume", label: "Resume/CV", required: false },
  ]);
});

test("Orca executor opens one supervised tab and captures rendered questions before filling", async () => {
  const commands = [];
  const captures = [];
  const runOrcaImpl = async (args) => {
    commands.push(args);
    if (args[0] === "tab") return { browserPageId: "page-123" };
    if (args[0] === "snapshot") return FORM_SNAPSHOT;
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    runOrcaImpl,
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return {
        source: "rendered",
        questions: input.questions.filter((question) => question.label !== "Gender"),
        excluded: [{ id: "rendered-gender", label: "Gender", reason: "gender" }],
        demographicSectionPresent: true,
      };
    },
  });

  const result = await execute({
    applicationId: "app-1",
    application: { id: "app-1", company: "Example", role: "Staff AI Engineer" },
    postingUrl: FORM_SNAPSHOT.origin,
    questionCapture: { state: "site-required" },
  });

  assert.equal(result.verified, false);
  assert.equal(result.state, "questions-captured");
  assert.equal(result.questionCaptureUpdated, true);
  assert.equal(result.session.provider, "orca");
  assert.equal(result.session.answerableCount, 3);
  assert.equal(result.session.excludedCount, 1);
  assert.deepEqual(commands, [
    ["tab", "create", "--url", FORM_SNAPSHOT.origin, "--json"],
    ["snapshot", "--page", "page-123", "--json"],
  ]);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].source, "rendered");
  assert.deepEqual(
    captures[0].questions.map(({ ref: _ref, ...question }) => question),
    [
      { id: "rendered-first-name", label: "First Name", type: "text", required: true },
      {
        id: "rendered-why-example",
        label: "Why Example?",
        type: "text",
        required: true,
      },
      {
        id: "rendered-work-authorization",
        label: "Work authorization",
        type: "select",
        required: true,
      },
      {
        id: "rendered-gender",
        label: "Gender",
        type: "select",
        required: false,
      },
    ]
  );
});

test("Orca executor fills confirmed values, stops before submit, and verifies only from the live page", async () => {
  const commands = [];
  let confirmationMode = false;
  const runOrcaImpl = async (args) => {
    commands.push(args);
    if (args[0] === "tab") return { browserPageId: "page-123" };
    if (args[0] === "snapshot") {
      return confirmationMode
        ? {
            origin: "https://careers.example.test/jobs/staff-ai/confirmation",
            refs: {},
            snapshot: 'StaticText "Thank you for applying"',
            browserPageId: "page-123",
          }
        : FORM_SNAPSHOT;
    }
    if (args[0] === "screenshot") return { data: "cG5n" };
    if (["fill", "select"].includes(args[0])) return {};
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    runOrcaImpl,
    candidateConfigGetImpl: () => ({
      profile: { candidate: { full_name: "Morgan Hale" } },
      honesty: {},
      "form-defaults": {
        first_name: "Morgan",
        work_authorization: "Yes",
      },
    }),
    loadAnswerMapImpl: () => new Map([["why example", "I build reliable systems."]]),
    saveScreenshotImpl: () => "workspace/captures/app-1-confirmation.png",
  });

  const first = await execute({
    applicationId: "app-1",
    application: { id: "app-1", company: "Example", role: "Staff AI Engineer" },
    postingUrl: FORM_SNAPSHOT.origin,
    questionCapture: {
      state: "captured",
      source: "rendered",
      answerableCount: 3,
      excludedCount: 1,
      answerableIds: ["rendered-first-name", "rendered-why-example", "rendered-work-authorization"],
      excludedIds: ["rendered-gender"],
    },
  });

  assert.equal(first.verified, false);
  assert.equal(first.state, "awaiting-submit");
  assert.equal(first.session.filledCount, 3);
  assert.deepEqual(first.session.unresolved, []);
  assert.equal(
    commands.some((args) => args[0] === "click"),
    false
  );
  const actionIndexes = commands
    .map((args, index) => (["fill", "select"].includes(args[0]) ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(actionIndexes.length, 3);
  for (const index of actionIndexes) {
    assert.equal(commands[index - 1][0], "snapshot", "every browser action needs a fresh snapshot");
  }
  assert.deepEqual(
    commands.filter((args) => ["fill", "select"].includes(args[0])),
    [
      ["fill", "--page", "page-123", "--element", "@e1", "--value", "Morgan", "--json"],
      [
        "fill",
        "--page",
        "page-123",
        "--element",
        "@e2",
        "--value",
        "I build reliable systems.",
        "--json",
      ],
      [
        "select",
        "--page",
        "page-123",
        "--element",
        "@e3",
        "--value",
        "Yes, authorized to work",
        "--json",
      ],
    ]
  );

  confirmationMode = true;
  const verified = await execute({
    applicationId: "app-1",
    application: { id: "app-1", company: "Example", role: "Staff AI Engineer" },
    postingUrl: FORM_SNAPSHOT.origin,
    questionCapture: { state: "captured", source: "rendered", answerableCount: 3 },
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.confirmation, "/confirmation");
  assert.equal(verified.currentUrl.endsWith("/confirmation"), true);
  assert.equal(verified.artifacts[0].kind, "submission_confirmation");
  assert.equal(commands.at(-1)[0], "screenshot");
});

test("Orca executor uploads generated PDFs through explicit live controls", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-orca-upload-"));
  try {
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeFileSync(join(repoRoot, "workspace", "tailored", "resume.pdf"), "resume");
    writeFileSync(join(repoRoot, "workspace", "tailored", "cover.pdf"), "cover");
    const commands = [];
    const runOrcaImpl = async (args) => {
      commands.push(args);
      if (args[0] === "tab") return { browserPageId: "page-123" };
      if (args[0] === "snapshot") return UPLOAD_SNAPSHOT;
      if (args[0] === "upload") return {};
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    const execute = createOrcaApplyExecutor({
      repoRoot,
      env: {},
      runOrcaImpl,
      candidateConfigGetImpl: () => ({ profile: {}, honesty: {}, "form-defaults": {} }),
      loadAnswerMapImpl: () => new Map(),
    });

    const result = await execute({
      applicationId: "app-1",
      application: {
        id: "app-1",
        artifacts: {
          resumePdf: "workspace/tailored/resume.pdf",
          coverLetterPdf: "workspace/tailored/cover.pdf",
        },
      },
      postingUrl: UPLOAD_SNAPSHOT.origin,
      questionCapture: { state: "captured", source: "rendered", answerableCount: 0 },
    });

    assert.equal(result.state, "awaiting-submit");
    assert.equal(result.session.uploadedCount, 2);
    assert.deepEqual(
      commands.filter((args) => args[0] === "upload"),
      [
        [
          "upload",
          "--page",
          "page-123",
          "--element",
          "@e21",
          "--files",
          join(repoRoot, "workspace", "tailored", "resume.pdf"),
          "--json",
        ],
        [
          "upload",
          "--page",
          "page-123",
          "--element",
          "@e23",
          "--files",
          join(repoRoot, "workspace", "tailored", "cover.pdf"),
          "--json",
        ],
      ]
    );
    for (const index of commands
      .map((args, index) => (args[0] === "upload" ? index : -1))
      .filter((index) => index >= 0)) {
      assert.equal(commands[index - 1][0], "snapshot");
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Orca executor refuses LinkedIn Easy Apply until supervised preparation consent is live", async () => {
  const commands = [];
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    runOrcaImpl: async (args) => {
      commands.push(args);
      return {};
    },
    mayRunImpl: () => ({
      allowed: false,
      reasons: ["authenticated_apply_preparation on LinkedIn is off"],
    }),
  });

  const result = await execute({
    applicationId: "app-linkedin",
    application: {},
    postingUrl: "https://www.linkedin.com/jobs/view/123?easyApplyModal=true",
  });

  assert.equal(result.available, true);
  assert.equal(result.verified, false);
  assert.equal(result.state, "blocked");
  assert.match(result.reason, /authenticated_apply_preparation on LinkedIn is off/);
  assert.deepEqual(commands, []);
});

test("Orca executor stops before account creation or password entry", async () => {
  const commands = [];
  const snapshot = {
    origin: "https://careers.example.test/create-account",
    refs: { e1: { name: "Create a password", role: "textbox" } },
    snapshot: '- textbox "Create a password" [required, ref=e1]',
  };
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "tab") return { browserPageId: "page-123" };
      if (args[0] === "snapshot") return snapshot;
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  });

  const result = await execute({
    applicationId: "app-account",
    application: {},
    postingUrl: snapshot.origin,
    questionCapture: { state: "site-required" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /account creation or password entry/i);
  assert.equal(
    commands.some((args) => ["fill", "select", "click"].includes(args[0])),
    false
  );
});

test("configured executor fails the extension provider immediately with an honest reason", async () => {
  const extensionExecute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    loadAutomationImpl: () => ({ data: { session: { provider: "extension" } } }),
  });
  assert.equal(typeof extensionExecute, "function");
  const extensionResult = await extensionExecute({
    applicationId: "app-1",
    application: {},
    postingUrl: FORM_SNAPSHOT.origin,
  });
  assert.equal(extensionResult.available, false);
  assert.equal(extensionResult.verified, false);
  assert.equal(extensionResult.state, "unavailable");
  assert.match(
    extensionResult.reason,
    /automatic apply isn't available on the .*extension.* provider yet/i
  );
  // Provider-neutral: the reason must not steer the user at one hardcoded
  // replacement provider (AGENTS.md Domain-Neutral Rule) — see session.mjs
  // automaticApplyGap().
  assert.doesNotMatch(extensionResult.reason, /playwright/i);
});

test("configured executor connects explicit Orca or automatic Orca detection", async () => {
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    loadAutomationImpl: () => ({ data: { session: { provider: "orca" } } }),
    runOrcaImpl: async () => {
      throw new Error("Orca is not running");
    },
  });
  const result = await execute({
    applicationId: "app-1",
    application: {},
    postingUrl: FORM_SNAPSHOT.origin,
  });
  assert.equal(result.available, false);
  assert.equal(result.state, "unavailable");
  assert.match(result.reason, /Orca is not running/);

  const automatic = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: { ORCA_WORKTREE_ID: "worktree-123" },
    loadAutomationImpl: () => ({ data: { session: { provider: "auto" } } }),
    runOrcaImpl: async () => {
      throw new Error("automatic Orca attempted");
    },
  });
  assert.equal(typeof automatic, "function");
  const automaticResult = await automatic({
    applicationId: "app-1",
    application: {},
    postingUrl: FORM_SNAPSHOT.origin,
  });
  assert.match(automaticResult.reason, /automatic Orca attempted/);
});
