// Phase 08 Wave 0 RED contracts for deterministic Deep ingest source scanning.
// These tests intentionally fail until src/core/deep-ingest/source-scanner.mjs
// exists and implements bounded text, URL, repo, and local-path outcomes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const cleanupRoots = [];

const VISIBLE_OUTCOME_STATUSES = new Set([
  "proposal_ready",
  "manual_fallback",
  "gap",
  "deferred",
  "not_available",
  "failed",
]);

const TARGET_SHAPES = [
  "auto",
  "evidence",
  "story",
  "writing_voice",
  "honesty_boundary",
  "role_signal",
  "paste",
  "link",
];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-deep-ingest-scanner-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

async function loadScanner() {
  return import("../src/core/deep-ingest/source-scanner.mjs");
}

async function publicResolver() {
  return [{ address: "93.184.216.34", family: 4 }];
}

function assertVisibleOutcome(result, { sourceKind } = {}) {
  assert.ok(result, "scanner must return a result");
  assert.ok(VISIBLE_OUTCOME_STATUSES.has(result.status), `unexpected status ${result.status}`);
  assert.equal(
    [
      result.proposal,
      result.manualFallback,
      result.gap,
      result.deferred,
      result.notAvailable,
      result.error,
    ].filter(Boolean).length,
    1,
    "each source must produce exactly one visible proposal/manual/gap/deferred/not_available/failed outcome"
  );
  if (sourceKind) assert.equal(result.source.kind, sourceKind);
  assert.equal(result.source.status, result.status);
}

test("scanDeepIngestSource reads pasted text directly and produces one visible proposal-ready outcome", async () => {
  const { scanDeepIngestSource } = await loadScanner();

  const result = await scanDeepIngestSource({
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Built a local SQLite-backed job-search runtime with bounded AI proposals.",
    },
  });

  assertVisibleOutcome(result, { sourceKind: "paste" });
  assert.equal(result.status, "proposal_ready");
  assert.equal(result.source.targetShape, "evidence");
  assert.match(result.chunks[0].text, /SQLite-backed/);
  assert.equal(result.truncated, false);
});

test("scanDeepIngestSource preserves every explicit Deep ingest target shape", async () => {
  const { scanDeepIngestSource } = await loadScanner();

  for (const targetShape of TARGET_SHAPES) {
    const result = await scanDeepIngestSource({
      input: {
        targetShape,
        sourceKind: "paste",
        text: `Source material for ${targetShape}.`,
      },
    });

    assertVisibleOutcome(result, { sourceKind: "paste" });
    assert.equal(result.source.targetShape, targetShape);
    assert.equal(result.outcome.targetShape, targetShape);
  }
});

test("scanDeepIngestSource rejects unsafe schemes and private network hosts before fetch", async () => {
  const { scanDeepIngestSource } = await loadScanner();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run for unsafe URLs");
  };

  for (const url of [
    "file:///Users/scott/private-notes.md",
    "ftp://example.test/profile.txt",
    "http://127.0.0.1:7777/private",
    "http://localhost:7777/private",
    "http://10.0.0.5/internal",
    "http://172.16.0.8/internal",
    "http://192.168.1.10/internal",
    "http://169.254.169.254/latest/meta-data",
  ]) {
    const result = await scanDeepIngestSource({
      input: { targetShape: "auto", sourceKind: "url", url },
      fetchImpl,
      resolveHost: publicResolver,
    });
    assertVisibleOutcome(result, { sourceKind: "url" });
    assert.equal(result.status, "not_available");
    assert.match(result.reason, /unsafe|private|unsupported/i);
  }

  const resolvedPrivate = await scanDeepIngestSource({
    input: { targetShape: "auto", sourceKind: "url", url: "https://profile.example.test/private" },
    fetchImpl,
    resolveHost: async () => [{ address: "10.0.0.8", family: 4 }],
  });
  assertVisibleOutcome(resolvedPrivate, { sourceKind: "url" });
  assert.equal(resolvedPrivate.status, "not_available");
  assert.match(resolvedPrivate.reason, /private|local/i);

  assert.equal(fetchCalls, 0);
});

test("scanDeepIngestSource fetches bounded public URL text and marks login-gated/truncated outcomes explicitly", async () => {
  const { scanDeepIngestSource } = await loadScanner();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes("login")) {
      return {
        status: 200,
        url,
        headers: new Headers({ "content-type": "text/html" }),
        text: async () =>
          "<html><title>Sign in</title><body>Please log in to continue.</body></html>",
      };
    }
    return {
      status: 200,
      url,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => `<html><body>${"public profile ".repeat(5000)}</body></html>`,
    };
  };

  const publicResult = await scanDeepIngestSource({
    input: { targetShape: "writing_voice", sourceKind: "url", url: "https://example.test/profile" },
    fetchImpl,
    resolveHost: publicResolver,
    limits: { maxSourceChars: 800, maxFetchBytes: 1200 },
  });
  assertVisibleOutcome(publicResult, { sourceKind: "url" });
  assert.equal(publicResult.status, "gap");
  assert.equal(publicResult.truncated, true);
  assert.match(publicResult.reason, /truncated|too large/i);

  const loginResult = await scanDeepIngestSource({
    input: { targetShape: "evidence", sourceKind: "url", url: "https://example.test/login" },
    fetchImpl,
    resolveHost: publicResolver,
  });
  assertVisibleOutcome(loginResult, { sourceKind: "url" });
  assert.equal(loginResult.status, "deferred");
  assert.match(loginResult.reason, /login|sign in/i);
  assert.equal(calls.length, 2);
});

test("scanDeepIngestSource treats non-2xx URL responses as visible unavailable or gap states", async () => {
  const { scanDeepIngestSource } = await loadScanner();
  let bodyReads = 0;

  const missing = await scanDeepIngestSource({
    input: { targetShape: "auto", sourceKind: "url", url: "https://example.test/missing" },
    resolveHost: publicResolver,
    fetchImpl: async () => ({
      status: 404,
      url: "https://example.test/missing",
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => {
        bodyReads += 1;
        return "not found";
      },
    }),
  });
  assertVisibleOutcome(missing, { sourceKind: "url" });
  assert.equal(missing.status, "not_available");
  assert.match(missing.reason, /HTTP 404/);

  const errored = await scanDeepIngestSource({
    input: { targetShape: "auto", sourceKind: "url", url: "https://example.test/error" },
    resolveHost: publicResolver,
    fetchImpl: async () => ({
      status: 503,
      url: "https://example.test/error",
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => {
        bodyReads += 1;
        return "server error";
      },
    }),
  });
  assertVisibleOutcome(errored, { sourceKind: "url" });
  assert.equal(errored.status, "gap");
  assert.match(errored.reason, /HTTP 503/);
  assert.equal(bodyReads, 0);
});

test("scanDeepIngestSource scans public repo README, docs, and package metadata within file-count and byte caps", async () => {
  const { scanDeepIngestSource } = await loadScanner();
  const repoRoot = tempRepo();
  const repoPath = join(repoRoot, "sample-project");
  mkdirSync(join(repoPath, "docs"), { recursive: true });
  writeFileSync(join(repoPath, "README.md"), "# Agent workflow\nBuilt MCP tools.\n");
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "agent-workflow" }));
  writeFileSync(join(repoPath, "docs", "overview.md"), "System overview and evidence notes.");
  writeFileSync(join(repoPath, ".env"), "SECRET=do-not-read");

  const result = await scanDeepIngestSource({
    input: { targetShape: "story", sourceKind: "repo", repoPath },
    limits: { maxRepoFiles: 3, maxRepoBytes: 4096 },
  });

  assertVisibleOutcome(result, { sourceKind: "repo" });
  assert.equal(result.status, "proposal_ready");
  assert.deepEqual(result.files.map((file) => file.relativePath).sort(), [
    "README.md",
    "docs/overview.md",
    "package.json",
  ]);
  assert.equal(JSON.stringify(result).includes("SECRET=do-not-read"), false);
});

test("scanDeepIngestSource reads explicit local paths only and reports unreadable or unsupported paths as gaps", async () => {
  const { scanDeepIngestSource } = await loadScanner();
  const repoRoot = tempRepo();
  const notesPath = join(repoRoot, "notes.md");
  writeFileSync(notesPath, "Project note with supported local evidence.");

  const readable = await scanDeepIngestSource({
    input: {
      targetShape: "role_signal",
      sourceKind: "local_path",
      path: notesPath,
      explicit: true,
    },
  });
  assertVisibleOutcome(readable, { sourceKind: "local_path" });
  assert.equal(readable.status, "proposal_ready");
  assert.match(readable.chunks[0].text, /supported local evidence/);

  const implicit = await scanDeepIngestSource({
    input: {
      targetShape: "role_signal",
      sourceKind: "local_path",
      path: notesPath,
      explicit: false,
    },
  });
  assertVisibleOutcome(implicit, { sourceKind: "local_path" });
  assert.equal(implicit.status, "not_available");
  assert.match(implicit.reason, /explicit local path/i);

  const unreadable = await scanDeepIngestSource({
    input: {
      targetShape: "role_signal",
      sourceKind: "local_path",
      path: join(repoRoot, "missing.md"),
      explicit: true,
    },
  });
  assertVisibleOutcome(unreadable, { sourceKind: "local_path" });
  assert.equal(unreadable.status, "gap");
  assert.match(unreadable.reason, /unreadable|missing/i);
});

test("scanDeepIngestSource maps unsupported files and scanner failures to explicit visible states", async () => {
  const { scanDeepIngestSource } = await loadScanner();
  const unsupported = await scanDeepIngestSource({
    input: {
      targetShape: "auto",
      sourceKind: "file",
      fileName: "profile.mov",
      bytes: Buffer.from("video"),
    },
  });
  assertVisibleOutcome(unsupported, { sourceKind: "file" });
  assert.equal(unsupported.status, "not_available");
  assert.match(unsupported.reason, /unsupported/i);

  const failed = await scanDeepIngestSource({
    input: { targetShape: "auto", sourceKind: "url", url: "https://example.test/fail" },
    resolveHost: publicResolver,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assertVisibleOutcome(failed, { sourceKind: "url" });
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /network down/);
});
