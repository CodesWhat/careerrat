import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataRel } from "../src/core/paths/workspace.mjs";
import {
  computeResearchWrite,
  isStale,
  listResearch,
  parseResearchFrontmatter,
  RESEARCH_SUBDIR,
  readCompanyResearch,
  researchAbsPath,
  researchRelPath,
  slugifyCompany,
  splitFrontmatter,
  writeResearch,
} from "../src/core/research/research-store.mjs";

// Build a valid company-research document. `over` lets a test tweak frontmatter or body.
function doc({ fm = {}, body } = {}) {
  const front = {
    type: "company-research",
    company: "Globex Logistics",
    slug: "globex-logistics",
    fetchedAt: "2026-06-13",
    staleness_days: 14,
    ...fm,
  };
  const sources =
    front.sources === undefined
      ? `sources:\n  - url: "https://example.com/a"\n    title: "Globex opens third hub"\n    confidence: high\n`
      : `sources: ${JSON.stringify(front.sources)}\n`;
  delete front.sources;
  const lines = Object.entries(front)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const bodyText =
    body ??
    `## Overview
Globex runs regional freight. [source: "Globex opens third hub" (https://example.com/a), fetched 2026-06-13, confidence: high]

## Candidate Angle
Fits your background. [AGENT-INFERRED from: https://example.com/a — candidate to verify]
`;
  return `---\n${lines}\n${sources}---\n\n${bodyText}`;
}

// ── slug + paths ──────────────────────────────────────────────────────────────

test("slugifyCompany lowercases, collapses non-alnum, trims, idempotent", () => {
  assert.equal(slugifyCompany("Globex Logistics, Inc."), "globex-logistics-inc");
  assert.equal(slugifyCompany("  Acme/Freight  "), "acme-freight");
  assert.equal(slugifyCompany("globex-logistics"), "globex-logistics");
  assert.equal(slugifyCompany(""), "unknown");
});

test("researchRelPath / researchAbsPath slugify and root-join", () => {
  assert.equal(researchRelPath("Globex Logistics"), `${RESEARCH_SUBDIR}/globex-logistics.md`);
  assert.equal(
    researchAbsPath("Globex Logistics", "/repo"),
    `/repo/${dataRel(`${RESEARCH_SUBDIR}/globex-logistics.md`)}`
  );
});

// ── frontmatter parsing ───────────────────────────────────────────────────────

test("splitFrontmatter separates frontmatter object from body", () => {
  const { frontmatter, body } = splitFrontmatter(doc());
  assert.equal(frontmatter.type, "company-research");
  assert.equal(frontmatter.company, "Globex Logistics");
  assert.match(body, /## Overview/);
});

test("splitFrontmatter returns null frontmatter when absent", () => {
  const { frontmatter, body } = splitFrontmatter("no frontmatter here");
  assert.equal(frontmatter, null);
  assert.equal(body, "no frontmatter here");
  assert.deepEqual(parseResearchFrontmatter("no frontmatter"), {});
});

// ── isStale (pure date math) ──────────────────────────────────────────────────

test("isStale compares fetchedAt against the window, treating unknown as stale", () => {
  const now = Date.parse("2026-06-20");
  assert.equal(isStale("2026-06-13", 14, now), false); // 7d < 14d
  assert.equal(isStale("2026-05-01", 30, now), true); // 50d > 30d
  assert.equal(isStale(undefined, 14, now), true);
  assert.equal(isStale("not-a-date", 14, now), true);
});

// ── computeResearchWrite (pure) ───────────────────────────────────────────────

test("computeResearchWrite accepts a valid cited artifact and reports staleness", () => {
  const r = computeResearchWrite({ text: doc(), now: Date.parse("2026-06-20") });
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
  assert.equal(r.frontmatter.company, "Globex Logistics");
  assert.match(r.nextText, /\n$/);
});

test("computeResearchWrite accepts colon-bearing citation markers and markdown links", () => {
  const body = `## Overview
Fact one. [source: "Title" (https://x.com/a), fetched 2026-06-13, confidence: med]
Fact two via [Glassdoor](https://glassdoor.com/x).
Disagreement noted. [CONFLICT: A says 1200 (https://x.com/a, high); B says 800 (https://y.com/b, med). candidate to verify]
Angle. [AGENT-INFERRED from: https://x.com/a, https://y.com/b — candidate to verify]
`;
  assert.equal(computeResearchWrite({ text: doc({ body }) }).ok, true);
});

test("computeResearchWrite refuses a bare [AGENT-INFERRED] (no attribution) as placeholder residue", () => {
  const r = computeResearchWrite({ text: doc({ body: "## Overview\nAngle. [AGENT-INFERRED]\n" }) });
  assert.equal(r.ok, false);
  assert.ok(r.lint);
  assert.match(r.error, /placeholder/i);
});

test("computeResearchWrite refuses missing frontmatter / bad type / missing fetchedAt / no subject", () => {
  assert.match(computeResearchWrite({ text: "## Body only" }).error, /frontmatter/i);
  assert.match(
    computeResearchWrite({ text: doc({ fm: { type: "bogus" } }) }).error,
    /type must be/i
  );
  assert.match(computeResearchWrite({ text: doc({ fm: { fetchedAt: "" } }) }).error, /fetchedAt/i);
  assert.match(
    computeResearchWrite({ text: doc({ fm: { company: "", role: "" } }) }).error,
    /company or a role/i
  );
});

test("computeResearchWrite enforces the citation-hygiene rule for sourced types", () => {
  const r = computeResearchWrite({ text: doc({ fm: { sources: [] } }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /sources\[\] must list at least one/i);
});

test("computeResearchWrite allows a board-discovery-log without sources", () => {
  const text = `---
type: board-discovery-log
company: "n/a"
fetchedAt: "2026-06-13"
---

## Boards reviewed
- example-board (added)
`;
  assert.equal(computeResearchWrite({ text }).ok, true);
});

test("computeResearchWrite refuses a private current_base leak anywhere in the doc", () => {
  const r = computeResearchWrite({
    text: doc({ body: "## Overview\nVs your current_base, market is higher.\n" }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.leak);
  assert.match(r.error, /current_base/);
});

test("computeResearchWrite does NOT false-positive on legitimate market/HQ comp prose", () => {
  const body = `## Overview
Their current base of operations is Austin. [source: "About" (https://x.com/a), fetched 2026-06-13, confidence: high]
Engineers currently make $200k here per Glassdoor. [source: "Salaries" (https://x.com/b), fetched 2026-06-13, confidence: med]
`;
  assert.equal(
    computeResearchWrite({
      text: doc({
        fm: { type: "comp-benchmark", role: "Staff Engineer", company: "Globex" },
        body,
      }),
    }).ok,
    true
  );
});

// ── fs round-trip ─────────────────────────────────────────────────────────────

test("writeResearch + readResearch + readCompanyResearch + listResearch round-trip in a tmp root", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-research-"));
  try {
    assert.equal(readCompanyResearch("Globex Logistics", { root }), null);
    assert.deepEqual(listResearch({ root }), []);

    const w = writeResearch({
      stem: "Globex Logistics",
      text: doc(),
      root,
      now: Date.parse("2026-06-20"),
    });
    assert.equal(w.ok, true);
    assert.equal(w.relPath, dataRel(`${RESEARCH_SUBDIR}/globex-logistics.md`));
    assert.ok(existsSync(join(root, w.relPath)));

    const hit = readCompanyResearch("globex logistics", { root, now: Date.parse("2026-06-20") });
    assert.ok(hit);
    assert.equal(hit.stale, false);
    assert.equal(hit.frontmatter.company, "Globex Logistics");

    // upsert: a second write to the same stem overwrites in place (one file per subject).
    writeResearch({
      stem: "Globex Logistics",
      text: doc({
        body: '## Overview\nUpdated. [source: "x" (https://x.com/a), fetched 2026-06-13, confidence: high]\n',
      }),
      root,
    });
    const list = listResearch({ root });
    assert.equal(list.length, 1);
    assert.equal(list[0].company, "Globex Logistics");
    assert.equal(list[0].sources, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeResearch refuses to persist an invalid artifact (writes nothing)", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-research-"));
  try {
    const bad = writeResearch({ stem: "Globex", text: doc({ fm: { sources: [] } }), root });
    assert.equal(bad.ok, false);
    assert.equal(existsSync(join(root, RESEARCH_SUBDIR, "globex.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listResearch flags stale artifacts and ignores non-markdown files", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-research-"));
  try {
    mkdirSync(join(root, RESEARCH_SUBDIR), { recursive: true });
    writeFileSync(
      join(root, RESEARCH_SUBDIR, "old-co.md"),
      doc({ fm: { company: "Old Co", fetchedAt: "2026-01-01" } })
    );
    writeFileSync(join(root, RESEARCH_SUBDIR, "notes.txt"), "ignore me");
    const list = listResearch({ root, now: Date.parse("2026-06-20") });
    assert.equal(list.length, 1);
    assert.equal(list[0].company, "Old Co");
    assert.equal(list[0].stale, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
