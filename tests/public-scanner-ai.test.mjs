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
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-public-scanner-ai-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function html(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

async function aiModule() {
  return import("../src/core/discovery/public-scanner-ai.mjs");
}

async function scannerModule() {
  return import("../src/core/discovery/scanner-cascade.mjs");
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded AI fallback runs only for ambiguous usable public text and retries at most once", async () => {
  const { extractAmbiguousPublicCareersPage } = await aiModule();
  const calls = [];

  const result = await extractAmbiguousPublicCareersPage({
    pageUrl: "https://ambiguous.example/careers",
    pageText:
      "Careers Open roles Join our AI workflow team. See https://boards.example/acme and https://jobs.example/acme",
    root: tempRepo(),
    call: async (options) => {
      calls.push(options);
      return {
        content: [
          {
            type: "text",
            text:
              calls.length === 1
                ? "not json with prompt/resume/bodyText"
                : JSON.stringify({
                    status: "ambiguous",
                    candidates: [
                      {
                        url: "https://boards.example/acme",
                        providerHint: "custom",
                        confidence: "low",
                      },
                    ],
                    reviewReason: "multiple plausible boards",
                  }),
          },
        ],
        model: "claude-native-test",
      };
    },
    now: NOW,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].outputMode, "native");
  assert.equal(calls[0].outputName, "public_careers_extract_response");
  assert.match(calls[1].messages.at(-1).content, /invalid JSON/);
  assert.equal(result.ok, true);
  assert.equal(result.ai.used, true);
  assert.equal(result.ai.retried, true);
  assert.equal(result.data.status, "ambiguous");

  const serialized = JSON.stringify(result);
  for (const token of ["prompt", "resume", "bodyText", "rawModelText", "pageText"]) {
    assert.equal(serialized.includes(token), false, `AI result leaked ${token}`);
  }
});

test("invalid AI schema produces manual review and no public write", async () => {
  const { extractAmbiguousPublicCareersPage } = await aiModule();
  const result = await extractAmbiguousPublicCareersPage({
    pageUrl: "https://invalid.example/careers",
    pageText: "Careers with two plausible public links and enough text for ambiguity.",
    root: tempRepo(),
    call: async () => ({
      content: [
        { type: "text", text: JSON.stringify({ jobPostings: [{ title: "Private Job" }] }) },
      ],
      model: "claude-native-test",
    }),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "review_needed");
  assert.equal(result.writeApproved, false);
  assert.equal(result.manual.available, true);
});

test("AI-suggested URL and provider remain advisory until deterministic validation passes", async () => {
  const { scanPublicIntelSeed } = await scannerModule();
  const repoRoot = tempRepo();
  let atsWrites = 0;

  const result = await scanPublicIntelSeed({
    repoRoot,
    seed: { name: "Model Hint Co", careersUrl: "https://model.example/careers" },
    resolveCompanyBoard: async () => ({
      ok: true,
      status: "unsupported_public",
      companyName: "Model Hint Co",
      companyDomain: "model.example",
      careersUrl: "https://model.example/careers",
      confidence: "medium",
      provenance: [{ source: "fixture", url: "https://model.example" }],
    }),
    fetchImpl: async () =>
      html(`
        <html><body>
          <a href="https://opaque-board.example/model">Roles</a>
          <a href="https://another-board.example/model">Jobs</a>
          <p>Ambiguous but reachable public careers content for model fallback.</p>
        </body></html>
      `),
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    aiCall: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "candidate_found",
            candidates: [
              {
                url: "https://jobs.lever.co/model-hint",
                providerHint: "lever",
                confidence: "high",
              },
            ],
            reviewReason: "AI suggested supported ATS",
          }),
        },
      ],
      model: "claude-native-test",
    }),
    validateAiCandidate: async () => ({ ok: false, reason: "not-observed-in-public-page" }),
    companyAtsUpsertImpl: async () => {
      atsWrites += 1;
    },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ai.used, true);
  assert.equal(result.status, "review_needed");
  assert.equal(result.deterministicValidation.ok, false);
  assert.equal(result.publicWriteApproved, false);
  assert.equal(atsWrites, 0);
});
