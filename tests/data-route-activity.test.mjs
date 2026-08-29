import assert from "node:assert/strict";
import { test } from "node:test";
import { readActivityEvents } from "../src/cli/data-route.mjs";

test("activity reads bind a positive limit before rows are loaded or parsed", () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        all(...params) {
          calls.push({ sql, params });
          return [
            { data: JSON.stringify({ id: "newest", at: "2026-08-27T17:00:00.000Z" }) },
            { data: JSON.stringify({ id: "next", at: "2026-08-27T16:00:00.000Z" }) },
          ];
        },
      };
    },
  };

  assert.deepEqual(
    readActivityEvents(db, { limit: 2 }).map((event) => event.id),
    ["newest", "next"]
  );
  assert.match(calls[0].sql, /ORDER BY at DESC, rowid DESC LIMIT \?/);
  assert.deepEqual(calls[0].params, [2]);
});

test("activity reads preserve the unbounded query when no positive limit is supplied", () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        all(...params) {
          calls.push({ sql, params });
          return [];
        },
      };
    },
  };

  readActivityEvents(db, { limit: null });
  assert.doesNotMatch(calls[0].sql, /LIMIT/);
  assert.deepEqual(calls[0].params, []);
});
