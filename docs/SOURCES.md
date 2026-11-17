# Search Sources

CareerRat should pull from as many practical sources as it can without turning
scanner matches into apply decisions. Sources feed intake; `evaluate-job` still
owns the body-read gate.

## Source Types

- URL-query sources: build deterministic search URLs from config and capture
  results with Playwright when the page is browser-rendered.
- RSS/Atom sources: poll feeds, store item metadata, then open each posting for
  body capture.
- ATS sources: use public or reverse-discovered company job APIs where stable.
- Aggregators: collect broad matches, preserve their source labels, and dedupe
  against canonical job URLs.
- In the legacy browser workspace, login-backed sources use saved browser sessions and participate in normal
  searches once enabled. When a source is added or first used and login is
  needed, CareerRat asks “Do you want to log into LinkedIn so I can use it?” (or
  names the actual site). Yes opens that exact saved search in the visible app
  browser. No skips it and keeps searching the other sources. Each result's full
  description is read in that same session so a login-only posting is captured
  locally instead of being fetched again over public HTTP.

## AI Open-Web Discovery

AI search broadens the built-in public job-board source layer across specialist
boards, employer career pages, and useful aggregators. It is domain-neutral;
every search follows the same candidate location, compensation, eligibility,
and fit rules.

Discovery and verification are separate stages. When AI finds a specific role
and employer but automated fetching cannot read the full description, CareerRat
preserves the visible title, company, URL, location, compensation, date, and
factual search evidence as an **AI · unverified** lead. It does not guess the
missing job description and does not present the role as confirmed. **Evaluate**
later verifies liveness, uses the public or supervised browser path to capture
the full posting, and runs the body-read gate before tailoring or application
work. Known expired roles, hard-filter violations, duplicates, and results with
no specific role or employer are still dropped.

## Targeted Built-In Sources

Source setup selects applicable built-in public job-board and ATS adapters from
the candidate's saved roles and location. Every adapter validates its host and
URL shape, reads structured job-posting data, rejects expired postings, and
normalizes title, employer, location, compensation, date, and the full visible
description. `research-boards` and `discover-companies` add specialist boards
and employer career pages that are useful for the candidate's actual search.

## Public Company Intelligence

Public company intelligence helps CareerRat learn public company and careers-board
metadata without mixing it with candidate-specific search state. It is stored in
dedicated `public_*` SQLite tables and can be prepared for sync-home only after
scrub validation passes.

Public records may include:

- company key, name, and domain
- careers URL and public board URL
- ATS/provider hint
- confidence, freshness, provenance, and conflicts
- scanner status and review reason

Public records must not include:

- resumes, profile data, applications, sourced rows, tracker ids, or private notes
- compensation floors, fit scores, gate output, or candidate targeting
- local paths, raw prompts, model text, page bodies, or individual job postings
- private source config such as search queries or tracked company rows

The scanner cascade runs in this order:

1. Supported ATS APIs and known provider links.
2. Deterministic public-page extraction for visible careers/job-board links.
3. Metadata-only no-result handling for empty, blocked, login-gated, and useless
   pages.
4. Bounded AI fallback only for ambiguous reachable public text.
5. Review queue for ambiguous or conflicting metadata.

The review queue is intentionally quiet. Clean misses are recorded locally and do
not ask the user anything. `Use supported ATS` is the only review action that can
cross into source config, and only after deterministic validation proves a
supported provider. `Keep public metadata`, `Refresh scan`, `Suppress review`,
and `Escalate to agent` change public-intel review state only; escalation is
explicit metadata and does not silently start chat.

## HiringCafe

HiringCafe keeps filters inside the `searchState` query parameter. CareerRat
should build that URL directly from a search string and optional `searchState`
filters instead of clicking through the UI to configure searches.

Rules:

- Preserve arbitrary filters from config or a pasted full HiringCafe URL.
- Default generated searches to `sortBy: "date"` unless a source URL/config
  explicitly says otherwise.
- Derive the recency window from `lastRunAt` when available.
- Add a small safety margin to the URL fetch window.
- Store `recency.postFilterAfter` and exact-filter captured rows after
  Playwright extraction, because HiringCafe's URL filter is a coarse window.

The initial implementation lives in `src/core/providers/hiringcafe.mjs`.

## Remote Vibe Coding Jobs

Remote Vibe Coding Jobs is useful as an AI-native remote aggregator. It exposes:

- search URLs shaped like `https://remotevibecodingjobs.com/?q=<query>`
- an RSS feed at `https://remotevibecodingjobs.com/feed.xml`
- tech, culture, level, location, and salary browsing paths
- visible source labels such as Jobicy, LinkedIn, Greenhouse, Ashby, RemoteOK,
  Google Jobs, Working Nomads, Lever, and manual listings

Use it as both:

- a direct query source for AI-assisted developer roles
- a source-discovery hint for which upstream boards and ATS adapters are worth
  prioritizing

## How to add a source provider

CareerRat vendors the public-network provider contract from Career Ops commit
`ffb49be1f394041840c31c23a5d3a3347854340e`. The canonical inventory is
`src/core/providers/provider-parity.mjs`; inspect it with
`careerrat searches --providers` or `careerrat searches --providers --json`.

To add one of those providers to a candidate workspace:

- Paste a recognized board URL with `careerrat searches --add-url "<url>"`. Known
  hosts are inferred and become deterministic ATS sources automatically.
- Add a broad provider with `careerrat searches --add-provider "<id>" --query
  "<role or keyword>"`.
- Add a branded/custom-domain board whose adapter is known with `careerrat
  searches --add-provider "<id>" --url "<url>"`, or a company board with
  `careerrat companies --add "<name>" --url "<url>" --provider "<id>" --write`.

Adding a new adapter to CareerRat itself requires a parity-manifest entry, the
provider module, upstream/offline conformance fixtures, CareerRat wrapper tests,
URL inference where possible, full-JD hydration coverage, and documentation.

## Curated Board Registry

A domain-tagged menu of the board/aggregator providers CareerRat ships support for
(`implemented`) or has on the roadmap (`planned`). Skills read this table to offer a filtered
starter menu — it is NOT a universal set of defaults. The `general` tag means suitable for all
domains; domain-specific tags (e.g. `tech/software`, `tech/AI`, `remote`) indicate narrower scope.

**Field-neutral only.** This file ships and is published, so it lists provider infrastructure
ONLY — never one user's discovered boards. The registry currently leans tech/software/AI because
that is what has been built so far; provider support for other domains (healthcare, finance,
trades, logistics, etc.) gets added here as it ships. Boards you discover via `research-boards`
are candidate-specific and persist to your own gitignored `.careerrat/config/search-sources.yml` (or the existing legacy
`config/search-sources.yml`) — they are
never written here.

| Board | Domain tag(s) | Type | Confidence | Status | Notes |
|---|---|---|---|---|---|
| HiringCafe | general | aggregator | high | implemented | `src/core/providers/hiringcafe.mjs`; DOM extractor in `capture-search-sources.mjs`; field-neutral shipped default |
| LinkedIn | general | aggregator | high | implemented | Saved browser source with a point-of-use Yes/No login handoff; participates in normal searches once enabled |
| Indeed | general | aggregator | high | implemented | Saved browser source with provider-specific result extraction, point-of-use login handoff, and session JD capture. The official Indeed MCP connector is used by the search-jobs skill only when it is already connected in the session (beta, Claude connectors only); it never reads the person's Indeed résumé without saying so first, and no scraper is used |
| Glassdoor | general | aggregator | high | implemented | Saved browser source with provider-specific result extraction, point-of-use login handoff, and session JD capture |
| Google Jobs | general | aggregator | high | planned | structured-data aggregator; field-neutral; no provider impl yet |
| Wellfound | tech/software | aggregator | high | implemented | `src/core/providers/wellfound.mjs`; SPA browser source; tech-domain only |
| Remote Vibe Coding Jobs | tech/software, remote | aggregator | high | implemented | URL builder in `source-url.mjs`; RSS via `src/core/providers/rss.mjs`; AI-native remote aggregator |
| Ashby | general | ATS | high | implemented | Career Ops deterministic adapter; company-level ATS API |
| Greenhouse | general | ATS | high | implemented | Career Ops deterministic adapter; company-level ATS API |
| Lever | general | ATS | high | implemented | `src/core/providers/lever.mjs`; JSON API in `capture-search-sources.mjs`; company-level ATS API |
| Workable | general | ATS | high | implemented | Career Ops deterministic adapter; company-level ATS API |
| SmartRecruiters | general | ATS | high | implemented | Career Ops deterministic adapter; company-level ATS API |
| Recruitee | general | ATS | high | implemented | Career Ops deterministic adapter; company-level public API |
| Workday | general | ATS | high | implemented | Career Ops deterministic adapter with bounded pagination |
| RemoteOK | remote | niche-board | high | implemented | public board-wide API |
| Jobicy | remote | niche-board | high | implemented | public board API |
| Working Nomads | remote | niche-board | high | implemented | public board-wide API |
| We Work Remotely | remote | niche-board | high | implemented | public RSS adapter |
| Remotive | remote | niche-board | high | implemented | public board-wide API |
| Himalayas | remote | niche-board | high | implemented | public board-wide JSON API; seeded for every domain |
| Arbeitnow | general | niche-board | high | implemented | public board-wide JSON API; seeded as the baseline source |
| The Muse | general | niche-board | high | implemented | public JSON API; paged, so add it by hand (`--add-provider themuse --query "<title>"`) rather than seeding it |
| Hacker News: Who is hiring | tech/software | niche-board | high | implemented | monthly thread read through the public Algolia API; seeded for tech domains |
| USAJobs | general | official-api | high | implemented | `src/core/providers/usajobs.mjs`; US federal postings; free key in `USAJOBS_API_KEY` and `USAJOBS_USER_AGENT` (your email) |
| Adzuna | general | aggregator | high | implemented | `src/core/providers/adzuna.mjs`; one country per source; paid `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` (25 trial calls, then a paid plan); returns a snippet, so the body is marked partial |
| OysterLink | hospitality | niche-board | high | implemented | public hospitality search and structured job-detail adapter |
| Hcareers | hospitality | niche-board | high | implemented | public hospitality search and structured job-detail adapter |
| Hospitality Online | hospitality | niche-board | high | implemented | public hospitality search and structured job-detail adapter |
| iHireHospitality | hospitality | niche-board | high | implemented | public hospitality search and structured job-detail adapter |

### Registry legend

- **Domain tag(s):** `general` = all domains; `tech/software` = software engineering domain only; `tech/AI` = AI/ML/agent roles; `hospitality` = hospitality, food-service, and beverage work; `remote` = remote-posture candidates across domains. Combine tags with commas for entries that span multiple.
- **Type:** `official-api` = a government or vendor API that needs a free key; `aggregator` = collects from many sources; `ATS` = company-level ATS API adapter; `niche-board` = curated domain-specific board; `RSS` = feed-only.
- **Confidence:** `high` = real dated listings, stable URL, identifiable companies; `medium` = unvetted but reputable; `borderline` = real but with noted quality caveats.
- **Status:** `implemented` = provider code ships with CareerRat; `planned` = on roadmap, not yet implemented.

> **This shipped registry lists only field-neutral provider infrastructure.** Boards you
> discover via `research-boards` are candidate-specific (they match your domain and role
> families), so they are NEVER written here — they persist to your own gitignored
> `.careerrat/config/search-sources.yml` and your `.careerrat/workspace/research/` log. Keeping this file neutral is
> a hard invariant (enforced by `tests/release-safety.test.mjs`): a shipped, published doc must
> not carry one user's discovered boards.

---

## ATS Sweep (your own slug list)

The sweep scans employer boards you did not track, looking for roles that match your targeting.
It reads a list you provide at `config/ats-sweep-slugs.json` or `config/ats-sweep-slugs.txt` in the
workspace. Without that file nothing runs.

```text
# config/ats-sweep-slugs.txt: one provider:slug per line
greenhouse:acme
lever:globex
ashby:umbrella
```

JSON works too: `{"greenhouse": ["acme"], "lever": ["globex"]}`. Providers: greenhouse, lever, ashby,
workable, smartrecruiters, recruitee. Boards you already track are skipped. A list longer than
`search_preferences.ats_sweep.max_boards` (default 150) is covered over several days. Swept boards
never count toward run health, and a swept board that answers 404 on two runs is skipped like any
other dead board. Postings go through the same title, location and scoring filters as everything else.

Known gap: CareerRat ships no slug data and downloads none. Building the list (from a public ATS
slug dataset you trust, or your own research) is on you, and company names are derived from the slug.

## Shared posting cache (several people)

When CareerRat runs for more than one person (`--for <name>`), a board is fetched once and every
person is matched. Public posting data (company, title, location, comp text, body, posted date, URL)
goes into `postings-cache.db` in the base data root, next to `people/`. Scores, fit, notes and
anything from a person's profile never do.

- **Reuse.** A source another person's scan fetched cleanly in the last 6 hours is read from the
  cache instead of refetched. Dead-board memory and request throttling still apply to real fetches.
  An explicit `--company` or `--recheck-dead` always fetches fresh.
- **Cross-match.** Postings new to the cache are run through every other person's own targeting,
  location, comp floor, exclusions and dedupe, and saved into their workspace with source
  `shared-cache`, under their own presentation cap. A person with no workspace database or
  unfinished setup is skipped with a note.
- **Summary.** The scan summary reports `sharedCache` (sources reused or fetched, `alsoMatchedFor`
  counts per person, skipped notes). `careerrat` prints "Also matched for: bob (3)".
- **Settings.** Off for one person: `search_preferences.shared_cache.receive: false` in their
  targeting. Off for everyone, or a different window: `shared-cache.json` in the base data root
  (`{"enabled": false, "freshnessHours": 6}`), or `CAREERRAT_SHARED_CACHE=off` and
  `CAREERRAT_SHARED_CACHE_HOURS`. With no people registered the cache does nothing.

Known gaps: browser and login sources are never cached; the owner's own workspace (no `--for`) fills
the cache but is not a cross-match target; cross-matched postings keep the cached body, so a
partial description is not re-hydrated.

## Deterministic provider parity

The curated table above is a starter menu, not the complete runtime inventory.
CareerRat accounts for all 83 providers in the pinned Career Ops snapshot: 82
public-network adapters are implemented, and `local-parser` is intentionally
unsupported because it executes user-configured local commands rather than making
a public network call. The npm package includes the adapter sources, MIT license,
and parity manifest.

Every provider runs through the same CareerRat boundary: bounded HTTP transport,
normalized offers, source provenance, scanner dedupe, and immediate full-JD
hydration when a list API only returns metadata. AI/browser discovery remains the
fallback for ambiguous custom pages, authentication gates, and providers outside
the manifest.

## State

Each source run should write:

- source id and label
- generated or captured URL
- `lastRunAt`
- exact recency cutoff
- raw result count
- deduped result count
- closed/expired count
- intake file path

This lets the next run use the exact delta from the prior run instead of a fixed
24-hour sweep.
