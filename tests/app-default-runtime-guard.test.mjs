import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const APP_DEFAULT_FILES = [
  "apps/web/src/App.jsx",
  "apps/web/src/main.jsx",
  "apps/web/src/chat-first/dashboard-context.jsx",
  "apps/web/src/chat-first/ChatFirstApp.jsx",
  "apps/web/src/chat-first/FirstRunExperience.jsx",
  "apps/web/src/chat-first/ProfileSettings.jsx",
  "apps/web/src/chat-first/ProfileSettingsController.jsx",
  "apps/web/src/chat-first/WorkspaceBrowser.jsx",
  "apps/web/src/chat-first/browser-model.js",
  "apps/web/src/chat-first/chat-first-app-controller.js",
  "apps/web/src/chat-first/chat-first-controller.js",
  "apps/web/src/chat-first/chat-first-icons.jsx",
  "apps/web/src/chat-first/chat-first-model.js",
  "apps/web/src/chat-first/conversation-surfaces.jsx",
  "apps/web/src/chat-first/deep-ingest-controller.js",
  "apps/web/src/chat-first/first-run-controller.js",
  "apps/web/src/chat-first/profile-settings-controller.js",
  "apps/web/src/chat-first/workspace-shell.jsx",
  "apps/web/src/components/Button.jsx",
  "apps/web/src/jobs/ArtifactViewerModal.jsx",
  "apps/web/src/jobs/jobsSearch.js",
  "apps/web/src/lib/errorCopy.js",
  "apps/web/src/lib/safeExternalUrl.js",
  "apps/web/src/lib/sse.js",
  "apps/web/src/onboarding/confirmBlocks.js",
  "apps/web/src/onboarding/onboardingSetup.js",
  "src/cli/assist-route.mjs",
  "src/cli/boards-route.mjs",
  "src/cli/dashboard-route.mjs",
  "src/cli/data-route.mjs",
  "src/cli/deep-ingest-route.mjs",
  "src/cli/logo-route.mjs",
  "src/cli/packet-route.mjs",
  "src/cli/search-route.mjs",
  "src/cli/sourcing-route.mjs",
  "apps/desktop/main.mjs",
];

const MIXED_ROUTE_SLICES = [
  {
    file: "src/cli/discovery-route.mjs",
    label: "company proposal create route",
    start: 'addRoute("POST", "/api/discovery/company-proposals"',
    end: 'addRoute("GET", "/api/discovery/company-proposals"',
  },
  {
    file: "src/cli/discovery-route.mjs",
    label: "company proposal read route",
    start: 'addRoute("GET", "/api/discovery/company-proposals"',
    end: 'addRoute("POST", "/api/discovery/company-proposal-decisions"',
  },
  {
    file: "src/cli/discovery-route.mjs",
    label: "company proposal decision route",
    start: 'addRoute("POST", "/api/discovery/company-proposal-decisions"',
    end: 'addRoute("GET", "/api/discovery/state"',
  },
  {
    file: "src/cli/onboard-route.mjs",
    label: "text resume onboarding route",
    start: 'addRoute("POST", "/api/onboard/resume"',
    end: 'addRoute("POST", "/api/onboard/resume-docx"',
  },
  {
    file: "src/cli/onboard-route.mjs",
    label: "DOCX resume onboarding route",
    start: 'addRoute("POST", "/api/onboard/resume-docx"',
    end: 'addRoute("POST", "/api/onboard/resume-ai"',
  },
  {
    file: "src/cli/onboard-route.mjs",
    label: "quick-start first-search route",
    start: 'addRoute("POST", "/api/onboard/quick-start"',
    end: 'addRoute("POST", "/api/settings/ai-key"',
  },
  {
    file: "src/cli/intake-route.mjs",
    label: "intake capture route",
    start: 'addRoute("POST", "/api/intake"',
    end: 'addRoute("POST", "/api/intake/upload"',
  },
  {
    file: "src/cli/intake-route.mjs",
    label: "intake classify route",
    start: 'addRoute("POST", "/api/intake/classify"',
    end: 'addRoute("POST", "/api/intake/confirm"',
  },
];

const CLASSIFIED_RETAINED_RUNTIME_FILES = [
  {
    file: "src/cli/skill-run-route.mjs",
    classification: "retained full-skill HTTP runtime owner",
    patterns: [/addRoute\("POST", "\/api\/skill\/run"/, /\brunSkillStream\b/],
  },
  {
    file: "src/core/ai/skill-runtime.mjs",
    classification: "retained one-shot skill runtime owner",
    patterns: [
      /\bexport async function runSkillStream\b/,
      /\bpermissionMode:\s*"default"/,
      /\bcreateRuntimeToolPolicy\b/,
    ],
  },
  {
    file: "src/cli/chat-route.mjs",
    classification: "explicit chat HTTP runtime owner",
    patterns: [/addRoute\("POST", "\/api\/chat\/start"/, /\bchatRuntime\.startSession\b/],
  },
  {
    file: "src/core/ai/chat-runtime.mjs",
    classification: "explicit conversational skill runtime owner",
    patterns: [/\basync function startSession\b/, /\bfunction findBySkill\b/],
  },
  {
    file: "src/cli/tracker-dev.mjs",
    classification: "embedded server mount for classified retained/debug/chat surfaces",
    patterns: [/\bmountSkillRunRoute\b/, /\bmountChatRoute\b/],
  },
];

const CLASSIFIED_EXPLICIT_CHAT_SLICES = [
  {
    file: "apps/web/src/lib/api.js",
    label: "first-run chat API helpers",
    slices: [["export function startChat", "export function getDashboard"]],
    patterns: [/\/api\/chat\/start/, /\/api\/chat\/message/, /\/api\/chat\/by-skill/],
  },
  {
    file: "apps/web/src/chat-first/FirstRunController.jsx",
    label: "chat-first setup conversation",
    slices: [["export function FirstRunController", null]],
    patterns: [/\bfindChatBySkill\b/, /\/api\/chat\/events/],
  },
  {
    file: "src/cli/discovery-route.mjs",
    label: "visible discovery chat handoff routes",
    slices: [
      ["async function startOrReuseDiscoveryChat", "function quickStartGuidance"],
      ['addRoute("GET", "/api/discovery/state"', 'addRoute("POST", "/api/discovery/quick-start"'],
      ['addRoute("POST", "/api/discovery/quick-start"', 'addRoute("POST", "/api/discovery/next"'],
      ['addRoute("POST", "/api/discovery/next"', null],
    ],
    patterns: [/\bchatRuntime\.startSession\b/, /\bfindActiveDiscoveryChat\b/],
  },
  {
    file: "src/cli/intake-route.mjs",
    label: "confirm-first intake background skill dispatch",
    slices: [["function executeLaneB", "async function executeLaneW"]],
    patterns: [/\brunSkillStream\b/],
  },
  {
    file: "src/cli/onboard-route.mjs",
    label: "Read-only resume-extract retained runtime slice",
    slices: [
      ['addRoute("POST", "/api/onboard/resume-ai"', 'addRoute("POST", `/api/onboard/candidate'],
    ],
    patterns: [/\brunSkillStream\b/, /tools:\s*\[\s*"Read"\s*\]/, /skill:\s*"resume-extract"/],
  },
  {
    file: "src/cli/intake-route.mjs",
    label: "Read-only intake-extract retained runtime slice (PDF/image upload extraction)",
    slices: [
      ["async function runIntakeExtractBounded", "async function extractUploadText"],
      ['addRoute("POST", "/api/intake/upload"', 'addRoute("GET", "/api/intake/list"'],
    ],
    patterns: [/\brunSkillStream\b/, /tools:\s*\[\s*"Read"\s*\]/, /skill:\s*"intake-extract"/],
  },
];

const CLASSIFIED_RETAINED_RUNTIME_TEST_FILES = [
  "tests/skill-runtime.test.mjs",
  "tests/skill-run-route.test.mjs",
  "tests/chat-runtime.test.mjs",
  "tests/packet-runtime-boundary.test.mjs",
  "tests/app-default-runtime-guard.test.mjs",
];

const RETAINED_RUNTIME_SEAMS = [
  [/\/api\/skill\/run\b/, "POST /api/skill/run"],
  [/\brunSkillStream\b/, "runSkillStream"],
  [/\bmountSkillRunRoute\b/, "mountSkillRunRoute"],
  [/\bchatRuntime\.startSession\b|\bstartSession\s*\(/, "chat runtime startSession"],
  [/\/api\/chat\b/, "chat API"],
  [/\/api\/discovery\/(?:quick-start|next)\b/, "discovery chat handoff"],
];

function readSource(file) {
  return readFileSync(resolve(REPO_ROOT, file), "utf8");
}

function stripJavaScriptComments(source) {
  let output = "";
  let state = "code";
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === "line-comment") {
      if (char === "\n") {
        output += char;
        state = "code";
      }
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        i += 1;
        state = "code";
      } else if (char === "\n") {
        output += "\n";
      }
      continue;
    }

    if (state === "single-quote" || state === "double-quote" || state === "template") {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (
        (state === "single-quote" && char === "'") ||
        (state === "double-quote" && char === '"') ||
        (state === "template" && char === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      i += 1;
      state = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 1;
      state = "block-comment";
      continue;
    }
    if (char === "'") state = "single-quote";
    else if (char === '"') state = "double-quote";
    else if (char === "`") state = "template";
    output += char;
  }

  return output;
}

function labelFor(file, detail = null) {
  const base = relative(REPO_ROOT, resolve(REPO_ROOT, file));
  return detail ? `${base} ${detail}` : base;
}

function assertNoRetainedRuntime(source, label) {
  for (const [pattern, reason] of RETAINED_RUNTIME_SEAMS) {
    assert.doesNotMatch(source, pattern, `${label} must not invoke ${reason}`);
  }
}

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} missing start marker: ${startMarker}`);
  if (!endMarker) return source.slice(start);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label} missing end marker: ${endMarker}`);
  assert.ok(end > start, `${label} slice has a valid range`);
  return source.slice(start, end);
}

function assertClassifiedPatterns(source, patterns, label) {
  for (const pattern of patterns) {
    assert.match(source, pattern, `${label} classification marker ${pattern} must remain present`);
  }
}

test("SEC-01 app-default guard scans the named product/default file set", () => {
  assert.ok(APP_DEFAULT_FILES.includes("apps/web/src/chat-first/ChatFirstApp.jsx"));
  assert.ok(APP_DEFAULT_FILES.includes("apps/web/src/chat-first/FirstRunExperience.jsx"));
  assert.ok(APP_DEFAULT_FILES.includes("apps/web/src/chat-first/ProfileSettings.jsx"));
  assert.ok(APP_DEFAULT_FILES.includes("apps/web/src/jobs/jobsSearch.js"));
  assert.equal(
    APP_DEFAULT_FILES.some((file) => file.includes("/JobsPage.jsx")),
    false
  );
  assert.equal(
    APP_DEFAULT_FILES.some((file) => file.includes("/OnboardingPage.jsx")),
    false
  );
});

test("SEC-01 retained runtime classifications are named, not blanket exceptions", () => {
  assert.deepEqual(
    CLASSIFIED_RETAINED_RUNTIME_FILES.map(({ file, classification }) => ({
      file,
      classification,
    })),
    [
      {
        file: "src/cli/skill-run-route.mjs",
        classification: "retained full-skill HTTP runtime owner",
      },
      {
        file: "src/core/ai/skill-runtime.mjs",
        classification: "retained one-shot skill runtime owner",
      },
      {
        file: "src/cli/chat-route.mjs",
        classification: "explicit chat HTTP runtime owner",
      },
      {
        file: "src/core/ai/chat-runtime.mjs",
        classification: "explicit conversational skill runtime owner",
      },
      {
        file: "src/cli/tracker-dev.mjs",
        classification: "embedded server mount for classified retained/debug/chat surfaces",
      },
    ]
  );
  assert.deepEqual(CLASSIFIED_RETAINED_RUNTIME_TEST_FILES, [
    "tests/skill-runtime.test.mjs",
    "tests/skill-run-route.test.mjs",
    "tests/chat-runtime.test.mjs",
    "tests/packet-runtime-boundary.test.mjs",
    "tests/app-default-runtime-guard.test.mjs",
  ]);
});

test("product/default files do not invoke retained full-runtime seams", () => {
  for (const file of APP_DEFAULT_FILES) {
    const source = stripJavaScriptComments(readSource(file));
    assertNoRetainedRuntime(source, labelFor(file));
  }
});

test("mixed app-default route slices stay local and deterministic", () => {
  for (const slice of MIXED_ROUTE_SLICES) {
    const source = stripJavaScriptComments(readSource(slice.file));
    const routeSource = sliceBetween(
      source,
      slice.start,
      slice.end,
      labelFor(slice.file, slice.label)
    );
    assertNoRetainedRuntime(routeSource, labelFor(slice.file, slice.label));
  }
});

test("explicit chat handoffs and narrow retained-runtime slices are classified by name", () => {
  for (const entry of CLASSIFIED_EXPLICIT_CHAT_SLICES) {
    const source = stripJavaScriptComments(readSource(entry.file));
    const joined = entry.slices
      .map(([start, end]) => sliceBetween(source, start, end, labelFor(entry.file, entry.label)))
      .join("\n");
    assertClassifiedPatterns(joined, entry.patterns, labelFor(entry.file, entry.label));
  }
});

test("retained runtime owners remain explicitly classified", () => {
  for (const entry of CLASSIFIED_RETAINED_RUNTIME_FILES) {
    const source = stripJavaScriptComments(readSource(entry.file));
    assertClassifiedPatterns(source, entry.patterns, labelFor(entry.file, entry.classification));
  }
});
