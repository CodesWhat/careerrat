import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_FIRST_SEARCH_RUNTIME = [
  [/\/api\/chat\b/, "chat API"],
  [/\/api\/discovery\/(?:quick-start|next)\b/, "discovery chat handoff"],
  [/\/api\/skill\/run\b/, "retained skill runtime"],
  [/\brunSkillStream\b/, "full skill runtime"],
  [/\b(?:startSession|captureBoard|captureSearchSources|capture-board)\b/, "browser capture"],
  [/\b(?:research-boards|discover-companies)\b/, "agent discovery skill handoff"],
];

function source(path) {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function stripJavaScriptComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function assertNoForbiddenRuntime(text, label) {
  for (const [pattern, reason] of FORBIDDEN_FIRST_SEARCH_RUNTIME) {
    assert.doesNotMatch(text, pattern, `${label} must not invoke ${reason}`);
  }
}

function sliceBetween(text, startMarker, endMarker, label = startMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker for ${label}`);
  const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : -1;
  assert.notEqual(end, -1, `missing end marker for ${label}`);
  return text.slice(start, end);
}

function functionBlock(text, marker) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing function marker ${marker}`);
  const bodyStartMatch = /\)\s*\{/.exec(text.slice(start));
  assert.ok(bodyStartMatch, `missing body opening brace for ${marker}`);
  const braceStart = start + bodyStartMatch.index + bodyStartMatch[0].lastIndexOf("{");

  let depth = 0;
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
  }

  assert.fail(`missing closing brace for ${marker}`);
}

test("first-search backend routes stay deterministic and local", () => {
  const firstSearch = stripJavaScriptComments(source("src/core/onboarding/first-search-run.mjs"));
  assert.match(firstSearch, /\brunSourcedScan\b/);
  assert.match(firstSearch, /\bsourceConfigGet\b/);
  assert.match(firstSearch, /\bsourceConfigPut\b/);
  assert.match(firstSearch, /\bcountDeterministicSources\b/);
  assert.match(firstSearch, /purpose = "first-search"/);
  assert.match(firstSearch, /purpose: "manual-search"/);
  assertNoForbiddenRuntime(firstSearch, "first-search service");

  const sourcingRoute = stripJavaScriptComments(source("src/cli/sourcing-route.mjs"));
  assert.match(sourcingRoute, /\/api\/sourcing\/first-run\/start/);
  assert.match(sourcingRoute, /\/api\/sourcing\/search\/start/);
  assert.match(sourcingRoute, /\bstartFirstSearchRun\b/);
  assert.match(sourcingRoute, /\bstartManualSearchRun\b/);
  assert.match(sourcingRoute, /\brunFirstSearchInBackground\b/);
  assertNoForbiddenRuntime(sourcingRoute, "sourcing route");

  const onboardRoute = stripJavaScriptComments(source("src/cli/onboard-route.mjs"));
  const quickStartFunction = functionBlock(
    onboardRoute,
    "export async function prepareQuickStartFirstSearch"
  );
  assert.match(quickStartFunction, /\bstartFirstSearchRun\b/);
  assert.match(quickStartFunction, /\brunFirstSearchInBackground\b/);
  assertNoForbiddenRuntime(quickStartFunction, "quick-start first-search function");

  const quickStartRoute = sliceBetween(
    onboardRoute,
    'addRoute("POST", "/api/onboard/quick-start"',
    'addRoute("POST", "/api/settings/ai-key"',
    "quick-start route"
  );
  assert.match(quickStartRoute, /\bprepareQuickStartFirstSearch\b/);
  assertNoForbiddenRuntime(quickStartRoute, "quick-start route");
});

test("manual search helper uses the deterministic sourcing endpoint", () => {
  const jobsSearch = stripJavaScriptComments(source("apps/web/src/jobs/jobsSearch.js"));
  assert.match(jobsSearch, /\bstartSearchRun\b/);
  assert.match(jobsSearch, /purpose: "manual-search"/);
  assert.doesNotMatch(jobsSearch, /\bstartFirstSearchRun\b/);
  assertNoForbiddenRuntime(jobsSearch, "jobsSearch manual search helper");

  const apiSource = stripJavaScriptComments(source("apps/web/src/lib/api.js"));
  const startSearchRun = functionBlock(apiSource, "export function startSearchRun");
  assert.match(startSearchRun, /\/api\/sourcing\/search\/start/);
  assertNoForbiddenRuntime(startSearchRun, "startSearchRun API helper");

  const chatFirstApi = stripJavaScriptComments(source("apps/web/src/chat-first/api.js"));
  assert.match(
    chatFirstApi,
    /export const chatFirstApi = Object\.freeze\(\{[\s\S]*\bstartSearchRun\b/
  );

  const trackerDev = source("src/cli/tracker-dev.mjs");
  assert.match(trackerDev, /\bmountSearchRoutes\b/);
  const searchRoute = stripJavaScriptComments(source("src/cli/search-route.mjs"));
  assert.match(searchRoute, /addRoute\("GET", "\/api\/search\/sources"/);
});

test("chat-first onboarding starts the local first search as soon as targeting is ready", () => {
  const firstRunController = stripJavaScriptComments(
    source("apps/web/src/chat-first/FirstRunController.jsx")
  );
  const advanceOnboard = sliceBetween(
    firstRunController,
    "const advanceOnboard = useCallback(",
    "\n\n  const refreshOnboard = useCallback(",
    "first-run search kickoff"
  );
  assert.match(advanceOnboard, /readiness\?\.search_ready === true/);
  assert.match(advanceOnboard, /\bfirstSearchStatus\(next\)/);
  assert.match(advanceOnboard, /\bstartFirstSearchRun\(/);
  assert.doesNotMatch(advanceOnboard, /\bstartSearchRun\b/);
  assertNoForbiddenRuntime(advanceOnboard, "first-run search kickoff");
});

test("DB-backed search readiness comes from source config, not generated YAML", () => {
  const onboardRoute = stripJavaScriptComments(source("src/cli/onboard-route.mjs"));
  const dbCounts = functionBlock(onboardRoute, "function dbDeterministicSourceCounts");
  const dbReady = functionBlock(onboardRoute, "function dbSearchSourcesPresent");
  assert.match(dbCounts, /sourceConfigGet\(\{ \.\.\.pathCtx, name: "search-sources" \}\)/);
  assert.match(dbCounts, /sourceConfigGet\(\{ \.\.\.pathCtx, name: "sourced-scan" \}\)/);
  assert.match(dbCounts, /\bcountDeterministicSources\b/);
  assert.match(dbCounts, /\bhealSearchSourceConfig\b/);
  assert.match(dbReady, /dbDeterministicSourceCounts\(pathCtx, config\)\.attempted > 0/);
  assert.doesNotMatch(dbReady, /config\/search-sources\.yml|existsSync/);

  const dbStateBranch = sliceBetween(
    onboardRoute,
    "if (dbExists(pathCtx)) {",
    "\n    const load = loadCandidate",
    "DB state branch"
  );
  assert.match(dbStateBranch, /searchSourcesPresent: dbSearchSourcesPresent\(pathCtx, config\)/);
  assert.doesNotMatch(dbStateBranch, /config\/search-sources\.yml/);

  const searchRoute = stripJavaScriptComments(source("src/cli/search-route.mjs"));
  const configuredSources = functionBlock(searchRoute, "function hasConfiguredDbSourcesOnly");
  const searchSourcesRoute = sliceBetween(
    searchRoute,
    'addRoute("GET", "/api/search/sources"',
    "\n  });\n}",
    "search sources route"
  );
  assert.match(configuredSources, /name: "search-sources"/);
  assert.match(configuredSources, /name: "sourced-scan"/);
  assert.doesNotMatch(configuredSources, /config\/search-sources\.yml|existsSync/);
  assert.match(
    searchSourcesRoute,
    /sourceConfigGet\(\{ \.\.\.pathCtx, name: "search-sources" \}\)/
  );
  assert.match(searchSourcesRoute, /\bcountDeterministicSources\b/);
});

test("DOCX onboarding offers AI markdown extraction while preserving raw-text local fallback", () => {
  const docxParser = stripJavaScriptComments(source("src/core/onboarding/resume-docx.mjs"));
  assert.match(docxParser, /\bmammoth\.extractRawText\b/);
  assert.match(docxParser, /\bnormalizeDocxResumeText\b/);
  assert.match(docxParser, /\bmammoth\.convertToMarkdown\b/);
  assert.match(docxParser, /\bmammoth\.convertToHtml\b/);

  const onboardRoute = stripJavaScriptComments(source("src/cli/onboard-route.mjs"));
  const docxRoute = onboardRoute.slice(
    onboardRoute.indexOf('addRoute("POST", "/api/onboard/resume-docx"'),
    onboardRoute.indexOf('addRoute("POST", "/api/onboard/resume-ai"')
  );
  assert.match(docxRoute, /resolveAIRoute\(env, \{ repoRoot \}\)\.type !== "none"/);
  assert.match(docxRoute, /extractDocxResumeMarkdown\(bytes\)/);
  assert.match(docxRoute, /runResumeExtractBounded/);
  assert.match(docxRoute, /const parsed = parseResume\(text\)/);
  assert.match(docxRoute, /extraction: "local"/);

  const candidateSetupTests = source("tests/candidate-setup.test.mjs");
  assert.match(candidateSetupTests, /defaults form-defaults\.document_formats to PDF packets/);
  assert.match(candidateSetupTests, /default_packet_format: "pdf"/);
  assert.match(candidateSetupTests, /required_export_formats: \[\]/);
  assert.match(candidateSetupTests, /validates DOCX as a board-required export format/);
  assert.match(candidateSetupTests, /required_export_formats: \["docx"\]/);
});
