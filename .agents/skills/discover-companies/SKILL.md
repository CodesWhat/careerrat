---
name: discover-companies
description: Web-search companies LIKELY to be hiring the candidate's target roles → resolve each to a scannable ATS careers board → legitimacy-screen and dedup → propose adding to Rolester tracked-company source config, confirm-first. Upstream of search-jobs; turns a closed company set into a growing one.
tier_1_inputs: [profile.candidate.domain, targeting role_buckets, targeting keep_signals, targeting excluded_companies, profile.compensation.minimum_base, STEP 0 dedup set, modes verdict]
tier_2_inputs: [per-company WebSearch/WebFetch bodies, careers-page resolution]
---

# discover-companies

Discovers **companies** likely to be hiring the candidate's target roles, resolves
each to a careers board the scanner can sweep, screens them, and proposes adding them
to the Rolester source config (`rolester companies`: SQLite in DB workspaces,
legacy `config/sourced-scan.json` otherwise). Never writes a company without explicit
user confirmation. Never duplicates a company already tracked, applied to, sourced,
or excluded.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

This is the company analog of `research-boards`. `research-boards` finds **boards/aggregators**;
`discover-companies` finds **employers** and wires their ATS board into the sweep. The sweep
(`search-jobs` → `scan:sourced`) only ever scans configured tracked companies (`rolester
companies`: SQLite in DB workspaces, legacy `config/sourced-scan.json` otherwise) — it has no
discovery of its own. This skill is what grows that list, so future sweeps reach beyond the set
the candidate has already exhausted.

Post-onboarding discovery order:

```
setup-searches -> research-boards -> discover-companies -> search-jobs
```

---

## Inputs

| File | Fields used |
|---|---|
| `candidate/targeting.yml` | `role_buckets[].name`, `role_buckets[].titles`, `role_buckets[].priority`, `keep_signals`, `cut_signals`, `excluded_companies` |
| `candidate/profile.yml` | `candidate.domain`, `location.remote`/`home`/`relocation`, `compensation.minimum_base` (comp-plausibility filter — never surface the figure outbound) |
| Source config | `rolester companies` / `tracked_companies[].name`, `tracked_companies[].careers_url` — the company dedup + write target. In DB mode, `rolester companies` reads/writes SQLite; in legacy mode it reads/writes `config/sourced-scan.json`. |
| `workspace/tracker.json` | `applications[].company`, `sourced[].company` — companies already in play; never re-propose |

---

## STEP 0 — Load context (load to decide)

Run `rolester doctor` and confirm it exits clean. If it fails, stop and report.

Check usage mode:

```
rolester modes allows research:companies
```

If it returns `skip` / `downshift`, treat company discovery as discretionary: explain that
lean usage mode downshifts it and either run a smaller pass (fewer queries) or proceed only
on an explicit override. If it returns `run`, continue.

Read the input files above. Extract:

- **Domain** — `profile.candidate.domain`.
- **Role families** — the `name` of every `role_buckets[]` entry (families drive query breadth, not the title list).
- **Relevance signals** — `targeting.keep_signals` (what makes a company a fit) and `cut_signals` (what disqualifies one).
- **Comp-plausibility floor** — `profile.compensation.minimum_base`. Used only to screen out companies that plausibly can't clear the floor (tiny/seed shops, sub-market employers). **This figure is an internal screen — never put it in any outbound text or artifact.**
- **Location posture** — `profile.location.remote` + `home` + `relocation` (US-hiring / remote relevance).

Build the **dedup set** — the union of every company name the candidate is already engaged with, so nothing is re-proposed:

- every `tracked_companies[].name` from `rolester companies` (already swept), **and**
- every `applications[].company` and `sourced[].company` in `workspace/tracker.json` (already applied/sourced), **and**
- every `targeting.excluded_companies` entry (hard-excluded).

Print a one-line summary before proceeding:

```
Domain: <domain> | Role families: <comma-list> | Comp floor screen: <yes> | Already in play: <N companies>
```

---

## STEP 1 — Web-search for candidate companies

Run WebSearch using domain-neutral query templates. Substitute `candidate.domain`,
`role_buckets[].name`, and `keep_signals` phrasing into each template — never use hardcoded
industry, company, or technology names. The candidate's "what's a cool/desirable company"
notion is **derived from their config** (domain + keep_signals + comp floor), not assumed.

**Query templates** (run a selection across role families; skip redundant permutations):

- `"companies hiring <role family> <year>"`
- `"<candidate domain> companies hiring <role-family title>"`
- `"top <candidate domain> companies <year>"` (well-funded / well-known employers in the domain)
- `"<keep-signal phrase> companies hiring"` (e.g. the distinctive capability the candidate is hired for)
- `"<role-family title> jobs <remote if remote=true>"` then note the **employers** appearing, not the postings
- `"<candidate domain> startups <funding stage that clears the comp floor>"`

Run at least 4 distinct queries spanning the candidate's role families (primary buckets first).
Collect **employer names** — ignore aggregator/board pages and individual posting URLs. You want
companies, not listings.

Build a raw candidate list: company name + a one-phrase reason it plausibly fits (tie it to a
`keep_signal` or role family) + any role title you saw them hiring.

**Drop immediately** (before screening): any company in the STEP 0 dedup set, and any company
matching `excluded_companies`.

---

## STEP 2 — Resolve careers board + legitimacy/relevance screen

**[DELEGATE: subagent]** Each candidate company resolves + screens independently — fan out one
subagent per company (parallel `WebSearch`/`WebFetch`, no one-browser limit), each returning the
verdict block (`{company, careers_url, ats, verdict: added|rejected|borderline, reason, roleSeen, confidence}`)
using the gate below. The orchestrator holds the STEP 0 dedup set and owns the STEP 4
confirm-first write — subagents only resolve + screen; they do not read AGENTS.md, re-derive a
gate, or write any file. Degrade to inline sequential screening with no subagent primitive. See
the **Delegation Contract** in AGENTS.md.

For each candidate company, do two things:

**(a) Resolve a scannable careers board.** Find the company's real careers page and identify its
ATS. The scanner can sweep **only** these hosts (the `careers_url` must be one of them, with the
company's slug):

| ATS | careers_url shape |
|---|---|
| Greenhouse | `https://job-boards.greenhouse.io/<slug>` or `https://boards.greenhouse.io/<slug>` |
| Ashby | `https://jobs.ashbyhq.com/<slug>` |
| Lever | `https://jobs.lever.co/<slug>` |
| Workable | `https://apply.workable.com/<slug>` |
| SmartRecruiters | `https://careers.smartrecruiters.com/<slug>` or `https://jobs.smartrecruiters.com/<slug>` |

Verify the slug resolves to a real board (fetch it, or a known listing path). A company on
Workday / a custom / an embedded ATS that is **not** one of the five is `ATS: unsupported` —
keep it as intel in the table marked unsupported, but it **cannot be auto-added** (the
`companies` helper will reject the URL).

**(b) Screen — REQUIRE all three to propose:**

1. **Real, hiring employer** — the company is a real org and the resolved board shows at least one current, dated role (note the title you saw).
2. **Domain/role relevance** — at least one visible role plausibly matches a `role_buckets[]` family or a `keep_signal`; the company does not read as a pure `cut_signal` shop.
3. **Comp-plausibility** — the company is plausibly able to clear the candidate's comp floor for the target seniority (well-funded / established enough). A clearly sub-floor employer is a reject. (Screen only — never print the floor figure.)

**REJECT if any:** in the dedup/excluded set; no resolvable board and no current roles; clearly a
`cut_signal`-only employer; implausible on comp; a staffing-farm/reseller rather than a direct
employer; board returns 4xx/5xx.

A company with mixed signals (one strong positive + one mild negative) is `borderline` — include
it flagged, let the user decide.

Record a verdict for every company screened: `added-candidate` | `rejected: <reason>` | `borderline`.

---

## STEP 3 — Present the proposed-companies table

Present results before writing anything:

```
## Companies reviewed: <N total screened>

| # | Company | Why it fits | Role seen / likely | ATS | careers_url | Confidence | Status |
|---|---|---|---|---|---|---|---|
| 1 | <name> | <one phrase tied to a keep-signal/family> | <title> | ashby | <url> | high | NEW |
| 2 | <name> | <one phrase> | <title> | greenhouse | <url> | medium | NEW (borderline: <reason>) |
| 3 | <name> | <one phrase> | <title> | — | — | — | REJECTED: <reason> / ATS unsupported |
```

Do not add anything to source config yet.

---

## STEP 3.5 — Classify by confidence tier

Classify each passing company into a tier (mirrors `research-boards` STEP 3.5):

**HIGH-CONFIDENCE** — all of: resolved board on a supported ATS; ≥1 current dated role visibly
relevant to a target family; real, identifiable employer; plausibly clears the comp floor;
clean-resolving canonical careers URL.

**BORDERLINE / MEDIUM** — passes the STEP 2 gate but fails one or more high-confidence criteria
(role relevance inferred not seen, comp-plausibility uncertain, slug resolved but board thin).
Always confirm-first, regardless of any auto-add posture.

Record each company's tier alongside its verdict; the tier drives STEP 4.

---

## STEP 4 — Add companies (confirm-first by default; opt-in auto-add for high-confidence)

**Default is confirm-first for everything.** Auto-add is active only when the user has explicitly
opted in this session ("auto-add high-confidence companies" or equivalent).

**Without opt-in (default):** present the STEP 3 table and wait for the user to pick which
companies to add. Write nothing before that.

**With opt-in:**
- HIGH-CONFIDENCE companies: add without per-company confirmation; report each as it lands.
- BORDERLINE / MEDIUM companies: always confirm-first, even with auto-add on.

For each company being added (auto or confirmed), use the companies helper — **never hand-edit
SQLite source tables or `config/sourced-scan.json`**:

```
rolester companies --add "<Company Name>" --url "<careers_url>"          # dry-run preview
rolester companies --add "<Company Name>" --url "<careers_url>" --write  # commit
```

The helper infers the provider from the host, **rejects any URL not on a supported ATS**, dedups
by name and URL (idempotent no-op if already tracked), and writes atomically. In DB workspaces it
writes SQLite source config; in legacy workspaces it writes `config/sourced-scan.json`. An
`ATS: unsupported` company cannot be added — leave it in the table as intel only.

After adding, confirm the result and validate:

```
rolester companies
rolester doctor
```

Confirm source config still validates before reporting done.

Then log the discovery to the Activity Pulse feed (see **Activity Pulse** in AGENTS.md) — one
summary event, not one per company:

```
rolester activity append --type research --actor agent \
  --title "Discovered <N> companies to track" \
  --summary "<one line: what kind of companies / for which role families>" \
  --skill discover-companies --operation companies:add --write
```

---

## STEP 5 — Hand off to search-jobs

Newly tracked companies aren't scanned until the next sweep. After adding, offer to run the
sweep so the new boards are pulled immediately:

```
npm run scan:sourced -- --write --intake --summary --verify
```

or, to scan only the just-added companies, one targeted rescan each:

```
npm run scan:sourced -- --company "<Company>" --write --intake --summary --verify
```

Then `search-jobs` owns triage, JD save, and queueing as usual. `discover-companies` stops at
growing the tracked-company list.

---

## Scope boundary

`discover-companies` discovers employers, resolves their ATS board, screens, proposes, and (on
confirmation) adds them to source config through `rolester companies`. It does not:

- scan boards for postings (that is `search-jobs`)
- find boards/aggregators (that is `research-boards`)
- research a single named company in depth for fit/interview context (that is `research-company`)
- evaluate, tailor, fill, or submit anything

The artifact this skill produces is tracked-company source config: SQLite rows in DB workspaces,
legacy `config/sourced-scan.json` rows otherwise. Hand off to `search-jobs` to scan them.

## Final handoff

End every run with the next agent task: `search-jobs` next. If no companies were
added because confirmation is pending, tell the user that `search-jobs` can still
run on broad sources, but the stronger handoff is to approve or revise the proposed
companies first.

---

## Required output block

Emit at the end of every run (before or after confirmation):

```
COMPANIES REVIEWED: <N screened>
PROPOSED (new): <N> (<N> high-confidence, <N> borderline/medium)
REJECTED: <N> (reasons: <comma-list of distinct categories, incl. "ATS unsupported" / "already tracked">)
AUTO-ADDED: <comma-list of names auto-added, or "none (opt-in not active)">
CONFIRMED-ADDED: <comma-list added after confirmation, or "awaiting confirmation">
NEXT: <"run search-jobs sweep" | "awaiting confirmation">
```

---

## Rules

- **Domain-neutral.** No hardcoded company names, industries, technologies, or comp figures in
  this skill's prose. Every nominee derives from web-search results for the candidate's actual
  `domain`, `role_buckets`, and `keep_signals`. The same skill must serve a nurse, a driver, and
  an engineer by swapping the gate files.
- **Confirm-first is the default.** Never write source config without explicit user approval,
  unless the user opted into auto-add for high-confidence companies this session.
- **Borderline/medium always confirm-first**, even with auto-add on.
- **Dedup hard.** Never propose a company in the STEP 0 dedup set (tracked + applied + sourced)
  or in `excluded_companies`.
- **Scannable-ATS gate.** Only propose-to-add a company whose careers board resolves to a
  supported ATS host (greenhouse / ashby / lever / workable / smartrecruiters). Unsupported-ATS
  companies are intel only — the helper refuses them, by design (an un-scannable board would
  silently never sweep).
- **Comp screen stays internal.** Use `minimum_base` to filter implausible employers; never write
  the figure into the table, an artifact, or any outbound text (Privacy Invariant).
- **Use the helper.** Additions go through `rolester companies --add … --write`. Do not edit
  SQLite source tables or `config/sourced-scan.json` directly.
- **Quality gate.** A company must be a real employer with at least one current, dated, relevant
  role on a resolvable board to be proposed. An inferred board with no visible roles is borderline
  at best.

---

## Intent → Command

| Intent | Command |
|---|---|
| See currently tracked companies | `rolester companies` |
| Preview adding a company (dry run) | `rolester companies --add "<name>" --url "<careers_url>"` |
| Add a confirmed company | `rolester companies --add "<name>" --url "<careers_url>" --write` |
| Remove a tracked company | `rolester companies --remove "<name>" --write` |
| Scan the newly added companies | `npm run scan:sourced -- --company "<name>" --write --intake --summary --verify` |
| Health check after additions | `rolester doctor` |
