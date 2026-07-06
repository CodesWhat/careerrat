import assert from "node:assert/strict";
import { test } from "node:test";

async function scrubModule() {
  return import("../src/core/discovery/public-intel-scrub.mjs");
}

function publicPayload(overrides = {}) {
  return {
    companyKey: "acme-ai",
    companyName: "Acme AI",
    companyDomain: "acme.example",
    careersUrl: "https://acme.example/careers",
    jobBoardUrl: "https://jobs.lever.co/acme",
    atsProvider: "lever",
    sourceKind: "supported_ats",
    confidence: "high",
    freshnessStatus: "fresh",
    provenance: [{ source: "resolver", url: "https://acme.example" }],
    conflicts: [],
    publicSignals: ["supported-ats"],
    ...overrides,
  };
}

test("public scrub allows metadata-only company and board payloads", async () => {
  const { assertPublicIntelPayload, scrubPublicIntelPayload } = await scrubModule();
  const payload = publicPayload();

  assert.doesNotThrow(() => assertPublicIntelPayload(payload, { context: "unit" }));
  const scrubbed = scrubPublicIntelPayload(payload, { context: "unit" });
  assert.deepEqual(scrubbed, payload);
  assert.notEqual(scrubbed, payload, "scrubbed payload should be a clone");
});

test("public scrub fails closed on private candidate, tracker, comp, notes, and local path fields", async () => {
  const { assertPublicIntelPayload } = await scrubModule();
  const cases = [
    ["candidate profile", { candidate: { full_name: "Private Person" } }],
    ["resume text", { resume: "private resume body" }],
    ["evidence", { evidence: [{ claim: "private fact" }] }],
    ["current comp", { compensation: { current_base: 171234 } }],
    ["comp floor", { minimum_base: 206789 }],
    ["fit score", { roleFit: { score: 92, why: ["private fit"] } }],
    ["gate output", { gate: "KEEP" }],
    ["tracker id", { trackerId: "app-123" }],
    ["application id", { applicationId: "app-123" }],
    ["sourced id", { sourcedId: "sourced-123" }],
    ["private note", { privateNote: "do not share" }],
    ["local path", { artifactPath: "/Users/scott/workspace/jobs/acme.md" }],
    ["workspace path", { jdPath: "workspace/jobs/acme.md" }],
  ];

  for (const [name, contamination] of cases) {
    assert.throws(
      () => assertPublicIntelPayload(publicPayload(contamination), { context: name }),
      (err) => err?.code === "PUBLIC_INTEL_PRIVATE_FIELD",
      name
    );
  }
});

test("public scrub blocks raw AI, prompt, page bodies, and individual job postings", async () => {
  const { assertPublicIntelPayload } = await scrubModule();
  const cases = [
    ["raw prompt", { prompt: "PROMPT_SECRET_09" }],
    ["raw model text", { rawModelText: "RAW_MODEL_REPLY_09" }],
    ["raw AI envelope", { ai: { raw: "RAW_MODEL_REPLY_09" } }],
    ["page body", { pageBody: "Full careers page body with private scraping text" }],
    ["body text", { bodyText: "Applied AI Engineer job body" }],
    [
      "job postings",
      { jobPostings: [{ title: "Applied AI Engineer", url: "https://jobs.test/1" }] },
    ],
    ["captured offers", { capturedOffers: [{ title: "Applied AI Engineer" }] }],
    ["req id", { reqId: "job-123" }],
    ["jd artifact", { artifacts: { jd: "workspace/jobs/acme.md" } }],
  ];

  for (const [name, contamination] of cases) {
    assert.throws(
      () => assertPublicIntelPayload(publicPayload(contamination), { context: name }),
      (err) => err?.code === "PUBLIC_INTEL_PRIVATE_FIELD",
      name
    );
  }
});

test("public scrub blocks sync-preview-shaped private source config and posting contamination", async () => {
  const { assertPublicIntelPayload } = await scrubModule();
  const preview = {
    companies: [publicPayload()],
    boards: [],
    careersPages: [],
  };

  for (const contamination of [
    {
      sourceConfig: {
        tracked_companies: [{ name: "Private Target", careers_url: "https://x.test" }],
      },
    },
    { searchSources: { searches: [{ query: "private candidate targeting" }] } },
    { sourcedRows: [{ id: "sourced-1", title: "Private sourced row" }] },
    {
      companies: [publicPayload({ jobPostings: [{ title: "Role", url: "https://jobs.test/1" }] })],
    },
    { careersPages: [{ ...publicPayload(), pageText: "Full public page body should not sync" }] },
  ]) {
    assert.throws(
      () => assertPublicIntelPayload({ ...preview, ...contamination }, { context: "sync-preview" }),
      (err) => err?.code === "PUBLIC_INTEL_PRIVATE_FIELD"
    );
  }
});

test("public scrub reports nested forbidden paths without leaking the raw private value", async () => {
  const { assertPublicIntelPayload } = await scrubModule();

  assert.throws(
    () =>
      assertPublicIntelPayload(
        publicPayload({
          provenance: [
            {
              source: "bad-fixture",
              nested: { profile: { full_name: "Private Candidate Secret 09" } },
            },
          ],
        }),
        { context: "nested" }
      ),
    (err) => {
      assert.equal(err.code, "PUBLIC_INTEL_PRIVATE_FIELD");
      assert.match(err.message, /provenance\.0\.nested\.profile/);
      assert.equal(err.message.includes("Private Candidate Secret 09"), false);
      return true;
    }
  );
});
