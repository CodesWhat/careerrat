import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchPublicHttpText,
  guardedFetch,
  validatePublicHttpUrl,
} from "../src/core/net/public-http-fetch.mjs";

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

test("validatePublicHttpUrl rejects an IPv4-mapped loopback in both its textual and hex-group forms", () => {
  // Node's URL parser canonicalizes a bracketed IPv6 host to hex groups
  // (::ffff:127.0.0.1 -> ::ffff:7f00:1), so both spellings must be caught —
  // a check that only matched the dotted-decimal text would miss the second.
  const textual = validatePublicHttpUrl("http://[::ffff:127.0.0.1]/");
  assert.equal(textual.ok, false);
  assert.equal(textual.reason, "private, local, or non-public network host is not fetchable");

  const hexForm = validatePublicHttpUrl("http://[::ffff:7f00:1]/");
  assert.equal(hexForm.ok, false);
  assert.equal(hexForm.reason, "private, local, or non-public network host is not fetchable");
});

test("validatePublicHttpUrl rejects the cloud metadata address mapped into IPv6, textual and hex", () => {
  const textual = validatePublicHttpUrl("http://[::ffff:169.254.169.254]/latest/meta-data");
  assert.equal(textual.ok, false);

  const hexForm = validatePublicHttpUrl("http://[::ffff:a9fe:a9fe]/latest/meta-data");
  assert.equal(hexForm.ok, false);
});

test("validatePublicHttpUrl rejects plain private-range IPv4 addresses mapped into IPv6", () => {
  for (const host of ["[::ffff:10.0.0.1]", "[::ffff:192.168.1.1]", "[::ffff:172.16.0.1]"]) {
    const result = validatePublicHttpUrl(`http://${host}/`);
    assert.equal(result.ok, false, `${host} should be rejected`);
  }
});

test("validatePublicHttpUrl still allows a genuinely public address mapped into IPv6", () => {
  const result = validatePublicHttpUrl("http://[::ffff:8.8.8.8]/");
  assert.equal(result.ok, true);
});

test("validatePublicHttpUrl still rejects unmapped IPv6 private/local/loopback ranges", () => {
  for (const host of ["[::1]", "[::]", "[fc00::1]", "[fd00::1]", "[fe80::1]", "[2001:db8::1]"]) {
    const result = validatePublicHttpUrl(`http://${host}/`);
    assert.equal(result.ok, false, `${host} should be rejected`);
  }
});

test("validatePublicHttpUrl rejects a NAT64-embedded loopback and metadata address", () => {
  // NAT64's well-known prefix 64:ff9b::/96 embeds an IPv4 in its low 32 bits,
  // the same way IPv4-mapped addresses do, and reaches Node's URL parser in
  // both the textual dotted-decimal and canonical hex-group spellings.
  for (const host of ["[64:ff9b::127.0.0.1]", "[64:ff9b::7f00:1]"]) {
    const result = validatePublicHttpUrl(`http://${host}/`);
    assert.equal(result.ok, false, `${host} should be rejected`);
  }
  for (const host of ["[64:ff9b::169.254.169.254]", "[64:ff9b::a9fe:a9fe]"]) {
    const result = validatePublicHttpUrl(`http://${host}/`);
    assert.equal(result.ok, false, `${host} should be rejected`);
  }
});

test("validatePublicHttpUrl rejects a 6to4-embedded private address", () => {
  // 6to4's 2002::/16 prefix embeds the IPv4 higher up, in bits 16-47
  // (groups 1-2), with an SLA ID/interface ID in the remaining groups.
  const result = validatePublicHttpUrl("http://[2002:0a00:0001::]/");
  assert.equal(result.ok, false);
});

test("validatePublicHttpUrl still allows a genuinely public address embedded via NAT64 or 6to4", () => {
  const nat64 = validatePublicHttpUrl("http://[64:ff9b::8.8.8.8]/");
  assert.equal(nat64.ok, true);

  const sixToFour = validatePublicHttpUrl("http://[2002:0808:0808::]/");
  assert.equal(sixToFour.ok, true);
});

// guardedFetch is the Response-returning sibling of fetchPublicHttpText,
// added for callers (the Career Ops provider registry) that need arbitrary
// methods/bodies/headers and consume the body themselves rather than getting
// back capped text. It reuses the exact same validate/resolve/pin machinery.

test("guardedFetch rejects an unsafe target before ever calling fetchImpl", async () => {
  let fetchCalls = 0;
  const result = await guardedFetch(
    "http://169.254.169.254/latest/meta-data",
    {},
    {
      fetchImpl: async () => (fetchCalls += 1),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "unsafe_url");
  assert.equal(fetchCalls, 0);
});

test("guardedFetch with redirect: follow re-validates each hop and blocks a private second hop", async () => {
  let fetchCalls = 0;
  const result = await guardedFetch(
    "https://public.example.test/start",
    {},
    {
      resolveHost: async (host) =>
        host === "public.example.test"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "10.0.0.8", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        assert.equal(init.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { location: "http://internal.example.test/admin" },
        });
      },
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "unsafe_redirect");
  assert.equal(fetchCalls, 1);
});

test("guardedFetch returns the real Response and a close() for an allowed public target", async () => {
  let closed = false;
  const result = await guardedFetch(
    "https://public.example.test/jobs",
    {},
    {
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({
        close: async () => {
          closed = true;
        },
      }),
      fetchImpl: async () => new Response("available jobs", { status: 200 }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(await result.response.text(), "available jobs");
  assert.equal(closed, false);
  await result.close();
  assert.equal(closed, true);
});

// guardedFetch's redirect chain replays WHATWG fetch's own per-hop request
// mutation (https://fetch.spec.whatwg.org/#http-redirect-fetch) rather than
// the original init verbatim: a 303 (or a non-GET/HEAD 301/302) downgrades to
// a bodyless GET and drops the body-describing headers, a 307/308 preserves
// method and body untouched, and a hop that crosses origin loses any
// caller-supplied credential headers.

test("guardedFetch turns a 303 hop from POST into a bodyless GET and drops body headers", async () => {
  const hops = [];
  const result = await guardedFetch(
    "https://public.example.test/start",
    {
      method: "POST",
      body: "payload",
      headers: { "Content-Type": "application/json", "X-Custom": "keep-me" },
    },
    {
      resolveHost: async () => PUBLIC_ADDRESSES,
      dispatcherFactory: () => ({ close: async () => {} }),
      fetchImpl: async (url, init) => {
        hops.push({ url, ...init });
        if (hops.length === 1) {
          return new Response(null, {
            status: 303,
            headers: { location: "https://public.example.test/next" },
          });
        }
        return new Response("done", { status: 200 });
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(hops.length, 2);
  assert.equal(hops[0].method, "POST");
  assert.equal(hops[0].body, "payload");
  assert.equal(hops[1].method, "GET");
  assert.equal(hops[1].body, undefined);
  assert.equal(hops[1].headers["Content-Type"], undefined);
  assert.equal(hops[1].headers["X-Custom"], "keep-me");
});

test("guardedFetch preserves method and body across a 307 hop", async () => {
  const hops = [];
  const result = await guardedFetch(
    "https://public.example.test/start",
    { method: "POST", body: "payload", headers: { "Content-Type": "application/json" } },
    {
      resolveHost: async () => PUBLIC_ADDRESSES,
      dispatcherFactory: () => ({ close: async () => {} }),
      fetchImpl: async (url, init) => {
        hops.push({ url, ...init });
        if (hops.length === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: "https://public.example.test/next" },
          });
        }
        return new Response("done", { status: 200 });
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(hops.length, 2);
  assert.equal(hops[1].method, "POST");
  assert.equal(hops[1].body, "payload");
  assert.equal(hops[1].headers["Content-Type"], "application/json");
});

test("guardedFetch drops authorization/cookie on a cross-origin hop but keeps them same-origin", async () => {
  const hops = [];
  const result = await guardedFetch(
    "https://public.example.test/start",
    { headers: { Authorization: "Bearer secret", Cookie: "session=abc", "X-Custom": "keep-me" } },
    {
      resolveHost: async () => PUBLIC_ADDRESSES,
      dispatcherFactory: () => ({ close: async () => {} }),
      fetchImpl: async (url, init) => {
        hops.push({ url, ...init });
        if (hops.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://public.example.test/same-origin" },
          });
        }
        if (hops.length === 2) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example.test/cross-origin" },
          });
        }
        return new Response("done", { status: 200 });
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(hops.length, 3);
  assert.equal(hops[1].headers.Authorization, "Bearer secret");
  assert.equal(hops[1].headers.Cookie, "session=abc");
  assert.equal(hops[2].headers.Authorization, undefined);
  assert.equal(hops[2].headers.Cookie, undefined);
  assert.equal(hops[2].headers["X-Custom"], "keep-me");
});

// resolveHost is awaited to resolve every hop's target before that hop's
// deadline (timeoutMs for fetchPublicHttpText, init.signal for guardedFetch)
// starts covering anything else. A resolver that never settles (a hung DNS
// client, a black-holed network) must not be able to hold the call open past
// that deadline — these tests use a resolveHost that deliberately never
// resolves or rejects, on both the initial hop and a redirect hop.
const NEVER_SETTLES = () => new Promise(() => {});

test("fetchPublicHttpText aborts a stalled initial DNS lookup within the deadline", async () => {
  const start = Date.now();
  const result = await fetchPublicHttpText("https://public.example.test/jobs", {
    timeoutMs: 50,
    resolveHost: NEVER_SETTLES,
    fetchImpl: async () => {
      throw new Error("fetchImpl must not be reached — DNS never resolved");
    },
  });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - start < 2000, "resolveHost must not outlive timeoutMs");
});

test("fetchPublicHttpText aborts a stalled redirect-hop DNS lookup within the deadline", async () => {
  const start = Date.now();
  let hop = 0;
  const result = await fetchPublicHttpText("https://public.example.test/start", {
    timeoutMs: 50,
    dispatcherFactory: () => ({ close: async () => {} }),
    resolveHost: async (host) => {
      hop += 1;
      if (hop === 1) return [{ address: "93.184.216.34", family: 4 }];
      return NEVER_SETTLES();
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://public.example.test/next" },
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(hop, 2);
  assert.ok(Date.now() - start < 2000, "the redirect hop's resolveHost must not outlive timeoutMs");
});

test("guardedFetch aborts a stalled initial DNS lookup within the caller's own abort signal", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("caller deadline")), 50);
  const start = Date.now();
  const result = await guardedFetch(
    "https://public.example.test/jobs",
    { signal: controller.signal },
    {
      resolveHost: NEVER_SETTLES,
      fetchImpl: async () => {
        throw new Error("fetchImpl must not be reached — DNS never resolved");
      },
    }
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /caller deadline/);
  assert.ok(Date.now() - start < 2000, "resolveHost must not outlive the caller's abort signal");
});

test("guardedFetch aborts a stalled redirect-hop DNS lookup within the caller's own abort signal", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("caller deadline")), 50);
  let hop = 0;
  const start = Date.now();
  const result = await guardedFetch(
    "https://public.example.test/start",
    { signal: controller.signal },
    {
      dispatcherFactory: () => ({ close: async () => {} }),
      resolveHost: async () => {
        hop += 1;
        if (hop === 1) return [{ address: "93.184.216.34", family: 4 }];
        return NEVER_SETTLES();
      },
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://public.example.test/next" },
        });
      },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(hop, 2);
  assert.match(result.reason, /caller deadline/);
  assert.ok(
    Date.now() - start < 2000,
    "the redirect hop's resolveHost must not outlive the caller's abort signal"
  );
});

test("guardedFetch passes redirect: 'error'/'manual' straight through to fetchImpl, pinning only the initial hop", async () => {
  let receivedInit;
  const result = await guardedFetch(
    "https://public.example.test/api",
    { redirect: "error" },
    {
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
      fetchImpl: async (_url, init) => {
        receivedInit = init;
        return new Response("{}", { status: 200 });
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(receivedInit.redirect, "error");
});

test("fetchPublicHttpText allowedHosts lets a listed host through unchanged", async () => {
  const result = await fetchPublicHttpText("https://public.example.test/jobs", {
    resolveHost: async () => PUBLIC_ADDRESSES,
    dispatcherFactory: () => ({ close: async () => {} }),
    allowedHosts: ["public.example.test"],
    fetchImpl: async () =>
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.rawText, "ok");
});

test("fetchPublicHttpText allowedHosts rejects an unlisted host before touching the network", async () => {
  let fetchCalls = 0;
  const result = await fetchPublicHttpText("https://public.example.test/jobs", {
    resolveHost: async () => PUBLIC_ADDRESSES,
    allowedHosts: ["only-this-host.example.test"],
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "host_not_allowed");
  assert.equal(fetchCalls, 0);
});

test("fetchPublicHttpText allowedHosts is re-checked on a redirect hop", async () => {
  const result = await fetchPublicHttpText("https://public.example.test/start", {
    resolveHost: async (host) =>
      host === "public.example.test" ? PUBLIC_ADDRESSES : [{ address: "93.184.216.35", family: 4 }],
    dispatcherFactory: () => ({ close: async () => {} }),
    allowedHosts: ["public.example.test"],
    fetchImpl: async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example.test/next" },
      }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "host_not_allowed");
});
