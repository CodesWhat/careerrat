import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchPublicHttpText } from "../src/core/net/public-http-fetch.mjs";

const PUBLIC_ADDRESSES = [{ address: "93.184.216.34", family: 4 }];

test("public fetch rejects literal and DNS-resolved private targets before network access", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("unsafe target must not be fetched");
  };

  const literal = await fetchPublicHttpText("http://169.254.169.254/latest/meta-data", {
    fetchImpl,
    resolveHost: async () => PUBLIC_ADDRESSES,
  });
  assert.equal(literal.ok, false);
  assert.equal(literal.code, "unsafe_url");

  const resolved = await fetchPublicHttpText("https://metadata.example.test/latest", {
    fetchImpl,
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "unsafe_url");
  assert.equal(fetchCalls, 0);
});

test("public fetch manually revalidates redirects and refuses a private second hop", async () => {
  let fetchCalls = 0;
  const result = await fetchPublicHttpText("https://public.example.test/start", {
    resolveHost: async (host) =>
      host === "public.example.test" ? PUBLIC_ADDRESSES : [{ address: "10.0.0.8", family: 4 }],
    dispatcherFactory: () => ({ close: async () => {} }),
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      assert.equal(init.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://internal.example.test/admin" },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "unsafe_redirect");
  assert.equal(fetchCalls, 1);
});

test("public fetch pins the approved DNS answers into its transport dispatcher", async () => {
  const dispatcher = { close: async () => {} };
  let dispatcherInput;
  const result = await fetchPublicHttpText("https://public.example.test/jobs", {
    resolveHost: async () => PUBLIC_ADDRESSES,
    dispatcherFactory: (input) => {
      dispatcherInput = input;
      return dispatcher;
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.dispatcher, dispatcher);
      return new Response("available jobs", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(dispatcherInput.addresses, PUBLIC_ADDRESSES);
  assert.equal(dispatcherInput.hostname, "public.example.test");
});

test("public fetch stops and cancels a streaming body at the byte cap", async () => {
  const chunks = [Buffer.from("12345678"), Buffer.from("90abcdef")];
  let reads = 0;
  let cancelled = false;
  const body = {
    getReader() {
      return {
        async read() {
          const value = chunks[reads];
          reads += 1;
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        async cancel() {
          cancelled = true;
        },
      };
    },
  };

  const result = await fetchPublicHttpText("https://public.example.test/large", {
    maxBytes: 10,
    resolveHost: async () => PUBLIC_ADDRESSES,
    dispatcherFactory: () => ({ close: async () => {} }),
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      url: "https://public.example.test/large",
      headers: new Headers({ "content-type": "text/plain" }),
      body,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "response_too_large");
  assert.equal(result.truncated, true);
  assert.equal(result.byteLength, 10);
  assert.equal(cancelled, true);
  assert.equal(reads, 2);
});
