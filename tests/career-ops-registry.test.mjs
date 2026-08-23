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
// module's top-level registry build: 74+ vendored provider files used to load
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

test("createContext().fetchJson blocks a non-http(s) protocol", async () => {
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
