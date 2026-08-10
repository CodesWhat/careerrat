import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Synced against source deletions/renames from 728a5f85 (calendar V2/V3
// consolidation: CalendarEventChip/MonthView/WeekView deleted) and a85a9e96
// (JobFunnel/JobRow deleted — replaced by FunnelSankey.jsx + inline rows on
// JobsPage.jsx; HomePage.jsx deleted — DashboardV2Page de-versioned to
// DashboardPage.jsx as its replacement).
const APP_DEFAULT_FILES = [
  "apps/web/src/App.jsx",
  "apps/web/src/main.jsx",
  "apps/web/src/app-shell/ActivityBell.jsx",
  "apps/web/src/app-shell/AppShell.jsx",
  "apps/web/src/app-shell/AskBar.jsx",
  "apps/web/src/app-shell/DashboardContext.jsx",
  "apps/web/src/app-shell/NavList.jsx",
  "apps/web/src/app-shell/useNeedsYouCount.js",
  "apps/web/src/calendar/CalendarPage.jsx",
  "apps/web/src/components/Button.jsx",
  "apps/web/src/components/Card.jsx",
  "apps/web/src/components/Chip.jsx",
  "apps/web/src/components/CompanyAvatar.jsx",
  "apps/web/src/components/PageScaffold.jsx",
  "apps/web/src/components/Toast.jsx",
  "apps/web/src/components/form.jsx",
  "apps/web/src/components/icons.jsx",
  "apps/web/src/inbox/InboxPage.jsx",
  "apps/web/src/inbox/IntakeCard.jsx",
  "apps/web/src/inbox/intake-labels.js",
  "apps/web/src/jobs/FunnelSankey.jsx",
  "apps/web/src/jobs/JobDrawer.jsx",
  "apps/web/src/jobs/JobsPage.jsx",
  "apps/web/src/jobs/jobsSearch.js",
  "apps/web/src/lib/quickFacts.js",
  "apps/web/src/library/LibraryPage.jsx",
  "apps/web/src/network/NetworkPage.jsx",
  "apps/web/src/onboarding/EngineScreen.jsx",
  "apps/web/src/onboarding/FilePane.jsx",
  "apps/web/src/onboarding/OnboardingBar.jsx",
  "apps/web/src/onboarding/OnboardingPage.jsx",
  "apps/web/src/onboarding/OnboardingShell.jsx",
  "apps/web/src/onboarding/onboardingSetup.js",
  "apps/web/src/onboarding/steps/GuardrailsStep.jsx",
  "apps/web/src/pages/ComingSoonPage.jsx",
  "apps/web/src/pages/DashboardPage.jsx",
  "apps/web/src/pages/SetupReadinessCard.jsx",
  "apps/web/src/settings/InstalledRuntimeChoices.jsx",
  "apps/web/src/settings/SettingsPage.jsx",
  "src/cli/assist-route.mjs",
  "src/cli/boards-route.mjs",
  "src/cli/dashboard-route.mjs",
  "src/cli/data-route.mjs",
  "src/cli/deep-ingest-route.mjs",
  "src/cli/logo-route.mjs",
  "src/cli/packet-route.mjs",
  "src/cli/search-route.mjs",
  "src/cli/sourcing-route.mjs",
  "src/core/ai/answer-page.mjs",
  "src/core/onboarding/packet-page.mjs",
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
    label: "intake upload route",
    start: 'addRoute("POST", "/api/intake/upload"',
    end: 'addRoute("GET", "/api/intake/list"',
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

const CLASSIFIED_LEGACY_STATIC_RUNTIME_FILES = [
  {
    file: "src/core/onboarding/chat-page.mjs",
    classification: "legacy static chat page explicit chat client",
    patterns: [/\/api\/chat\/start/, /\/api\/chat\/events/],
  },
];

const CLASSIFIED_EXPLICIT_CHAT_SLICES = [
  {
    file: "apps/web/src/lib/api.js",
    label: "discovery chat handoff API helpers",
    slices: [
      ["export function startDiscoveryQuickStart", "export async function suggestAssist"],
      ["export function startChat", "export function createIntake"],
    ],
    patterns: [/\/api\/discovery\/quick-start/, /\/api\/chat\/start/],
  },
  {
    file: "apps/web/src/onboarding/ChatPanel.jsx",
    label: "visible chat panel",
    slices: [["export function ChatPanel", null]],
    patterns: [/\bstartChat\b/, /\/api\/chat\/events/],
  },
  {
    file: "apps/web/src/onboarding/InterviewSurface.jsx",
    label: "W4 chat-first onboarding interview panel",
    slices: [["export function InterviewSurface", null]],
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
    label: "confirm-first intake retained runtime dispatch",
    slices: [
      ["function executeLaneB", "function buildChatHandoffText"],
      ["async function executeLaneC", "export function mountIntakeRoutes"],
      ['addRoute("POST", "/api/intake/confirm"', 'addRoute("POST", "/api/intake/dismiss"'],
    ],
    patterns: [/\brunSkillStream\b/, /\bchatRuntime\.startSession\b/],
  },
  {
    file: "src/cli/onboard-route.mjs",
    label: "Read-only resume-extract retained runtime slice",
    slices: [
      ['addRoute("POST", "/api/onboard/resume-ai"', 'addRoute("POST", `/api/onboard/candidate'],
    ],
    patterns: [/\brunSkillStream\b/, /tools:\s*\[\s*"Read"\s*\]/, /skill:\s*"resume-extract"/],
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
  assert.deepEqual(APP_DEFAULT_FILES, [
    "apps/web/src/App.jsx",
    "apps/web/src/main.jsx",
    "apps/web/src/app-shell/ActivityBell.jsx",
    "apps/web/src/app-shell/AppShell.jsx",
    "apps/web/src/app-shell/AskBar.jsx",
    "apps/web/src/app-shell/DashboardContext.jsx",
    "apps/web/src/app-shell/NavList.jsx",
    "apps/web/src/app-shell/useNeedsYouCount.js",
    "apps/web/src/calendar/CalendarPage.jsx",
    "apps/web/src/components/Button.jsx",
    "apps/web/src/components/Card.jsx",
    "apps/web/src/components/Chip.jsx",
    "apps/web/src/components/CompanyAvatar.jsx",
    "apps/web/src/components/PageScaffold.jsx",
    "apps/web/src/components/Toast.jsx",
    "apps/web/src/components/form.jsx",
    "apps/web/src/components/icons.jsx",
    "apps/web/src/inbox/InboxPage.jsx",
    "apps/web/src/inbox/IntakeCard.jsx",
    "apps/web/src/inbox/intake-labels.js",
    "apps/web/src/jobs/FunnelSankey.jsx",
    "apps/web/src/jobs/JobDrawer.jsx",
    "apps/web/src/jobs/JobsPage.jsx",
    "apps/web/src/jobs/jobsSearch.js",
    "apps/web/src/lib/quickFacts.js",
    "apps/web/src/library/LibraryPage.jsx",
    "apps/web/src/network/NetworkPage.jsx",
    "apps/web/src/onboarding/EngineScreen.jsx",
    "apps/web/src/onboarding/FilePane.jsx",
    "apps/web/src/onboarding/OnboardingBar.jsx",
    "apps/web/src/onboarding/OnboardingPage.jsx",
    "apps/web/src/onboarding/OnboardingShell.jsx",
    "apps/web/src/onboarding/onboardingSetup.js",
    "apps/web/src/onboarding/steps/GuardrailsStep.jsx",
    "apps/web/src/pages/ComingSoonPage.jsx",
    "apps/web/src/pages/DashboardPage.jsx",
    "apps/web/src/pages/SetupReadinessCard.jsx",
    "apps/web/src/settings/InstalledRuntimeChoices.jsx",
    "apps/web/src/settings/SettingsPage.jsx",
    "src/cli/assist-route.mjs",
    "src/cli/boards-route.mjs",
    "src/cli/dashboard-route.mjs",
    "src/cli/data-route.mjs",
    "src/cli/deep-ingest-route.mjs",
    "src/cli/logo-route.mjs",
    "src/cli/packet-route.mjs",
    "src/cli/search-route.mjs",
    "src/cli/sourcing-route.mjs",
    "src/core/ai/answer-page.mjs",
    "src/core/onboarding/packet-page.mjs",
    "apps/desktop/main.mjs",
  ]);
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

test("retained runtime owners and legacy/static clients remain explicitly classified", () => {
  for (const entry of [
    ...CLASSIFIED_RETAINED_RUNTIME_FILES,
    ...CLASSIFIED_LEGACY_STATIC_RUNTIME_FILES,
  ]) {
    const source = stripJavaScriptComments(readSource(entry.file));
    assertClassifiedPatterns(source, entry.patterns, labelFor(entry.file, entry.classification));
  }
});
