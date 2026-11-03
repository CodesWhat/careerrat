// A saved job with no "# Job Description" heading used to parse to an empty body,
// so the gate scored the title alone and the hard-cut signals never saw the posting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSavedJob } from "../src/core/evaluate/gate.mjs";

test("without a Job Description heading, the text after the frontmatter is the posting", () => {
  const job = parseSavedJob(
    "---\ncompany: Example\nrole: Lead\n---\n\nWe need someone on call weekends.\n\nMust relocate.\n"
  );
  assert.match(job.body, /on call weekends/);
  assert.match(job.body, /Must relocate/);
});

test("the Gate Notes section is not part of the posting when the heading is missing", () => {
  const job = parseSavedJob(
    "---\ncompany: Example\n---\n\nPosting text here.\n\n# Gate Notes\nChecked by hand.\n"
  );
  assert.match(job.body, /Posting text here/);
  assert.doesNotMatch(job.body, /Checked by hand/);
  assert.match(job.gateNotes, /Checked by hand/);
});

test("a heading, when present, still wins", () => {
  const job = parseSavedJob(
    "---\ncompany: Example\n---\n\nIntro.\n\n# Job Description\nThe real text.\n"
  );
  assert.equal(job.body, "The real text.");
});
