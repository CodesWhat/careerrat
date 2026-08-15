// tests/logo-route.test.mjs
// node:test suite for the M8 logo.dev proxy (src/cli/logo-route.mjs) —
// GET /api/logos/search and GET /api/logos/img. Mirrors
// tests/search-route.test.mjs's bootServer() (a bare addRoute Map wrapped in
// http.createServer) and its fetchImpl-injection convention (real `Response`
// objects standing in for the network, per that file's leverFetchStub()) —
// no real network call happens anywhere in this suite.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  mountLogoRoutes,
  resolveLogoTokens,
  sanitizeDomainForCache,
} from "../src/cli/logo-route.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { stringifyYaml } from "../src/core/profile/yaml.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-logo-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  return repoRoot;
}

function writeAutomation(repoRoot, integrations = {}) {
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  writeFileSync(join(repoRoot, "candidate/automation.yml"), `${stringifyYaml({ integrations })}\n`);
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountLogoRoutes({ addRoute, repoRoot, env: {}, ...opts });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    dispatchHttpRoute(route, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
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

// ---------------------------------------------------------------------------
// sanitizeDomainForCache — pure, traversal-safety unit tests
// ---------------------------------------------------------------------------

test("sanitizeDomainForCache: a clean domain passes through lowercased", () => {
  assert.equal(sanitizeDomainForCache("Sweetgreen.com"), "sweetgreen.com");
});

test("sanitizeDomainForCache: rejects path separators and parent-dir traversal", () => {
  assert.equal(sanitizeDomainForCache("../../etc/passwd"), null);
  assert.equal(sanitizeDomainForCache("..\\..\\windows\\system32"), null);
  assert.equal(sanitizeDomainForCache("acme.com/../../../etc/passwd"), null);
  assert.equal(sanitizeDomainForCache(".."), null);
});

test("sanitizeDomainForCache: strips disallowed characters, rejects a leading dot/hyphen result", () => {
  assert.equal(sanitizeDomainForCache("acme corp!.com"), "acmecorp.com");
  assert.equal(sanitizeDomainForCache(""), null);
  assert.equal(sanitizeDomainForCache("   "), null);
});

test("resolveLogoTokens: image logo lookup has a built-in publishable logo.dev key", () => {
  const repoRoot = tempRepo();
  assert.equal(resolveLogoTokens({ repoRoot }, {}).publishableToken, "pk_SgppRPhNTWqQdH-WZX5BWA");
});

// ---------------------------------------------------------------------------
// GET /api/logos/search
// ---------------------------------------------------------------------------

test("GET /api/logos/search: no secret key configured -> 200 {ok:false, reason:'no-token'}, never calls fetchImpl", async () => {
  const repoRoot = tempRepo();
  let fetchCalled = false;
  const server = await bootServer(repoRoot, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("should never be called");
    },
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/search?q=Acme`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: false, reason: "no-token", results: [] });
    assert.equal(fetchCalled, false);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/search: with a secret key, proxies Brand Search and strips logo_url from results", async () => {
  const repoRoot = tempRepo();
  writeAutomation(repoRoot, { logo_dev_secret_key: "sk_test_123" });

  let receivedUrl = null;
  let receivedAuth = null;
  const server = await bootServer(repoRoot, {
    fetchImpl: async (url, opts) => {
      receivedUrl = String(url);
      receivedAuth = opts?.headers?.Authorization;
      return new Response(
        JSON.stringify([
          {
            name: "Sweetgreen",
            domain: "sweetgreen.com",
            logo_url: "https://img.logo.dev/sweetgreen.com?token=SOMETHING",
          },
        ]),
        { status: 200 }
      );
    },
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/search?q=Sweetgreen`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.results, [{ name: "Sweetgreen", domain: "sweetgreen.com" }]);
    assert.ok(!JSON.stringify(body).includes("logo_url"), "logo_url must never be passed through");

    // NEVER call logo.dev with candidate PII — the literal user-typed query only.
    assert.match(receivedUrl, /^https:\/\/api\.logo\.dev\/search\?q=Sweetgreen$/);
    assert.equal(receivedAuth, "Bearer sk_test_123");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/search: repeated identical query hits the in-memory cache, fetchImpl called only once", async () => {
  const repoRoot = tempRepo();
  writeAutomation(repoRoot, { logo_dev_secret_key: "sk_test_123" });

  let fetchCalls = 0;
  const server = await bootServer(repoRoot, {
    fetchImpl: async () => {
      fetchCalls++;
      return new Response(JSON.stringify([{ name: "Acme", domain: "acme.com" }]), { status: 200 });
    },
  });
  try {
    const first = await fetch(`${baseUrl(server)}/api/logos/search?q=Acme`);
    const second = await fetch(`${baseUrl(server)}/api/logos/search?q=Acme`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(
      await first.json(),
      await (async () => {
        // re-fetch not possible on a consumed body; assert shape independently below
        return { ok: true, results: [{ name: "Acme", domain: "acme.com" }] };
      })()
    );
    assert.equal(fetchCalls, 1, "the second identical query must be served from the memory cache");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/search: persists to workspace/logos/search-cache.json — a fresh mount (server restart) still hits the disk cache", async () => {
  const repoRoot = tempRepo();
  writeAutomation(repoRoot, { logo_dev_secret_key: "sk_test_123" });

  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return new Response(JSON.stringify([{ name: "Acme", domain: "acme.com" }]), { status: 200 });
  };

  const server1 = await bootServer(repoRoot, { fetchImpl });
  try {
    const res1 = await fetch(`${baseUrl(server1)}/api/logos/search?q=Acme`);
    assert.equal(res1.status, 200);
  } finally {
    await closeServer(server1);
  }

  const cachePath = userPath({ repoRoot }, "workspace/logos/search-cache.json");
  assert.ok(existsSync(cachePath), "search-cache.json should be written to disk");
  const persisted = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.ok(persisted.acme, "cache is keyed by the normalized (lowercased) query");

  // A brand-new mountLogoRoutes() call = a brand-new in-memory Map, simulating
  // a server restart. It should still resolve from the persisted disk cache.
  const server2 = await bootServer(repoRoot, { fetchImpl });
  try {
    const res2 = await fetch(`${baseUrl(server2)}/api/logos/search?q=Acme`);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.deepEqual(body2.results, [{ name: "Acme", domain: "acme.com" }]);
  } finally {
    await closeServer(server2);
  }
  assert.equal(fetchCalls, 1, "the disk-cache hit on the second mount must not re-call fetchImpl");
});

test("GET /api/logos/search: upstream non-2xx degrades to 200 {ok:false, reason:'upstream-error'}, never a 500", async () => {
  const repoRoot = tempRepo();
  writeAutomation(repoRoot, { logo_dev_secret_key: "sk_test_123" });

  const server = await bootServer(repoRoot, {
    fetchImpl: async () => new Response("Internal Server Error", { status: 500 }),
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/search?q=Acme`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, "upstream-error");
    assert.deepEqual(body.results, []);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/search: missing ?q= is a 400", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, { fetchImpl: async () => new Response("[]") });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/search`);
    assert.equal(res.status, 400);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// GET /api/logos/img
// ---------------------------------------------------------------------------

test("GET /api/logos/img: missing ?domain= is a 400", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, {});
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/img`);
    assert.equal(res.status, 400);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/img: a traversal attempt in ?domain= 404s and never calls fetchImpl or writes outside workspace/logos", async () => {
  const repoRoot = tempRepo();
  writeAutomation(repoRoot, { logo_dev_token: "pk_test_123" });

  let fetchCalled = false;
  const server = await bootServer(repoRoot, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("should never be called");
    },
  });
  try {
    const res = await fetch(
      `${baseUrl(server)}/api/logos/img?domain=${encodeURIComponent("../../../../etc/passwd")}`
    );
    assert.equal(res.status, 404);
    assert.equal(fetchCalled, false);
  } finally {
    await closeServer(server);
  }
  // Nothing escaped workspace/logos — no file created outside it.
  assert.ok(!existsSync(join(repoRoot, "etc", "passwd")));
});

test("GET /api/logos/img: without user config, domain lookup uses the built-in publishable key", async () => {
  const repoRoot = tempRepo();
  const pngBytes = Buffer.from([5, 6, 7, 8]);
  let receivedUrl = null;
  const server = await bootServer(repoRoot, {
    fetchImpl: async (url) => {
      receivedUrl = String(url);
      return new Response(pngBytes, { status: 200 });
    },
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/img?domain=acme.com`);
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(pngBytes));
    assert.match(
      receivedUrl,
      /^https:\/\/img\.logo\.dev\/acme\.com\?token=pk_SgppRPhNTWqQdH-WZX5BWA/
    );
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/img: cache miss fetches from img.logo.dev, serves bytes, and writes the on-disk cache", async () => {
  const repoRoot = tempRepo();
  writeAutomation(repoRoot, { logo_dev_token: "pk_test_123" });

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // fake image bytes
  let receivedUrl = null;
  const server = await bootServer(repoRoot, {
    fetchImpl: async (url) => {
      receivedUrl = String(url);
      return new Response(pngBytes, { status: 200 });
    },
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/img?domain=Acme.com`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(pngBytes));

    assert.match(receivedUrl, /^https:\/\/img\.logo\.dev\/acme\.com\?token=pk_test_123/);
  } finally {
    await closeServer(server);
  }

  const cachePath = userPath({ repoRoot }, "workspace/logos/acme.com.webp");
  assert.ok(existsSync(cachePath), "the fetched image must be cached to workspace/logos/");
  assert.ok(readFileSync(cachePath).equals(pngBytes));
});

test("GET /api/logos/img: a company name uses logo.dev name lookup and caches the image", async () => {
  const repoRoot = tempRepo();

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let receivedUrl = null;
  const server = await bootServer(repoRoot, {
    fetchImpl: async (url) => {
      receivedUrl = String(url);
      return new Response(pngBytes, { status: 200 });
    },
  });
  try {
    const res = await fetch(
      `${baseUrl(server)}/api/logos/img?name=${encodeURIComponent("Sweet Green")}`
    );
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(pngBytes));

    assert.match(
      receivedUrl,
      /^https:\/\/img\.logo\.dev\/name\/Sweet%20Green\?token=pk_SgppRPhNTWqQdH-WZX5BWA/
    );
  } finally {
    await closeServer(server);
  }

  const cachePath = userPath({ repoRoot }, "workspace/logos/name-sweet-green.webp");
  assert.ok(existsSync(cachePath), "the name lookup image must be cached to workspace/logos/");
  assert.ok(readFileSync(cachePath).equals(pngBytes));
});

test("GET /api/logos/img: dark theme forwards to logo.dev and uses its own cached image", async () => {
  const repoRoot = tempRepo();

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x44]);
  let receivedUrl = null;
  const server = await bootServer(repoRoot, {
    fetchImpl: async (url) => {
      receivedUrl = String(url);
      return new Response(pngBytes, { status: 200 });
    },
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/img?domain=Acme.com&theme=dark`);
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(pngBytes));

    assert.match(receivedUrl, /[?&]theme=dark(?:&|$)/);
  } finally {
    await closeServer(server);
  }

  const cachePath = userPath({ repoRoot }, "workspace/logos/acme.com-dark.webp");
  assert.ok(existsSync(cachePath), "the dark-theme image must use a separate cache entry");
  assert.ok(readFileSync(cachePath).equals(pngBytes));
});

test("GET /api/logos/img: a cache hit serves from disk without calling fetchImpl again", async () => {
  const repoRoot = tempRepo();
  writeAutomation(repoRoot, { logo_dev_token: "pk_test_123" });
  const cacheDir = userPath({ repoRoot }, "workspace/logos");
  mkdirSync(cacheDir, { recursive: true });
  const cached = Buffer.from([1, 2, 3, 4]);
  writeFileSync(join(cacheDir, "acme.com.webp"), cached);

  let fetchCalled = false;
  const server = await bootServer(repoRoot, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("should never be called on a cache hit");
    },
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/img?domain=acme.com`);
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(cached));
    assert.equal(fetchCalled, false);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/img: upstream non-2xx (or logo.dev's own fallback=404) degrades to a 404, never a 500", async () => {
  const repoRoot = tempRepo();
  writeAutomation(repoRoot, { logo_dev_token: "pk_test_123" });

  const server = await bootServer(repoRoot, {
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  try {
    const res = await fetch(`${baseUrl(server)}/api/logos/img?domain=doesnotexist.com`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("cache-control") || "", /max-age=/);
    assert.deepEqual(await res.json(), { error: "no logo for this domain" });
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/img: initials fallback turns an expected upstream miss into a quiet 204", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot, {
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  try {
    const res = await fetch(
      `${baseUrl(server)}/api/logos/img?name=${encodeURIComponent("Missing Company")}&fallback=initials`
    );
    assert.equal(res.status, 204);
    assert.match(res.headers.get("cache-control") || "", /max-age=/);
    assert.equal(await res.text(), "");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/logos/img: initials fallback does not cache transient failures", async () => {
  const scenarios = [
    {
      name: "network failure",
      fetchImpl: async () => {
        throw new Error("temporary network failure");
      },
    },
    {
      name: "upstream 503",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    },
    {
      name: "body read failure",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          throw new Error("truncated response");
        },
      }),
    },
  ];

  for (const scenario of scenarios) {
    const repoRoot = tempRepo();
    const server = await bootServer(repoRoot, { fetchImpl: scenario.fetchImpl });
    try {
      const fallbackRes = await fetch(
        `${baseUrl(server)}/api/logos/img?domain=temporary.example&fallback=initials`
      );
      assert.equal(fallbackRes.status, 204, scenario.name);
      assert.equal(fallbackRes.headers.get("cache-control"), "no-store", scenario.name);

      const directRes = await fetch(`${baseUrl(server)}/api/logos/img?domain=temporary.example`);
      assert.equal(directRes.status, 404, scenario.name);
      assert.equal(directRes.headers.get("cache-control"), "no-store", scenario.name);
      assert.deepEqual(await directRes.json(), { error: "no logo for this domain" }, scenario.name);
    } finally {
      await closeServer(server);
    }
  }
});

test("GET /api/logos/img: initials fallback does not cache an unreadable local cache entry", async () => {
  const repoRoot = tempRepo();
  const cachePath = userPath({ repoRoot }, "workspace/logos/temporary.example.webp");
  mkdirSync(cachePath, { recursive: true });
  const server = await bootServer(repoRoot, {
    fetchImpl: async () => {
      throw new Error("cache hit must not fetch");
    },
  });
  try {
    const res = await fetch(
      `${baseUrl(server)}/api/logos/img?domain=temporary.example&fallback=initials`
    );
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    await closeServer(server);
  }
});
