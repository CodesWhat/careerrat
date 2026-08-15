# Data Contract

CareerRat separates reusable system code from private candidate data.

## User Layer

These files belong to the local user. They should be ignored by git in a public
repo and should never be overwritten by update scripts without explicit user
confirmation.

| Path | Purpose |
| --- | --- |
| `candidate/profile.yml` | Identity, contact, work authorization, location, compensation, and preferences. |
| `candidate/targeting.yml` | Target roles, keep/cut signals, search buckets, and scoring priorities. |
| `candidate/evidence.yml` | Truth bank: projects, claims, metrics, links, allowed wording, forbidden wording. |
| `candidate/stories.yml` | STAR+R behavioural story bank layered over `evidence.yml`. Every story traces to evidence claim ids (drafted from evidence, candidate-confirmed — never invented); assembled and reused by `interview-prep`. |
| `candidate/honesty.yml` | Hard boundaries: tools, credentials, education, claims, and exclusions. |
| `candidate/form-defaults.yml` | Reusable application form answers. |
| `candidate/modes.yml` | Optional mode switches. `usage_mode` controls discretionary compute/scope; `application_mode` controls pursuit posture after discovery. If absent, defaults are `standard` and `balanced`. |
| `candidate/automation.yml` | Optional browser-automation switchboard. Stores per-capability/per-platform opt-ins and ToS consent, including `mail_access` for Gmail/Outlook and generic `webmail`. If absent, every authenticated capability is off. |
| `candidate/writing-style.md` | Candidate writing voice profile. |
| `candidate/learnings/` | Durable per-role-family lesson files (one file per role family). Appended by `interview-prep`, `track-outcomes`, and `reevaluate-strategy` after debriefs and strategy reviews; read by `tailor-application`, `evaluate-job`, and `search-jobs` to sharpen fit signals and artifact quality over time. |
| `candidate/application-limits.yml` | Per-company application caps and cooldown periods. Checked as a step-zero gate by `apply-job` (blocks re-application within the cooldown window) and used as a deprioritization signal by `search-jobs`. |
| `workspace/jobs/` | Saved JDs with frontmatter and full body text. |
| `workspace/tailored/` | Generated resumes, cover letters, and form answers. |
| `workspace/intake/` | Sourced-role queues awaiting gate review. |
| `workspace/scan-results/` | Search snapshots and raw scanner output. |
| `workspace/comms/` | Email/recruiter-message drafts, thread summaries, and long communication bodies. |
| `workspace/interview-prep/` | Generated interview packets and prep notes. |
| `workspace/writing-samples/` | Optional candidate-authored samples for style calibration. |
| `workspace/research/` | Cited web-research artifacts (company intel, comp benchmarks) from the research-* skills. Treated as outbound; never contains `current_base`. |
| `workspace/tracker.*` | Application and sourced-role tracker state. |

### `companyHealth` (tracker row field)

A role-scoped company-health rating lives as a `companyHealth` object on an individual
`applications[]` or `sourced[]` row in `workspace/tracker.*` (not a separate file). Written by
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
recruiter reply, LinkedIn). **Write path:** `careerrat health record <applicationOrSourcedId>
--file <rating.json> --write` (`src/cli/health.mjs`, backed by the `companyHealthSet` verb in
`src/core/db/verbs/company-health.mjs`) — the only writer; it validates the shape above and
refuses a payload naming the private `current_base` field. Dry-run by default (omit `--write`
to preview).

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
- Public default is manual confirmation before final submit.
- Browser automation that submits applications must be opt-in.
- Verification-code and inbox workflows must be explicit opt-in. Generic
  `webmail` supports one-code-message verification flows; Gmail/Outlook support
  that plus webmail ingest. All are separate from in-platform messaging.
- Communication state should store concise summaries in tracker data and keep
  long bodies in `workspace/comms/`.
