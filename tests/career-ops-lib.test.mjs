import assert from "node:assert/strict";
import { test } from "node:test";

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
