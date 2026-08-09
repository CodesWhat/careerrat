import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const PRODUCT_FILES = [
  "apps/web/src/App.jsx",
  "apps/web/src/app-shell/NavList.jsx",
  "apps/web/src/app-shell/DashboardContext.jsx",
  "apps/web/src/lib/api.js",
  "src/cli/dashboard-route.mjs",
  "src/cli/data-route.mjs",
  "src/cli/packet-route.mjs",
  "src/cli/boards-route.mjs",
  "src/cli/search-route.mjs",
  "scripts/scan-sourced.mjs",
];

const REACT_PRODUCT_PAGE_FILES = [
  "apps/web/src/onboarding/OnboardingPage.jsx",
  "apps/web/src/onboarding/InterviewSurface.jsx",
];

const LEGACY_STATIC_ROUTES = ["/onboard", "/search", "/packet", "/evaluate", "/answer", "/tracker"];

const FORBIDDEN_PRODUCT_DEPENDENCIES = [
  {
    name: "generated tracker export read",
    pattern: /workspace\/tracker\.json|["']tracker\.json["']/,
  },
  {
    name: "generated activity export read",
    pattern: /workspace\/activity\.jsonl|["']activity\.jsonl["']/,
  },
  {
    name: "storage-adapter tracker read",
    pattern: /\bdefaultAdapter\b|\.readTracker\s*\(|\breadTrackerOrRespondError\b/,
  },
  {
    name: "raw tracker or activity feed API call",
    pattern:
      /["']\/api\/(?:tracker|activity)["']|["']\/workspace\/(?:tracker\.json|activity\.jsonl)["']/,
  },
  {
    name: "legacy source setup file read",
    pattern: /config\/(?:search-sources\.yml|sourced-scan\.json)/,
  },
  {
    name: "scan-result file read",
    pattern:
      /workspace\/scan-results|sourced-\$\{[^}]+\}\.json|\^sourced-\.\+\\\.json\$|\breadScanFile\b|\bfindLatestScanFile\b/,
  },
  {
    name: "legacy tracker-derived seen-set helper",
    pattern: /\bbuildSeenSets\b/,
  },
];

const LEGACY_STATIC_AFFORDANCE_PATTERNS = LEGACY_STATIC_ROUTES.flatMap((route) => [
  {
    name: `direct ${route} anchor`,
    pattern: new RegExp(`(?:href|to)\\s*=\\s*["']${route.replace("/", "\\/")}["']`),
  },
  {
    name: `normal UX label for ${route}`,
    pattern: new RegExp(
      `(classic|legacy|static|retained utility|utility page|compatibility page)[^\\n]{0,80}${route.replace("/", "\\/")}|${route.replace("/", "\\/")}[^\\n]{0,80}(classic|legacy|static|retained utility|utility page|compatibility page)`,
      "i"
    ),
  },
]);

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

function assertNoMatch(source, pattern, message) {
  const match = source.match(pattern);
  assert.equal(match, null, `${message}${match ? `: ${match[0]}` : ""}`);
}

test("DB app shell guard scans the complete product boundary", () => {
  assert.deepEqual(PRODUCT_FILES, [
    "apps/web/src/App.jsx",
    "apps/web/src/app-shell/NavList.jsx",
    "apps/web/src/app-shell/DashboardContext.jsx",
    "apps/web/src/lib/api.js",
    "src/cli/dashboard-route.mjs",
    "src/cli/data-route.mjs",
    "src/cli/packet-route.mjs",
    "src/cli/boards-route.mjs",
    "src/cli/search-route.mjs",
    "scripts/scan-sourced.mjs",
  ]);
});

test("static affordance guard scans normal React product pages", () => {
  assert.deepEqual(REACT_PRODUCT_PAGE_FILES, [
    "apps/web/src/onboarding/OnboardingPage.jsx",
    "apps/web/src/onboarding/InterviewSurface.jsx",
  ]);
});

test("product files do not depend on generated tracker or activity exports", () => {
  for (const file of PRODUCT_FILES) {
    const source = stripJavaScriptComments(readSource(file));
    for (const dependency of FORBIDDEN_PRODUCT_DEPENDENCIES) {
      assertNoMatch(
        source,
        dependency.pattern,
        `${relative(REPO_ROOT, resolve(REPO_ROOT, file))} must not use ${dependency.name}`
      );
    }
  }
});

test("normal React product pages do not advertise legacy static-page affordances", () => {
  for (const file of REACT_PRODUCT_PAGE_FILES) {
    const source = stripJavaScriptComments(readSource(file));
    for (const affordance of LEGACY_STATIC_AFFORDANCE_PATTERNS) {
      assertNoMatch(
        source,
        affordance.pattern,
        `${relative(REPO_ROOT, resolve(REPO_ROOT, file))} must not expose ${affordance.name}`
      );
    }
  }
});
