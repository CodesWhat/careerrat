import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];
const NOW = new Date("2026-07-06T12:00:00.000Z");

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-public-scanner-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function response(body, { status = 200, headers = { "content-type": "text/html" } } = {}) {
  return new Response(body, { status, headers });
}

async function scannerModule() {
  return import("../src/core/discovery/scanner-cascade.mjs");
}

async function extractorModule() {
  return import("../src/core/discovery/public-page-extractor.mjs");
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supported ATS branch records public metadata without calling AI", async () => {
  const { scanPublicIntelSeed } = await scannerModule();
  const repoRoot = tempRepo();
  let aiCalls = 0;

  const result = await scanPublicIntelSeed({
    repoRoot,
    seed: { name: "Acme AI", domain: "acme.example" },
    resolveCompanyBoard: async () => ({
      ok: true,
      status: "supported_ats",
      companyName: "Acme AI",
      companyDomain: "acme.example",
      careersUrl: "https://jobs.lever.co/acme",
      jobBoardUrl: "https://jobs.lever.co/acme",
      atsProvider: "lever",
      confidence: "high",
      provenance: [{ source: "fixture", url: "https://acme.example" }],
    }),
    aiCall: async () => {
      aiCalls += 1;
      throw new Error("AI must not run for supported ATS");
    },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "supported_ats");
  assert.equal(result.classification, "supported_ats");
  assert.equal(result.ai.used, false);
  assert.equal(aiCalls, 0);
  assert.equal(result.reviewItem, null);
});

test("deterministic custom public page extraction records metadata and skips review for clean no-results", async () => {
  const { extractPublicCareersPage } = await extractorModule();

  const found = await extractPublicCareersPage({
    url: "https://acme.example/careers",
    fetchImpl: async () =>
      response(`
        <html><body>
          <h1>Careers at Acme</h1>
          <a href="https://jobs.ashbyhq.com/acme">Open roles</a>
          <a href="/about">About</a>
        </body></html>
      `),
    now: NOW,
  });

  assert.equal(found.ok, true);
  assert.equal(found.extractionStatus, "metadata_found");
  assert.equal(found.reviewRequired, false);
  assert.equal(found.aiEligible, false);
  assert.equal(found.metadata.jobBoardUrl, "https://jobs.ashbyhq.com/acme");
  assert.equal(found.metadata.atsProvider, "ashby");
  assert.ok(found.metadata.inputHash);

  const cleanNoResult = await extractPublicCareersPage({
    url: "https://plain.example/careers",
    fetchImpl: async () =>
      response("<html><body><h1>Careers</h1><p>No open roles.</p></body></html>"),
    now: NOW,
  });
  assert.equal(cleanNoResult.ok, true);
  assert.equal(cleanNoResult.extractionStatus, "no_public_jobs_signal");
  assert.equal(cleanNoResult.reviewRequired, false);
  assert.equal(cleanNoResult.aiEligible, false);
});

test("empty, blocked, robots-disallowed, login-gated, and useless pages do not call AI or create review items", async () => {
  const { scanPublicIntelSeed } = await scannerModule();
  const repoRoot = tempRepo();
  const cases = [
    ["empty", response("")],
    ["blocked", response("Forbidden", { status: 403 })],
    [
      "robots",
      response('<html><head><meta name="robots" content="noindex,nofollow"></head></html>'),
    ],
    ["login", response("<html><body>Please sign in to view careers.</body></html>")],
    ["useless", response("<html><body><nav>Home</nav></body></html>")],
  ];

  for (const [name, res] of cases) {
    let aiCalls = 0;
    const result = await scanPublicIntelSeed({
      repoRoot,
      seed: { name: `Case ${name}`, careersUrl: `https://${name}.example/careers` },
      resolveCompanyBoard: async () => ({
        ok: true,
        status: "unsupported_public",
        companyName: `Case ${name}`,
        companyDomain: `${name}.example`,
        careersUrl: `https://${name}.example/careers`,
        confidence: "low",
        provenance: [{ source: "fixture", url: `https://${name}.example` }],
      }),
      fetchImpl: async () => res,
      aiCall: async () => {
        aiCalls += 1;
        return { content: [{ type: "text", text: "{}" }] };
      },
      now: NOW,
    });

    assert.equal(result.ok, true, name);
    assert.equal(aiCalls, 0, name);
    assert.equal(result.ai.used, false, name);
    assert.equal(result.reviewItem, null, name);
    assert.match(result.status, /no_result|blocked|robots|login|unsupported_public/, name);
  }
});

test("ambiguous reachable public text creates review metadata before any source-config write", async () => {
  const { scanPublicIntelSeed } = await scannerModule();
  const repoRoot = tempRepo();
  let companyAtsWrites = 0;

  const result = await scanPublicIntelSeed({
    repoRoot,
    seed: { name: "Ambiguous Co", careersUrl: "https://ambiguous.example/careers" },
    resolveCompanyBoard: async () => ({
      ok: true,
      status: "unsupported_public",
      companyName: "Ambiguous Co",
      companyDomain: "ambiguous.example",
      careersUrl: "https://ambiguous.example/careers",
      confidence: "medium",
      provenance: [{ source: "fixture", url: "https://ambiguous.example" }],
    }),
    fetchImpl: async () =>
      response(`
        <html><body>
          <a href="/careers">Careers</a>
          <a href="https://boards.example/ambiguous">Open roles</a>
          <a href="https://jobs.example/ambiguous">Jobs</a>
          <p>Join our team building AI workflow tools.</p>
        </body></html>
      `),
    companyAtsUpsertImpl: async () => {
      companyAtsWrites += 1;
    },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "review_needed");
  assert.equal(result.reviewItem.reason, "ambiguous_public_page");
  assert.equal(companyAtsWrites, 0);
});
