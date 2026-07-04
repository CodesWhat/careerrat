---
phase: 01
reviewed: 2026-07-04T18:26:42Z
depth: deep
files_reviewed: 4
files_reviewed_list:
  - tests/decomposition-map.test.mjs
  - .planning/architecture/skill-decomposition.yml
  - .planning/architecture/discover-companies-target-contract.md
  - .planning/architecture/runtime-routing-policy.md
findings:
  critical: 0
  warning: 3
  info: 0
  total: 3
status: issues
---

# Phase 01: Code Review Report

**Reviewed:** 2026-07-04T18:26:42Z
**Depth:** deep
**Files Reviewed:** 4
**Status:** issues

## Narrative Findings (AI reviewer)

## Summary

Reviewed the Phase 01 decomposition artifacts and the Node drift guard against the locked D-01 through D-14 decisions, AGENTS.md contracts, and referenced runtime owners. The architecture docs are broadly aligned, but the guard gives false confidence: it can pass while required schema, path/privacy boundaries, section structure, and D-02 ordering drift.

## Warnings

### WR-01: WARNING - Owner path validation accepts private or non-source paths

**File:** `tests/decomposition-map.test.mjs:103`

**Issue:** The owner check accepts any non-empty `owner` string that either starts with `planned:` or exists under `path.join(repoRoot, ownerRef)`. It does not reject `candidate/`, `workspace/`, generated files, absolute/path-traversal-like references, or other private compatibility data. Because Phase 01 is supposed to map owners to source/config modules and preserve the domain-neutral/privacy boundary, a future artifact could point an owner at `candidate/profile.yml` or `workspace/tracker.json` and still pass.

**Fix:**

```js
function assertRepoOwnerPath(ownerRef) {
  if (ownerRef.startsWith("planned:")) return;
  assert.ok(!path.isAbsolute(ownerRef), `owner must be repo-relative: ${ownerRef}`);
  const resolved = path.resolve(repoRoot, ownerRef);
  assert.ok(
    resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`),
    `owner must stay inside the repo: ${ownerRef}`
  );
  assert.ok(
    !/^(candidate|workspace|\.internal)\//.test(ownerRef),
    `owner must not point at private/generated workspace data: ${ownerRef}`
  );
  assert.ok(existsSync(resolved), `owner reference must exist: ${ownerRef}`);
}
```

### WR-02: WARNING - Inventory schema guard only checks buckets, not required metadata

**File:** `tests/decomposition-map.test.mjs:90`

**Issue:** The inventory test verifies each high-priority skill has the five bucket arrays, then only validates nested `owner` paths. It never asserts the required `source`, `requirements`, `notes`, `owner_type`, `step`, or `decisions` shapes that Plan 01-01 required. A skill entry can lose its skill-contract source, ARCH requirement mapping, owner type, or D-01 through D-14 row-level decision mapping and the guard will still pass as long as the bucket keys remain arrays.

**Fix:**

```js
const allowedOwnerTypes = new Set(Object.keys(decomposition.owner_types));
const allowedDecisions = new Set(Object.keys(decomposition.source_decisions));

for (const skill of requiredSkills) {
  const entry = decomposition.skills[skill];
  assert.equal(typeof entry.source, "string", `${skill}.source is required`);
  assertRepoOwnerPath(entry.source);
  assert.ok(Array.isArray(entry.requirements), `${skill}.requirements must be an array`);
  assert.ok(Array.isArray(entry.notes), `${skill}.notes must be an array`);

  for (const bucket of requiredBuckets) {
    for (const [index, row] of entry[bucket].entries()) {
      assert.equal(typeof row.step, "string", `${skill}.${bucket}[${index}].step is required`);
      assert.equal(typeof row.owner, "string", `${skill}.${bucket}[${index}].owner is required`);
      assert.ok(allowedOwnerTypes.has(row.owner_type), `${skill}.${bucket}[${index}] owner_type is invalid`);
      assert.ok(Array.isArray(row.decisions), `${skill}.${bucket}[${index}].decisions must be an array`);
      for (const id of row.decisions) assert.ok(allowedDecisions.has(id), `unknown decision ${id}`);
    }
  }
}
```

### WR-03: WARNING - Contract and routing assertions are broad substrings, so D-02/order and section drift can pass

**File:** `tests/decomposition-map.test.mjs:112`

**Issue:** The contract guard checks only that required phrases appear somewhere in the whole document. It does not assert the exact section headings from Plans 01-02/01-03, the lane order inside `## Cheapest-First Sourcing Cascade`, or required fields such as `next_refresh_reason`. The D-01 through D-14 check is also just "ID appears anywhere" across all architecture text. Separately, `sectionBetween()` returns through EOF when an end heading is missing, so the UI/CLI/Agents assertions can pass from later examples or owner lists after a heading is removed.

**Fix:** Add heading and ordered-section helpers that fail closed.

```js
function requiredSection(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  assert.notEqual(start, -1, `expected section ${startHeading}`);
  if (!endHeading) return text.slice(start);
  const end = text.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(end, -1, `expected section ${endHeading} after ${startHeading}`);
  return text.slice(start, end);
}

function assertOrdered(text, phrases, label) {
  let previous = -1;
  for (const phrase of phrases) {
    const next = text.indexOf(phrase);
    assert.ok(next > previous, `${label} must contain ${phrase} in order`);
    previous = next;
  }
}

const cascade = requiredSection(
  discoverCompaniesText,
  "## Cheapest-First Sourcing Cascade",
  "## Scanner And Extractor Cascade"
);
assertOrdered(cascade, [
  "existing DB/source config",
  "cached company board resolution",
  "direct ATS scanner/local scraper",
  "free or cheap job API",
  "targeted crawler/extractor",
  "AI web search/extract",
  "full skill runtime",
], "D-02 cascade");
assertContains(discoverCompaniesText, "next_refresh_reason", artifactPaths.discoverCompanies);
```

---

_Reviewed: 2026-07-04T18:26:42Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: deep_
