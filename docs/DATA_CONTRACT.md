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
