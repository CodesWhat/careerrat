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
  assert.equal(result.providerExactMatch, true);
  assert.equal(result.title, "Staff Engineer");
  assert.equal(
    result.company,
    "Acme",
    "falls back to the URL's company slug when the board doesn't name one"
  );
  assert.match(result.bodyText, /Full JD text here/);
});

test("Greenhouse uses the posting employer name instead of inventing one from the board slug", async () => {
  const url = "https://job-boards.greenhouse.io/smartlyio/jobs/6030600004";
  const result = await resolveJobUrl(url, {
    resolveHost: publicResolver,
    fetchImpl: async () =>
      jsonResponse({
        jobs: [
          {
            id: 6030600004,
            title: "Event Operations Manager, (Contract)",
            company_name: "Smartly",
            absolute_url: url,
            location: { name: "New York, New York, United States" },
            content: "<p>Full canonical job description.</p>",
          },
        ],
      }),
  });

  assert.equal(result.company, "Smartly");
});

test("hydrateJobOffer does not replace a usable location with a numeric ATS label", async () => {
  const url = "https://job-boards.greenhouse.io/550/jobs/5186736008";
  const hydrated = await hydrateJobOffer(
    {
      company: "Gracious Hospitality Management",
      title: "Assistant General Manager (Bar Chimera)",
      url,
      location: "New York, NY",
      bodyText: "Open-web preview.",
      bodyPartial: true,
    },
    {
      force: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        jsonResponse({
          jobs: [
            {
              id: 5186736008,
              title: "Assistant General Manager (Bar Chimera)",
              absolute_url: url,
              location: { name: "550" },
              content: `<p>${"Lead an active Midtown Manhattan restaurant operation. ".repeat(4)}</p>`,
            },
          ],
        }),
    }
  );

  assert.equal(hydrated.location, "New York, NY");
  assert.equal(hydrated.bodyPartial, false);
});

test("strict Greenhouse hydration preserves offered identity when the board identifier is numeric", async () => {
  const url = "https://job-boards.greenhouse.io/550/jobs/5186736008";
  const hydrated = await hydrateJobOffer(
    {
      company: "Gracious Hospitality Management",
      title: "Assistant General Manager (Bar Chimera)",
      url,
      location: "New York, NY",
      bodyText: "Open-web preview.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        jsonResponse({
          jobs: [
            {
              id: 5186736008,
              title: "Assistant General Manager (Food &amp; Beverage)",
              absolute_url: url,
              location: { name: "550" },
              content: `<p>${"Lead an active Midtown Manhattan restaurant operation. ".repeat(4)}</p>`,
            },
          ],
        }),
    }
  );

  assert.equal(hydrated.company, "Gracious Hospitality Management");
  assert.equal(hydrated.location, "New York, NY");
  assert.equal(hydrated.bodyPartial, false);
});

test("Greenhouse resolution decodes HTML entities in canonical titles", async () => {
  const url = "https://job-boards.greenhouse.io/550/jobs/5186736008";
  const result = await resolveJobUrl(url, {
    resolveHost: publicResolver,
    fetchImpl: async () =>
      jsonResponse({
        jobs: [
          {
            id: 5186736008,
            title: "Operations Manager, Food &amp; Beverage",
            absolute_url: url,
            location: { name: "New York, NY" },
            content: `<p>${"Lead an active hospitality operation. ".repeat(4)}</p>`,
          },
        ],
      }),
  });

  assert.equal(result.title, "Operations Manager, Food & Beverage");
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

test("an exact Greenhouse requisition missing from its current board cannot canonicalize to an unrelated posting", async () => {
  const expiredUrl = "https://job-boards.greenhouse.io/gracioushospitality/jobs/5158318008";
  const boardUrl = "https://job-boards.greenhouse.io/gracioushospitality?error=true";
  const unrelatedUrl = "https://job-boards.greenhouse.io/gracioushospitality/jobs/4750317008";
  const fetchImpl = async (requestedUrl) => {
    if (new URL(String(requestedUrl)).hostname === "boards-api.greenhouse.io") {
      return jsonResponse({
        jobs: [
          {
            title: "Research and Development Sous Chef",
            absolute_url: unrelatedUrl,
            location: { name: "New York, NY" },
            content: `<p>${"Unrelated active kitchen posting. ".repeat(20)}</p>`,
          },
        ],
      });
    }
    assert.equal(String(requestedUrl), expiredUrl);
    return htmlResponse(
      `<html><body><h1>Current openings</h1><a href="${unrelatedUrl}">Research and Development Sous Chef</a></body></html>`,
      { finalUrl: boardUrl }
    );
  };

  const result = await resolveJobUrl(expiredUrl, {
    fetchImpl,
    resolveHost: publicResolver,
  });

  assert.equal(result.url, expiredUrl);
  assert.equal(result.liveness.result, "expired");
  assert.equal(result.liveness.code, "provider_posting_missing");
  assert.match(result.liveness.reason, /current greenhouse board no longer lists requisition/i);
});

test("canonical ATS recovery cannot change a known requisition identity", async () => {
  const sourceUrl = "https://job-boards.greenhouse.io/acme/jobs/111111";
  const unrelatedUrl = "https://job-boards.greenhouse.io/acme/jobs/222222";
  const fetchImpl = async (requestedUrl) => {
    if (new URL(String(requestedUrl)).hostname === "boards-api.greenhouse.io") {
      return jsonResponse({
        jobs: [
          {
            title: "Unrelated active role",
            absolute_url: unrelatedUrl,
            content: `<p>${"Unrelated canonical body. ".repeat(20)}</p>`,
          },
        ],
      });
    }
    return htmlResponse(
      `<html><body><h1>Current openings</h1><a href="${unrelatedUrl}">Apply</a>${"Board content. ".repeat(30)}</body></html>`,
      { finalUrl: sourceUrl }
    );
  };

  const result = await resolveJobUrl(sourceUrl, {
    fetchImpl,
    resolveHost: publicResolver,
  });

  assert.equal(result.url, sourceUrl);
  assert.equal(result.title, null);
  assert.doesNotMatch(result.bodyText, /Unrelated canonical body/);
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

test("hydrateJobOffer rejects an exact ATS requisition missing from its successfully fetched current board", async () => {
  const url = "https://jobs.ashbyhq.com/plaid/5aead7d6-6d97-484e-958b-8c3cb1ae766e";
  const hydrated = await hydrateJobOffer(
    {
      company: "Plaid",
      title: "Event Operations Manager",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      rejectExpired: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async (requestedUrl) => {
        assert.equal(new URL(String(requestedUrl)).hostname, "api.ashbyhq.com");
        return jsonResponse({
          jobs: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              title: "Different active role",
              jobUrl: "https://jobs.ashbyhq.com/plaid/11111111-1111-4111-8111-111111111111",
              descriptionPlain: LONG_ACTIVE_JD,
            },
          ],
        });
      },
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.equal(hydrated.bodyPartial, true);
  assert.match(hydrated.bodyFetchReason, /current .*board|no longer lists/i);
});

test("hydrateJobOffer adopts canonical provider identity instead of model-supplied identity", async () => {
  const hydrated = await hydrateJobOffer(
    {
      company: "Garner Health",
      title: "Event Operations Senior Associate",
      url: "https://job-boards.greenhouse.io/garnerhealth/jobs/5982721004",
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      rejectExpired: true,
      resolveJobUrlImpl: async (url) => ({
        bodyFetchStatus: "resolved",
        url,
        provider: "greenhouse",
        company: "Garnerhealth",
        title: "Senior IT Systems Engineer",
        location: "New York City, New York",
        bodyText: LONG_ACTIVE_JD,
      }),
    }
  );

  assert.equal(hydrated.company, "Garnerhealth");
  assert.equal(hydrated.title, "Senior IT Systems Engineer");
  assert.equal(hydrated.provider, "greenhouse");
  assert.equal(hydrated.bodyPartial, false);
});

test("hydrateJobOffer accepts an exact provider match with an opaque requisition URL", async () => {
  const url = "https://careers.smartrecruiters.com/acme/opaque-reference";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Platform Engineer",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveJobUrlImpl: async () => ({
        bodyFetchStatus: "resolved",
        url,
        provider: "smartrecruiters",
        providerExactMatch: true,
        title: "Platform Engineer",
        company: "Acme",
        bodyText:
          "Build and operate the company platform with the product engineering team. ".repeat(8),
      }),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, undefined);
  assert.equal(hydrated.bodyPartial, false);
  assert.match(hydrated.bodyText, /Build and operate/);
});

test("opaque provider posting identity ignores tracking queries and trailing slashes", async () => {
  const capturedUrl =
    "https://acme.recruitee.com/o/platform-engineer/?utm_source=partner#application";
  const canonicalUrl = "https://acme.recruitee.com/o/platform-engineer";
  const result = await resolveJobUrl(capturedUrl, {
    resolveHost: publicResolver,
    fetchImpl: async (requestedUrl) => {
      assert.equal(String(requestedUrl), "https://acme.recruitee.com/api/offers/");
      return jsonResponse({
        offers: [
          {
            title: "Platform Engineer",
            careers_url: canonicalUrl,
            location: "Remote, United States",
            description: `<p>${"Build and operate the product platform. ".repeat(12)}</p>`,
          },
        ],
      });
    },
  });

  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.providerExactMatch, true);
  assert.equal(result.url, canonicalUrl);
  assert.equal(result.title, "Platform Engineer");
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

test("hydrateJobOffer rejects an exact SPA posting whose guarded redirect probe proves it expired", async () => {
  const sourceUrl = "https://www.linkedin.com/jobs/view/events-manager-4337644841";
  const expiredUrl =
    "https://www.linkedin.com/jobs/conference-planning-manager-jobs?trk=expired_jd_redirect";
  const requested = [];
  const hydrated = await hydrateJobOffer(
    {
      company: "Little Island",
      title: "Events Manager",
      url: sourceUrl,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      rejectExpired: true,
      resolveHost: publicResolver,
      fetchImpl: async (url) => {
        requested.push(String(url));
        if (String(url) === sourceUrl) {
          return new Response(null, { status: 302, headers: { location: expiredUrl } });
        }
        return new Response("Expired results page", { status: 200 });
      },
    }
  );

  assert.deepEqual(requested, [sourceUrl, expiredUrl]);
  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.equal(hydrated.bodyPartial, true);
  assert.match(hydrated.bodyFetchReason, /expired_jd_redirect/);
});

test("hydrateJobOffer keeps an exact SPA posting deferred when the redirect probe finds only an auth wall", async () => {
  const sourceUrl = "https://www.indeed.com/viewjob?jk=active-but-gated";
  let requested = 0;
  const hydrated = await hydrateJobOffer(
    {
      company: "COTE NYC",
      title: "Bar Manager",
      url: sourceUrl,
      location: "Invented, NY",
      comp: "$999,999",
      postedAt: "2020-01-01",
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      rejectExpired: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () => {
        requested += 1;
        return new Response("Authentication required", { status: 401 });
      },
    }
  );

  assert.equal(requested, 1);
  assert.equal(hydrated.bodyFetchStatus, "deferred");
  assert.equal(hydrated.bodyPartial, true);
  assert.equal(hydrated.bodyText, "Model-controlled open-web evidence.");
  assert.equal(hydrated.location, "Invented, NY");
  assert.equal(hydrated.comp, "$999,999");
  assert.equal(hydrated.postedAt, "2020-01-01");
  assert.match(hydrated.bodyFetchReason, /SPA-rendered or login-gated/);
});

test("hydrateJobOffer preserves a posting-specific deferred board URL without a source allowlist", async () => {
  const url = "https://culinaryagents.com/jobs/12345/bartender";
  const hydrated = await hydrateJobOffer(
    {
      company: "Dante NYC",
      title: "Bartender",
      url,
      location: "New York, NY",
      bodyText: "Unverified open-web evidence for one active bartender opening.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveJobUrlImpl: async () => ({
        bodyFetchStatus: "deferred",
        url,
        reason: "The board needs a browser session.",
      }),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "deferred");
  assert.equal(hydrated.bodyPartial, true);
  assert.match(hydrated.bodyText, /Unverified open-web evidence/);
});

test("hydrateJobOffer rejects a deferred generic hub without posting-shaped URL evidence", async () => {
  const url = "https://culinaryagents.com/jobs/search-results";
  const hydrated = await hydrateJobOffer(
    {
      company: "Dante NYC",
      title: "Bartender",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveJobUrlImpl: async () => ({
        bodyFetchStatus: "deferred",
        url,
        reason: "The board needs a browser session.",
      }),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.equal(hydrated.bodyPartial, true);
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("an arbitrary posting-id query cannot prove deferred identity on an unrecognized host", async () => {
  const url = "https://careers.example.test/jobs?job_id=12345";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Platform Engineer",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveJobUrlImpl: async () => ({
        bodyFetchStatus: "deferred",
        url,
        reason: "The site needs a browser session.",
        postingEvidence: { guardedRedirectProbe: true, finalUrl: url },
      }),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("a posting-shaped deferred URL stays as an unverified lead without a source allowlist", async () => {
  const url = "https://jobs.example.test/platform-engineer-12345";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Platform Engineer",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveJobUrlImpl: async () => ({
        bodyFetchStatus: "deferred",
        url,
        reason: "The site needs a browser session.",
      }),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "deferred");
  assert.equal(hydrated.bodyPartial, true);
  assert.equal(hydrated.bodyText, "Model-controlled open-web evidence.");
});

test("a known platform URL stays unverified when its guarded probe cannot resolve the host", async () => {
  const url = "https://www.indeed.com/viewjob?jk=active-but-unreachable";
  let fetched = false;
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Platform Engineer",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: async () => [],
      fetchImpl: async () => {
        fetched = true;
        throw new Error("unreachable hosts must not be fetched");
      },
    }
  );

  assert.equal(fetched, false);
  assert.equal(hydrated.bodyFetchStatus, "deferred");
  assert.equal(hydrated.bodyPartial, true);
  assert.equal(hydrated.bodyText, "Model-controlled open-web evidence.");
});

test("hydrateJobOffer rejects a readable multi-role careers location page", async () => {
  const url = "https://careers.example.test/new-york";
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Bartender",
      url,
      bodyText: "Unverified open-web evidence for one bartender opening.",
      bodyPartial: true,
    },
    {
      force: true,
      rejectExpired: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>New York careers</title></head><body><h1>New York</h1><h2>Bartender</h2><h2>Server</h2><h2>General Manager</h2><p>${"Join our New York team across several restaurants and choose the role that fits you. ".repeat(8)}</p><label>Choose a position<select><option>Bartender</option><option>Server</option><option>General Manager</option></select></label><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.equal(hydrated.bodyPartial, true);
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("hydrateJobOffer fails closed when a readable page has no posting identity", async () => {
  const url = "https://www.example.test/locations/new-york";
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Bartender",
      url,
      location: "New York, NY",
      bodyText: "Unverified open-web evidence for one bartender opening.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Open roles in New York</title></head><body><h1>New York</h1><p>${"Browse openings across our New York locations and teams. ".repeat(12)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("a generic career search page cannot become specific from the claimed title", async () => {
  const url = "https://www.example.test/careers/search-results";
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Bartender",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Bartender jobs in New York</title></head><body><h1>Bartender jobs in New York</h1><p>${"Browse current bartender jobs across our New York venues. ".repeat(12)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("a role-category board page cannot become specific from matching title words", async () => {
  const url = "https://board.example.test/bartender-jobs-new-york";
  const hydrated = await hydrateJobOffer(
    {
      company: "Dante NYC",
      title: "Bartender",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Bartender Jobs in New York</title></head><body><h1>Bartender Jobs in New York</h1><h2>Dante NYC</h2><h2>Death &amp; Co</h2><p>${"Browse current bartender jobs from restaurants and bars across New York. ".repeat(12)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("a location in the claimed title cannot make a location landing page posting-specific", async () => {
  const url = "https://careers.example.test/new-york";
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Bartender - New York",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>New York careers</title></head><body><h1>New York</h1><p>${"Browse restaurant roles across New York and choose a position. ".repeat(10)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("hydrateJobOffer rejects a careers page with multiple structured job postings", async () => {
  const url = "https://careers.example.test/new-york";
  const structured = [
    {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Bartender",
      description: `<p>${"Build a polished beverage program and serve guests. ".repeat(8)}</p>`,
    },
    {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "General Manager",
      description: `<p>${"Lead restaurant operations and develop the team. ".repeat(10)}</p>`,
    },
  ];
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Bartender",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Bartender jobs in New York</title>${structured.map((posting) => `<script type="application/ld+json">${JSON.stringify(posting)}</script>`).join("")}</head><body><h1>Bartender jobs in New York</h1><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
  assert.doesNotMatch(hydrated.bodyText, /Lead restaurant operations/);
});

test("empty JobPosting metadata does not prove a generic page is one posting", async () => {
  const url = "https://careers.example.test/jobs";
  const posting = { "@context": "https://schema.org", "@type": "JobPosting" };
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Platform Engineer",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><h1>Engineering jobs</h1><p>${"Browse every current role across our engineering teams and locations. ".repeat(10)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("identifier labels cannot collapse distinct structured postings", async () => {
  const url = "https://careers.example.test/jobs";
  const postings = [
    {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Platform Engineer",
      url,
      identifier: { "@type": "PropertyValue", name: "Job ID" },
      description: `<p>${"Build the shared product platform and production infrastructure. ".repeat(8)}</p>`,
    },
    {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Product Manager",
      url,
      identifier: { "@type": "PropertyValue", name: "Job ID" },
      description: `<p>${"Lead product discovery, planning, and delivery with engineering. ".repeat(8)}</p>`,
    },
  ];
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Platform Engineer",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head>${postings.map((posting) => `<script type="application/ld+json">${JSON.stringify(posting)}</script>`).join("")}</head><body><h1>Engineering jobs</h1><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("hydrateJobOffer accepts one structured posting at a generic-looking careers URL", async () => {
  const url = "https://careers.example.test/new-york";
  const canonicalBody = "Own the beverage program and lead polished guest service. ".repeat(10);
  const posting = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Lead Bartender",
    description: `<p>${canonicalBody}</p>`,
    hiringOrganization: { "@type": "Organization", name: "Example Hospitality Group" },
  };
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Bartender",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, undefined);
  assert.equal(hydrated.bodyPartial, false);
  assert.equal(hydrated.title, "Lead Bartender");
  assert.equal(hydrated.company, "Example Hospitality Group");
  assert.match(hydrated.bodyText, /Own the beverage program/);
});

test("duplicate structured metadata for one posting is still one posting identity", async () => {
  const url = "https://careers.example.test/new-york/lead-bartender";
  const posting = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Lead Bartender",
    url,
    identifier: { "@type": "PropertyValue", value: "BAR-42" },
    description: `<p>${"Own the bar program and train the opening team. ".repeat(10)}</p>`,
  };
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Lead Bartender",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head>${[posting, posting].map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join("")}</head><body><p>${"Own the bar program and train the opening team. ".repeat(10)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, undefined);
  assert.equal(hydrated.bodyPartial, false);
  assert.match(hydrated.bodyText, /Own the bar program/);
});

test("duplicate structured metadata dedupes when only one copy has an identifier", async () => {
  const url = "https://careers.example.test/new-york/lead-bartender";
  const posting = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Lead Bartender",
    url,
    description: `<p>${"Own the bar program and train the opening team. ".repeat(10)}</p>`,
  };
  const postings = [
    { ...posting, identifier: { "@type": "PropertyValue", value: "BAR-42" } },
    posting,
  ];
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Lead Bartender",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head>${postings.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join("")}</head><body><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, undefined);
  assert.equal(hydrated.bodyPartial, false);
  assert.match(hydrated.bodyText, /Own the bar program/);
});

test("structured postings with a shared page URL remain distinct by identifier", async () => {
  const url = "https://careers.example.test/new-york";
  const postings = [
    {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Bartender",
      url,
      identifier: { "@type": "PropertyValue", value: "BAR-42" },
      description: `<p>${"Own the bar program and train the opening team. ".repeat(10)}</p>`,
    },
    {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "General Manager",
      url,
      identifier: { "@type": "PropertyValue", value: "GM-84" },
      description: `<p>${"Lead restaurant operations and develop the management team. ".repeat(10)}</p>`,
    },
  ];
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Bartender",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head>${postings.map((posting) => `<script type="application/ld+json">${JSON.stringify(posting)}</script>`).join("")}</head><body><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("hydrateJobOffer accepts a readable career detail URL that carries the role title", async () => {
  const url = "https://careers.example.test/careers/assistant-general-manager-new-york";
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Assistant General Manager",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Assistant General Manager | Example Hospitality</title></head><body><h1>Assistant General Manager</h1><p>${"Lead restaurant operations, coach the team, and deliver polished guest service. ".repeat(8)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, undefined);
  assert.equal(hydrated.bodyPartial, false);
  assert.match(hydrated.bodyText, /Lead restaurant operations/);
});

test("a canonical visible title replaces model-inflated seniority", async () => {
  const url = "https://careers.example.test/careers/software-engineer";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Senior Software Engineer",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Software Engineer | Acme</title></head><body><h1>Software Engineer</h1><p>${"Build and maintain the product platform with the software engineering team. ".repeat(10)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, undefined);
  assert.equal(hydrated.title, "Software Engineer");
  assert.doesNotMatch(hydrated.title, /Senior/);
});

test("a detail URL without claimed seniority needs matching canonical visible title evidence", async () => {
  const url = "https://careers.example.test/careers/software-engineer";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Senior Software Engineer",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Join Acme</title></head><body><h1>Build with us</h1><p>${"Build and maintain the product platform with the software engineering team. ".repeat(10)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("the final redirect destination can prove plain-page posting identity", async () => {
  const sourceUrl = "https://links.example.test/opening?id=42";
  const finalUrl = "https://careers.example.test/careers/assistant-general-manager-new-york";
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Assistant General Manager",
      url: sourceUrl,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Assistant General Manager | Example Hospitality</title></head><body><h1>Assistant General Manager</h1><p>${"Lead restaurant operations, coach the team, and deliver polished guest service. ".repeat(8)}</p><button>Apply</button></body></html>`,
          { finalUrl }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, undefined);
  assert.equal(hydrated.url, finalUrl);
  assert.equal(hydrated.capturedUrl, sourceUrl);
});

test("a generic final redirect cannot borrow posting identity from its source URL", async () => {
  const sourceUrl = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const finalUrl = "https://careers.example.test/jobs";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Platform Engineer",
      url: sourceUrl,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async (requestedUrl) => {
        if (new URL(String(requestedUrl)).hostname === "boards-api.greenhouse.io") {
          throw new Error("board API unavailable");
        }
        return htmlResponse(
          `<html><head><title>Engineering jobs</title></head><body><h1>Engineering jobs</h1><p>${"Browse current engineering openings across every team and location. ".repeat(12)}</p><button>Apply</button></body></html>`,
          { finalUrl }
        );
      },
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("exact provider metadata cannot bless a readable generic destination body", async () => {
  const sourceUrl = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const finalUrl = "https://careers.example.test/jobs";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Platform Engineer",
      url: sourceUrl,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveJobUrlImpl: async () => ({
        bodyFetchStatus: "resolved",
        url: finalUrl,
        providerExactMatch: true,
        title: "Platform Engineer",
        bodyText:
          "Browse every current engineering opening across all teams and locations. ".repeat(10),
        postingEvidence: {
          finalUrl,
          pageTitle: "Engineering jobs",
          headings: ["Engineering jobs"],
          structuredPostingCount: 0,
          canonicalPostingUrls: [],
        },
      }),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("an exact-looking provider URL cannot override contradictory readable evidence", async () => {
  const url = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const hydrated = await hydrateJobOffer(
    {
      company: "Acme",
      title: "Senior Software Engineer",
      url,
      bodyText: "Model-controlled open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveJobUrlImpl: async () => ({
        bodyFetchStatus: "resolved",
        url,
        title: null,
        bodyText:
          "Browse every current engineering opening across all teams and locations. ".repeat(10),
        postingEvidence: {
          finalUrl: url,
          pageTitle: "Engineering Jobs",
          headings: ["Engineering Jobs"],
          structuredPostingCount: 2,
          canonicalPostingUrls: [
            "https://job-boards.greenhouse.io/acme/jobs/111111",
            "https://job-boards.greenhouse.io/acme/jobs/222222",
          ],
        },
      }),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
});

test("structured posting facts replace model-controlled location compensation and date", async () => {
  const url = "https://careers.example.test/careers/beverage-manager";
  const posting = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Beverage Manager",
    description: `<p>${"Own the beverage program, train the team, and lead service. ".repeat(10)}</p>`,
    hiringOrganization: { "@type": "Organization", name: "Example Hospitality Group" },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: "New York",
        addressRegion: "NY",
        addressCountry: "US",
      },
    },
    baseSalary: {
      "@type": "MonetaryAmount",
      currency: "USD",
      value: {
        "@type": "QuantitativeValue",
        minValue: 90000,
        maxValue: 110000,
        unitText: "YEAR",
      },
    },
    datePosted: "2026-08-20",
  };
  const hydrated = await hydrateJobOffer(
    {
      company: "Wrong Company",
      title: "Bar Manager",
      url,
      location: "Los Angeles, CA",
      comp: "$40,000",
      postedAt: "2020-01-01",
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.company, "Example Hospitality Group");
  assert.equal(hydrated.title, "Beverage Manager");
  assert.equal(hydrated.location, "New York, NY, US");
  assert.equal(hydrated.comp, "$90,000 to $110,000 per year");
  assert.equal(hydrated.postedAt, "2026-08-20T00:00:00.000Z");
});

test("hard posting identity does not retain unverified model facts absent from the page", async () => {
  const url = "https://careers.example.test/careers/assistant-general-manager";
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Assistant General Manager",
      url,
      location: "Los Angeles, CA",
      comp: "$200,000",
      postedAt: "2020-01-01",
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(
          `<html><head><title>Assistant General Manager</title></head><body><h1>Assistant General Manager</h1><p>${"Lead restaurant operations and coach the service team. ".repeat(10)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        ),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, undefined);
  assert.equal(hydrated.location, "");
  assert.equal(hydrated.comp, "");
  assert.equal(hydrated.postedAt, null);
});

test("hydrateJobOffer rejects a careers page with several canonical ATS posting links", async () => {
  const url = "https://careers.example.test/new-york";
  const firstPosting = "https://job-boards.greenhouse.io/acme/jobs/111111";
  const secondPosting = "https://jobs.lever.co/acme/22222222-2222-4222-8222-222222222222";
  const requested = [];
  const hydrated = await hydrateJobOffer(
    {
      company: "Example Hospitality",
      title: "Bartender",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      requirePostingIdentity: true,
      resolveHost: publicResolver,
      fetchImpl: async (requestedUrl) => {
        requested.push(String(requestedUrl));
        assert.equal(String(requestedUrl), url);
        return htmlResponse(
          `<html><head><title>Bartender jobs in New York</title></head><body><h1>Bartender jobs in New York</h1><a href="${firstPosting}">Bartender</a><a href="${secondPosting}">General Manager</a><p>${"Browse several current New York openings across the restaurant group. ".repeat(8)}</p><button>Apply</button></body></html>`,
          { finalUrl: url }
        );
      },
    }
  );

  assert.deepEqual(requested, [url]);
  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /one specific job posting/i);
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

test("Remote Vibe's capped structured job body remains explicitly partial", async () => {
  const aggregatorUrl = "https://remotevibecodingjobs.com/jobs/acme-staff-engineer";
  const cappedDescription = `${"Build reliable distributed systems. ".repeat(140)}Compensa`.slice(
    0,
    5000
  );
  assert.equal(cappedDescription.length, 5000);
  const html = `<html><body><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Staff Engineer",
    description: cappedDescription,
  })}</script><button>Apply now</button></body></html>`;

  const result = await resolveJobUrl(aggregatorUrl, {
    fetchImpl: async () => htmlResponse(html, { finalUrl: aggregatorUrl }),
    resolveHost: publicResolver,
  });

  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.bodyPartial, true);
  assert.match(result.reason, /capped preview/i);
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
  assert.equal(result.bodyPartial, false);
  assert.match(result.bodyText, /Complete canonical job description/);
});

test("plain aggregator identity may hand off to a different canonical ATS requisition", async () => {
  const aggregatorUrl = "https://hiring.cafe/job/swfwvwmaq6basefz";
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
            content: `<p>${"Complete employer-owned job description. ".repeat(30)}</p>`,
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await resolveJobUrl(aggregatorUrl, { fetchImpl, resolveHost: publicResolver });

  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.url, atsUrl);
  assert.equal(result.sourceUrl, aggregatorUrl);
  assert.equal(result.provider, "greenhouse");
  assert.match(result.bodyText, /Complete employer-owned job description/);
});

test("plain aggregator page: keeps its job body but hands application work to an embedded applyUrl", async () => {
  const aggregatorUrl = "https://remotevibecodingjobs.com/jobs/acme-staff-engineer";
  const applicationUrl = "https://www.linkedin.com/jobs/view/1234567890";
  const html = `<html><body><h1>Staff Engineer</h1><p>${"Build reliable distributed systems and platform tooling. ".repeat(20)}</p><script>self.__next_f.push([1,"{\\"applyUrl\\":\\"${applicationUrl}\\",\\"label\\":\\"Apply for this position\\"}"])</script></body></html>`;

  const result = await resolveJobUrl(aggregatorUrl, {
    fetchImpl: async () => htmlResponse(html, { finalUrl: aggregatorUrl }),
    resolveHost: publicResolver,
  });

  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.url, applicationUrl);
  assert.equal(result.sourceUrl, aggregatorUrl);
  assert.equal(result.bodyPartial, true);
  assert.match(result.bodyText, /Build reliable distributed systems/);
});

test("plain aggregator page: decodes only one mixed escaping layer in an embedded application URL", async () => {
  const aggregatorUrl = "https://remotevibecodingjobs.com/jobs/acme-staff-engineer";
  const applicationUrl =
    "https://www.linkedin.com/jobs/view/1234567890?ref=board\\u0026amp;recommended=true";
  const html = `<html><body><h1>Staff Engineer</h1><p>${"Build reliable distributed systems and platform tooling. ".repeat(20)}</p><script>{"applyUrl":"${applicationUrl}"}</script></body></html>`;

  const result = await resolveJobUrl(aggregatorUrl, {
    fetchImpl: async () => htmlResponse(html, { finalUrl: aggregatorUrl }),
    resolveHost: publicResolver,
  });

  assert.equal(
    result.url,
    "https://www.linkedin.com/jobs/view/1234567890?ref=board&amp;recommended=true"
  );
});

test("plain aggregator page: rejects untrusted and private embedded application URLs", async () => {
  const aggregatorUrl = "https://remotevibecodingjobs.com/jobs/acme-staff-engineer";
  for (const applicationUrl of [
    "https://attacker.example/collect",
    "https://attacker.example/jobs.lever.co/acme/collect",
    "http://127.0.0.1:7777/api/data/dashboard",
  ]) {
    const html = `<html><body><h1>Staff Engineer</h1><p>${"Build reliable distributed systems and platform tooling. ".repeat(20)}</p><script>self.__next_f.push([1,"{\\"applyUrl\\":\\"${applicationUrl}\\"}"])</script></body></html>`;

    const result = await resolveJobUrl(aggregatorUrl, {
      fetchImpl: async () => htmlResponse(html, { finalUrl: aggregatorUrl }),
      resolveHost: publicResolver,
    });

    assert.equal(result.bodyFetchStatus, "resolved");
    assert.equal(result.url, aggregatorUrl);
    assert.equal(result.sourceUrl, undefined);
  }
});

test("plain aggregator page: keeps its listing URL when embedded application URLs are ambiguous", async () => {
  const aggregatorUrl = "https://remotevibecodingjobs.com/jobs/acme-staff-engineer";
  const recommendedUrl = "https://www.linkedin.com/jobs/view/1111111111";
  const currentUrl = "https://www.linkedin.com/jobs/view/2222222222";
  const html = `<html><body><h1>Staff Engineer</h1><p>${"Build reliable distributed systems and platform tooling. ".repeat(20)}</p><script>self.__next_f.push([1,"{\\"applyUrl\\":\\"${recommendedUrl}\\"},{\\"applyUrl\\":\\"${currentUrl}\\"}"])</script></body></html>`;

  const result = await resolveJobUrl(aggregatorUrl, {
    fetchImpl: async () => htmlResponse(html, { finalUrl: aggregatorUrl }),
    resolveHost: publicResolver,
  });

  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.url, aggregatorUrl);
  assert.equal(result.sourceUrl, undefined);
});

test("plain aggregator page: rejects a trusted recommendation beside an untrusted application URL", async () => {
  const aggregatorUrl = "https://remotevibecodingjobs.com/jobs/acme-staff-engineer";
  const currentUrl = "https://ats.vendor.example/apply/current-role";
  const recommendedUrl = "https://www.linkedin.com/jobs/view/1111111111";
  const html = `<html><body><h1>Staff Engineer</h1><p>${"Build reliable distributed systems and platform tooling. ".repeat(20)}</p><script>self.__next_f.push([1,"{"applyUrl":"${currentUrl}"},{"applyUrl":"${recommendedUrl}"}"])</script></body></html>`;

  const result = await resolveJobUrl(aggregatorUrl, {
    fetchImpl: async () => htmlResponse(html, { finalUrl: aggregatorUrl }),
    resolveHost: publicResolver,
  });

  assert.equal(result.bodyFetchStatus, "resolved");
  assert.equal(result.url, aggregatorUrl);
  assert.equal(result.sourceUrl, undefined);
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

test("hydrateJobOffer rejects an inactive employer career account", async () => {
  const url = "https://thegroupnyc.applytojob.com/apply/9Qc0WGm5TR/Assistant-General-Manager";
  const hydrated = await hydrateJobOffer(
    {
      company: "The Group NYC",
      title: "Assistant General Manager",
      url,
      bodyText: "Unverified open-web evidence.",
      bodyPartial: true,
    },
    {
      force: true,
      rejectExpired: true,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        htmlResponse(`
          <html><head><title>JazzHR - Inactive Career Page</title></head>
          <body><h1>This account is no longer active.</h1><a href="/apply">Apply</a></body></html>
        `),
    }
  );

  assert.equal(hydrated.bodyFetchStatus, "unavailable");
  assert.match(hydrated.bodyFetchReason, /no longer active/i);
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
