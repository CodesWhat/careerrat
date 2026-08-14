# Phase 9: Public Company Intelligence and Scanner Cascade - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-07-06T00:56:12Z
**Phase:** 9-Public Company Intelligence and Scanner Cascade
**Areas discussed:** Public/private data boundary, Sync-home consent and scrub rules, Unsupported careers-page outcomes, Scanner cascade fallback behavior

---

## Public/private data boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Public metadata only | Sync reusable public company and careers-board metadata that saves AI calls. | yes |
| Include current job postings | Sync individual job postings as public intelligence too. | |
| You decide | Let downstream agents choose the publication boundary. | |

**User's choice:** Public metadata only.
**Notes:** User said "nothing personal" and clarified the useful shared layer is likely companies and their job boards, not jobs themselves at this point.

| Option | Description | Selected |
|--------|-------------|----------|
| Same local SQLite DB, separate public_* tables | Keep one DB but make the public sync boundary testable at table level. | yes |
| Separate local public-intel database file | Stronger physical separation with more runtime and migration complexity. | |
| You decide | Planner chooses the storage boundary. | |

**User's choice:** Same local SQLite DB, separate `public_*` tables.
**Notes:** Sync-home may only read from public tables.

---

## Sync-home consent and scrub rules

| Option | Description | Selected |
|--------|-------------|----------|
| One onboarding toggle, default on | Plain "help improve CareerRat" consent during setup. | yes |
| Setup section with details, default on | More transparent but heavier onboarding. | |
| Settings-only control, default on | Low friction but weaker consent visibility. | |

**User's choice:** One onboarding toggle, default on.
**Notes:** Copy should be clear that only public company/job-board metadata is shared and no private candidate/search data leaves the machine.

| Option | Description | Selected |
|--------|-------------|----------|
| Block the publish and surface a local error | Fail closed on forbidden private fields. | yes |
| Drop unsafe fields and publish the rest | More forgiving but can hide serializer bugs. | |
| Keep local only and queue for debug review | Conservative but risks stale public intel. | |

**User's choice:** Block the publish and surface a local error.
**Notes:** Scrub tests and runtime should prevent questionable data from publishing.

---

## Unsupported careers-page outcomes

| Option | Description | Selected |
|--------|-------------|----------|
| Best-effort scrape now, metadata only for public sync | Locally extract enough to help discovery, but sync only metadata/confidence. | yes |
| Scrape jobs and persist local sourced roles immediately | Higher utility but greater noise risk. | |
| Cache board metadata only; no job extraction yet | Safest but weakens scanner-cascade value. | |

**User's choice:** Best-effort scrape now, metadata only for public sync.
**Notes:** User asked why a reachable page could not just be scraped. Decision: it should be scraped when public and reachable, but public sync still excludes individual jobs.

---

## Scanner cascade fallback behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Only when confidence is ambiguous or conflict exists | Auto-cache clear public metadata; review conflicts/ambiguity only. | yes |
| Review every unsupported/custom page result | Safer but noisy. | |
| Never ask review; cache low-confidence records with flags | Lower friction but quality can rot. | |

**User's choice:** Only when confidence is ambiguous or conflict exists.
**Notes:** User clarified that if the scanner did not find anything useful, it should just move on rather than ask for review.

| Option | Description | Selected |
|--------|-------------|----------|
| Only after deterministic/scraper paths found text but structure is ambiguous | Spend AI only when there is real ambiguous page content. | yes |
| Try AI whenever deterministic scraping finds nothing | More coverage, but spends AI on low-signal pages. | |
| Never use AI for page extraction in this phase | Cheapest, but weaker than the planned cascade. | |

**User's choice:** Only after deterministic/scraper paths found text but structure is ambiguous.
**Notes:** Empty, blocked, robots-disallowed, or clearly useless pages should not spend model calls.

---

## the agent's Discretion

- Exact migration/table shapes beyond the `public_*` table boundary.
- Exact local route names and API envelope shapes.
- Exact crawler/scraper limits, confidence thresholds, and metadata fields, as long as public sync stays private-data-free.
- Exact UI placement/details around the onboarding toggle, as long as the consent is present during onboarding and default on.
- Exact test filenames and implementation sequencing.

## Deferred Ideas

- Publishing or syncing individual job postings from scraped careers pages.
