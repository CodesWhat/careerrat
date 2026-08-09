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
- Manual/auth sources: support saved browser sessions, but mark them as
  interactive and do not require them for baseline setup.

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
3. Metadata-only no-result handling for empty, blocked, robots-disallowed,
   login-gated, and useless pages.
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

Touch these files in order, replacing `<name>` with the provider key (lowercase, no spaces):

1. **`src/core/providers/<name>.mjs`** — export a `buildXxxUrl(source)` function that
   returns a string URL from a source config object. See `lever.mjs` or `wellfound.mjs`
   for a pure URL-builder template, or `hiringcafe.mjs` for one that also computes
   recency state.

2. **`src/core/providers/source-url.mjs`** — import the builder and add an `if
   (provider === "<name>")` branch inside `buildSourceUrl`. Return
   `{ url, searchState: {}, recency: null }` (or the full recency shape if applicable).

3. **`scripts/capture-search-sources.mjs`** — two additions:
   - In `inferProviderFromUrl`: add an `if (raw.includes("<domain>")) return "<name>";`
     line so bare URLs are auto-detected.
   - In `extractOffers`: add a branch for the provider. For SPA boards, add a
     `page.evaluate(extractXxx)` DOM extractor (see `extractHiringCafe` or
     `extractWellfound`). For boards with a public JSON API, fetch directly instead
     (see `fetchLeverPostings` for the pattern).

4. **`src/core/liveness/job-link-checker.mjs`** — if the board renders via JavaScript
   and a plain HTTP fetch will return a short shell (or 403), add the hostname(s) to the
   array inside `isSpaJobHost`. Optionally extend `spaEscalation` if the provider has a
   machine-readable API to use as a liveness fallback.

5. **`src/core/scoring/sourced-scanner.mjs`** *(only if the provider has a company-level
   ATS API)* — add a `fetchXxx(entry, fetchImpl)` function, register it in
   `fetchProvider`'s dispatch, and add the URL pattern to `inferProvider` so company
   entries can be detected automatically from a `careers_url`.

## Curated Board Registry

A domain-tagged menu of the board/aggregator providers CareerRat ships support for
(`implemented`) or has on the roadmap (`planned`). Skills read this table to offer a filtered
starter menu — it is NOT a universal set of defaults. The `general` tag means suitable for all
domains; domain-specific tags (e.g. `tech/software`, `tech/AI`, `remote`) indicate narrower scope.

**Field-neutral only.** This file ships and is published, so it lists provider infrastructure
ONLY — never one user's discovered boards. The registry currently leans tech/software/AI because
that is what has been built so far; provider support for other domains (healthcare, finance,
trades, logistics, etc.) gets added here as it ships. Boards you discover via `research-boards`
are candidate-specific and persist to your own gitignored `config/search-sources.yml` — they are
never written here.

| Board | Domain tag(s) | Type | Confidence | Status | Notes |
|---|---|---|---|---|---|
| HiringCafe | general | aggregator | high | implemented | `src/core/providers/hiringcafe.mjs`; DOM extractor in `capture-search-sources.mjs`; field-neutral shipped default |
| LinkedIn | general | aggregator | high | implemented | `extractLinkedIn` in `capture-search-sources.mjs`; disabled by default (auth brittleness); `--include-disabled` to surface |
| Google Jobs | general | aggregator | high | planned | structured-data aggregator; field-neutral; no provider impl yet |
| Wellfound | tech/software | aggregator | high | implemented | `src/core/providers/wellfound.mjs`; SPA browser source; tech-domain only |
| Remote Vibe Coding Jobs | tech/software, remote | aggregator | high | implemented | URL builder in `source-url.mjs`; RSS via `src/core/providers/rss.mjs`; AI-native remote aggregator |
| Ashby | general | ATS | high | implemented | `fetchAshby` in `sourced-scanner.mjs`; company-level ATS API |
| Greenhouse | general | ATS | high | implemented | `fetchGreenhouse` in `sourced-scanner.mjs`; company-level ATS API |
| Lever | general | ATS | high | implemented | `src/core/providers/lever.mjs`; JSON API in `capture-search-sources.mjs`; company-level ATS API |
| Workable | general | ATS | high | implemented | `fetchWorkable` in `sourced-scanner.mjs`; company-level ATS API |
| SmartRecruiters | general | ATS | high | implemented | `fetchSmartRecruiters` in `sourced-scanner.mjs`; company-level ATS API |
| Recruitee | general | ATS | medium | planned | company-level ATS; no provider impl yet |
| Workday | general | ATS | medium | planned | company-level ATS; no provider impl yet |
| RemoteOK | remote | niche-board | high | planned | remote-only; RSS feed available |
| Jobicy | remote | niche-board | high | planned | remote-only; RSS feed available |
| Working Nomads | remote | niche-board | high | planned | remote-only; curated listings |
| We Work Remotely | remote | niche-board | high | planned | remote-only; well-established |
| Remotive | remote | niche-board | high | planned | remote-only; RSS feed available |

### Registry legend

- **Domain tag(s):** `general` = all domains; `tech/software` = software engineering domain only; `tech/AI` = AI/ML/agent roles; `remote` = remote-posture candidates across domains. Combine tags with commas for entries that span multiple.
- **Type:** `aggregator` = collects from many sources; `ATS` = company-level ATS API adapter; `niche-board` = curated domain-specific board; `RSS` = feed-only.
- **Confidence:** `high` = real dated listings, stable URL, identifiable companies; `medium` = unvetted but reputable; `borderline` = real but with noted quality caveats.
- **Status:** `implemented` = provider code ships with CareerRat; `planned` = on roadmap, not yet implemented.

> **This shipped registry lists only field-neutral provider infrastructure.** Boards you
> discover via `research-boards` are candidate-specific (they match your domain and role
> families), so they are NEVER written here — they persist to your own gitignored
> `config/search-sources.yml` and your `workspace/research/` log. Keeping this file neutral is
> a hard invariant (enforced by `tests/release-safety.test.mjs`): a shipped, published doc must
> not carry one user's discovered boards.

---

## Initial Catalog (legacy reference)

The table above supersedes this list. Kept briefly for cross-reference until all
entries are confirmed migrated.

Aggregators and broad sources:

- HiringCafe — ✓ implemented (`src/core/providers/hiringcafe.mjs`, DOM extractor in `capture-search-sources.mjs`)
- Wellfound — ✓ implemented (`src/core/providers/wellfound.mjs`, DOM extractor in `capture-search-sources.mjs`; SPA host in `isSpaJobHost`)
- Remote Vibe Coding Jobs — ✓ implemented (URL builder inline in `source-url.mjs`, feeds via `src/core/providers/rss.mjs`)
- LinkedIn — ✓ implemented (DOM extractor `extractLinkedIn` in `capture-search-sources.mjs`; disabled by default, requires `--include-disabled`)
- Google Jobs — planned

Boards discovered via `research-boards` are domain-specific to whoever runs it, so they are
NOT listed here (this file ships publicly). They persist to the user's own gitignored
`config/search-sources.yml` and `workspace/research/` log instead.

ATS and company APIs:

- Ashby — ✓ implemented (`fetchAshby` in `sourced-scanner.mjs`; SPA host in `isSpaJobHost`)
- Greenhouse — ✓ implemented (`fetchGreenhouse` in `sourced-scanner.mjs`)
- Lever — ✓ implemented (`src/core/providers/lever.mjs`; `fetchLeverPostings` JSON API in `capture-search-sources.mjs`; `fetchLever` in `sourced-scanner.mjs`; SPA host in `isSpaJobHost`)
- Workable — ✓ implemented (`fetchWorkable` in `sourced-scanner.mjs`)
- SmartRecruiters — ✓ implemented (`fetchSmartRecruiters` in `sourced-scanner.mjs`)
- Recruitee — planned
- Workday — planned

Remote boards:

- RemoteOK — planned
- Jobicy — planned
- Working Nomads — planned
- We Work Remotely — planned
- Remotive — planned

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
