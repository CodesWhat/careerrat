// tests/intake-resolve.test.mjs — src/core/intake/resolve.mjs's deterministic
// (zero-AI) URL resolver. Every case below drives a hand-rolled fetchImpl —
// no real network, no real ATS API — verifying: known-ATS board-JSON success,
// known-ATS board fetch failure falling through to plain fetch (or straight
// to "deferred" when the same host is also SPA-rendered), non-ATS SPA/login-
// gated hosts short-circuiting BEFORE any fetch call at all, and the plain-
// fetch liveness-classification branches (active/insufficient/bot-wall/
// network-error).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hydrateJobOffer, resolveJobUrl } from "../src/core/intake/resolve.mjs";

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function htmlResponse(html, { status = 200, finalUrl = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: finalUrl,
    text: async () => html,
  };
}

const LONG_ACTIVE_JD = `<html><body><h1>Staff Engineer</h1><p>${"Real job description content. ".repeat(20)}</p><button>Apply</button></body></html>`;
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("invalid URL string -> deferred, never calls fetchImpl", async () => {
  let called = false;
  const result = await resolveJobUrl("not a url at all", {
    fetchImpl: async () => (called = true),
  });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.match(result.reason, /invalid URL/);
  assert.equal(called, false);
});

test("unsupported protocol -> deferred, never calls fetchImpl", async () => {
  let called = false;
  const result = await resolveJobUrl("ftp://example.com/file", {
    fetchImpl: async () => (called = true),
  });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.match(result.reason, /unsupported protocol/);
  assert.equal(called, false);
});

test("private-network URL -> deferred before any fetch", async () => {
  let called = false;
  const result = await resolveJobUrl("http://127.0.0.1:7777/api/data/dashboard", {
    fetchImpl: async () => {
      called = true;
      throw new Error("private URL must not be fetched");
    },
  });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.match(result.reason, /private|unsafe/i);
  assert.equal(called, false);
});

test("known ATS (Greenhouse) board fetch succeeds and finds the matching posting -> resolved, zero AI needed", async () => {
  const url = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const fetchImpl = async (requestedUrl) => {
    assert.match(String(requestedUrl), /boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs/);
    return jsonResponse({
      jobs: [
        {
          title: "Staff Engineer",
          absolute_url: url,
          location: { name: "Remote" },
          content: "<p>Full JD text here.</p>",
        },
      ],
    });
  };
  const result = await resolveJobUrl(url, { fetchImpl, resolveHost: publicResolver });
  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.provider, "greenhouse");
  assert.equal(result.title, "Staff Engineer");
  assert.equal(
    result.company,
    "Acme",
    "falls back to the URL's company slug when the board doesn't name one"
  );
  assert.match(result.bodyText, /Full JD text here/);
});

test("known ATS preserves a complete canonical body beyond the old 4000-character preview cap", async () => {
  const url = "https://job-boards.greenhouse.io/acme/jobs/long-body";
  const ending =
    "Final responsibility: keep the complete canonical job description available locally.";
  const canonicalBody = `${"Build durable systems with the product team and own delivery outcomes. ".repeat(90)}${ending}`;
  assert.ok(canonicalBody.length > 4000);

  const result = await resolveJobUrl(url, {
    fetchImpl: async () =>
      jsonResponse({
        jobs: [
          {
            title: "Staff Engineer",
            absolute_url: url,
            content: `<p>${canonicalBody}</p>`,
          },
        ],
      }),
    resolveHost: publicResolver,
  });

  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.bodyPartial, false);
  assert.ok(result.bodyText.length > 4000);
  assert.ok(result.bodyText.endsWith(ending));
});

test("known ATS resolutions share one provider-board fetch per run", async () => {
  const firstUrl = "https://job-boards.greenhouse.io/acme/jobs/111111";
  const secondUrl = "https://job-boards.greenhouse.io/acme/jobs/222222";
  const resolutionCache = new Map();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return jsonResponse({
      jobs: [
        {
          title: "Platform Engineer",
          absolute_url: firstUrl,
          content: `<p>${"Own the platform and ship reliable systems. ".repeat(4)}</p>`,
        },
        {
          title: "Product Engineer",
          absolute_url: secondUrl,
          content: `<p>${"Build the product and collaborate with customers. ".repeat(4)}</p>`,
        },
      ],
    });
  };

  const [first, second] = await Promise.all([
    resolveJobUrl(firstUrl, { fetchImpl, resolveHost: publicResolver, resolutionCache }),
    resolveJobUrl(secondUrl, { fetchImpl, resolveHost: publicResolver, resolutionCache }),
  ]);

  assert.equal(fetchCalls, 1);
  assert.equal(first.title, "Platform Engineer");
  assert.equal(second.title, "Product Engineer");
});

test("hydrateJobOffer keeps a safety-capped canonical body explicitly partial", async () => {
  const url = "https://job-boards.greenhouse.io/acme/jobs/oversized";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Staff Engineer",
      url,
      bodyText: "Model preview only.",
      bodyPartial: true,
    },
    {
      force: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        jsonResponse({
          jobs: [
            {
              title: "Staff Engineer",
              absolute_url: url,
              content: `<p>${"A".repeat(70_000)}</p>`,
            },
          ],
        }),
    }
  );

  assert.equal(hydrated.bodyText.length, 65_536);
  assert.equal(hydrated.bodyPartial, true);
  assert.match(hydrated.bodyFetchReason, /safety limit/);
});

test("known ATS (Greenhouse) board fetch fails -> falls through to a plain fetch of the same URL", async () => {
  const url = "https://job-boards.greenhouse.io/acme/jobs/999999";
  let plainFetchCalled = false;
  const fetchImpl = async (requestedUrl) => {
    if (new URL(String(requestedUrl)).hostname === "boards-api.greenhouse.io") {
      throw new Error("board API unreachable");
    }
    plainFetchCalled = true;
    assert.equal(requestedUrl, url);
    return htmlResponse(LONG_ACTIVE_JD, { finalUrl: url });
  };
  const result = await resolveJobUrl(url, { fetchImpl, resolveHost: publicResolver });
  assert.equal(plainFetchCalled, true);
  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.provider, "greenhouse");
  assert.equal(result.liveness.result, "active");
});

test("known ATS that's ALSO an SPA host (Ashby) with a failing board fetch -> deferred, no plain-fetch fallback", async () => {
  const url = "https://jobs.ashbyhq.com/acme/12345678-1234-1234-1234-123456789abc";
  let plainFetchAttempted = false;
  const fetchImpl = async (requestedUrl) => {
    if (new URL(String(requestedUrl)).hostname === "api.ashbyhq.com") {
      throw new Error("board API unreachable");
    }
    plainFetchAttempted = true;
    return htmlResponse(LONG_ACTIVE_JD);
  };
  const result = await resolveJobUrl(url, { fetchImpl });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.match(result.reason, /SPA-rendered or login-gated/);
  assert.equal(
    plainFetchAttempted,
    false,
    "an SPA-classified host must never fall through to a plain fetch"
  );
});

test("non-ATS SPA-listed host (Wellfound) -> deferred without ever calling fetchImpl", async () => {
  let called = false;
  const result = await resolveJobUrl("https://wellfound.com/jobs/12345", {
    fetchImpl: async () => (called = true),
  });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.equal(called, false);
});

test("non-ATS aggregator host recognized via platformForHost (LinkedIn) -> deferred without calling fetchImpl", async () => {
  let called = false;
  const result = await resolveJobUrl("https://www.linkedin.com/jobs/view/123456", {
    fetchImpl: async () => (called = true),
  });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.equal(called, false);
});

test("plain fetch: a long body with a visible apply control -> resolved, active liveness", async () => {
  const result = await resolveJobUrl("https://example-startup.com/careers/eng-1", {
    fetchImpl: async () => htmlResponse(LONG_ACTIVE_JD),
    resolveHost: publicResolver,
  });
  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.liveness.result, "active");
  assert.match(result.bodyText, /Staff Engineer/);
});

test("plain aggregator fetch: prefers the structured JobPosting body over site navigation and footer noise", async () => {
  const html = readFileSync(
    join(import.meta.dirname, "fixtures/intake/job-posting-with-site-chrome.html"),
    "utf8"
  );
  const result = await resolveJobUrl("https://remote-board.example/jobs/acme-platform", {
    fetchImpl: async () => htmlResponse(html),
    resolveHost: publicResolver,
  });

  assert.equal(result.bodyFetchStatus, "resolved");
  assert.match(result.bodyText, /Build and operate the application platform/);
  assert.match(result.bodyText, /Production Python and Kubernetes experience/);
  assert.match(result.bodyText, /\$180,000-\$220,000 USD base salary\.$/);
  assert.doesNotMatch(result.bodyText, /Jobs Companies Salaries|Similar Jobs|Developer Questions/);
  assert.doesNotMatch(result.bodyText, /For Candidates|Privacy Policy|All rights reserved/);
});

test("plain aggregator page: follows a canonical ATS apply link and returns the full provider body", async () => {
  const aggregatorUrl = "https://remotevibecodingjobs.com/jobs/acme-staff-engineer";
  const atsUrl = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const fetchImpl = async (requestedUrl) => {
    const url = String(requestedUrl);
    if (url === aggregatorUrl) {
      return htmlResponse(
        `<html><body><h1>Staff Engineer</h1><a href="${atsUrl}">Apply now</a></body></html>`,
        { finalUrl: aggregatorUrl }
      );
    }
    if (url.includes("boards-api.greenhouse.io/v1/boards/acme/jobs")) {
      return jsonResponse({
        jobs: [
          {
            title: "Staff Engineer",
            absolute_url: atsUrl,
            location: { name: "United States (Remote)" },
            content: `<p>${"Complete canonical job description. ".repeat(30)}</p>`,
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await resolveJobUrl(aggregatorUrl, { fetchImpl, resolveHost: publicResolver });
  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.url, atsUrl);
  assert.equal(result.provider, "greenhouse");
  assert.equal(result.location, "United States (Remote)");
  assert.match(result.bodyText, /Complete canonical job description/);
});

test("plain fetch: short/shell body -> deferred (insufficient_content)", async () => {
  const result = await resolveJobUrl("https://example-startup.com/careers/eng-2", {
    fetchImpl: async () => htmlResponse("<html><body>Loading…</body></html>"),
    resolveHost: publicResolver,
  });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.match(result.reason, /insufficient content/);
});

test("plain fetch: bot-wall interstitial -> deferred (bot_challenge)", async () => {
  const html = `<html><body>${"Checking your browser before accessing. ".repeat(10)}</body></html>`;
  const result = await resolveJobUrl("https://example-startup.com/careers/eng-3", {
    fetchImpl: async () => htmlResponse(html),
    resolveHost: publicResolver,
  });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.match(result.reason, /bot-wall interstitial/);
});

test("plain fetch: an 'expired'-classified page still returns resolved (honest signal, never a silent empty body)", async () => {
  const html = `<html><body>${"This job posting has expired and is no longer accepting applications. ".repeat(6)}</body></html>`;
  const result = await resolveJobUrl("https://example-startup.com/careers/eng-4", {
    fetchImpl: async () => htmlResponse(html),
    resolveHost: publicResolver,
  });
  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.liveness.result, "expired");
  assert.match(result.bodyText, /expired/);
});

test("plain fetch: a network error -> deferred with the error message", async () => {
  const result = await resolveJobUrl("https://example-startup.com/careers/eng-5", {
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
    resolveHost: publicResolver,
  });
  assert.equal(result.bodyFetchStatus, "deferred");
  assert.match(result.reason, /fetch failed: ECONNRESET/);
});
