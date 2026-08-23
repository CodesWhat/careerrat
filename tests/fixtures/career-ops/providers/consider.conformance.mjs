// tests/providers/consider.test.mjs — direct provider-contract tests (PR #825).
// Consider boards take their origin from a config-driven careers_url, so the
// host guard is the security boundary here: detect() and fetch() must both
// reject non-https, IP-literal, loopback, link-local, and internal-suffix hosts
// before any request goes out. Also covers the redirect:'error' guard and
// malformed-payload tolerance.

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider — consider");

try {
  const consider = (
    await import(
      pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/consider.mjs")).href
    )
  ).default;
  const { createContext } = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops-registry.mjs")).href
  );

  if (consider.id === "consider") pass('consider.id is "consider"');
  else fail(`consider.id is ${JSON.stringify(consider.id)}`);

  const okEntry = {
    name: "Founderful",
    consider_board: "wingman",
    careers_url: "https://jobs.founderful.com/jobs",
  };
  const hit = consider.detect(okEntry);
  if (hit && hit.url === "https://jobs.founderful.com/api-boards/search-jobs")
    pass("consider.detect() claims a valid https board");
  else fail(`consider.detect() returned ${JSON.stringify(hit)}`);

  if (consider.detect({ name: "X", careers_url: "https://jobs.founderful.com/jobs" }) === null) {
    pass("consider.detect() returns null without consider_board");
  } else {
    fail("consider.detect() must require consider_board");
  }

  // SSRF: non-https + IP-literal + loopback/internal hosts are all rejected.
  const considerEvil = [
    ["http://jobs.founderful.com/jobs", "non-https"],
    ["https://127.0.0.1/jobs", "IPv4 loopback"],
    ["https://169.254.169.254/jobs", "cloud metadata IPv4"],
    ["https://[::1]/jobs", "IPv6 loopback"],
    ["https://localhost/jobs", "localhost"],
    ["https://stuff.internal/jobs", ".internal suffix"],
    ["https://box.local/jobs", ".local suffix"],
  ];
  let considerBlocked = 0;
  for (const [url, label] of considerEvil) {
    if (consider.detect({ name: "Evil", consider_board: "x", careers_url: url }) === null)
      considerBlocked++;
    else fail(`consider.detect() should reject unsafe host (${label}): ${url}`);
  }
  if (considerBlocked === considerEvil.length)
    pass(`consider host guard rejects ${considerEvil.length} unsafe hosts (SSRF)`);

  // Shared no-op stub: prevents acquireCsrfHandshake from touching the network
  // in unit tests. Tests that verify CSRF behaviour supply their own stub below.
  const noHandshake = async () => ({ cookie: null, csrfToken: null });

  // fetch() passes redirect:'error' on the happy path.
  let considerOpts = null;
  const considerJobs = await consider.fetch(okEntry, {
    _acquireHandshake: noHandshake,
    fetchJson: async (_url, opts) => {
      considerOpts = opts;
      return {
        jobs: [
          {
            title: "AI Eng",
            url: "https://jobs.founderful.com/x",
            companyName: "Acme",
            locations: ["Remote"],
            timeStamp: "2026-01-02",
          },
        ],
      };
    },
  });
  if (considerOpts?.redirect === "error") pass('consider.fetch() passes redirect:"error"');
  else fail(`consider.fetch() should pass redirect:"error", got ${JSON.stringify(considerOpts)}`);
  if (considerJobs.length === 1 && considerJobs[0].company === "Acme")
    pass("consider.fetch() normalizes a job row");
  else fail(`consider.fetch() row = ${JSON.stringify(considerJobs[0])}`);

  // postedAt is derived from timeStamp — both the ISO and epoch-ms shapes.
  if (considerJobs[0].postedAt === Date.parse("2026-01-02"))
    pass("consider.fetch() maps an ISO timeStamp to postedAt");
  else fail(`consider.fetch() postedAt = ${JSON.stringify(considerJobs[0].postedAt)}`);

  // A non-positive stamp is treated as missing, not as 1970 (which would read
  // as permanently stale to the freshness filter).
  const considerZeroStamp = await consider.fetch(okEntry, {
    _acquireHandshake: noHandshake,
    fetchJson: async () => ({
      jobs: [
        { title: "T", url: "https://jobs.founderful.com/y", companyName: "Acme", timeStamp: 0 },
      ],
    }),
  });
  if (considerZeroStamp[0]?.postedAt == null)
    pass("consider.fetch() treats a 0 timeStamp as missing, not epoch 0");
  else
    fail(
      `consider.fetch() postedAt for timeStamp=0 = ${JSON.stringify(considerZeroStamp[0]?.postedAt)}`
    );

  // fetch() refuses an unsafe host BEFORE touching the network.
  let considerThrew = false;
  try {
    await consider.fetch(
      { name: "Evil", consider_board: "x", careers_url: "https://169.254.169.254/jobs" },
      {
        fetchJson: async () => {
          throw new Error("SSRF! should not reach here");
        },
      }
    );
  } catch (e) {
    considerThrew = /public host|https/.test(e.message);
  }
  if (considerThrew) pass("consider.fetch() rejects unsafe host before fetch");
  else fail("consider.fetch() must throw on an unsafe host without fetching");

  // Malformed / empty payloads → empty array, no crash.
  const considerEmpty = await consider.fetch(okEntry, {
    _acquireHandshake: noHandshake,
    fetchJson: async () => ({}),
  });
  const considerNoUrl = await consider.fetch(okEntry, {
    _acquireHandshake: noHandshake,
    fetchJson: async () => ({ jobs: [{ title: "No URL" }] }),
  });
  if (
    Array.isArray(considerEmpty) &&
    considerEmpty.length === 0 &&
    Array.isArray(considerNoUrl) &&
    considerNoUrl.length === 0
  ) {
    pass("consider.fetch() tolerates malformed/empty payloads");
  } else {
    fail(
      `consider.fetch() malformed handling: ${JSON.stringify({ considerEmpty, considerNoUrl })}`
    );
  }

  // ── CSRF handshake ──────────────────────────────────────────────────────

  // The handshake must be called with the board origin (not the full careers_url).
  let handshakeOrigin = null;
  await consider.fetch(okEntry, {
    _acquireHandshake: async (origin) => {
      handshakeOrigin = origin;
      return { cookie: null, csrfToken: null };
    },
    fetchJson: async () => ({ jobs: [] }),
  });
  if (handshakeOrigin === "https://jobs.founderful.com")
    pass("consider.fetch() passes board origin to the handshake");
  else fail(`consider.fetch() handshake origin = ${JSON.stringify(handshakeOrigin)}`);

  // When the handshake returns a cookie, it must appear in the POST headers.
  let postHeadersWithCookie = null;
  await consider.fetch(okEntry, {
    _acquireHandshake: async () => ({ cookie: "session=abc; session.sig=xyz", csrfToken: null }),
    fetchJson: async (_url, opts) => {
      postHeadersWithCookie = opts.headers;
      return { jobs: [] };
    },
  });
  if (postHeadersWithCookie?.cookie === "session=abc; session.sig=xyz")
    pass("consider.fetch() forwards cookie to the POST");
  else
    fail(`consider.fetch() POST cookie header = ${JSON.stringify(postHeadersWithCookie?.cookie)}`);

  // When the handshake returns a csrfToken, it must appear as x-csrf-token.
  let postHeadersWithCsrf = null;
  await consider.fetch(okEntry, {
    _acquireHandshake: async () => ({ cookie: null, csrfToken: "tok123abc" }),
    fetchJson: async (_url, opts) => {
      postHeadersWithCsrf = opts.headers;
      return { jobs: [] };
    },
  });
  if (postHeadersWithCsrf?.["x-csrf-token"] === "tok123abc")
    pass("consider.fetch() forwards x-csrf-token to the POST");
  else
    fail(
      `consider.fetch() POST x-csrf-token = ${JSON.stringify(postHeadersWithCsrf?.["x-csrf-token"])}`
    );

  // When both cookie and csrfToken are returned, both must be in the POST.
  let postHeadersBoth = null;
  await consider.fetch(okEntry, {
    _acquireHandshake: async () => ({
      cookie: "session=s1; session.sig=s2",
      csrfToken: "token-full",
    }),
    fetchJson: async (_url, opts) => {
      postHeadersBoth = opts.headers;
      return { jobs: [] };
    },
  });
  if (
    postHeadersBoth?.cookie === "session=s1; session.sig=s2" &&
    postHeadersBoth?.["x-csrf-token"] === "token-full"
  ) {
    pass("consider.fetch() forwards both cookie and x-csrf-token when handshake succeeds");
  } else {
    fail(`consider.fetch() POST headers (both) = ${JSON.stringify(postHeadersBoth)}`);
  }

  // When the handshake returns null for both, no cookie/x-csrf-token must appear.
  let postHeadersNone = null;
  await consider.fetch(okEntry, {
    _acquireHandshake: async () => ({ cookie: null, csrfToken: null }),
    fetchJson: async (_url, opts) => {
      postHeadersNone = opts.headers;
      return { jobs: [] };
    },
  });
  if (!("cookie" in postHeadersNone) && !("x-csrf-token" in postHeadersNone)) {
    pass("consider.fetch() omits cookie and x-csrf-token when handshake returns null");
  } else {
    fail(`consider.fetch() POST headers (null handshake) = ${JSON.stringify(postHeadersNone)}`);
  }

  // A failed handshake (null/null) must not prevent the POST from being attempted.
  let degradedPostCalled = false;
  await consider.fetch(okEntry, {
    _acquireHandshake: async () => ({ cookie: null, csrfToken: null }),
    fetchJson: async () => {
      degradedPostCalled = true;
      return { jobs: [] };
    },
  });
  if (degradedPostCalled)
    pass("consider.fetch() attempts the POST even when the handshake returns null");
  else fail("consider.fetch() must not skip the POST when handshake fails");

  // ── Real acquireCsrfHandshake path (ctx.fetchResponse mock) ──────────────
  // The tests above stub _acquireHandshake and never exercise the actual GET
  // /jobs logic. CareerRat-local divergence from the upstream fixture this
  // file was adapted from: acquireCsrfHandshake now goes through the same
  // injected ctx.fetchResponse the POST uses (the SSRF-guarded transport),
  // not a bare `fetch` call — see the review finding that flagged the old
  // globalThis.fetch bypass. These tests mock ctx.fetchResponse instead of
  // globalThis.fetch so the real acquireCsrfHandshake runs and is proven to
  // use the injected transport, and verify cookie/csrfToken extracted from
  // the response reach the POST without going through _acquireHandshake.
  {
    let handshakeUrl = null;
    let handshakeOpts = null;
    let realHandshakePostHeaders = null;

    await consider.fetch(okEntry, {
      // No _acquireHandshake — exercises the real acquireCsrfHandshake.
      fetchResponse: async (url, opts) => {
        handshakeUrl = url;
        handshakeOpts = opts;
        return {
          ok: true,
          url,
          headers: {
            getSetCookie: () => ["session=s1; Path=/; HttpOnly", "session.sig=sig1; Path=/"],
            get: () => null,
          },
          text: async () => `<script>window.__cfg={"csrfToken":"handshake-token-ok"}</script>`,
        };
      },
      fetchJson: async (_url, opts) => {
        realHandshakePostHeaders = opts.headers;
        return { jobs: [] };
      },
    });

    if (handshakeUrl === "https://jobs.founderful.com/jobs") {
      pass("acquireCsrfHandshake GETs {origin}/jobs via ctx.fetchResponse");
    } else {
      fail(`acquireCsrfHandshake GET url = ${JSON.stringify(handshakeUrl)}`);
    }
    if (handshakeOpts?.redirect === "error") {
      pass('acquireCsrfHandshake uses redirect:"error" (SSRF guard)');
    } else {
      fail(`acquireCsrfHandshake redirect = ${JSON.stringify(handshakeOpts?.redirect)}`);
    }
    if (realHandshakePostHeaders?.cookie === "session=s1; session.sig=sig1") {
      pass("acquireCsrfHandshake extracts Set-Cookie and forwards it to the POST");
    } else {
      fail(`acquireCsrfHandshake cookie = ${JSON.stringify(realHandshakePostHeaders?.cookie)}`);
    }
    if (realHandshakePostHeaders?.["x-csrf-token"] === "handshake-token-ok") {
      pass("acquireCsrfHandshake extracts csrfToken from HTML and forwards it to the POST");
    } else {
      fail(
        `acquireCsrfHandshake x-csrf-token = ${JSON.stringify(realHandshakePostHeaders?.["x-csrf-token"])}`
      );
    }

    // A failure on GET /jobs (network error, redirect thrown by
    // ctx.fetchResponse's own redirect:'error' handling, a timeout, …) must
    // cause the handshake to degrade gracefully — the POST is still attempted.
    let redirectDegradedPostCalled = false;
    await consider.fetch(okEntry, {
      fetchResponse: async () => {
        throw new Error("fetch failed");
      },
      fetchJson: async () => {
        redirectDegradedPostCalled = true;
        return { jobs: [] };
      },
    });
    if (redirectDegradedPostCalled) {
      pass(
        "acquireCsrfHandshake degrades gracefully when ctx.fetchResponse rejects — POST still attempted"
      );
    } else {
      fail("acquireCsrfHandshake must not swallow a handshake failure into a full abort");
    }

    // A non-2xx response from GET /jobs (e.g. 403, 500) must degrade to
    // null/null and still attempt the POST. career-ops-registry.mjs's
    // request() (the real implementation behind ctx.fetchResponse) already
    // drains and throws on a non-ok response before ever handing a Response
    // back to the caller, so this mock reproduces that same throw-on-non-ok
    // contract rather than returning an `ok: false` object — matching what
    // acquireCsrfHandshake actually observes in production.
    //
    // The would-be response carries deceptive cookies and a csrfToken. If
    // acquireCsrfHandshake's try/catch were removed or the registry stopped
    // throwing on non-ok, this scrape would reach the POST — the "no
    // cookie/no x-csrf-token" assertions below would then fail, making this
    // test mutation-resistant.
    let notOkGetUrl = null;
    let notOkPostHeaders = null;
    let notOkPostCalled = false;
    await consider.fetch(okEntry, {
      fetchResponse: async (url) => {
        notOkGetUrl = url;
        const error = new Error("HTTP 403 Forbidden");
        error.status = 403;
        throw error;
      },
      fetchJson: async (_url, opts) => {
        notOkPostCalled = true;
        notOkPostHeaders = opts.headers;
        return { jobs: [] };
      },
    });
    if (notOkGetUrl === "https://jobs.founderful.com/jobs") {
      pass(
        "acquireCsrfHandshake !ok: GET /jobs was attempted before the guard evaluated the status"
      );
    } else {
      fail(
        `acquireCsrfHandshake !ok: expected GET https://jobs.founderful.com/jobs, got ${JSON.stringify(notOkGetUrl)}`
      );
    }
    if (notOkPostCalled) {
      pass("acquireCsrfHandshake !ok (403): POST still attempted (graceful degrade, not abort)");
    } else {
      fail("acquireCsrfHandshake !ok must not abort the POST");
    }
    if (!notOkPostHeaders?.cookie && !notOkPostHeaders?.["x-csrf-token"]) {
      pass(
        "acquireCsrfHandshake !ok: POST carries no cookie and no x-csrf-token (guard blocks scraping the 403 body)"
      );
    } else {
      fail(
        `acquireCsrfHandshake !ok: guard missing — leaked cookie=${notOkPostHeaders?.cookie} csrf=${notOkPostHeaders?.["x-csrf-token"]}`
      );
    }
  }

  // ── CareerRat addition: the handshake goes through the real SSRF guard ───
  // Not part of the upstream fixture — added for the review finding that the
  // handshake bypassed the shared transport. Wires the REAL createContext()
  // from career-ops-registry.mjs (the same guard every other Career Ops
  // request goes through) with a resolveHost that resolves the board's
  // hostname to a private address, and a fetchImpl that throws if ever
  // reached. Proves the handshake GET is rejected before any network access —
  // not merely that consider.mjs calls ctx.fetchResponse, but that doing so
  // actually gets it DNS-checked. Because the POST goes to the same origin,
  // this also blocks the POST attempt, which is the correct end-to-end
  // outcome for an entry whose host resolves private.
  {
    let networkReached = false;
    const guardedCtx = createContext(
      async () => {
        networkReached = true;
        throw new Error("must not reach fetchImpl — handshake host resolves private");
      },
      { resolveHost: async () => [{ address: "169.254.169.254", family: 4 }] }
    );
    let threw = false;
    try {
      await consider.fetch(okEntry, guardedCtx);
    } catch {
      threw = true;
    }
    if (threw && !networkReached) {
      pass(
        "acquireCsrfHandshake: a hostname that DNS-resolves private is rejected before any network access"
      );
    } else {
      fail(
        `acquireCsrfHandshake DNS-private guard: threw=${threw} networkReached=${networkReached}`
      );
    }
  }
} catch (e) {
  fail(`consider provider tests crashed: ${e.message}`);
}
