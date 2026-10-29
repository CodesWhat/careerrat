# Data Contract

CareerRat separates reusable system code from private candidate data.

## User Layer

These files belong to the local user. They should be ignored by git in a public
repo and should never be overwritten by update scripts without explicit user
confirmation (candidate knowledge follows the exception below). An older install that already has top-level `candidate/` and
`workspace/` directories at the repo root keeps using those instead of the
`.careerrat/` prefix shown below.

| Path | Purpose |
| --- | --- |
| `.careerrat/candidate/profile.yml` | Identity, contact, work authorization, location, compensation, and preferences. |
| `.careerrat/candidate/targeting.yml` | Target roles, keep/cut signals, search buckets, and scoring priorities. |
| `.careerrat/candidate/evidence.yml` | Truth bank: projects, claims, metrics, links, allowed wording, forbidden wording. |
| `.careerrat/candidate/stories.yml` | STAR+R behavioural story bank layered over `evidence.yml`. Every story traces to evidence claim ids (drafted from evidence, candidate-confirmed, never invented); assembled and reused by `interview-prep`. |
| `.careerrat/candidate/honesty.yml` | Hard boundaries: tools, credentials, education, claims, and exclusions. |
| `.careerrat/candidate/form-defaults.yml` | Reusable application form answers. |
| `.careerrat/candidate/modes.yml` | Optional mode switches. `usage_mode` controls discretionary compute/scope; `application_mode` controls pursuit posture after discovery. If absent, defaults are `standard` and `balanced`. |
| `.careerrat/candidate/automation.yml` | Optional browser-automation switchboard. Every capability is on by default; set a capability or platform to `false` to turn it off (`careerrat automation disable <capability> [platform] --write`), including `mail_access` for Gmail/Outlook and generic `webmail`. A file carrying `capabilities_default: on` holds real operator choices; an older file without that marker is migrated once on the next write (its old off values are dropped, `submit` and `session` carry over). `consent` and `setup_mode` are retired and ignored. Also stores the final `submit` mode (`auto` by default, or `manual`). Workspaces with a database keep these values in SQLite and ignore this file; set `submit` with `careerrat automation submit <auto\|manual> --write`. If absent, every capability is on. If the file exists but can't be read or parsed, every capability is denied until it is fixed (`careerrat automation status` shows the error). |
| `.careerrat/candidate/writing-style.md` | Candidate writing voice profile. |
| `.careerrat/candidate/learnings/` | Durable per-role-family lesson files (one file per role family). Appended by `interview-prep`, `track-outcomes`, and `reevaluate-strategy` after debriefs and strategy reviews; read by `tailor-application`, `evaluate-job`, and `search-jobs` to sharpen fit signals and artifact quality over time. |
| `.careerrat/candidate/application-limits.yml` | Per-company application caps and cooldown periods. Checked as a step-zero gate by `apply-job` (blocks re-application within the cooldown window) and used as a deprioritization signal by `search-jobs`. |
| `.careerrat/workspace/jobs/` | Saved JDs with frontmatter and full body text. |
| `.careerrat/workspace/tailored/` | Generated resumes, cover letters, and form answers. |
| `.careerrat/workspace/intake/` | Sourced-role queues awaiting gate review. |
| `.careerrat/workspace/scan-results/` | Search snapshots and raw scanner output. |
| `.careerrat/workspace/comms/` | Email/recruiter-message drafts, thread summaries, and long communication bodies. |
| `.careerrat/workspace/interview-prep/` | Generated interview packets and prep notes. |
| `.careerrat/workspace/writing-samples/` | Optional candidate-authored samples for style calibration. |
| `.careerrat/workspace/research/` | Cited web-research artifacts (company intel, comp benchmarks) from the research-* skills. Treated as outbound; never contains `current_base`. |
| `.careerrat/workspace/tracker.*` | Application and sourced-role tracker state. |

### Candidate knowledge writes

CareerRat runs in operator mode, so grounded changes to candidate knowledge
apply directly instead of waiting for a confirmation. That covers evidence
claims that pass `computeEvidenceWrite`, onboarding saves, and coaching drafts.
Each one is logged in the thread with an Undo. Changes that loosen honesty
still need explicit confirmation: removing a do-not-claim or do-not-fabricate
entry, moving a tool from adjacent or do-not-claim to confirmed, and lowering
a comp floor or target. Outbound actions are unaffected by this exception.

## `companyHealth` (tracker row field)

A role-scoped company-health rating lives as a `companyHealth` object on an individual
`applications[]` or `sourced[]` row in `.careerrat/workspace/tracker.*` (not a separate file). Written by
the `company-health` skill, read by `evaluate-job` (fit cross-cut) and the dashboard
(`src/core/tracker/dashboard-data.js`'s `buildHealthBlock`/`buildHealthBadge`).

| Field | Type | Notes |
| --- | --- | --- |
| `rating` | `"healthy" \| "watch" \| "risky"` | Required. |
| `forFunction` | string | Required. The candidate's target function the rating is scoped to (never hardcoded). |
| `asOf` | `YYYY-MM-DD` | Required. Decays past `modes.yml#company_health.recheck_days`. |
| `provenance` | `"built-from-data" \| "needs-more-info" \| "stale"` | Required. |
| `dimensions` | object | Required. Per-dimension `{ level, note, functionHit?, trend? }` (layoffRisk/hiringMomentum/financial/sentiment/leadership). |
| `rationale` | string | Required. One-paragraph, role-scoped. |
| `crossCut` | string[] | Optional, defaults to `[]`. Candidate needs (from `targeting.yml`) this rating intersected. |
| `fitDelta` | number | Optional, defaults to `0`. A small negative nudge applied to fit only via `crossCut`; never positive. |
| `signals` | array | Optional, defaults to `[]`. `{ source, date, summary, url }` evidence entries. |

**Internal signal only** — this object never appears in any outbound artifact (cover letter,
recruiter reply, LinkedIn). **Write path:** the `companyHealthSet` verb in
`src/core/db/verbs/company-health.mjs` is the single validated writer, reached through two entry
points — the dry-run-default CLI, `careerrat health record <applicationOrSourcedId> --file
<rating.json> --write` (`src/cli/health.mjs`), and the confirm-first `company.health-record`
intent for shell-less embedded sessions. Both validate the shape above and refuse a payload
naming the private `current_base` field.

## System Layer

These files are safe for CareerRat updates and public distribution.

| Path | Purpose |
| --- | --- |
| `.agents/skills/` | Agent workflow definitions. |
| `src/` | Deterministic CLI, parsers, renderers, validators, and provider adapters. |
| `config/*.schema.json` | Data schemas. |
| `config/*.example.yml` | Example config templates. |
| `templates/` | Starter files copied into the user layer. |
| `docs/` | Project documentation. |
| `tests/` | Test fixtures and validation. |

## Rules

- Scanner scores are triage only. The JD body-read gate decides KEEP/CUT/REVIEW.
- Generated text must map back to user-layer evidence.
- The system must not invent degrees, tools, employers, metrics, credentials, or
  authorization status.
- Public default is `submit: auto`: CareerRat submits only when the application is complete and verified. `submit: manual` stops before final submit. Set it with `careerrat automation submit manual --write`; legacy YAML workspaces can also edit `automation.yml` directly.
- Verification-code and inbox workflows are on by default and read only what the
  task needs. Generic
  `webmail` supports one-code-message verification flows; Gmail/Outlook support
  that plus webmail ingest. All are separate from in-platform messaging.
- Communication state should store concise summaries in tracker data and keep
  long bodies in `.careerrat/workspace/comms/`.
