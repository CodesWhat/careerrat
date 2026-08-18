---
name: discover-companies
description: Continuously discover companies LIKELY to be hiring the candidate's target roles from their company thesis and role context → resolve each to a scannable ATS careers board → legitimacy-screen and dedup → propose adding to CareerRat tracked-company source config, confirm-first. Named focus companies are priority examples, never an allowlist. Upstream of search-jobs; turns a closed company set into a growing one.
tier_1_inputs: [profile.candidate.domain, targeting role_buckets, targeting company_preferences, targeting keep_signals, targeting excluded_companies, profile.compensation.minimum_base, STEP 0 dedup set, modes verdict]
tier_2_inputs: [per-company WebSearch/WebFetch bodies, careers-page resolution]
---

# discover-companies

Discovers **companies** likely to be hiring the candidate's target roles, resolves
each to a careers board the scanner can sweep, screens them, and proposes adding them
to the CareerRat source config (`careerrat companies`: SQLite in DB workspaces,
legacy `config/sourced-scan.json` otherwise). Never writes a company without explicit
user confirmation. Never duplicates a company already tracked, applied to, sourced,
or excluded.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

This is the company analog of `research-boards`. `research-boards` finds **boards/aggregators**;
`discover-companies` finds **employers** and wires their ATS board into the sweep. The sweep
(`search-jobs` → `scan:sourced`) only ever scans configured tracked companies (`careerrat
companies`: SQLite in DB workspaces, legacy `config/sourced-scan.json` otherwise) — it has no
discovery of its own. This skill is what grows that list, so future sweeps reach beyond the set
the candidate has already exhausted.

The configured scan list is not the discovery universe. `company_preferences.examples` are
priority seeds and the rest of `company_preferences` supplies reusable focus signals. Always
look for additional matching employers beyond those examples. Only explicit company/category
exclusions constrain the universe.

Post-onboarding discovery order:

```
setup-searches -> research-boards -> discover-companies -> search-jobs
```

---

## Inputs

| File | Fields used |
|---|---|
| `candidate/targeting.yml` | `role_buckets[].name`, `role_buckets[].titles`, `role_buckets[].priority`, `company_preferences`, `keep_signals`, `cut_signals`, `excluded_companies` |
| `candidate/profile.yml` | `candidate.domain`, `location.remote`/`home`/`relocation`, `compensation.minimum_base` (comp-plausibility filter — never surface the figure outbound) |
| Source config | `careerrat companies` / `tracked_companies[].name`, `tracked_companies[].careers_url` — the company dedup + write target. In DB mode, `careerrat companies` reads/writes SQLite; in legacy mode it reads/writes `config/sourced-scan.json`. |
| `workspace/tracker.json` | `applications[].company`, `sourced[].company` — companies already in play; never re-propose |

---

## STEP 0 — Load context (load to decide)

In conversational chat, use the server's `Outbound-safe candidate context`, including
`configured_companies`, `tracked_companies`, `excluded_companies`, role buckets, keep/cut signals,
and location, as canonical. Never ask the candidate to enumerate local source config or companies
already in play. The shell reads below apply to one-shot CLI execution; the web handoff performed
the local reads before this network-isolated research session began.

Run `careerrat doctor` and confirm it exits clean. If it fails, stop and report.

Check usage mode:

```
careerrat modes allows research:companies
```

If it returns `skip` / `downshift`, treat company discovery as discretionary: explain that
lean usage mode downshifts it and either run a smaller pass (fewer queries) or proceed only
on an explicit override. If it returns `run`, continue.

Read the input files above. Extract:

- **Domain** — `profile.candidate.domain`.
- **Role families** — the `name` of every `role_buckets[]` entry (families drive query breadth, not the title list).
- **Relevance signals** — `targeting.keep_signals` (what makes a company a fit) and `cut_signals` (what disqualifies one).
- **Company thesis** — `targeting.company_preferences` captures industry, employer type, size/stage, business model, values, geography, and focus examples. Examples are searched first but never suppress broader discovery.
- **Comp-plausibility floor** — `profile.compensation.minimum_base`. Used only to screen out companies that plausibly can't clear the floor (tiny/seed shops, sub-market employers). **This figure is an internal screen — never put it in any outbound text or artifact.**
- **Location posture** — `profile.location.remote` + `home` + `relocation` (US-hiring / remote relevance).

Build the **dedup set** — the union of every company name the candidate is already engaged with, so nothing is re-proposed:

- every `tracked_companies[].name` from `careerrat companies` (already swept), **and**
- every `applications[].company` and `sourced[].company` in `workspace/tracker.json` (already applied/sourced), **and**
- every `targeting.excluded_companies` entry (hard-excluded).

Print a one-line summary before proceeding:

```
Domain: <domain> | Role families: <comma-list> | Comp floor screen: <yes> | Already in play: <N companies>
```

---

## STEP 1 — Web-search for candidate companies

Run WebSearch using domain-neutral query templates. Substitute `candidate.domain`,
`role_buckets[].name`, `company_preferences`, and `keep_signals` phrasing into each template —
never use hardcoded industry, company, or technology names. The candidate's company thesis is
read from config, not assumed. Focus examples are searched first and also used to find similar
employers; always include queries that can surface companies the candidate did not name.

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

If focus/manual seeds are present, resolve them first **and** run the broader queries in the same
discovery pass. Never return early just because the candidate named one or more companies.

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
provider. The pinned provider catalog is authoritative:

```
careerrat searches --providers --json
```

Recognized hosts infer their adapter automatically. Common examples include:

| ATS | careers_url shape |
|---|---|
| Greenhouse | `https://job-boards.greenhouse.io/<slug>` or `https://boards.greenhouse.io/<slug>` |
| Ashby | `https://jobs.ashbyhq.com/<slug>` |
| Lever | `https://jobs.lever.co/<slug>` |
| Workable | `https://apply.workable.com/<slug>` |
| SmartRecruiters | `https://careers.smartrecruiters.com/<slug>` or `https://jobs.smartrecruiters.com/<slug>` |
| Recruitee | `https://<tenant>.recruitee.com` |
| Workday | `https://<tenant>.<instance>.myworkdayjobs.com/<site>` |
| BambooHR | `https://<tenant>.bamboohr.com/careers` |
| Personio | `https://<tenant>.jobs.personio.com` |

Verify the board resolves to current listings. A branded/custom domain may still be supported
when its underlying adapter is known; add it with `--provider <id>`. If neither URL inference nor
an explicit implemented adapter can resolve it, mark it `ATS: unsupported` and keep it as intel
without adding it.

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

### Conversational web handoff

In conversational chat, follow the table with one typed proposal block for every NEW company that
passed the supported-ATS gate. The app renders these as real Track company / Skip controls and owns
the confirmed source-config write:

```careerrat:discovery
{"kind":"company_proposal","name":"<company>","url":"https://<supported-ats-host>/<slug>","why":"<one short evidence-based reason>","confidence":"high"}
```

Use `"confidence":"borderline"` for medium/borderline rows. Never emit a proposal for an
unsupported ATS. Do not ask the user to type company names or claim that a prose reply wrote
config. After every proposal block (or immediately after the table when there are zero proposals),
emit:

```careerrat:discovery
{"kind":"discovery_complete","step":"discover-companies"}
```

The app withholds the first-search button until every proposal is tracked or skipped. In a one-shot
CLI session, keep using STEP 4's CLI confirmation and write procedure instead.

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

**External-agent / one-shot CLI runs only.** In conversational chat, this skill runs as an
embedded session under the `chat` tool profile (`CHAT_RUNTIME_TOOLS`), which has no Bash —
there is no shell to run `careerrat companies --add … --write` from. The STEP 3 Conversational
web handoff already IS the write mechanism: each `company_proposal` block renders a real Track
company / Skip control, and clicking it calls the confirm-first write server-side through the
exact same `saveCompanyBoard`/source-config guards this step's CLI path uses. Skip this step's
CLI commands, the `careerrat doctor` check, and the Activity Pulse CLI call entirely in chat
mode — go straight to the **Required output block** below, using its chat-mode wording. Do not
run or narrate running `careerrat companies --add`, and do not tell the user a company was
added — a chat turn ends before any click on the STEP 3 controls, so the model never observes
whether the user actually tracked or skipped a proposal. Claiming a write here without having
run one violates the skill's Honesty Firewall. This step's CLI procedure below stays exactly as
written for a one-shot, non-embedded (external-agent) run, where there is a real shell.

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
careerrat companies --add "<Company Name>" --url "<careers_url>"          # dry-run preview
careerrat companies --add "<Company Name>" --url "<careers_url>" --write  # commit
careerrat companies --add "<Company Name>" --url "<branded_url>" --provider "<id>" --write
```

The helper infers recognized hosts, validates explicit branded-host adapters against the parity
manifest, dedups by name and URL, and writes atomically. In DB workspaces it writes SQLite source
config; in legacy workspaces it writes `config/sourced-scan.json`. An `ATS: unsupported` company
cannot be added; leave it in the table as intel only.

After adding, confirm the result and validate:

```
careerrat companies
careerrat doctor
```

Confirm source config still validates before reporting done.

Then log the discovery to the Activity Pulse feed (see **Activity Pulse** in AGENTS.md) — one
summary event, not one per company:

```
careerrat activity append --type research --actor agent \
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
confirmation) adds them to source config through `careerrat companies`. It does not:

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

**In conversational chat**, the model's turn ends the moment the STEP 3 proposal blocks are
emitted — it never sees whether the user later clicks Track company or Skip. Use only these
values in chat mode, regardless of how confident the proposals looked:

```text
AUTO-ADDED: none (chat handoff — writes happen via the Track company/Skip controls, not this turn)
CONFIRMED-ADDED: awaiting confirmation
NEXT: awaiting confirmation
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
- **Focus is not scope.** `company_preferences.examples`, manual seed lists, and currently tracked
  companies never become an allowlist. Every non-excluded employer remains eligible when it
  matches the role, location, compensation-plausibility, and company-thesis signals.
- **Scannable-ATS gate.** Only propose-to-add a company whose careers board resolves to one of
  the 73 implemented public adapters in `careerrat searches --providers`. Recognized hosts infer
  automatically; branded hosts require a validated explicit provider. Unsupported companies are
  intel only because an unscannable board would silently never sweep.
- **Comp screen stays internal.** Use `minimum_base` to filter implausible employers; never write
  the figure into the table, an artifact, or any outbound text (Privacy Invariant).
- **Use the helper.** Additions go through `careerrat companies --add … --write`. Do not edit
  SQLite source tables or `config/sourced-scan.json` directly. **One-shot CLI runs only** — chat
  sessions have no Bash and use the STEP 3 typed-block handoff instead; never narrate running
  this command from a chat session.
- **Quality gate.** A company must be a real employer with at least one current, dated, relevant
  role on a resolvable board to be proposed. An inferred board with no visible roles is borderline
  at best.

---

## Intent → Command

| Intent | Command |
|---|---|
| See currently tracked companies | `careerrat companies` |
| Preview adding a company (dry run) | `careerrat companies --add "<name>" --url "<careers_url>"` |
| Add a confirmed company | `careerrat companies --add "<name>" --url "<careers_url>" --write` |
| Add a branded supported board | `careerrat companies --add "<name>" --url "<url>" --provider "<id>" --write` |
| Remove a tracked company | `careerrat companies --remove "<name>" --write` |
| Scan the newly added companies | `npm run scan:sourced -- --company "<name>" --write --intake --summary --verify` |
| Health check after additions | `careerrat doctor` |
