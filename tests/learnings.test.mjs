import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataRel } from "../src/core/paths/workspace.mjs";
import {
  appendLearning,
  computeAppend,
  countEntries,
  findCompLeak,
  formatEntry,
  LEARNINGS_SUBDIR,
  learningsAbsPath,
  learningsHeader,
  learningsRelPath,
  listLearnings,
  readLearnings,
  resolveFamilySlug,
  slugifyFamily,
} from "../src/core/profile/learnings.mjs";

// ── slug + path ──────────────────────────────────────────────────────────────

test("slugifyFamily lowercases, collapses non-alnum, trims, and is idempotent", () => {
  assert.equal(slugifyFamily("Applied AI"), "applied-ai");
  assert.equal(slugifyFamily("  Forward/Deployed  "), "forward-deployed");
  assert.equal(slugifyFamily("applied-ai"), "applied-ai"); // idempotent
  assert.equal(slugifyFamily(""), "uncategorized");
  assert.equal(slugifyFamily("***"), "uncategorized");
});

test("resolveFamilySlug uses role_families patterns, then role_buckets, then neutral slug", () => {
  const targeting = {
    role_families: [{ name: "Applied AI", patterns: ["forward deployed", "applied ai"] }],
  };
  assert.equal(resolveFamilySlug("Forward Deployed Engineer", targeting), "applied-ai");
  // defined families but no match → "other"
  assert.equal(resolveFamilySlug("Random Title", targeting), "other");
  // no targeting → neutral slug derived from the title
  assert.equal(resolveFamilySlug("Platform Engineer", undefined), "platform-engineer");
});

test("learningsRelPath / learningsAbsPath slugify and root-join", () => {
  assert.equal(learningsRelPath("Applied AI"), `${LEARNINGS_SUBDIR}/applied-ai.md`);
  assert.equal(
    learningsAbsPath("Applied AI", "/repo"),
    `/repo/${dataRel(`${LEARNINGS_SUBDIR}/applied-ai.md`)}`
  );
});

// ── pure formatting ──────────────────────────────────────────────────────────

test("learningsHeader names the family and the current_base invariant", () => {
  const h = learningsHeader("Applied AI");
  assert.match(h, /# Learnings · applied-ai/);
  assert.match(h, /current_base/);
});

test("formatEntry produces a dated heading, trims the body, ends with one newline", () => {
  const entry = formatEntry({
    date: "2026-06-13",
    title: "  Bullets land  ",
    body: "\n- a\n- b\n\n",
  });
  assert.equal(entry, "## 2026-06-13 — Bullets land\n\n- a\n- b\n");
});

test("countEntries counts entry headings, ignoring the file title", () => {
  assert.equal(
    countEntries("# Learnings · x\n\n## 2026-01-01 — a\n\nbody\n\n## 2026-01-02 — b\n"),
    2
  );
  assert.equal(countEntries(""), 0);
  assert.equal(countEntries("# title only\n"), 0);
});

test("findCompLeak catches current_base and common phrasings, passes clean text", () => {
  assert.ok(findCompLeak("they asked my current_base"));
  assert.ok(findCompLeak("my current base is high"));
  assert.ok(findCompLeak("disclosed current salary"));
  assert.ok(findCompLeak("I currently make above band"));
  assert.equal(findCompLeak("target_base and minimum_base are fine to record"), null);
});

// ── computeAppend (pure) ─────────────────────────────────────────────────────

test("computeAppend on an empty file prepends the header then the entry", () => {
  const r = computeAppend({
    family: "applied-ai",
    date: "2026-06-13",
    title: "T",
    body: "- a",
    currentText: null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.match(r.nextText, /^# Learnings · applied-ai/);
  assert.match(r.nextText, /## 2026-06-13 — T\n\n- a\n$/);
});

test("computeAppend on an existing file appends with one blank line and no header", () => {
  const current = `# Learnings · applied-ai\n\n## 2026-06-12 — old\n\n- prior\n`;
  const r = computeAppend({
    family: "applied-ai",
    date: "2026-06-13",
    title: "new",
    body: "- fresh",
    currentText: current,
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(countEntries(r.nextText), 2);
  assert.match(r.nextText, /- prior\n\n## 2026-06-13 — new\n\n- fresh\n$/);
  // exactly one top-level title remains
  assert.equal((r.nextText.match(/^# /gm) || []).length, 1);
});

test("computeAppend rejects a missing/invalid date, empty title, empty body", () => {
  assert.equal(computeAppend({ family: "x", date: "", title: "t", body: "b" }).ok, false);
  assert.equal(computeAppend({ family: "x", date: "not-a-date", title: "t", body: "b" }).ok, false);
  assert.equal(
    computeAppend({ family: "x", date: "2026-06-13", title: "  ", body: "b" }).ok,
    false
  );
  assert.equal(computeAppend({ family: "x", date: "2026-06-13", title: "t", body: " " }).ok, false);
});

test("computeAppend refuses placeholder residue", () => {
  const r = computeAppend({
    family: "x",
    date: "2026-06-13",
    title: "ok",
    body: "- reached out to [Company]",
  });
  assert.equal(r.ok, false);
  assert.ok(r.lint);
  assert.match(r.error, /placeholder/i);
});

test("computeAppend refuses a private comp leak", () => {
  const r = computeAppend({
    family: "x",
    date: "2026-06-13",
    title: "comp",
    body: "- they asked my current_base",
  });
  assert.equal(r.ok, false);
  assert.ok(r.leak);
  assert.match(r.error, /current_base/);
});

// ── fs round-trip ────────────────────────────────────────────────────────────

test("appendLearning + readLearnings + listLearnings round-trip in a tmp root", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-learn-"));
  try {
    // No file yet → readLearnings null, listLearnings empty.
    assert.equal(readLearnings("applied-ai", { root }), null);
    assert.deepEqual(listLearnings({ root }), []);

    const w1 = appendLearning({
      family: "Applied AI",
      date: "2026-06-13",
      title: "first",
      body: "- a",
      root,
    });
    assert.equal(w1.ok, true);
    assert.equal(w1.created, true);
    assert.equal(w1.relPath, dataRel(`${LEARNINGS_SUBDIR}/applied-ai.md`));
    assert.ok(existsSync(join(root, w1.relPath)));

    const w2 = appendLearning({
      family: "applied-ai",
      date: "2026-06-14",
      title: "second",
      body: "- b",
      root,
    });
    assert.equal(w2.ok, true);
    assert.equal(w2.created, false);

    const text = readLearnings("applied-ai", { root });
    assert.equal(countEntries(text), 2);
    assert.match(text, /## 2026-06-13 — first/);
    assert.match(text, /## 2026-06-14 — second/);

    const list = listLearnings({ root });
    assert.equal(list.length, 1);
    assert.equal(list[0].family, "applied-ai");
    assert.equal(list[0].entries, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendLearning refuses placeholder/comp-leak entries and writes nothing new", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-learn-"));
  try {
    const bad = appendLearning({
      family: "x",
      date: "2026-06-13",
      title: "t",
      body: "- [Role] placeholder",
      root,
    });
    assert.equal(bad.ok, false);
    assert.equal(existsSync(join(root, LEARNINGS_SUBDIR, "x.md")), false);

    const leak = appendLearning({
      family: "x",
      date: "2026-06-13",
      title: "t",
      body: "- my current_base is private",
      root,
    });
    assert.equal(leak.ok, false);
    assert.equal(existsSync(join(root, LEARNINGS_SUBDIR, "x.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listLearnings ignores non-markdown files", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-learn-"));
  try {
    mkdirSync(join(root, LEARNINGS_SUBDIR), { recursive: true });
    writeFileSync(
      join(root, LEARNINGS_SUBDIR, "fde.md"),
      "# Learnings · fde\n\n## 2026-06-13 — a\n\n- x\n"
    );
    writeFileSync(join(root, LEARNINGS_SUBDIR, "notes.txt"), "ignore me");
    const list = listLearnings({ root });
    assert.equal(list.length, 1);
    assert.equal(list[0].family, "fde");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
