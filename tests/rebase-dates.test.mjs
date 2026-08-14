import assert from "node:assert/strict";
import test from "node:test";

import { rebaseTrackerData, shiftTreeByMs } from "../src/core/tracker/rebase-dates.mjs";

test("demo rebase keeps embedded prose dates aligned with structured timestamps", () => {
  const tracker = {
    meta: { demoAnchor: "2026-06-26" },
    communications: [
      {
        lastInboundAt: "2026-06-24",
        summary:
          "Offer extended Jun 24, expires June 30, start 2026-07-07. Reply Thursday April 17.",
      },
    ],
  };

  const result = rebaseTrackerData(tracker, "2026-08-14");

  assert.equal(result.deltaDays, 49);
  assert.equal(tracker.meta.demoAnchor, "2026-08-14");
  assert.equal(tracker.communications[0].lastInboundAt, "2026-08-12");
  assert.equal(
    tracker.communications[0].summary,
    "Offer extended Aug 12, expires August 18, start 2026-08-25. Reply Thursday June 5."
  );
});

test("activity rebase accepts the demo anchor for month/day prose", () => {
  const activity = [
    {
      at: "2026-05-24T10:00:00.000Z",
      summary: "Recruiter screen May 24; decision expected 2026-06-02.",
    },
  ];

  shiftTreeByMs(activity, 49 * 86_400_000, "2026-06-26");

  assert.equal(activity[0].at, "2026-07-12T10:00:00.000Z");
  assert.equal(activity[0].summary, "Recruiter screen Jul 12; decision expected 2026-07-21.");
});
