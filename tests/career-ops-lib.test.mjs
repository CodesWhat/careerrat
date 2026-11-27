import assert from "node:assert/strict";
import { test } from "node:test";
import { ATS_HOST_PATTERNS, atsVendorOf } from "../src/core/providers/career-ops/ats-vendor.mjs";
import {
  boardTruncation,
  describeTruncation,
  markTruncated,
  partialBoardsNote,
} from "../src/core/providers/career-ops/lib/board-truncation.mjs";
import { closesAtIso } from "../src/core/providers/career-ops/lib/posting-close.mjs";
import * as http from "../src/core/providers/career-ops/vendor/_http.mjs";

test("board-truncation: canonical and legacy partial-read signals", () => {
  assert.equal(boardTruncation([]), null);
  assert.equal(boardTruncation(null), null);
  const jobs = markTruncated([], "page-cap", { fetched: 100, total: 340 });
  assert.deepEqual(boardTruncation(jobs), {
    reason: "page-cap",
    fetched: 100,
    total: 340,
    source: "truncated",
  });
  assert.equal(describeTruncation("Apple", boardTruncation(jobs)), "Apple (page-cap, 100 of 340)");
  const legacy = Object.assign([], { workdayTruncated: true });
  assert.deepEqual(boardTruncation(legacy), {
    reason: "cap-or-fetch-error",
    source: "workdayTruncated",
  });
});

test("board-truncation: the partial note carries no em dash", () => {
  const note = partialBoardsNote([{ reason: "page-cap", source: "truncated" }]);
  assert.match(note, /PARTLY read/);
  assert.ok(!note.includes("—"));
});

test("posting-close: closesAtIso reads a calendar day and rejects impossible dates", () => {
  assert.equal(closesAtIso("2026-11-11"), "2026-11-11");
  assert.equal(closesAtIso("  2024-02-29  "), "2024-02-29");
  assert.equal(closesAtIso("2026-02-31"), "");
  assert.equal(closesAtIso("2026-11-11T23:59:59"), "2026-11-11");
  assert.equal(closesAtIso("2026-11-11T23:30:00-05:00"), "2026-11-12");
  assert.equal(closesAtIso("2026-11-11T10:00:00+0200"), "2026-11-11");
  assert.equal(closesAtIso({ validThrough: "nope", endDate: "2026-12-01" }), "2026-12-01");
  assert.equal(closesAtIso(42), "");
});

test("_http shim: new retry surface keeps the guarded-transport contract", async () => {
  assert.equal(typeof http.fetchResponseWithRetry, "function");
  assert.equal(typeof http.parseRetryAfterMs, "function");
  assert.equal(typeof http.BROWSER_LIKE_USER_AGENT, "string");
  assert.equal(typeof http.MACOS_BROWSER_LIKE_USER_AGENT, "string");

  const challenge = Object.assign(new Error("HTTP 403"), { status: 403, cfMitigated: "challenge" });
  assert.equal(http.isCloudflareChallenge(challenge), true);
  assert.equal(http.isCloudflareChallenge(new Error("x")), false);
  // A challenge is not throttling: not retried even as a 429 or 503.
  assert.equal(http.isRetryableError(Object.assign(challenge, { status: 429 })), false);
  assert.equal(http.isRetryableError(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(
    http.isRetryableError(Object.assign(new Error("x"), { code: "response_too_large" })),
    false
  );

  let calls = 0;
  const ctx = {
    sleep: async () => {},
    fetchResponse: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("HTTP 503"), { status: 503 });
      return new Response("ok", { status: 200 });
    },
  };
  const response = await http.fetchResponseWithRetry(
    ctx,
    "https://example.com/",
    {},
    { retries: 2 }
  );
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 3);

  let challenged = 0;
  await assert.rejects(
    http.fetchResponseWithRetry(
      {
        sleep: async () => {},
        fetchResponse: async () => {
          challenged += 1;
          throw Object.assign(new Error("HTTP 403"), { status: 403, cfMitigated: "challenge" });
        },
      },
      "https://example.com/"
    )
  );
  assert.equal(challenged, 1);
});

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };
const streamSeams = (fetchImpl) => ({
  fetchImpl,
  resolveHost: async () => [PUBLIC_ADDRESS],
  dispatcherFactory: () => ({ close: async () => {} }),
});

function chunkedResponse(chunks, init = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

test("_http shim: resolveDefaultTimeoutMs falls back for unusable values", () => {
  assert.equal(http.resolveDefaultTimeoutMs(undefined), 10_000);
  assert.equal(http.resolveDefaultTimeoutMs(""), 10_000);
  assert.equal(http.resolveDefaultTimeoutMs("abc"), 10_000);
  assert.equal(http.resolveDefaultTimeoutMs("0"), 10_000);
  assert.equal(http.resolveDefaultTimeoutMs("2147483648"), 10_000);
  assert.equal(http.resolveDefaultTimeoutMs("60000"), 60_000);
  assert.equal(http.resolveDefaultTimeoutMs(null, 5_000), 5_000);
});

test("_http shim: fetchTextStream hands the body over in pieces through guardedFetch", async () => {
  const seen = [];
  let requested;
  const result = await http.fetchTextStream(
    "https://www.workable.com/boards/workable.xml",
    {
      ...streamSeams(async (url, init) => {
        requested = { url, redirect: init.redirect };
        return chunkedResponse(["<source>", "<job/>", "</source>"], {
          headers: { "last-modified": "Tue, 24 Nov 2026 00:00:00 GMT" },
        });
      }),
    },
    (text) => {
      seen.push(text);
    }
  );
  assert.equal(seen.join(""), "<source><job/></source>");
  assert.equal(requested.redirect, "error");
  assert.deepEqual(result, {
    bytes: 23,
    complete: true,
    notModified: false,
    lastModified: "Tue, 24 Nov 2026 00:00:00 GMT",
  });
});

test("_http shim: fetchTextStream stops when onText returns false", async () => {
  const result = await http.fetchTextStream(
    "https://www.workable.com/boards/workable.xml",
    streamSeams(async () => chunkedResponse(["a", "b", "c"])),
    () => false
  );
  assert.equal(result.complete, false);
  assert.equal(result.bytes, 1);
});

test("_http shim: fetchTextStream enforces maxBytes on the decoded body", async () => {
  await assert.rejects(
    http.fetchTextStream(
      "https://www.workable.com/boards/workable.xml",
      { ...streamSeams(async () => chunkedResponse(["12345", "67890"])), maxBytes: 8 },
      () => {}
    ),
    (error) => error.code === "response_too_large"
  );
});

test("_http shim: fetchTextStream answers a 304 only when asked to accept it", async () => {
  const notModified = streamSeams(async () => new Response(null, { status: 304 }));
  const accepted = await http.fetchTextStream(
    "https://www.workable.com/boards/workable.xml",
    { ...notModified, acceptNotModified: true },
    () => assert.fail("onText must not run on a 304")
  );
  assert.equal(accepted.notModified, true);
  await assert.rejects(
    http.fetchTextStream("https://www.workable.com/boards/workable.xml", notModified, () => {}),
    (error) => error.status === 304
  );
});

test("_http shim: fetchTextStream keeps status and retry headers on a non-2xx", async () => {
  await assert.rejects(
    http.fetchTextStream(
      "https://www.workable.com/boards/workable.xml",
      streamSeams(
        async () => new Response("busy", { status: 429, headers: { "retry-after": "7" } })
      ),
      () => {}
    ),
    (error) => error.status === 429 && error.retryAfter === "7"
  );
});

test("_http shim: fetchTextStream refuses private addresses and a non-callback", async () => {
  let fetched = false;
  await assert.rejects(
    http.fetchTextStream(
      "https://feed.example/jobs.xml",
      {
        fetchImpl: async () => {
          fetched = true;
          return new Response("x");
        },
        resolveHost: async () => [{ address: "10.0.0.5", family: 4 }],
        dispatcherFactory: () => ({ close: async () => {} }),
      },
      () => {}
    ),
    /blocked/
  );
  assert.equal(fetched, false);
  await assert.rejects(http.fetchTextStream("https://feed.example/", {}), TypeError);
});

test("ats-vendor: known hosts map to provider ids and the long tail to the hostname", () => {
  assert.equal(atsVendorOf("https://boards.greenhouse.io/acme/jobs/1"), "greenhouse");
  assert.equal(atsVendorOf("https://acme.myworkdayjobs.com/en-US/x"), "workday");
  assert.equal(atsVendorOf("https://Careers.Example.com/jobs"), "careers.example.com");
  assert.equal(atsVendorOf("ftp://jobs.example.com"), null);
  assert.equal(atsVendorOf("   "), null);
  assert.equal(atsVendorOf(42), null);
  assert.ok(ATS_HOST_PATTERNS.length >= 16);
});
