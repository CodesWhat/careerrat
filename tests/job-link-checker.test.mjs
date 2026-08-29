import assert from "node:assert/strict";
import test from "node:test";

import {
  checkUrlLiveness,
  extractApplyControlsFromHtml,
} from "../src/core/liveness/job-link-checker.mjs";

const SPA_RESPONSE = async () =>
  new Response("<html><body>Loading</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("recommendation-card apply links are not primary posting controls", () => {
  const controls = extractApplyControlsFromHtml(`
    <main><h1>Staff Platform Engineer</h1><p>This role has been removed.</p></main>
    <aside><h2>Similar Jobs</h2><a>Easy Apply</a></aside>
  `);

  assert.deepEqual(controls, []);
});

test("prose containing apply is not an interactive apply control", () => {
  const controls = extractApplyControlsFromHtml(`
    <main>
      <h1>Staff Platform Engineer</h1>
      <p>Apply systems thinking to reliable distributed infrastructure.</p>
    </main>
  `);

  assert.deepEqual(controls, []);
});

test("real apply links and buttons are detected from their accessible labels", () => {
  for (const html of [
    `<a href="/jobs/123/apply"><span>Apply now</span></a>`,
    `<button type="button" aria-label="Submit application"></button>`,
    `<input type="submit" value="Start application">`,
    `<div role="button" title="Easy Apply"></div>`,
  ]) {
    assert.equal(extractApplyControlsFromHtml(html).length, 1, html);
  }
});

test("a real apply button after a long primary description remains detectable", () => {
  const html = `<main><h1>Staff Platform Engineer</h1><p>${"Detailed responsibility. ".repeat(110)}</p><button>Apply now</button></main>`;

  assert.deepEqual(extractApplyControlsFromHtml(html), ["Apply now"]);
});

test("a recommendation boundary after a long description excludes its apply controls", () => {
  const html = `<main><h1>Staff Platform Engineer</h1><p>${"Detailed responsibility. ".repeat(110)}</p></main><aside><h2>Similar Jobs</h2><a href="/jobs/other">Easy Apply</a></aside>`;

  assert.deepEqual(extractApplyControlsFromHtml(html), []);
});

test("liveness stays active when the primary apply button follows a long job description", async () => {
  const html = `<html><body><main><h1>Staff Platform Engineer</h1><p>${"Detailed responsibility. ".repeat(110)}</p><button>Apply now</button></main></body></html>`;
  const result = await checkUrlLiveness("https://jobs.example.com/staff-platform-engineer", {
    fetchImpl: async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    resolveHost: publicResolver,
  });

  assert.equal(result.result, "active");
  assert.equal(result.code, "apply_control_visible");
});

test("short Ashby SPA shell is uncertain rather than expired", async () => {
  const result = await checkUrlLiveness("https://jobs.ashbyhq.com/acme/123", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });

  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "spa_shell");
  assert.equal(result.escalationHint, "browser-evaluate");
  assert.equal("escalationUrl" in result, false);
});

test("Lever SPA shell returns lever-json escalation hint with escalationUrl", async () => {
  const result = await checkUrlLiveness("https://jobs.lever.co/acme/abc-123", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });

  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "spa_shell");
  assert.equal(result.escalationHint, "lever-json");
  assert.equal(result.escalationUrl, "https://api.lever.co/v0/postings/acme?mode=json");
});

test("Lever SPA shell with no path company sets escalationUrl to null", async () => {
  const result = await checkUrlLiveness("https://jobs.lever.co/", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });

  assert.equal(result.escalationHint, "lever-json");
  assert.equal(result.escalationUrl, null);
});

test("Wellfound SPA shell returns browser-evaluate escalation hint", async () => {
  const result = await checkUrlLiveness("https://wellfound.com/company/acme/jobs", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });

  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "spa_shell");
  assert.equal(result.escalationHint, "browser-evaluate");
  assert.equal("escalationUrl" in result, false);
});

test("liveness rejects a DNS name resolving to loopback before fetch", async () => {
  let called = false;
  const result = await checkUrlLiveness("https://attacker.example.test/job", {
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    fetchImpl: async () => {
      called = true;
      throw new Error("unsafe URL must not be fetched");
    },
  });

  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "unsafe_url");
  assert.equal(called, false);
});
