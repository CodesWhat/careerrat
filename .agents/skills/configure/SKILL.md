---
name: configure
description: Show current settings and route changes to the validated CLI or owning skill — never a new mutation path itself.
---

# configure

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section. Bare `candidate/`, `workspace/`, `config/`, and `.internal/` paths below are symbolic; resolve them per AGENTS.md's Path Resolution rule.

> **Agent voice.** Read candidate modes through the shared DB-first accessor (`modes.agent_voice`, default `standard`) before producing settings summaries. Apply the register from AGENTS.md#mode-switches. `exec-summary` = changed setting + confirmation in one line; `standard` = current state + change + confirmation as short bullets; `verbose` = full settings matrix. To change `agent_voice` itself: `careerrat modes set agent_voice <value> --write`.

## Core Principle

`configure` is a **menu and router**. It reads state directly (read-only) and shows it to you. Every **write** goes through the existing validated, schema-checked, atomic CLI or the owning skill — configure never hand-edits a YAML file itself. In DB workspaces those CLIs write SQLite; in legacy workspaces they may patch YAML. This is the [[capture-is-skills-not-cli]] invariant: mutations go through the write-guarded, confirm-first paths that already exist, not through this skill.

DB-backed `gate`, `modes` and `automation` writes record the changed field and its Undo reference atomically. Dry runs, no-ops and refused changes create no Undo entry. Inspect `careerrat data changes list --json` before promising Undo for a lower-level candidate/evidence write; those commands do not yet record it automatically. Legacy file writes do not create a database as a side effect. Lowering a comp floor or target and loosening an honesty boundary are confirm-first. Everything stays local. Nothing is run on a schedule.

---

## When to Use

- "Change a setting", "update my comp floor", "raise my floor", "edit excluded companies"
- "Change my writing style", "update form defaults", "update how did you hear about us"
- "Turn on status polling", "turn off messaging", "turn off LinkedIn automation"
- "Switch the session browser", "use the extension", "use Playwright instead"
- "Configure", "settings", "what are my settings", "show my config"
- Any time you want to change a gate or preference **without** re-running the full `ingest-profile` onboarding interview

`ingest-profile` is the heavyweight first-run interview; `configure` is the lightweight always-available alternative for targeted changes after setup is complete.

---

## STEP 1 — Show Current State

Before offering to change anything, run these checks and report what they show:

```
careerrat doctor
careerrat modes status
careerrat automation status
```

Report a brief summary of each setting's current value and where it lives. Never print `current_base` — it is a private gate input and must never appear in any output, shared artifact, or report from this skill.

---

## STEP 2 — Ask What to Change

Ask the user what they want to change. Route to the correct CLI or owning skill from the table below. If they name multiple things, address them in order.

---

## Routing Table

### Settings with a dedicated CLI

Run the CLI dry run first. The default is a **dry run**: it shows the exact line that will change without writing. Add `--write` to commit. Only lowering or clearing a comp floor or target also requires `--confirm`, after an explicit yes; `--confirm` is ignored on every other write.

| What to change | Command | Friction |
|---|---|---|
| Comp floor (walk-away minimum) | `careerrat gate comp-floor <N> --write` (add `--confirm` only when lowering) | write-and-report when raising or first set, confirm-first when lowering |
| Comp target (negotiation anchor) | `careerrat gate comp-target <N> --write` (add `--confirm` only when lowering) | write-and-report when raising or first set, confirm-first when lowering |
| Comp expected (form-field value) | `careerrat gate comp-expected <N> --write` | write-and-report |
| Excluded company | `careerrat gate exclude-company "<Name>" --write` | write-and-report |
| Cut signal | `careerrat gate cut-signal "<signal>" --write` | write-and-report |
| Keep signal | `careerrat gate keep-signal "<signal>" --write` | write-and-report |
| Honesty: do not claim a tool | `careerrat gate do-not-claim "<tool>" --write` | write-and-report |
| Honesty: do not fabricate a claim | `careerrat gate do-not-fabricate "<claim>" --write` | write-and-report |
| Usage mode (compute/scope) | `careerrat modes set usage <lean\|standard\|full> --write` | write-and-report |
| Application mode (pursuit posture after discovery) | `careerrat modes set application <selective\|balanced\|high-volume> --write` | write-and-report |
| Turn a capability back on (globally or per-platform) | `careerrat automation enable <capability> [platform] --write` | write-and-report |
| Turn a capability off (globally or per-platform) | `careerrat automation disable <capability> [platform] --write` | write-and-report |
| Session browser provider | `careerrat automation session <extension\|playwright> --write` | write-and-report |
| Final submit mode (auto presses Submit, manual stops for you) | `careerrat automation submit <auto\|manual> --write` | write-and-report |

**Capabilities:** `status_polling`, `messaging`, `authenticated_apply_preparation`, `profile_optimize`, `profile_apply`, `mail_access`, `relationship_sourcing`, `calendar_sync`, `calendar_read`. All are on by default.

**Platforms per capability:**

- `status_polling`: greenhouse, workday, ashby, lever
- `messaging`: linkedin, wellfound
- `authenticated_apply_preparation`: linkedin
- `profile_optimize`: linkedin
- `profile_apply`: linkedin
- `mail_access`: gmail, outlook, webmail (`webmail` is provider-agnostic verification-code access; Gmail/Outlook also support webmail ingest)

A capability runs on a platform unless its global switch or that platform's per-capability switch is turned off. This is the verdict from `mayRun()` in `src/core/automation/consent.mjs`; never re-derive it here. There is no consent step or setup mode: route "turn on X" to `careerrat automation enable` and "turn off X" to `careerrat automation disable`.

**Dry-run first.** For every CLI command above, run it once without `--write` so the user sees the exact change before it commits. For a loosening change (lowering a comp floor or target, loosening an honesty boundary), only add `--write` (and `--confirm` where required) after an explicit yes. Other knowledge and targeting writes go ahead directly and are reported with an Undo.

**Mode semantics:** `usage_mode` changes compute/scope for discretionary work; it never lowers core gate/tailor/track/comms quality. `application_mode` changes what CareerRat does after discovery: promote, review, apply, or hold. Discovery should remain recall-oriented by default so plausible roles are not missed; application mode gates what happens next. Neither mode relaxes honesty, privacy, comp, or application-limit gates.

### Settings without a dedicated CLI — route to the owning skill

Do NOT hand-edit these files. Route the user to the skill that owns the write path.

| What to change | Route to |
|---|---|
| Search sources / job boards | `setup-searches` skill |
| Identity / contact info (`profile.yml` name/email/phone/location) | `ingest-profile` — re-run the identity step |
| Writing style (`writing-style.md` and `workspace/writing-samples/`) | `ingest-profile` — re-run the writing samples step (STEP 14) |
| Form defaults (`form-defaults.yml` applicant facts) | `ingest-profile`: re-run the form defaults step (STEP 11) |

For `ingest-profile`-owned settings: tell the user which step to target. `ingest-profile` supports resuming from a specific step — it will not restart the whole interview.

---

## Session Browser Provider

The session browser is the Layer 3 interactive provider (`docs/BROWSER.md`). Two options:

- **Extension (recommended default):** Claude-in-Chrome or equivalent. It already holds the user's logins and password store, so authenticated portals just work. No credentials are stored by CareerRat.
- **Playwright (fallback):** A persistent profile at `<data root>/board-profiles/<platform>` (data root per AGENTS.md's Path Resolution rule). The user signs in once per platform; the session persists across runs.

Switch the provider with:

```
careerrat automation session <extension|playwright> --write
```

Dry-run by default; `--write` commits. In DB mode this writes `candidate_automation`; in legacy mode the first `--write` scaffolds `candidate/automation.yml` from the template if it doesn't exist yet. The change is schema-validated in both modes.

`careerrat doctor` now surfaces the configured provider and a best-effort presence probe (whether the provider looks reachable). See `docs/BROWSER.md` for the full substrate map and the Browser Automation Contract in `AGENTS.md` for the on/off model.

---

## STEP 3 — Re-validate After Any Change

After every write, run:

```
careerrat doctor
```

For changes to candidate config files, also run:

```
careerrat ingest --check
```

Report what changed. If validation fails, surface the exact error and fix it before closing.

---

## Conversational workspace settings

In the Ask workspace, showing settings and applying a targeted change are native:
the app runs typed intents (`settings.explain`, `settings.apply`) directly in
`workspace-agent.mjs`, not this skill's CLI routing. A terminal or
external-agent run of this skill still follows STEP 1 → 3 exactly as written.
Both intents reuse the same validated write paths this skill routes to
(`candidateConfigPatch`, the gate routes); neither opens a new mutation path.

- **Explain.** "What are my settings", "show my automation settings", and
  "what mode am I in" return a read-only `settings_overview` card built by
  strict allow-list: modes, the automation capability and platform matrix, and
  gate values (comp floor/target/expected, excluded-company count, cut/keep
  signals, do-not-claim). `current_base` is never read, and a leak backstop
  refuses the whole card rather than surface it.
- **Apply.** Free-text changes ("set my comp floor to $150k", "exclude Acme
  from my search", "switch usage mode to full", "turn off status polling
  on Greenhouse", "turn on relationship sourcing") preview as a labeled action chip;
  confirming runs one narrow, schema-validated write and returns a
  `settings_apply` receipt with the prior and new value. "…to match my current
  salary" phrasings are refused with private-comp copy, never parsed.
- **What stays elsewhere.** Any capability or platform can be turned on or off
  from Ask. Consent and setup mode were retired, so those old phrases succeed
  as a no-op note and write nothing. AI keys, runtime selection, and search-source edits keep
  their own owning flows.

Job-source login is not a setting or automation capability. A source that needs
login asks one plain Yes/No question when it runs. Yes opens that source in the
visible CareerRat browser, and No skips it.

---

## Rules

- **Never a new mutation path.** configure reads state and routes. Every write goes through the CLI or the owning skill — never a direct YAML or SQLite edit from this skill.
- **`current_base` is private.** Never print it, never let it appear in any output or artifact. It is stored in candidate profile config with `current_comp_shareable: false` and is never an outbound value.
- **Confirm-first on loosening writes.** Dry-run first, show the exact line that will change, get an explicit yes before adding `--write --confirm`. Loosening gates: lowering the comp floor or target, loosening an honesty boundary.
- **Apply directly, with an Undo, on other knowledge and targeting writes.** Cut/keep signals, company exclusions, raised comp, expected comp, tightened honesty boundaries, automation switches: write through the owning writer and echo what changed.
- **Everything stays local.** No data leaves the machine. No automation runs on a schedule. Every automated session is user-initiated.
- **Never auto-run browser automation.** configure surfaces the CLI commands; the user confirms each one.
- **Domain-neutral.** No hardcoded role titles, companies, tools, or candidate-specific values in this skill. All candidate values live in SQLite in DB mode and compatibility config files only in legacy/export mode.
