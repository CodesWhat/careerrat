import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const APP_DEFAULT_FILES = [
  "apps/web/src/App.jsx",
  "apps/web/src/app-shell/AppShell.jsx",
  "apps/web/src/app-shell/CaptureBar.jsx",
  "apps/web/src/app-shell/DashboardContext.jsx",
  "apps/web/src/app-shell/NavList.jsx",
  "apps/web/src/inbox/InboxPage.jsx",
  "apps/web/src/jobs/JobsPage.jsx",
  "apps/web/src/library/LibraryPage.jsx",
  "apps/web/src/lib/api.js",
  "apps/web/src/onboarding/OnboardingPage.jsx",
  "apps/web/src/onboarding/steps/CompaniesStep.jsx",
  "apps/web/src/onboarding/steps/FinishStep.jsx",
  "apps/web/src/onboarding/steps/ResumeStep.jsx",
  "apps/web/src/pages/HomePage.jsx",
  "apps/web/src/settings/SettingsPage.jsx",
  "src/cli/boards-route.mjs",
  "src/cli/dashboard-route.mjs",
  "src/cli/data-route.mjs",
  "src/cli/deep-ingest-route.mjs",
  "src/cli/discovery-route.mjs",
  "src/cli/onboard-route.mjs",
  "src/cli/packet-route.mjs",
  "src/cli/search-route.mjs",
  "src/cli/sourcing-route.mjs",
  "apps/desktop/main.mjs",
];

const RETAINED_RUNTIME_SEAMS = [
  [/\/api\/skill\/run\b/, "POST /api/skill/run"],
  [/\brunSkillStream\b/, "runSkillStream"],
  [/\bchatRuntime\.startSession\b|\bstartSession\s*\(/, "chat runtime startSession"],
  [/\/api\/chat\b/, "chat API"],
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

function assertNoRetainedRuntime(source, label) {
  for (const [pattern, reason] of RETAINED_RUNTIME_SEAMS) {
    assert.doesNotMatch(source, pattern, `${label} must not invoke ${reason}`);
  }
}

test("SEC-01 app-default files do not invoke retained full runtime", () => {
  for (const file of APP_DEFAULT_FILES) {
    const source = stripJavaScriptComments(readSource(file));
    assertNoRetainedRuntime(source, relative(REPO_ROOT, resolve(REPO_ROOT, file)));
  }
});
