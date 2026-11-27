import assert from "node:assert/strict";
import { test } from "node:test";

import {
  careerOpsLoadFailures,
  careerOpsProviderIds,
  createContext,
  fetchCareerOpsProvider,
  loadCareerOpsProviders,
} from "../src/core/providers/career-ops-registry.mjs";

// loadCareerOpsProviders is the per-provider isolation loader behind the
// module's top-level registry build: 78+ vendored provider files used to load
// through a single Promise.all, so one broken vendor file threw and took down
// the WHOLE registry (and therefore every module that imports it) for every
// other provider too. `importProvider` is injectable specifically so this can
// be tested with a mocked failing loader, without touching the real vendor/
// tree (which is vendored, not ours to edit).

function fakeProvider(id, overrides = {}) {
  return { default: { id, fetch: async () => [], ...overrides } };
}

test("loadCareerOpsProviders isolates one failing provider and still loads the survivors", async () => {
  const importProvider = async (id) => {
    if (id === "broken") throw new Error("syntax error in vendor file");
    return fakeProvider(id);
  };

  const { providers, failures } = await loadCareerOpsProviders(
    ["good-a", "broken", "good-b"],
    importProvider
  );

  assert.deepEqual(providers.map((p) => p.id).sort(), ["good-a", "good-b"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, "broken");
  assert.match(failures[0].error.message, /syntax error in vendor file/);
});

test("loadCareerOpsProviders records a shape-invalid provider as a failure, not a thrown error", async () => {
  // A provider module that loads fine but doesn't satisfy { id, fetch } (e.g.
  // its id doesn't match the registry id, or fetch isn't a function) must be
  // skipped the same way an import-time throw is — it should never propagate
  // and take the whole registry down.
  const importProvider = async (id) => {
    if (id === "mismatched-id") return fakeProvider("something-else");
    if (id === "no-fetch") return { default: { id: "no-fetch" } };
    if (id === "bad-detect") return fakeProvider(id, { detect: "not-a-function" });
    return fakeProvider(id);
  };

  const { providers, failures } = await loadCareerOpsProviders(
    ["mismatched-id", "no-fetch", "bad-detect", "healthy"],
    importProvider
  );

  assert.deepEqual(
    providers.map((p) => p.id),
    ["healthy"]
  );
  const failedIds = failures.map((f) => f.id).sort();
  assert.deepEqual(failedIds, ["bad-detect", "mismatched-id", "no-fetch"]);
  for (const f of failures) assert.ok(f.error instanceof Error);
});

test("loadCareerOpsProviders with every provider healthy returns zero failures", async () => {
  const importProvider = async (id) => fakeProvider(id);
  const { providers, failures } = await loadCareerOpsProviders(["a", "b", "c"], importProvider);
  assert.equal(providers.length, 3);
  assert.deepEqual(failures, []);
});

test("loadCareerOpsProviders preserves provider order for the survivors", async () => {
  const importProvider = async (id) => {
    if (id === "b") throw new Error("nope");
    return fakeProvider(id);
  };
  const { providers } = await loadCareerOpsProviders(["a", "b", "c", "d"], importProvider);
  assert.deepEqual(
    providers.map((p) => p.id),
    ["a", "c", "d"]
  );
});

// Regression guard on the real registry: every vendored provider currently in
// the tree must actually load. If this ever fails, `careerOpsLoadFailures()`
// is exactly the diagnostic the fix added — a broken vendor file no longer
// takes the whole module down, it shows up here instead.
test("the real career-ops registry loads with zero failures and a non-empty provider set", () => {
  assert.deepEqual(careerOpsLoadFailures(), []);
  assert.ok(careerOpsProviderIds().length > 0);
});

// The registry's own request()/createContext() (not any one vendored
// provider) is what routes every provider's outbound fetch through the
// shared SSRF guard in src/core/net/public-http-fetch.mjs. These tests drive
// that integration directly via the exported createContext(), so they don't
// depend on any single vendor's URL-derivation logic (owned separately, and
// vendored rather than ours to author tests against). All cases inject
// resolveHost/dispatcherFactory the same way public-http-fetch.test.mjs does,
// so nothing here touches real DNS or a real network socket.
const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };
const noopDispatcherFactory = () => ({ close: async () => {} });

test("createContext().fetchJson blocks a literal private-IP target with a clear error naming the url and reason, never a silent empty result", async () => {
  let fetchCalled = false;
  const ctx = createContext(async () => {
    fetchCalled = true;
    return new Response("{}");
  });

  await assert.rejects(
    () => ctx.fetchJson("http://169.254.169.254/latest/meta-data"),
    (error) => {
      assert.match(error.message, /169\.254\.169\.254/);
      assert.match(error.message, /private, local, or non-public network host is not fetchable/);
      assert.equal(error.code, "unsafe_url");
      assert.equal(error.url, "http://169.254.169.254/latest/meta-data");
      return true;
    }
  );
  assert.equal(fetchCalled, false);
});

test("createContext().fetchJson blocks a DNS-resolved private-IP target before ever calling fetchImpl", async () => {
  let fetchCalled = false;
  const ctx = createContext(
    async () => {
      fetchCalled = true;
      return new Response("{}");
    },
    { resolveHost: async () => [{ address: "10.0.0.5", family: 4 }] }
  );

  await assert.rejects(
    () => ctx.fetchJson("https://internal.example.test/api"),
    (error) => {
      assert.match(error.message, /internal\.example\.test/);
      assert.equal(error.code, "unsafe_url");
      return true;
    }
  );
  assert.equal(fetchCalled, false);
});

test("createContext().fetchText blocks a non-http(s) protocol", async () => {
  let fetchCalled = false;
  const ctx = createContext(async () => {
    fetchCalled = true;
    return new Response("{}");
  });

  await assert.rejects(
    () => ctx.fetchText("file:///etc/passwd"),
    (error) => {
      assert.equal(error.code, "unsafe_url");
      return true;
    }
  );
  assert.equal(fetchCalled, false);
});

test("createContext().fetchJson blocks a private target even when the provider opts into redirect:'error'", async () => {
  let fetchCalled = false;
  const ctx = createContext(async () => {
    fetchCalled = true;
    return new Response("{}");
  });

  await assert.rejects(
    () => ctx.fetchJson("http://127.0.0.1/admin", { redirect: "error" }),
    (error) => {
      assert.equal(error.code, "unsafe_url");
      return true;
    }
  );
  assert.equal(fetchCalled, false);
});

test("createContext().fetchJson re-validates a redirect target when redirect defaults to follow, and blocks a private second hop", async () => {
  let fetchCalls = 0;
  const ctx = createContext(
    async (_url, init) => {
      fetchCalls += 1;
      assert.equal(init.redirect, "manual");
      if (fetchCalls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://internal.example.test/private" },
        });
      }
      throw new Error("must not reach a second hop");
    },
    {
      resolveHost: async (host) =>
        host === "public.example.test" ? [PUBLIC_ADDRESS] : [{ address: "10.0.0.9", family: 4 }],
      dispatcherFactory: noopDispatcherFactory,
    }
  );

  await assert.rejects(
    () => ctx.fetchJson("https://public.example.test/start"),
    (error) => {
      assert.equal(error.code, "unsafe_redirect");
      assert.match(error.message, /internal\.example\.test/);
      return true;
    }
  );
  assert.equal(fetchCalls, 1);
});

test("createContext().fetchJson allows a validated public target through to fetchImpl and returns the parsed body", async () => {
  let closed = false;
  const ctx = createContext(
    async (url) => new Response(JSON.stringify({ ok: true, url }), { status: 200 }),
    {
      resolveHost: async () => [PUBLIC_ADDRESS],
      dispatcherFactory: () => ({
        close: async () => {
          closed = true;
        },
      }),
    }
  );

  const body = await ctx.fetchJson("https://public.example.test/jobs");
  assert.deepEqual(body, { ok: true, url: "https://public.example.test/jobs" });
  assert.equal(closed, true);
});

test("createContext().fetchJson honors an explicit redirect:'error' request without auto-following, still pinning the initial hop", async () => {
  let receivedInit;
  const ctx = createContext(
    async (_url, init) => {
      receivedInit = init;
      return new Response("{}", { status: 200 });
    },
    { resolveHost: async () => [PUBLIC_ADDRESS], dispatcherFactory: noopDispatcherFactory }
  );

  await ctx.fetchJson("https://public.example.test/api", { redirect: "error" });
  assert.equal(receivedInit.redirect, "error");
});

test("createContext().fetchResponse hands a manual 3xx back to the provider, while fetchText still throws on it", async () => {
  const seen = [];
  const ctx = createContext(
    async (_url, init) => {
      seen.push(init.redirect);
      return new Response(null, { status: 302, headers: { location: "/next" } });
    },
    { resolveHost: async () => [PUBLIC_ADDRESS], dispatcherFactory: noopDispatcherFactory }
  );
  const res = await ctx.fetchResponse("https://public.example.test/start", { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/next");
  await assert.rejects(
    () => ctx.fetchText("https://public.example.test/start", { redirect: "manual" }),
    (error) => error.status === 302 && error.location === "/next"
  );
  // Without redirect: "manual" a failed status still throws from fetchResponse.
  await assert.rejects(
    () => ctx.fetchResponse("https://public.example.test/start", { redirect: "error" }),
    (error) => error.status === 302
  );
  assert.deepEqual(seen, ["manual", "manual", "error"]);
});

// fetchCareerOpsProvider's normalizeOffer maps `job.comp` (a plain string)
// into the returned offer's comp field. Some vendored providers (ashby among
// them) instead surface a structured `job.salary: {min, max, currency}`. The
// vendored Job type documents no `comp` field, so without a fallback that
// figure never reached the offer at all.
test("fetchCareerOpsProvider formats a structured salary object into the offer's comp string", async () => {
  const offers = await fetchCareerOpsProvider(
    "ashby",
    { name: "Acme", careers_url: "https://jobs.ashbyhq.com/acme" },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            jobs: [
              {
                title: "Staff Engineer",
                jobUrl: "https://jobs.ashbyhq.com/acme/1",
                compensation: { minValue: 170000, maxValue: 210000, currency: "USD" },
              },
            ],
          }),
          { status: 200 }
        ),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.equal(offers[0].comp, "USD 170000-210000");
});

test("fetchCareerOpsProvider leaves comp empty when there is neither a comp string nor a usable salary object", async () => {
  const offers = await fetchCareerOpsProvider(
    "ashby",
    { name: "Acme", careers_url: "https://jobs.ashbyhq.com/acme" },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            jobs: [{ title: "Staff Engineer", jobUrl: "https://jobs.ashbyhq.com/acme/1" }],
          }),
          { status: 200 }
        ),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.equal(offers[0].comp, "");
});

// Response-size limits: the context fetchers used to call response.text(), so a
// provider's maxBytes was ignored and the whole body was buffered.
const SIZE_SEAMS = {
  resolveHost: async () => [PUBLIC_ADDRESS],
  dispatcherFactory: () => ({ close: async () => {} }),
};

function endlessResponse(counter) {
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  return new Response(
    new ReadableStream({
      pull(controller) {
        counter.pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        counter.cancelled = true;
      },
    }),
    { status: 200 }
  );
}

test("createContext().fetchText enforces a per-request maxBytes and throws response_too_large", async () => {
  const ctx = createContext(async () => new Response("abcdefgh", { status: 200 }), SIZE_SEAMS);
  await assert.rejects(
    () => ctx.fetchText("https://public.example.test/feed", { maxBytes: 1 }),
    (error) => error.code === "response_too_large"
  );
  assert.equal(
    await ctx.fetchText("https://public.example.test/feed", { maxBytes: 8 }),
    "abcdefgh"
  );
});

test("createContext().fetchJson and fetchResponse honor maxBytes too", async () => {
  const ctx = createContext(async () => new Response('{"a":1}', { status: 200 }), SIZE_SEAMS);
  await assert.rejects(
    () => ctx.fetchJson("https://public.example.test/api", { maxBytes: 3 }),
    (error) => error.code === "response_too_large"
  );
  await assert.rejects(
    () => ctx.fetchResponse("https://public.example.test/api", { maxBytes: 3 }),
    (error) => error.code === "response_too_large"
  );
  assert.deepEqual(await ctx.fetchJson("https://public.example.test/api", { maxBytes: 64 }), {
    a: 1,
  });
});

test("createContext() applies a default ceiling and cancels the body at the limit instead of buffering it", async () => {
  const counter = { pulls: 0, cancelled: false };
  const ctx = createContext(async () => endlessResponse(counter), SIZE_SEAMS);
  await assert.rejects(
    () => ctx.fetchText("https://public.example.test/huge"),
    (error) => error.code === "response_too_large"
  );
  assert.equal(counter.cancelled, true);
  assert.ok(counter.pulls < 64, `read ${counter.pulls} chunks past the default ceiling`);
});

test("createContext() rejects on a declared content-length over maxBytes without reading the body", async () => {
  const counter = { pulls: 0, cancelled: false };
  const ctx = createContext(async () => {
    const res = endlessResponse(counter);
    return new Response(res.body, { status: 200, headers: { "content-length": "999999999" } });
  }, SIZE_SEAMS);
  await assert.rejects(
    () => ctx.fetchText("https://public.example.test/huge", { maxBytes: 1024 }),
    (error) => error.code === "response_too_large"
  );
  assert.equal(counter.cancelled, true);
});

test("an oversized error body keeps its first 64 KiB of text and cancels the rest", async () => {
  const counter = { pulls: 0, cancelled: false };
  const marker = "Service is down for maintenance";
  const head = new TextEncoder().encode(marker);
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  const ctx = createContext(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            counter.pulls += 1;
            controller.enqueue(counter.pulls === 1 ? head : chunk);
          },
          cancel() {
            counter.cancelled = true;
          },
        }),
        { status: 503 }
      ),
    SIZE_SEAMS
  );
  const error = await ctx.fetchText("https://public.example.test/down").catch((e) => e);
  assert.equal(error.status, 503);
  assert.ok(error.body.startsWith(marker), "diagnostic text was discarded");
  assert.equal(Buffer.byteLength(error.body, "utf8"), 64 * 1024);
  assert.equal(counter.cancelled, true);
  assert.ok(counter.pulls < 8);
});

test("a content-encoded response is judged on its decoded size, not Content-Length", async () => {
  const ctx = createContext(
    async () =>
      new Response("abcdefgh", {
        status: 200,
        headers: { "content-length": "999999", "content-encoding": "gzip" },
      }),
    SIZE_SEAMS
  );
  assert.equal(await ctx.fetchText("https://public.example.test/z", { maxBytes: 64 }), "abcdefgh");
  await assert.rejects(
    () => ctx.fetchText("https://public.example.test/z", { maxBytes: 4 }),
    (error) => error.code === "response_too_large"
  );
});

test("an identity-encoded Content-Length over maxBytes still short-circuits", async () => {
  const ctx = createContext(
    async () =>
      new Response("abc", {
        status: 200,
        headers: { "content-length": "999999", "content-encoding": "identity" },
      }),
    SIZE_SEAMS
  );
  await assert.rejects(
    () => ctx.fetchText("https://public.example.test/z", { maxBytes: 64 }),
    (error) => error.code === "response_too_large"
  );
});

test("an Ashby body over its cap falls back to the embed listing instead of being parsed whole", async () => {
  const embedHtml = `<script>window.__appData = ${JSON.stringify({
    jobBoard: {
      jobPostings: [{ id: "p1", title: "Embed Engineer", locationName: "Remote" }],
    },
  })};</script>`;
  let calls = 0;
  const offers = await fetchCareerOpsProvider(
    "ashby",
    { name: "Acme", careers_url: "https://jobs.ashbyhq.com/acme" },
    {
      fetchImpl: async (url) => {
        calls += 1;
        if (String(url).includes("posting-api")) {
          return new Response("x".repeat(1024), {
            status: 200,
            headers: { "content-length": String(65 * 1024 * 1024) },
          });
        }
        return new Response(embedHtml, { status: 200 });
      },
      ...SIZE_SEAMS,
    }
  ).catch((error) => error);
  assert.ok(calls >= 2, "the embed fallback never ran");
  assert.ok(Array.isArray(offers), String(offers?.message));
  assert.equal(offers[0]?.title, "Embed Engineer");
});
