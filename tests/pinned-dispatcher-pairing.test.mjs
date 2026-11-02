import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  createPinnedDispatcher,
  fetchPublicHttpText,
  guardedFetch,
} from "../src/core/net/public-http-fetch.mjs";
import { scanSearchSources } from "../src/core/scoring/sourced-scanner.mjs";

// The pinned dispatcher is an npm undici Agent. Node's bundled fetch rejects it
// on every request, which once made every public source fail while each test
// that injected its own fetch stayed green. These tests hand the real, unmodified
// Node fetch to each public entry point, in each way callers spell it, over a
// real socket. Only DNS is swapped (to a public address, so the SSRF checks
// still run) and the connection is pinned to the local server.
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Staff Engineer</title><link>https://example.test/jobs/1</link><description>Build things.</description></item>
</channel></rss>`;

async function withServer(run) {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": req.url === "/feed" ? "application/rss+xml" : "text/plain",
    });
    res.end(req.url === "/feed" ? FEED : "hello");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const seams = {
    resolveHost: async () => PUBLIC,
    dispatcherFactory: ({ hostname }) =>
      createPinnedDispatcher({ hostname, addresses: [{ address: "127.0.0.1", family: 4 }] }),
  };
  try {
    await run({ port, seams });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Node's own fetch works with the pinned dispatcher however a caller spells it", async () => {
  const bare = fetch;
  const spellings = { default: undefined, bare, global: globalThis.fetch };
  assert.equal(bare.name, "fetch", "this runtime's global fetch must be the real one");
  await withServer(async ({ port, seams }) => {
    for (const [label, fetchImpl] of Object.entries(spellings)) {
      const text = await fetchPublicHttpText(`http://fixture.example:${port}/x`, {
        ...seams,
        fetchImpl,
      });
      assert.equal(text.ok, true, `${label}: ${text.reason}`);
      assert.equal(text.rawText, "hello");
      const guarded = await guardedFetch(
        `http://fixture.example:${port}/x`,
        {},
        { ...seams, fetchImpl }
      );
      assert.equal(guarded.ok, true, `${label}: ${guarded.reason}`);
      await guarded.close();
    }
  });
});

test("a scanner source fetched with its default fetch reaches the server", async () => {
  await withServer(async ({ port, seams }) => {
    const result = await scanSearchSources(
      { sources: [{ label: "Fixture feed", rssUrl: `http://fixture.example:${port}/feed` }] },
      seams
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.offers.length, 1);
  });
});

test("an injected fetch that is not Node's own is left alone", async () => {
  let calls = 0;
  const stub = async () => {
    calls += 1;
    return new Response("stubbed", { status: 200 });
  };
  const text = await fetchPublicHttpText("https://example.test/x", {
    fetchImpl: stub,
    resolveHost: async () => PUBLIC,
    dispatcherFactory: () => undefined,
  });
  assert.equal(calls, 1);
  assert.equal(text.rawText, "stubbed");
});
