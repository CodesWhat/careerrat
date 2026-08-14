---
name: search-jobs
description: Run the top-of-funnel sourced sweep — scan configured sources, dedupe, check liveness, coarse-triage every new entry with fitScore/fitBucket/fitBasis, save JD bodies, write watermarks, and optionally hand top sourced roles to evaluate-job. Does not tailor, fill, or submit.
tier_1_inputs: [targeting excluded_companies/keep/cut, profile.compensation.comp_floors, modes verdict, source watermarks, sourced-row fit flags]
tier_2_inputs: [per-source scan results, per-role JD bodies]
---

# search-jobs

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## AI Web Search mode

Activated when the kickoff input is JSON containing `"mode": "ai-web-search"` (a `prompts: [{id, text}]` array and a `candidate` context object arrive alongside it in that same input). When this mode is active, run this section instead of STEP 0 through STEP 8 above — it is a separate, read-only execution path through the same skill, not a variant of the file-writing sweep.

**Tool surface is restricted to Read, Glob, Grep, WebFetch, WebSearch, and Skill.** No Bash, no Write, no Edit, no session browser, and no `careerrat`/npm CLI commands are available in this mode — the embedded runtime enforces this at the tool-allowlist level, so do not attempt any of them. Everything STEP 0-8 above does through a CLI command, a file write, or the session browser is out of scope here; see "Skip" below.

For each entry in `prompts`, run one or more `WebSearch` calls using that prompt's text (or a close paraphrase) as the query. For every promising result — a real job-posting URL, not an aggregator/search-results page — run `WebFetch` on the URL to pull the actual JD text. Prefer postings you can read directly; drop a result rather than guessing at a JD you couldn't fetch.

Score every posting you keep using the **STEP 3 — Coarse triage** rules above, verbatim — the same `fitScore`/`fitBucket`/`fitBasis`/`ruleFlags`/one-line-reason shape, no new rules invented here. Score against the `candidate` context object in the kickoff input (role buckets with their fit/down signals, excluded companies, comp floor, location posture, work authorization) rather than reading `candidate/targeting.yml` directly — the tracker, application-limits, company-history, and learnings inputs STEP 3 also lists are not reachable in this mode (no CLI, no tracker read). Flags that depend on that unreachable data (`company-history-*`, `app-limit-*`, `oe-candidate`) only apply if you can confirm the underlying condition from the posting itself and the given `candidate` context (e.g. `oe-candidate`'s remote+comp-band+priority conditions); otherwise omit the flag rather than guessing.

**Skip:** everything that writes. No `workspace/jobs/*.md`, no `config/search-sources.yml` watermark, no `careerrat activity append`, no tracker write, no `evaluate-job` handoff. The server that invoked this run validates your JSON reply and persists survivors itself — this mode never touches disk or the tracker directly.

Finish with **exactly one** fenced ` ```json ` block matching `config/ai-web-search.schema.json` and nothing else — no prose before or after the fence, since the server is a machine reading exactly that one block. Shape:

- `roles[]` — one entry per posting kept, each with `company`, `title`, `url`, `fit_score`, `fit_bucket`, `fit_basis`, `rule_flags`, `source_evidence` (required), plus whichever of `location`, `comp_text`, `posted_at`, `body_text`, `body_partial` you actually have.
- `queries_run[]` — `{prompt_id, query, status, error?}` for every `WebSearch` call you actually ran, so the server can report exact search coverage back to the user. Use `status: "completed"` when the query returned normally. Use `status: "failed"` and a short factual `error` when the search call failed; never hide a failed query or report it as completed.

## STEP 0 — Prerequisites

Read all gate files before touching anything else:

1. `candidate/targeting.yml` — `role_buckets`, `keep_signals`, `cut_signals`, `excluded_companies`, `fit_bands`, `degree_policy`
2. `candidate/profile.yml` — `compensation.minimum_base`, `location.*`, `candidate.domain` — used for salary floor and location triage. **Do not read or use `compensation.current_base` for any purpose in this skill.**
3. Application limits — in DB mode read `careerrat data candidate get --json` (`application-limits.companies[]`); in legacy mode read `candidate/application-limits.yml`. Build a blocked/capped company set now so the scan can flag them at triage time.
4. `workspace/tracker.json` — existing `applications[]` and `sourced[]`. Build company-history sets now: active applications, recent rejections, prior cuts/closed sourced rows, and exact req/company-role duplicates. Company history is not the same as an application-limit block, but it must affect warnings and priority.
5. For a classifiable role, read its learnings via `careerrat learnings read "<role>"` — the helper resolves the family from targeting.yml and skips silently when no file exists. Improves triage scoring.
6. `candidate/modes.yml` — optional. Run `careerrat modes status`; absent = `usage_mode: standard`, `application_mode: balanced`.
7. Source config — in DB mode use CareerRat commands/scan output as the canonical view; in legacy mode read `config/search-sources.yml` (`searches[]`, per-source `lastRunAt` watermarks, `recency.postFilterAfter`).

Run `careerrat doctor` and confirm it exits clean. Read the `Discovery pipeline`
section before scanning. The post-onboarding order is:

```
setup-searches -> research-boards -> discover-companies -> search-jobs
```

If `doctor` says the next discovery step is `setup-searches`, `research-boards`, or
`discover-companies`, stop and run that owning skill first unless the user explicitly
overrides and asks for a partial sweep. If source config is missing or has no enabled
entries, stop and run `setup-searches` first:

> **Available portals:** Wellfound (`wellfound.com`) is auto-seeded for tech-domain candidates; Lever (`jobs.lever.co`) is seeded one entry per company in `targeting.tracked_companies`. Pasting a `wellfound.com` or `jobs.lever.co` URL via `setup-searches` routes it automatically to the correct provider.

```
careerrat searches
```

If sources are present but haven't been derived from targeting yet, optionally rebuild:

```
careerrat searches --from-targeting
```

Privacy gate: `profile.compensation.current_base` is private. It must not appear in any scan output, intake file, tracker note, or JD frontmatter produced by this skill. Use `minimum_base` / `target_base` / `expected_base` as the comp floor only.

Mode gate: discovery stays broad/recall-oriented. `application_mode` affects how scanner
ratings are promoted after scoring (`high-volume` queues more medium fits; `selective`
keeps medium fits in review), not which plausible roles are discovered. Before a broad
multi-source sweep, run:

```
careerrat modes allows search:sweep:broad
```

If it returns `downshift`, run fewer enabled sources or a narrower recency window and state
that lean usage mode caused the downshift. If it returns `run`, proceed normally.

## STEP 1 — Full sweep

Run the full sourced sweep against all enabled sources since their `lastRunAt` watermarks:

```
npm run scan:sourced -- --write --intake --summary --verify
```

This dedupes against existing tracker sourced entries and `workspace/jobs/`, checks liveness,
captures JD artifacts, and writes sourced rows through the canonical write path. In DB mode,
`--write` uses DB verbs and exports the generated tracker files; agents must not hand-edit
canonical tracker state or source YAML. In legacy mode, it writes scan snapshots, JD artifacts,
intake, and source watermarks; any sourced-row tracker mutation still follows the Tracker Write
Contract.

It also writes:
- `workspace/scan-results/sourced-<date>.json` — raw scan snapshot
- `workspace/intake/sourced-<date>.md` — intake markdown

For a targeted rescan of a single company:

```
npm run scan:sourced -- --company "<Company>" --write --intake --summary --verify
```

Print the run summary: sources scanned, new entries, filtered, duplicates, expired, errors.

**JS-rendered or login-gated boards:** if a source returns nothing (or returns only partial listings) because the board requires a login or heavy client-side rendering, the normal scan path will not reach its content. In that case reach for the capture scripts instead:

```
npm run capture:board -- --ingest           # capture one board page and ingest offers in DB mode
npm run capture:search-sources -- --ingest  # capture configured source pages and ingest offers in DB mode
```

These drive the bundled browser session (Layer 2 per `docs/BROWSER.md`). In DB workspaces,
`--ingest` writes parsed offers through the SQLite sourced-row path and captures each JD body
into `workspace/jobs/*.md` with `artifacts.jd` mirrored onto the row. Without `--ingest`, they
are snapshot-only diagnostics/fallback artifacts. Use them as a manual fallback, not a first step.

### Authenticated browser sources (M12 Phase 2)

Sources with `source_type: "browser"`, `auth: true`, and a `platform` field (one of
`linkedin`, `indeed`, `wellfound`, `glassdoor`) are authenticated browser sources —
logged-in saved-search or results pages that require a session. These default to
`enabled: false` and are never run automatically.

**Two gates, both required.** For each such source, run it only if:

1. The source's own `enabled` is `true` in source config, AND
2. `careerrat automation status --json` shows `authenticated_search` `allowed: true` for that source's `platform`.

The `allowed` field encodes the three-part AND from `mayRun()` in `src/core/automation/consent.mjs` (capability global switch · per-platform switch · per-platform ToS consent). Never re-derive that predicate here.

**If either gate is not met — skip and explain how to opt in. Do not open a browser.**

To enable a source:
1. Read that platform's terms of service yourself.
2. Record ToS consent: `careerrat automation consent <platform> --write`
3. Enable the capability global switch: `careerrat automation enable authenticated_search --write`
4. Enable for the specific platform: `careerrat automation enable authenticated_search <platform> --write`
5. Set `enabled: true` for the source entry through the owning source-config command in DB mode,
   or in `config/search-sources.yml` in legacy mode.
6. Verify: `careerrat automation status --json`

Then stop for that source and continue with the next.

**If both gates pass — scrape via the session browser.**

Navigate to the source's saved-search URL in the session browser (Layer 3 per `docs/BROWSER.md`). Prefer the Chrome extension, which already holds the user's logins; fall back to a Playwright persistent profile the user signs into once per platform (`~/.careerrat/board-profiles/<platform>`, the `scripts/capture-board-snapshot.mjs` model). Snapshot or read the current page state before each action — never rely on hardcoded selectors. Drive the live DOM turn-by-turn.

Scrape the visible postings (title, company, URL, posted date where available). Then feed every scraped posting through the **same** existing pipeline this skill already uses for other sources: intake → dedupe against tracker and `workspace/jobs/` → liveness check → coarse triage (STEP 3) → JD save (STEP 4) → watermark (STEP 5). Do not invent a parallel pipeline.

**LinkedIn URL-filter recipe (keep each saved search to ~1 page).** Encode the candidate's hard gates directly in the saved-search URL so the platform pre-filters server-side and you read one page per keyword instead of paging through noise. Build/maintain the `url:` of each `platform: linkedin` source in source config from these query params:

- `keywords=%22<phrase>%22` — URL-encode the quoted phrase for an exact-title match (drop the quotes only when you deliberately want a broad net).
- `f_TPR=r<seconds>` — time-posted window. `r86400` = 24h, `r604800` = 7d, `r2592000` = 30d. Set this to track the run cadence: tight (24h) for a daily sweep so each term returns ~1 page; widen it if the source is run less often, or you'll miss postings between runs.
- `f_SB2=<band>` — salary-band floor. The band is an integer where each step is ~$20k (…`7`≈$160k+, `8`≈$180k+, `9`≈$200k+). **Derive the band from the candidate's `profile.yml#compensation.minimum_base`, never hardcode a figure** — pick the band whose threshold equals (or is the nearest at-or-below) `minimum_base`. This mirrors the same comp floor `evaluate-job` enforces, so below-floor roles never reach triage.
- `sortBy=DD` — sort by date, newest first, so the freshest postings are at the top of the single page.
- `location=<area>` / `geoId=<id>` — geography; match the candidate's location constraints.

Verify the salary-band integer renders the expected floor on the live page before trusting it (LinkedIn occasionally renumbers bands). When a term still returns multiple pages after these filters, tighten `f_TPR` rather than paging.

**Safety:** halt immediately and ask the user if you encounter a captcha, a 2FA prompt, a login wall, or any unexpected interstitial. Never attempt to bypass an auth challenge. Keep all scraped pages and screenshots under `workspace/` only. Never run an authenticated source on a schedule — always user-initiated with the agent in the loop.

## STEP 2 — Incremental delta (if a prior snapshot exists)

If a previous snapshot exists for a source, run the delta to extract only net-new entries not already in tracker or `workspace/jobs/`:

```
npm run delta:sourced -- --source <provider> --repo-new-only --write
```

Output: `workspace/intake/delta-<source>-<date>.md`.

**Cold start (no prior snapshot for the source):** the delta command will error because there is no baseline to diff against. Run the cold-start variant instead:

```
npm run delta:sourced -- --source <provider> --repo-new-only --write --baseline-ok
```

`--baseline-ok` tells the scanner to treat the current state as the baseline rather than erroring. Use this once per source on first run; omit it on all subsequent incremental runs.

## STEP 3 — Coarse triage on every new sourced entry

For each sourced entry in the intake, emit a triage block before writing it to the tracker. Score using:

- `candidate/targeting.yml` — `role_buckets.priority`, `keep_signals`, `cut_signals`, `excluded_companies`
- `careerrat learnings read "<role>"` — when the sourced role's family is classifiable; skips silently if no file exists
- `candidate/profile.yml#compensation.minimum_base` — salary floor (use this field, not `current_base`)
- application limits — blocked/capped companies

Emit per-entry:

```
fitScore: <0-100>
fitBucket: high | med | stretch        # high ≥ 85, med ≥ 65, stretch < 65 (from targeting.fit_bands; default 85/65)
fitBasis: "triage"                     # marks as pre-read estimate; evaluate-job overwrites with "evaluated"
ruleFlags: [<zero or more of the flags below>]
ratingReason: "<one line>"
```

Rule flags to apply where conditions are met:

- `likely-cut` — matches one or more `cut_signals`
- `comp-below-floor` — posted comp is explicitly below `minimum_base`
- `excluded-company` — company appears in `targeting.yml#excluded_companies`
- `comp-unposted` — no comp posted; cannot verify floor
- `top-of-band-only` — posting says "up to $X" near the floor
- `possible-duplicate` — title+company match an existing tracker row
- `company-history-active` — the same company has an active application (`awaiting`, `screen`, `interview`, `blocked`, or equivalent non-terminal status)
- `company-history-recent-rejection` — the same company has a rejection or pass in `applications[]` within the last 90 days, unless application limits define a different cooldown window
- `company-history-prior-sourced` — the same company has prior sourced rows, cuts, or closed/404 entries that may affect prioritization
- `oe-candidate` — ALL THREE conditions must hold: (1) the posting is fully remote (no required onsite days), AND (2) posted comp falls within `profile.compensation.oe_min_base`–`profile.compensation.oe_max_base` (both from foundations-spec §2; if either is null, the OE range is unconfigured — skip the flag), AND (3) the best-matching `role_buckets[]` entry has `priority: oe`. If any condition fails, do not apply the flag. The scanner does not flag OE itself — applying this three-part check at triage time is an agent behavior (the scanner stays a coarse pre-screen, not a comp gate).
- `app-limit-blocked` — company has an active application-limit block
- `app-limit-caution` — company is approaching its application-limit cap

A coarse honest estimate beats no fit at all. Closed or expired postings get status `closed` and are not queued.

**Company-history handling:** exact req/URL duplicates and exact company+role duplicates are dedupe hits; update/skip the existing row instead of adding a new one. Different roles at a previously applied company may be kept as prospects, but never treat company history as invisible. Add the relevant `company-history-*` flag, carry a concise warning into the intake/tracker note, and require `evaluate-job` to own the final manual/apply-now decision. If the company has an active app or recent rejection, search triage must not label the role `apply-now`; use `manual` until the body-read gate reviews the history.

## STEP 4 — Save the JD body

For each sourced entry not cut outright (i.e., not `excluded-company` or `app-limit-blocked`), save the **full JD body** — the durable copy that outlives the live posting (see the **JD-body capture invariant** in AGENTS.md). A saved URL is not enough: reqs close and login sessions expire, so capture the text now while it's reachable.

- If `workspace/scan-results/sourced-<date>.json` already has the body text, use it.
- If the body is missing from the snapshot, try `WebFetch` on the posting URL first. If the response is empty, truncated, login-walled, or clearly JS-rendered (no meaningful role content), escalate to the session browser: render the page and read `document.body.innerText`. The session browser holds the user's existing logins, so it reaches login-gated postings `WebFetch` can't. Prefer the Chrome extension (Claude-in-Chrome); fall back to Playwright with a login pause if the extension is unavailable. See `docs/BROWSER.md` for the full escalation ladder. Do not invoke the browser on every posting — only when `WebFetch` returns insufficient content. Treat a `WebFetch` failure as "escalate to the browser," never as "the posting is gone."

Write to `workspace/jobs/<company>-<slug>.md` with frontmatter:

```yaml
---
company: "<Company>"
role: "<Title>"
reqId: "<req-id or empty>"
source: "<source name from search-sources.yml>"
postedAt: "<ISO date or empty>"
fetchedAt: "<ISO date>"
status: sourced
url: "<posting URL>"
---
```

**Sourced-role lifecycle:** every new posting written here is simultaneously added to (or confirmed
in) sourced rows with `status: "sourced"`: through DB verbs in DB mode, or
`workspace/tracker.json` `sourced[]` in legacy mode. That is the ungated, pre-evaluation state.
The gate that advances or cuts the role runs in `evaluate-job`.

Validate the file against `config/job.schema.json`. One file per posting/req — consolidate location-clone duplicates to a single file.

## STEP 5 — Write the watermark

After the sweep completes, ensure `lastRunAt` is updated for each source that ran. Without this,
the next invocation is not incremental. In DB mode, the scan/write path owns source watermarks in
SQLite and exported files are generated artifacts; do not hand-edit YAML. In legacy mode only,
update `config/search-sources.yml` directly if the scanner did not already write the watermark.

For each legacy source that needs a manual watermark:
1. Read and print the current (before) `lastRunAt` value: `searches[id=<source>].lastRunAt` (print it so the write can be confirmed).
2. Edit `config/search-sources.yml` directly — set `lastRunAt` to the ISO timestamp of this run.
3. Print the new (after) `lastRunAt` value as confirmation: `Written lastRunAt for <source>: <before> → <after>`.

Then run `careerrat doctor` to confirm the file still validates.

## STEP 6 — Gate write-back (if user stated a new gate mid-session)

If during this session the user said something like "skip \<Company\> from now on", "add \<signal\> as a cut", or "cap me at N apps to \<Company\>", persist it through the owning DB-aware command now. A stated gate must never live only in chat.

| What the user said | Command |
|---|---|
| "skip / never / exclude \<Company\>" | `careerrat gate exclude-company "<Company>" --write --confirm` (confirm-first — broad exclusion) |
| "add \<signal\> as a cut signal" | `careerrat gate cut-signal "<signal>" --write` (write-and-report if unambiguous) |
| "cap \<Company\> at N apps" | `careerrat data candidate limits upsert --data '<json row>'` in DB mode (per-company caps/cooldowns); legacy mode routes to `configure` — never hand-edit `candidate/application-limits.yml` |
| "below $X is a no" | `careerrat gate comp-floor <N> --write --confirm` (confirm-first — changes comp floor) |

After writing, echo the CLI's confirmation. `careerrat gate` writes SQLite in DB mode and legacy YAML only in legacy mode; never hand-edit `candidate/*.yml`.

## STEP 7 — Optional: hand top sourced roles to evaluate-job

**[DELEGATE: subagent]** When several high-fit roles qualify, fan out the body-read gate —
one subagent per role (cap ≈5). Each runs evaluate-job's read-only gate (fetch JD, body-read,
emit the GATE/FIT/COMP/ACTION block) and **returns the verdict**; it does NOT write the
tracker. The orchestrator applies evaluate-job STEP 9 (the sourced-row fitScore/status
write-back) **serially** through the canonical write path (`careerrat data` in DB mode,
the legacy tracker writer otherwise), so there is one writer of canonical tracker state. WebFetch-able JDs
parallelize; JS-portal JDs that need the session browser serialize (one-browser rule).
Degrade to inline sequential gating with no subagent primitive. See the **Delegation
Contract** in AGENTS.md.

For each sourced entry with `fitBucket: high` and no `excluded-company` / `app-limit-blocked` / `likely-cut` flag, offer to run `evaluate-job` for a full body-read gate:

```
careerrat evaluate workspace/jobs/<company>-<slug>.md
```

Exit 0 = KEEP, exit 2 = REVIEW, exit 1 = CUT.

Do not promote any sourced entry to tracker application state without an `evaluate-job` GATE: KEEP verdict. The required gate output format is:

```
GATE: KEEP|CUT|REVIEW - reason
FIT: high|med|stretch <score> - why | caveats: ... | priority: ...
COMP: clear|review|below-floor|OE-bucket - reason
COMP ANCHOR: <expected salary to state> - <rationale>
ACTION: apply-now|hold|manual|cut
```

## STEP 8 — Validate

Run tracker integrity after any sourced additions:

```
npm run verify:tracker
```

Report the summary. List any issues found. Snapshot tracker state:

```
careerrat tracker
```

Then log the source run to the Activity Pulse feed (the dashboard's live timeline — see
**Activity Pulse** in AGENTS.md). One summary event per source run, not per role:

```
careerrat activity append --type sourced --actor agent \
  --title "Sourced <N> roles — <source>" --summary "<one-line triage note, e.g. 'M passed coarse triage'>" \
  --tag "<source>" --write
```

## Scope boundary

`search-jobs` owns discovery, coarse triage, JD save, and intake. It does not:

- tailor resumes
- fill or submit applications
- promote a sourced entry to application state without a GATE: KEEP from `evaluate-job`

The body-read gate is mandatory and lives in `evaluate-job`.

## Final handoff

End every run with the next agent task. If high-fit sourced roles were found, hand
off to `evaluate-job` for the top roles before any application work; if there are
KEEP verdicts ready, hand off to `apply-job`. If the sweep is dry or only returns
known companies, hand off to `research-boards` or `discover-companies` to expand
coverage before another refresh.

## Rules — authenticated browser sources

- **Both gates required.** Never scrape an authenticated source unless the source's `enabled` is `true` AND `careerrat automation status --json` shows `authenticated_search` `allowed: true` for its platform. If either is false, skip and explain the opt-in steps; do not open a browser.
- **`allowed` encodes the three-part AND.** The `allowed` field from `mayRun()` in `src/core/automation/consent.mjs` is the single predicate (capability global · platform · ToS consent). Never re-derive it in prose.
- **Same pipeline, no parallel track.** Postings scraped from authenticated sources flow through the same intake → dedupe → liveness → triage pipeline as every other source. No special path.
- **User-initiated only. Never on a schedule.**
- **Halt on any auth challenge** (captcha, 2FA, login wall, unexpected interstitial). Never bypass.
- **Local-only.** Scraped pages and screenshots stay under `workspace/`. Nothing goes outbound.
- **Tool-agnostic browser prose.** Prefer the Chrome extension (holds existing logins); fall back to Playwright with a one-time login pause. Never name an MCP namespace or vendor tool.
- **Domain-neutral.** No hardcoded platforms beyond what source config and `consent.mjs` define. No bracketed placeholder tokens — if a detail is unknown, omit or go generic.
