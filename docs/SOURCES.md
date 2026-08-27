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

## AI Open-Web Discovery

AI search broadens the deterministic baseline across specialist boards,
employer career pages, and useful aggregators. It is domain-neutral; engineering
and hospitality searches follow the same candidate location, compensation,
eligibility, and fit rules.

Discovery and verification are separate stages. When AI finds a specific role
and employer but automated fetching cannot read the full description, CareerRat
preserves the visible title, company, URL, location, compensation, date, and
factual search evidence as an **AI · unverified** lead. It does not guess the
missing job description and does not present the role as confirmed. **Evaluate**
later verifies liveness, uses the public or supervised browser path to capture
the full posting, and runs the body-read gate before tailoring or application
work. Known expired roles, hard-filter violations, duplicates, and results with
no specific role or employer are still dropped.

## Hospitality Baseline

Hospitality candidates receive deterministic public sources alongside the
general provider set. The current baseline includes OysterLink, Hcareers,
Hospitality Online, and iHireHospitality. Each adapter validates its host and URL
shape, reads structured job-posting data, rejects expired postings, and
normalizes title, employer, location, compensation, date, and the full visible
description. Engineering candidates continue to receive the engineering,
remote, ATS, and general sources matched to their targeting.

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

CareerRat vendors the public-network provider contract from Career Ops commit
`8be39e0934b83410276d66b541bf3a2edf3411cb`. The canonical inventory is
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
| Recruitee | general | ATS | high | implemented | Career Ops deterministic adapter; company-level public API |
| Workday | general | ATS | high | implemented | Career Ops deterministic adapter with bounded pagination |
| RemoteOK | remote | niche-board | high | implemented | public board-wide API |
| Jobicy | remote | niche-board | high | implemented | public board API |
| Working Nomads | remote | niche-board | high | implemented | public board-wide API |
| We Work Remotely | remote | niche-board | high | implemented | public RSS adapter |
| Remotive | remote | niche-board | high | implemented | public board-wide API |
| OysterLink | hospitality | niche-board | high | implemented | public hospitality search and structured job-detail adapter |
| Hcareers | hospitality | niche-board | high | implemented | public hospitality search and structured job-detail adapter |
| Hospitality Online | hospitality | niche-board | high | implemented | public hospitality search and structured job-detail adapter |
| iHireHospitality | hospitality | niche-board | high | implemented | public hospitality search and structured job-detail adapter |

### Registry legend

- **Domain tag(s):** `general` = all domains; `tech/software` = software engineering domain only; `tech/AI` = AI/ML/agent roles; `hospitality` = hospitality, food-service, and beverage work; `remote` = remote-posture candidates across domains. Combine tags with commas for entries that span multiple.
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

## Deterministic provider parity

The curated table above is a starter menu, not the complete runtime inventory.
CareerRat accounts for all 78 providers in the pinned Career Ops snapshot: 77
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
