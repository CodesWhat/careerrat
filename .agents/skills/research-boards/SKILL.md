---
name: research-boards
description: Web-search + legitimacy-screen NEW job boards for the candidate's domain/role families -> propose adding through `rolester searches`, confirm-first.
tier_1_inputs: [profile.candidate.domain, targeting role families, STEP 0 dedup set, modes verdict]
tier_2_inputs: [per-board WebFetch bodies]
---

# research-boards

Discovers new job boards and aggregators relevant to the candidate's domain and role
families. Source config is accessed through `rolester searches` (`--json` for reads,
`--add-url` for writes). In DB workspaces this is DB-backed source config; in legacy
workspaces it persists to `config/search-sources.yml`. Do not edit source YAML
directly. Never writes a source without explicit user confirmation. Never duplicates
an already-configured board.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

---

## Inputs

| Input | Fields used |
|---|---|
| Candidate targeting via DB-first accessor/compat export | `role_buckets[].name`, `role_buckets[].titles`, `role_buckets[].priority` |
| Candidate profile via DB-first accessor/compat export | `candidate.domain`, `location.remote`, `location.home` |
| Source config via `rolester searches --json` | `searches[].label`, `searches[].target`, `searches[].url`, `searches[].rssUrl` - build the already-configured URL+label set to dedupe against |

---

## STEP 0 — Load context

Run `rolester doctor` and confirm it exits clean. If it fails, stop and report.

Check usage mode:

```
rolester modes allows research:boards
```

If it returns `skip`, do not run board discovery by default; explain that lean usage
mode treats board discovery as discretionary and offer to proceed only if the user
explicitly overrides. If it returns `run`, continue.

Read candidate context through DB-first accessors/compat exports and read source
config with `rolester searches --json`. Extract:

- **Domain** — `profile.candidate.domain` (e.g. "software engineering", "finance", "logistics")
- **Role families** — the `name` of every bucket in `targeting.role_buckets` (not titles; families drive query breadth)
- **Remote posture** — `profile.location.remote` (drives relevance of remote-focused boards)
- **Configured URLs** — collect every `url`, `rssUrl`, and `target` value already present in source config; also collect every `label` value. This is the dedup set — no board whose root domain or label already appears here will be proposed.

Print a one-line summary of detected inputs before proceeding:

```
Domain: <domain> | Role families: <comma-list> | Remote: <yes/no/hybrid> | Existing sources: <N>
```

---

## STEP 1 — Web-search for boards

Run WebSearch using domain-neutral query templates. Substitute `candidate.domain` and
`role_buckets[].name` into each template — never use hardcoded industry names.

**Query templates** (run a selection; skip redundant permutations):

- `"<role family> job board <year>"`
- `"<candidate domain> job aggregator"`
- `"niche job board <candidate domain>"`
- `"<role family> jobs remote board site:*.io OR site:*.com -linkedin -indeed"`
- `"best job boards <candidate domain> <year>"`
- `"<role family> <remote if remote=true> job listings site"`

Run at least 3 distinct queries covering different role families or angles. Collect
the distinct board names and URLs mentioned in results. Ignore individual job posting
URLs — you want board root URLs (e.g. `https://example.com`, not `https://example.com/jobs/123`).

Build a raw candidate list: name, root URL, apparent source type (rss / url-query / browser).

---

## STEP 2 — Legitimacy screen

**[DELEGATE: subagent]** Each candidate board screens independently — fan out one subagent
per board (parallel `WebFetch`, no one-browser limit), each returning the verdict block
(`{board, url, verdict: added|rejected|borderline, reason, sampleListing}`) using the
REQUIRE/REJECT gate below. The orchestrator holds the STEP 0 dedup set and confirms
write-back in STEP 4 — subagents only screen; they do not re-gate, read AGENTS.md, or add a
source. Degrade to inline sequential screening with no subagent primitive. See the
**Delegation Contract** in AGENTS.md.

For each candidate board, WebFetch its root (or a known jobs listing path if the root
redirects). Apply the following gate — adapted from evaluate-job STEP 3.5 to screen a
SOURCE, not a posting:

**REQUIRE (all three must pass to propose):**

1. **Real, specific, dated listing** — the page must show at least one job posting with
   a company name, role title, and a discernible post date. An index page of clearly
   dated listings qualifies. A "join our talent community" landing page does not.
2. **Domain relevance** — at least one visible listing must be plausibly relevant to
   `candidate.domain` or one of the candidate's role families. A general board is
   acceptable only if its category/filter for the domain is surfaced.
3. **Not already configured** — the board's root domain must not match any URL already
   in the dedup set from STEP 0.

**REJECT if any of the following apply:**

- The page contains no dated listings (evergreen landing page, "talent pool", "future
  openings" language, or a "sign up to be notified" gate with no visible jobs).
- The site is clearly a staffing-agency/recruiter-farm aggregator with no direct
  employer postings and poor signal-to-noise.
- The root domain matches an already-configured source.
- The page returns a 4xx/5xx or a redirect loop.

A board with mixed signals (one strong positive + one mild negative) is a
`LEGITIMACY: borderline` — include it in the proposed table marked `(borderline)` with
a brief reason; let the user decide.

Record verdict for every board screened: `added` | `rejected: <reason>` | `borderline`.

---

## STEP 3 — Present proposed-boards table

Present the results before writing anything:

```
## Boards reviewed: <N total screened>

| # | Board | URL | Source type | Why relevant | Status |
|---|---|---|---|---|---|
| 1 | <name> | <url> | url-query / rss / browser | <one phrase> | NEW |
| 2 | <name> | <url> | browser | <one phrase> | NEW (borderline: <reason>) |
| 3 | <name> | <url> | rss | <one phrase> | REJECTED: <reason> |
```

- `url-query` — the board supports URL-based query-string filtering (suitable for `--add-url` with a search URL)
- `rss` — the board exposes an RSS/Atom feed
- `browser` — JS-rendered; requires browser fetch

For boards that are RSS or have a filterable search URL, include the specific URL with
embedded filters (domain / role family keyword pre-applied) in the "Why relevant" column
when you can determine it from the fetch.

Do not add anything to source config yet.

---

## STEP 3.5 — Classify by confidence tier

Before presenting the table, classify each passing board into one of two tiers:

**HIGH-CONFIDENCE** — a board meets ALL of the following:
- Shows real dated listings (visible post date, company name, role title on the listing page)
- At least one listing is from an identifiable real employer (not a recruiter farm or ghost posting)
- Canonical root URL resolves cleanly (no redirect loop, no 4xx/5xx)
- No sign of aggregator spam (low-signal job-title soup with no employer attribution)
- Stable host (domain has been around; not a brand-new or parked domain)

**BORDERLINE / MEDIUM** — any board that passes the STEP 2 gate but fails one or more
high-confidence criteria above. Requires confirm-first regardless of any user posture.

Record each board's tier (`high` or `borderline/medium`) alongside the STEP 2 verdict.
This tier drives the STEP 4 auto-add logic below.

---

## STEP 4 — Add boards (confirm-first by default; opt-in auto-add for high-confidence)

**Default behavior is confirm-first for everything.** Auto-add is only active when the
user has explicitly opted in during this session by saying something like "auto-add
high-confidence boards" or "yes, add high-confidence ones without asking."

**Without opt-in (default):** Wait for explicit user confirmation before writing any
source, regardless of tier. Present the proposed-boards table from STEP 3 and ask which
boards the user wants added.

**With opt-in (user has stated "auto-add high-confidence boards" or equivalent):**
- HIGH-CONFIDENCE boards: add immediately without per-board confirmation. Report each
  addition as it happens.
- BORDERLINE / MEDIUM boards: always confirm-first, even with auto-add opted in. Present
  them as a separate group and wait for explicit approval.

For each board being added (auto or confirmed), use the existing searches CLI:

```
rolester searches --add-url "<url>" --label "<label>"
```

Where `<url>` is:
- For `url-query` boards: the pre-filtered search URL (domain/role terms embedded if
  available), so the embedded filters are preserved exactly as parsed.
- For `rss` boards: the feed URL.
- For `browser` boards: the board root or listing page URL.

And `<label>` is the human-readable board name from the proposed table.

**Registry write-back - to the candidate's own source config ONLY, never `docs/SOURCES.md`.** A
discovered board is candidate-specific (it matches *this* user's domain and role families), so
it must never touch `docs/SOURCES.md` — that file is shipped and published, and writing a
discovered board there leaks one user's targeting into the public package. The durable record
of every added board is:
- its entry in source config through `rolester searches` (DB-backed in DB workspaces,
  legacy `config/search-sources.yml` otherwise), plus
- the research log recorded in the next step (gitignored `workspace/research/`).

Leave `docs/SOURCES.md` untouched. It ships only field-neutral provider infrastructure
(`implemented`/`planned` rows); a guard test (`tests/release-safety.test.mjs`) fails the build
if a candidate-discovered board lands in it.

After adding all boards, run:

```
rolester searches
```

Then run:

```
rolester doctor
```

Confirm source config passes schema validation before reporting done.

**Optional — record a board-discovery audit note:**

```
rolester research record "boards" --name board-discovery-<yyyy-mm-dd> --file <draft.md> --write
```

where `<draft.md>` contains:

```markdown
---
type: board-discovery-log
company: "n/a"
fetchedAt: "<today ISO>"
---
## Boards reviewed
- <name> (<url>) — added | rejected: <reason>
```

The draft filename must not conflict with an existing research artifact. This step is
optional — skip if the user did not request it and no persistent audit record is needed.

When the audit note is written (or when boards are added even without an audit note), log the discovery to the Activity Pulse feed (see **Activity Pulse** in AGENTS.md):

```
rolester activity append --type research --actor agent \
  --title "Discovered <N> job boards" --summary "<one-line: what kind of boards / for what track>" --write
```

---

## Scope boundary

`research-boards` discovers, screens, proposes, and (on confirmation) adds SOURCES
through `rolester searches`. It does not:

- scan sources for job postings (that is `search-jobs`)
- evaluate individual postings for fit (that is `evaluate-job`)
- tailor, fill, or submit applications

The artifact this skill produces is entries in source config. It sits in
the post-onboarding discovery order:

```
setup-searches -> research-boards -> discover-companies -> search-jobs
```

After board discovery, hand off to `discover-companies` so employer ATS boards are
wired into tracked-company source config through `rolester companies` before the first `search-jobs` sweep. Only go
straight to `search-jobs` if the user explicitly wants to skip company discovery.

## Final handoff

End every run with the next agent task: `discover-companies` next. If the user
explicitly skipped employer ATS discovery, record it with
`rolester next --skip discover-companies --write`. Do not hand straight to
`search-jobs` unless that skip is recorded or the workspace already has tracked companies.

---

## Required output block

Emit at the end of every run (before or after confirmation):

```
BOARDS FOUND: <N screened>
PROPOSED (new): <N> (<N> high-confidence, <N> borderline/medium)
REJECTED: <N> (reasons: <comma-list of distinct rejection categories>)
AUTO-ADDED: <comma-list of labels auto-added, or "none (opt-in not active)">
CONFIRMED-ADDED: <comma-list of labels added after explicit confirmation, or "awaiting confirmation">
REGISTRY-UPDATED: <yes | no>
```

---

## Rules

- **Domain-neutral.** No hardcoded board names, industries, or aggregator brands appear
  in this skill's prose. Every board name derives from web-search results for the
  candidate's actual domain and role families.
- **Confirm-first is the default.** Never add a source without the
  user explicitly approving additions, unless the user has opted into auto-add for
  high-confidence boards in the current session.
- **Auto-add is opt-in only.** Auto-add activates only when the user explicitly says
  "auto-add high-confidence boards" (or equivalent). Without that statement, all writes
  require confirmation regardless of tier.
- **Borderline/medium always confirm-first.** Even with auto-add opted in, any board
  below the high-confidence bar requires explicit user approval before being added.
- **Dedup.** Never propose a board whose root domain or label already appears in the
  configured sources loaded in STEP 0.
- **Quality gate.** A board must show at least one real, dated, domain-relevant listing
  to be proposed. An evergreen landing page or talent-pool gate is a rejection.
- **Use the existing CLI.** Additions go through `rolester searches --add-url "<url>" --label "<label>"`. Do not edit `config/search-sources.yml` directly.
- **Registry write-back.** Record every added board in candidate-owned source config only -
  through `rolester searches` plus the `workspace/research/` log. NEVER write
  discovered boards to `docs/SOURCES.md`; it ships and is published, so it stays field-neutral.

---

## Intent → Command

| Intent | Command |
|---|---|
| See currently configured sources | `rolester searches` |
| Add a confirmed board URL | `rolester searches --add-url "<url>" --label "<label>"` |
| Health check after additions | `rolester doctor` |
