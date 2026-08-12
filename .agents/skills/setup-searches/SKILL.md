---
name: setup-searches
description: Build and maintain config/search-sources.yml from candidate targeting — generate a baseline from role buckets, curate enabled sources, add or import individual searches (including pasted board URLs with embedded filters preserved), and tune global filters. Upstream of search-jobs; does not scan.
---

# setup-searches

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## STEP 0 — Preflight

Run `careerrat doctor` and inspect the output.

- If `candidate/targeting.yml` is missing or fails schema: halt. Instruct the user to run `ingest-profile` (`careerrat ingest`) first, then return here.
- If `candidate/profile.yml` is missing or fails schema: same halt.
- If `targeting.yml` exists but `role_buckets` is empty or absent: halt. The baseline generator will produce only a stub with no role-specific searches — a search catalog with no titles is useless. Tell the user to populate `role_buckets` in `candidate/targeting.yml` (or re-run `ingest-profile`) before continuing.
- If both files pass and `role_buckets` is non-empty: proceed to STEP 1.

## STEP 1 — Read targeting and profile

Read `candidate/targeting.yml` and report back the detected values that will drive generation:

- `role_buckets` — names, titles per bucket, priority flags
- `keep_signals`, `cut_signals` — these become `title_filter.positive` / `title_filter.negative`; note if `cut_signals` is empty (hardcoded Intern/Junior fallback will apply per Foundation C)
- `excluded_companies` — will be noted but does not affect search-source generation

Read `candidate/profile.yml` and report:

- `candidate.domain` — drives board/aggregator selection (e.g. "software engineering" → tech aggregator + job board; other domains → domain-appropriate boards, or no aggregator if none configured). Echo back detected domain so the user can correct before generation.
- `compensation.minimum_base` — this is the value used for `salary_filter.min`. **Do not read or surface `current_base`** — it is private and must not appear in any output.
- `location.remote`, `location.home`, `location.relocation` — these feed `location_filter`

Echo a summary to the user: detected domain, board catalog that will be used, `minimum_base` as the salary floor, and number of titles across all role buckets. Ask the user to correct anything before proceeding.

## STEP 2 — Generate baseline

```
careerrat searches --from-targeting
```

Idempotency: a search is added only when no existing entry matches provider + query (case-insensitive). Existing manual entries are preserved. If the user runs this on an already-populated config, confirm that only new titles will be appended and nothing will be overwritten.

If the command emits warnings (empty `role_buckets`, no aggregator found for domain, missing schema field): surface them verbatim to the user.

Note the aggregator entry behavior: if `profile.candidate.domain` maps to a known aggregator, one RSS source is generated for it. If no domain-appropriate aggregator is configured, the generator omits the aggregator entry entirely rather than emitting a nonsensical one. If the user is in a non-tech domain and sees an unexpected tech aggregator entry, flag it in STEP 5.

## STEP 3 — Curate sources

Perform any curation the user requested (or all of (a)–(d) on initial setup):

**(a) Add keyword searches** — one per title or per explicit user request:

```
careerrat searches --add-query "<title or keyword>" [--label "<l>"] [--provider <provider>]
```

> **Default provider:** if `--provider` is omitted, the CLI defaults to `HiringCafe`. For non-tech roles or when the user's `candidate.domain` does not map to HiringCafe, always pass `--provider <provider>` explicitly so the entry is not silently pinned to the wrong source.

**(b) Import a pasted board URL** — when the user pastes a URL from any job board:

```
careerrat searches --add-url "<full URL>" [--label "<label>"]
```

For hiring.cafe URLs: the embedded `searchState` and query-string filters are parsed and written into the `searchState` block verbatim. Do not strip, normalize, or drop query params.
For `wellfound.com` URLs: routed to provider `Wellfound`, `source_type: browser` (Wellfound is a SPA — agent must use a browser tool for liveness checks and browsing).
For `jobs.lever.co` or `api.lever.co` URLs: routed to provider `Lever`, `source_type: ats`; the company slug is derived from the URL path automatically.
For other hosts: the entry becomes `source_type: browser`.

Do not assume HiringCafe is the only importable provider. Any board URL a user pastes can be imported — label it clearly.

**(b.1) Authenticated browser sources (LinkedIn / Indeed / Glassdoor)**

When the user pastes a search or results URL from LinkedIn, Indeed, or Glassdoor, `--add-url` automatically creates an **authenticated browser source**: `source_type: browser`, `auth: true`, bound to its `platform` (e.g. `linkedin`), and **`enabled: false` by default**. It is off until the user explicitly opts in — `search-jobs` skips any authenticated source that is not both enabled and consented.

Two switches are required before `search-jobs` will run such a source:

1. **Enable the source** — the normal enable path (`careerrat searches --enable <index or label>`).
2. **Grant automation consent and enable the capability for that platform** — the user must read the platform's terms of service, then:

```
careerrat automation consent <platform> --write
careerrat automation enable authenticated_search <platform> --write
careerrat automation status
```

No credentials are stored. The logged-in session is held by the session browser (extension preferred; Playwright persistent profile as fallback) — see AGENTS.md → Browser Automation Contract and `docs/BROWSER.md`. Do not proceed with the platform if `mayRun({ capability: "authenticated_search", platform })` returns `allowed: false`; surface the `reasons` and stop.

**(c) Enable / disable entries:**

```
careerrat searches --enable <index or label>
careerrat searches --disable <index or label>
```

Use `careerrat searches` to get current indices before enabling/disabling by index.

**(d) Surface disabled-by-default entries.** Some providers (e.g. LinkedIn) are in the source catalog but disabled by default due to auth brittleness or rate limits. List them with `careerrat searches` and tell the user which entries are `enabled: false` so they can make an informed choice.

## STEP 4 — Tune global filters

Review the generated filters and adjust as needed:

- `title_filter.positive` — must include all titles from `role_buckets`. If a bucket title is missing, add it.
- `title_filter.negative` — must reflect `targeting.cut_signals`. If `cut_signals` is populated, these values override the hardcoded `['Intern', 'Junior']` defaults. If `cut_signals` is empty, the Intern/Junior defaults apply — confirm with the user this is correct for their seniority posture.
- `salary_filter.min` — must be set to `compensation.minimum_base` from `profile.yml`. Verify this is present and matches.
- `location_filter.allow` / `location_filter.block` — must cover the candidate's `location.remote` posture and any excluded regions from `profile.yml`.
- `recency.mode` and `recency.safetyMinutes` — each search entry carries a `recency` block. The three valid modes are:
  - `since-last-run` (default) — uses `recency.lastRunAt` watermark; set `recency.safetyMinutes` (default 30) to overlap slightly and avoid missing results at the boundary.
  - `fixed-hours` — always looks back a fixed window (`recency.windowHours`); use when a source does not support watermark-based deltas.
  - `manual` — no automatic date filter; the agent applies no recency constraint (use for sources with their own pagination).
  
  To tune: edit the `recency` block directly in `config/search-sources.yml` for the relevant entry. Example for a 7-day lookback on a fixed-hours source:
  ```yaml
  recency:
    mode: fixed-hours
    windowHours: 168
    safetyMinutes: 60
  ```
  After editing, run `careerrat doctor` to confirm the schema validates.

Use `careerrat searches` to review the current state before finalizing.

## STEP 5 — Review aggregator and board catalog

Verify the auto-selected aggregator and board set is appropriate for the candidate's domain:

- If the candidate is **not** in the domain that matches the aggregator (e.g. a trucking candidate with a tech RSS feed), disable or replace the aggregator entry manually via `careerrat searches --disable <index>` and add domain-appropriate boards via `--add-url` or `--add-query --provider <provider>`.
- If the user mentions a board or aggregator they always want included: add it now, and apply the gate write-back below.

**Auto-seeded portals (review these):**
- **Wellfound** (`wellfound.com`) — tech-domain candidates only; one entry per primary role title, `source_type: browser`. If the candidate is not in a tech-adjacent domain, disable these entries.
- **Lever** (`jobs.lever.co`) — domain-neutral ATS; one entry per company in `targeting.tracked_companies`, `source_type: ats`. Verify each company slug matches the company's actual Lever subdomain — a wrong slug returns an empty result set (HTTP 200, no postings), not a 404.

**STEP 5a — Optional: domain-gated starter menu from the board registry (initial setup only)**

On initial setup, offer the user a one-time starter menu from the `docs/SOURCES.md`
Curated Board Registry. This step is optional — skip it if the user declines or if
`config/search-sources.yml` already has more than the auto-generated baseline entries.

1. Read the `## Curated Board Registry` table in `docs/SOURCES.md`.
2. Filter to rows where Domain tag includes `general` OR matches `profile.candidate.domain`
   (e.g. a candidate with domain "software engineering" sees `general` + `tech/software` +
   `tech/AI` + `remote` entries; a candidate with domain "finance" sees only `general` entries
   and gets a note that no domain-specific vetted boards exist yet for that domain).
3. Exclude rows already in the dedup set (any board whose root domain already appears in
   `config/search-sources.yml`).
4. Exclude rows with Status `planned` that have no provider implementation — these cannot be
   added via the CLI yet. Note them to the user as "coming soon" if they look relevant.
5. Present the filtered list as a pick-list:

   ```
   Board registry matches for domain "<candidate.domain>":

   [1] HiringCafe (general / aggregator / high confidence) — already configured, skipped
   [2] Wellfound (tech/software / aggregator / high confidence) — already configured, skipped
   [3] Remote Vibe Coding Jobs (tech/software, remote / aggregator / high confidence) — already configured, skipped
   [4] Example Niche Board (your domain / niche-board / high confidence) — NEW
   [5] Example Specialist Aggregator (your domain / aggregator / high confidence) — NEW
   [6] Example Field Board (your domain / niche-board / borderline) — NEW (borderline: weak company attribution)

   Pick all, a subset by number, or none to skip.
   ```

6. Wait for explicit confirmation. Do not add anything automatically. If the user picks
   boards, add each confirmed one via:

   ```
   careerrat searches --add-url "<url>" --label "<label>"
   ```

   For niche boards with no canonical search URL yet, use `--add-query "<role family keyword>" --provider <provider>` if a provider key exists, or note that the board needs a URL once the provider is implemented and skip it.

7. If the candidate's domain has no matching registry boards beyond the general aggregators
   (which are already auto-generated), say so explicitly and do not prompt for picks.

This is a convenience starter menu — not a mandate. The auto-generated baseline from STEP 2
already includes the field-neutral defaults for the candidate's domain. This step adds
domain-specific niche boards the candidate might want.

**Known limitation — board-preference persistence:** there is no
`candidate/search-preferences.yml` yet, so there is no canonical config path that
makes per-candidate board preferences (e.g. "always use this board", "never use
LinkedIn") survive a future `--from-targeting` regeneration. Preferences written as
comments in `config/search-sources.yml` are silently lost the next time the
candidate runs `--from-targeting`. Until that file ships, explicitly warn the user
of this limitation after writing any persistent board preference, and prefer
encoding the intent as `targeting.yml` keep/cut signals (which DO survive
regeneration) where possible.

## STEP 6 — Gate write-back

If the user stated a new preference during this session that should survive future regenerations:

- "Never show me LinkedIn" or "exclude provider X" — confirm-first (consequential: affects every future scan). Once confirmed: (1) disable the entry via `careerrat searches --disable <index>`; (2) add a clearly marked comment at the top of `config/search-sources.yml` in the form `# PERSISTENT: exclude provider=<X> — re-disable after --from-targeting regeneration`; (3) warn the user that this preference will need to be re-applied after any `--from-targeting` run until `candidate/search-preferences.yml` exists.
- "Always use [board]" — confirm-first; add the entry, then add a comment `# PERSISTENT: always include <label> (<provider>)` in `config/search-sources.yml`. Same regeneration-loss caveat applies.
- Unambiguous, low-blast-radius preferences (one extra board the user just pasted) — write-and-report: add the entry via `--add-url` or `--add-query`, then echo `Added to config/search-sources.yml: <label> (<provider>)`.

Do not write board preferences to `candidate/targeting.yml` or `candidate/profile.yml` — those files govern targeting and identity, not source mechanics.

## STEP 7 — Verify

```
careerrat searches
```

Confirm for every entry:

- `provider` is set
- `label` is human-readable
- `target` / `query` / `url` / `rssUrl` is present and non-empty
- `enabled` is set intentionally (not accidentally true or false)

Then run:

```
careerrat doctor
```

Confirm `config/search-sources.yml` passes `config/search-sources.schema.json`. If the CLI refused to write an invalid config, no errors should appear — but verify explicitly. If the doctor flags errors, fix them before handing off.

**URL spot-check:** For at least one `url-query` or `rss` entry, open the `target` or `rssUrl` value in a browser (or use WebFetch) and confirm it returns job results rather than a 404, redirect loop, or empty feed. If an entry resolves to an error page, disable it (`careerrat searches --disable <index>`) and report to the user before handing off.

## Final handoff

When `config/search-sources.yml` is ready, continue the post-onboarding discovery
pipeline in this exact order:

```
setup-searches -> research-boards -> discover-companies -> search-jobs
```

This skill only produces the baseline source config. It does not discover new boards,
discover companies, scan, dedupe, gate, or score. Hand off next to `research-boards`
unless the user explicitly says to skip board discovery. After `research-boards`, run
`discover-companies` before the first `search-jobs` sweep so employer ATS boards are
wired into `config/sourced-scan.json`.

End every run by saying the next agent task plainly: `research-boards` next, or
`careerrat next --skip research-boards --write` if the user explicitly skipped board
discovery.

---

## Intent → Command

| User intent | Command |
|---|---|
| Generate baseline from targeting | `careerrat searches --from-targeting` |
| See current searches | `careerrat searches` |
| See current searches (JSON) | `careerrat searches --json` — emits `{ exists: bool, searches: [ { index, provider, label, target, enabled, recency? } ] }` |
| Add a keyword search | `careerrat searches --add-query "<query>" [--label "<label>"] [--provider <p>]` |
| Import a pasted board URL | `careerrat searches --add-url "<url>" [--label "<label>"]` |
| Enable a search | `careerrat searches --enable <index or label>` |
| Disable a search | `careerrat searches --disable <index or label>` |
| Health check | `careerrat doctor` |
| Bail to onboarding | `careerrat ingest` |

## Rules

- **Never fabricate sources or filters.** Only add entries the user explicitly requested or that `--from-targeting` derives from real targeting data.
- **Preserve embedded filters** when importing a pasted URL. The `searchState` block must be written exactly as parsed from the URL — do not normalize, simplify, or drop query params.
- **Salary floor is `compensation.minimum_base`.** Never read or surface `current_base` — it is private and must not appear in any output or log.
- **Writes `config/`; reads `candidate/`.** Never write to `candidate/`; never commit candidate files.
- **Domain-general.** No board name, aggregator, or provider is hardcoded as canonical in this skill's prose. Board selection follows `profile.candidate.domain`. The skill must execute correctly for a trucking, nursing, or finance candidate.
- **Do not scan or gate here.** `search-jobs` owns discovery and intake. `evaluate-job` is the fit gate.
