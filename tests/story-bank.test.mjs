import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStorySection } from "../src/core/interview/packet.mjs";
import {
  COMMON_COMPETENCIES,
  computeStoryWrite,
  coverageGaps,
  loadStories,
  matchStories,
  parseStories,
  renderStorySection,
  STAR_FIELDS,
  slugifyStoryId,
  summarizeStories,
  validateStories,
  writeStories,
} from "../src/core/interview/story-bank.mjs";

// A minimal evidence bank to trace against.
const EVIDENCE = [
  { id: "project-001", claim: "Cut dispatch latency." },
  { id: "project-002", claim: "Led a migration." },
];

function goodStory(overrides = {}) {
  return {
    id: "dispatch-latency",
    title: "Cut dispatch latency 40%",
    competencies: ["measurable-impact", "ownership"],
    role_signals: ["operations efficiency", "process improvement"],
    situation: "Orders were queuing.",
    task: "I owned the latency.",
    action: "I reworked the routing queue.",
    result: "Latency dropped 40%.",
    reflection: "I learned to profile first.",
    evidence_ids: ["project-001"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------

test("slugifyStoryId normalises and is idempotent", () => {
  assert.equal(slugifyStoryId("Cut Dispatch Latency 40%"), "cut-dispatch-latency-40");
  assert.equal(slugifyStoryId("cut-dispatch-latency-40"), "cut-dispatch-latency-40");
  assert.equal(slugifyStoryId(""), "story");
  assert.equal(slugifyStoryId("   "), "story");
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

test("parseStories reads stories[] and tolerates absence", () => {
  assert.deepEqual(parseStories("stories: []").stories, []);
  assert.deepEqual(parseStories("").stories, []);
  assert.deepEqual(parseStories("other: 1").stories, []);
  const { stories } = parseStories("stories:\n  - id: a\n    title: A\n");
  assert.equal(stories.length, 1);
  assert.equal(stories[0].id, "a");
});

// ---------------------------------------------------------------------------
// validateStories — the firewall
// ---------------------------------------------------------------------------

test("validateStories accepts a well-formed, traced story", () => {
  const v = validateStories([goodStory()], EVIDENCE);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("validateStories requires every STAR+R field", () => {
  for (const f of STAR_FIELDS) {
    const s = goodStory();
    delete s[f];
    const v = validateStories([s], EVIDENCE);
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.message.includes(f)),
      `expected error for missing ${f}`
    );
  }
});

test("validateStories refuses a story that cites no evidence", () => {
  const v = validateStories([goodStory({ evidence_ids: [] })], EVIDENCE);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("cites no evidence_ids")));
});

test("validateStories refuses a dangling evidence id when evidence is loaded", () => {
  const v = validateStories([goodStory({ evidence_ids: ["project-999"] })], EVIDENCE);
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some(
      (e) => e.message.includes("project-999") && e.message.includes("not in evidence.yml")
    )
  );
});

test("validateStories hard-fails a fabricated evidence id even when the evidence bank is empty", () => {
  // An empty evidence.yml can never back ANY cited id — that's the honesty
  // firewall the docstring promises, not a reason to skip the check. A story
  // that cites "whatever" against a zero-claim bank must fail, with a message
  // that names the missing evidence bank rather than silently passing.
  const v = validateStories([goodStory({ evidence_ids: ["whatever"] })], []);
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some((e) => e.message.includes("whatever") && e.message.includes("no claims")),
    JSON.stringify(v.errors)
  );
  // Zero ids is still refused too (unrelated rule, unaffected by this fix).
  assert.equal(validateStories([goodStory({ evidence_ids: [] })], []).ok, false);
});

test("validateStories still refuses a dangling id when the evidence bank is non-empty but doesn't contain it", () => {
  const v = validateStories([goodStory({ evidence_ids: ["project-999"] })], EVIDENCE);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("project-999")));
});

test("validateStories flags duplicate ids", () => {
  const v = validateStories([goodStory(), goodStory()], EVIDENCE);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("duplicate story id")));
});

test("validateStories refuses placeholder residue in the narrative", () => {
  const v = validateStories(
    [goodStory({ situation: "Worked at [Company] on the thing." })],
    EVIDENCE
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("placeholder")));
});

test("validateStories refuses a private comp leak in the narrative", () => {
  const v = validateStories(
    [goodStory({ result: "I shared that current_base was high." })],
    EVIDENCE
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("private comp input")));
});

// ---------------------------------------------------------------------------
// matchStories
// ---------------------------------------------------------------------------

test("matchStories ranks by signal (x2) then competency (x1)", () => {
  const stories = [
    goodStory({ id: "a", role_signals: ["process improvement"], competencies: [] }),
    goodStory({
      id: "b",
      role_signals: ["process improvement", "operations efficiency"],
      competencies: ["ownership"],
    }),
  ];
  const ranked = matchStories({
    stories,
    jobSignals: ["process improvement", "operations efficiency"],
    competencies: ["ownership"],
  });
  assert.equal(ranked[0].story.id, "b"); // 2 signals*2 + 1 comp = 5
  assert.equal(ranked[0].score, 5);
  assert.equal(ranked[1].story.id, "a"); // 1 signal*2 = 2
});

test("matchStories with no query surfaces the whole bank; with an unmatched query returns []", () => {
  const stories = [goodStory({ id: "a" }), goodStory({ id: "b" })];
  assert.equal(matchStories({ stories }).length, 2);
  assert.equal(matchStories({ stories, jobSignals: ["nothing-overlaps-xyz"] }).length, 0);
});

test("matchStories respects limit", () => {
  const stories = Array.from({ length: 10 }, (_, i) => goodStory({ id: `s${i}` }));
  assert.equal(matchStories({ stories, limit: 3 }).length, 3);
});

// ---------------------------------------------------------------------------
// coverageGaps
// ---------------------------------------------------------------------------

test("coverageGaps returns competencies no story covers", () => {
  const stories = [goodStory({ competencies: ["ownership", "measurable-impact"] })];
  const gaps = coverageGaps({ stories });
  assert.ok(!gaps.includes("ownership"));
  assert.ok(!gaps.includes("measurable-impact"));
  assert.ok(gaps.includes("leadership"));
  assert.equal(gaps.length, COMMON_COMPETENCIES.length - 2);
});

test("coverageGaps accepts a custom competency set and matches by overlap", () => {
  const stories = [goodStory({ competencies: ["cross-functional leadership"] })];
  // "leadership" overlaps "cross-functional leadership" → covered.
  assert.deepEqual(coverageGaps({ stories, competencies: ["leadership", "budgeting"] }), [
    "budgeting",
  ]);
});

// ---------------------------------------------------------------------------
// renderStorySection
// ---------------------------------------------------------------------------

test("renderStorySection notes an empty match set", () => {
  assert.match(renderStorySection([]), /No prepared stories/);
});

test("renderStorySection renders STAR+R, preserves case, and accepts wrappers or bare stories", () => {
  const bare = renderStorySection([goodStory({ situation: "Orders Were Queuing." })]);
  assert.match(bare, /\*\*Situation:\*\* Orders Were Queuing\./); // case preserved
  assert.match(bare, /\*\*Reflection:\*\*/);
  assert.match(bare, /_Evidence: project-001_/);
  // wrapper form (as returned by matchStories)
  const wrapped = renderStorySection([{ story: goodStory(), score: 4 }]);
  assert.match(wrapped, /Cut dispatch latency 40%/);
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test("summarizeStories projects the list fields safely", () => {
  const [s] = summarizeStories([{ id: "a", title: "A" }]);
  assert.deepEqual(s, {
    id: "a",
    title: "A",
    competencies: [],
    role_signals: [],
    evidence_ids: [],
  });
});

// ---------------------------------------------------------------------------
// computeStoryWrite — guarded upsert
// ---------------------------------------------------------------------------

test("computeStoryWrite adds a new story", () => {
  const plan = computeStoryWrite({ newStory: goodStory(), currentStories: [], evidence: EVIDENCE });
  assert.equal(plan.ok, true);
  assert.equal(plan.replaced, false);
  assert.equal(plan.nextStories.length, 1);
});

test("computeStoryWrite upserts by id (replace, not duplicate)", () => {
  const current = [goodStory()];
  const plan = computeStoryWrite({
    newStory: goodStory({ title: "New title" }),
    currentStories: current,
    evidence: EVIDENCE,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.replaced, true);
  assert.equal(plan.nextStories.length, 1);
  assert.equal(plan.nextStories[0].title, "New title");
});

test("computeStoryWrite derives an id from the title when absent", () => {
  const s = goodStory();
  delete s.id;
  const plan = computeStoryWrite({ newStory: s, currentStories: [], evidence: EVIDENCE });
  assert.equal(plan.ok, true);
  assert.equal(plan.story.id, "cut-dispatch-latency-40");
});

test("computeStoryWrite refuses a story that fails the firewall", () => {
  const plan = computeStoryWrite({
    newStory: goodStory({ evidence_ids: ["project-999"] }),
    currentStories: [],
    evidence: EVIDENCE,
  });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /not in evidence.yml/);
});

// ---------------------------------------------------------------------------
// fs round-trip
// ---------------------------------------------------------------------------

test("writeStories + loadStories round-trips through candidate/stories.yml", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-stories-"));
  try {
    const stories = [goodStory(), goodStory({ id: "migration", evidence_ids: ["project-002"] })];
    const res = writeStories({ stories, root: dir });
    assert.equal(res.count, 2);

    const loaded = loadStories({ root: dir });
    assert.equal(loaded.exists, true);
    assert.equal(loaded.stories.length, 2);
    assert.equal(loaded.stories[0].id, "dispatch-latency");
    assert.deepEqual(loaded.stories[0].evidence_ids, ["project-001"]);
    // Loaded bank still validates against evidence (no corruption on round-trip).
    assert.equal(validateStories(loaded.stories, EVIDENCE).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadStories reports a missing bank without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-stories-empty-"));
  try {
    const loaded = loadStories({ root: dir });
    assert.equal(loaded.exists, false);
    assert.deepEqual(loaded.stories, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// packet integration
// ---------------------------------------------------------------------------

test("buildStorySection omits the section for an empty bank and renders for a non-empty one", () => {
  assert.equal(buildStorySection({ jobSignals: ["x"], stories: [] }), "");
  const out = buildStorySection({ jobSignals: ["process improvement"], stories: [goodStory()] });
  assert.match(out, /Cut dispatch latency 40%/);
  assert.match(out, /\*\*Reflection:\*\*/);
});
