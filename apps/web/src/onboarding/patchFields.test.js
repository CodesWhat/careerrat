// apps/web/src/onboarding/patchFields.test.js
// vitest coverage for flattenPatchLeaves, the pure helper ConfirmPill uses to
// render WHAT a candidate_patch confirm block is about to save.

import { describe, expect, it } from "vitest";
import { flattenPatchLeaves } from "./patchFields.js";

describe("flattenPatchLeaves", () => {
  it("flattens a single-level nested patch into humanized leaf path/value pairs", () => {
    expect(
      flattenPatchLeaves({ candidate: { full_name: "Ada Lovelace", email: "ada@example.com" } })
    ).toEqual([
      { path: ["candidate", "full_name"], label: "Full name", value: "Ada Lovelace" },
      { path: ["candidate", "email"], label: "Email", value: "ada@example.com" },
    ]);
  });

  it("walks arbitrarily deep nesting, keeping the full path but labeling only the leaf key", () => {
    expect(flattenPatchLeaves({ location: { home: { city: "Austin" } } })).toEqual([
      { path: ["location", "home", "city"], label: "City", value: "Austin" },
    ]);
  });

  it("treats arrays as leaves (comma-joined), never recursing element-wise", () => {
    expect(flattenPatchLeaves({ tracked_companies: ["Stripe", "Anthropic"] })).toEqual([
      { path: ["tracked_companies"], label: "Tracked companies", value: "Stripe, Anthropic" },
    ]);
  });

  it("renders booleans as Yes/No", () => {
    expect(flattenPatchLeaves({ requires_sponsorship: false })).toEqual([
      { path: ["requires_sponsorship"], label: "Requires sponsorship", value: "No" },
    ]);
  });

  it("renders null/undefined leaves as an empty string rather than 'null'/'undefined'", () => {
    expect(flattenPatchLeaves({ phone: null })).toEqual([
      { path: ["phone"], label: "Phone", value: "" },
    ]);
  });

  it("returns an empty array for an empty or non-object patch", () => {
    expect(flattenPatchLeaves({})).toEqual([]);
    expect(flattenPatchLeaves(null)).toEqual([]);
    expect(flattenPatchLeaves(undefined)).toEqual([]);
    expect(flattenPatchLeaves("not an object")).toEqual([]);
  });

  // Bug 1 — an array of objects (e.g. targeting.role_buckets, each
  // {name, priority, titles, notes}) used to join via String() and produce
  // "[object Object]" per element. Never should, for any object shape.
  describe("array-of-objects leaves never render '[object Object]'", () => {
    it("joins a representative field (name/title/label) when every element has one", () => {
      expect(
        flattenPatchLeaves({
          targeting: {
            role_buckets: [
              { name: "Backend engineering", priority: 1, titles: ["SWE"], notes: "x" },
              { name: "Platform", priority: 2, titles: ["Platform eng"], notes: "y" },
            ],
          },
        })
      ).toEqual([
        {
          path: ["targeting", "role_buckets"],
          label: "Role buckets",
          value: "Backend engineering, Platform",
        },
      ]);
    });

    it("falls back to a count noun'd from the leaf's own key when no element has a representative field", () => {
      const result = flattenPatchLeaves({
        targeting: { role_buckets: [{ priority: 1 }, { priority: 2 }] },
      });
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("2 role buckets");
      expect(result[0].value).not.toContain("[object Object]");
    });

    it("singularizes the count fallback's noun for a single element (n === 1)", () => {
      const result = flattenPatchLeaves({
        targeting: { role_buckets: [{ priority: 1 }] },
      });
      expect(result[0].value).toBe("1 role bucket");
      expect(result[0].value).not.toBe("1 role buckets");
    });

    it("keeps the plural noun for n === 2", () => {
      const result = flattenPatchLeaves({
        targeting: { role_buckets: [{ priority: 1 }, { priority: 2 }] },
      });
      expect(result[0].value).toBe("2 role buckets");
    });

    it("singularizes an -ies plural correctly for n === 1", () => {
      const result = flattenPatchLeaves({
        tracked_companies: [{ headcount: 500 }],
      });
      expect(result[0].value).toBe("1 tracked company");
    });

    it("never emits '[object Object]' for a nested plain-object array element under any key", () => {
      const result = flattenPatchLeaves({
        evidence: { items: [{ nested: { deeper: "value" } }] },
      });
      expect(result[0].value).not.toContain("[object Object]");
    });
  });

  // Bug 2 — declined_fields is internal bookkeeping (the app recording that
  // a candidate declined to answer something), not a user answer, and must
  // never surface in the leaf list. Suppressed at any depth.
  describe("suppresses internal bookkeeping paths", () => {
    it("drops a declined_fields subtree entirely, leaving an empty leaf list", () => {
      expect(
        flattenPatchLeaves({
          declined_fields: { resume: { declined_at: "2026-08-10T00:00:00-04:00" } },
        })
      ).toEqual([]);
    });

    it("drops declined_fields while still surfacing sibling leaves", () => {
      const result = flattenPatchLeaves({
        declined_fields: { resume: { declined_at: "2026-08-10T00:00:00-04:00" } },
        candidate: { full_name: "Ada Lovelace" },
      });
      expect(result).toEqual([
        { path: ["candidate", "full_name"], label: "Full name", value: "Ada Lovelace" },
      ]);
    });
  });

  describe("formats ISO date/timestamp strings humanely instead of raw ISO 8601", () => {
    it("renders a date-time-with-offset string as a human date", () => {
      expect(flattenPatchLeaves({ available_at: "2026-08-10T00:00:00-04:00" })).toEqual([
        { path: ["available_at"], label: "Available at", value: "Aug 10, 2026" },
      ]);
    });

    it("renders a bare date string as a human date", () => {
      expect(flattenPatchLeaves({ start_date: "2026-08-10" })).toEqual([
        { path: ["start_date"], label: "Start date", value: "Aug 10, 2026" },
      ]);
    });

    it("leaves a non-date string untouched", () => {
      expect(flattenPatchLeaves({ email: "ada@example.com" })).toEqual([
        { path: ["email"], label: "Email", value: "ada@example.com" },
      ]);
    });

    // Bug 4 — the shape-only regex used to accept any digit-shaped string,
    // so an impossible calendar date (bad month, bad day-of-month, Feb 30,
    // Feb 29 outside a leap year) got formatted into a plausible-looking but
    // fabricated date instead of being rejected. `formatIsoDate` falls back
    // to the raw value on a `null` (see formatLeafValue's `|| value`), so
    // "left untouched" is the same fallback every other non-date string
    // already gets — no new behavior for callers to special-case.
    describe("rejects impossible calendar dates instead of fabricating them", () => {
      it("leaves a bad month untouched", () => {
        expect(flattenPatchLeaves({ start_date: "2026-13-01" })).toEqual([
          { path: ["start_date"], label: "Start date", value: "2026-13-01" },
        ]);
      });

      it("leaves an out-of-range day untouched", () => {
        expect(flattenPatchLeaves({ start_date: "2026-01-45" })).toEqual([
          { path: ["start_date"], label: "Start date", value: "2026-01-45" },
        ]);
      });

      it("leaves Feb 30 untouched rather than rolling it into March", () => {
        expect(flattenPatchLeaves({ start_date: "2026-02-30" })).toEqual([
          { path: ["start_date"], label: "Start date", value: "2026-02-30" },
        ]);
      });

      it("leaves Feb 29 untouched in a non-leap year", () => {
        expect(flattenPatchLeaves({ start_date: "2026-02-29" })).toEqual([
          { path: ["start_date"], label: "Start date", value: "2026-02-29" },
        ]);
      });

      it("still formats Feb 29 in a leap year", () => {
        expect(flattenPatchLeaves({ start_date: "2024-02-29" })).toEqual([
          { path: ["start_date"], label: "Start date", value: "Feb 29, 2024" },
        ]);
      });

      it("formats a valid year-end date without shifting a day", () => {
        expect(flattenPatchLeaves({ start_date: "2026-12-31" })).toEqual([
          { path: ["start_date"], label: "Start date", value: "Dec 31, 2026" },
        ]);
      });
    });
  });

  // Bug 3 — a single very long leaf value shouldn't be able to blow out
  // the pill's width on its own.
  describe("truncates long individual values", () => {
    it("truncates a long string value with an ellipsis", () => {
      const longValue = "x".repeat(80);
      const result = flattenPatchLeaves({ notes: longValue });
      expect(result[0].value.length).toBeLessThan(longValue.length);
      expect(result[0].value.endsWith("…")).toBe(true);
    });

    it("leaves a short value untouched", () => {
      expect(flattenPatchLeaves({ notes: "short note" })).toEqual([
        { path: ["notes"], label: "Notes", value: "short note" },
      ]);
    });

    // Bug 5 — truncating by UTF-16 code unit (bare `.slice()`) can cut an
    // astral character in half and emit a lone surrogate, which renders as a
    // replacement glyph. A lone surrogate is unpaired: a high surrogate
    // (\uD800-\uDBFF) with no low surrogate right after it, or a low
    // surrogate with no high surrogate right before it.
    const LONE_SURROGATE_RE =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    it("truncates a long run of astral emoji on whole code points, never emitting a lone surrogate", () => {
      const longValue = "\u{1F600}".repeat(60); // 60 code points, each a 2-unit surrogate pair
      const result = flattenPatchLeaves({ notes: longValue });
      expect(result[0].value.endsWith("…")).toBe(true);
      expect(LONE_SURROGATE_RE.test(result[0].value)).toBe(false);
    });

    it("truncates a long run of a multi-code-point grapheme (flag emoji) without splitting a surrogate pair", () => {
      const longValue = "\u{1F1FA}\u{1F1F8}".repeat(30); // flag = 2 code points / 4 UTF-16 units each
      const result = flattenPatchLeaves({ notes: longValue });
      expect(result[0].value.endsWith("…")).toBe(true);
      expect(LONE_SURROGATE_RE.test(result[0].value)).toBe(false);
    });
  });
});
