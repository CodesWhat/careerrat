---
name: configure
description: Show current settings and route changes to the validated CLI or owning skill — never a new mutation path itself.
---

# configure

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

> **Agent voice.** Read candidate modes through the shared DB-first accessor (`modes.agent_voice`, default `standard`) before producing settings summaries. Apply the register from AGENTS.md#mode-switches. `exec-summary` = changed setting + confirmation in one line; `standard` = current state + change + confirmation as short bullets; `verbose` = full settings matrix. To change `agent_voice` itself: `rolester modes set agent_voice <value> --write`.

## Core Principle

`configure` is a **menu and router**. It reads state directly (read-only) and shows it to you. Every **write** goes through the existing validated, schema-checked, atomic CLI or the owning skill — configure never hand-edits a YAML file itself. In DB workspaces those CLIs write SQLite; in legacy workspaces they may patch YAML. This is the [[capture-is-skills-not-cli]] invariant: mutations go through the write-guarded, confirm-first paths that already exist, not through this skill.

Consequential writes (comp floor/target, broad company exclusions) are confirm-first. Everything stays local. Nothing is ever auto-applied or run on a schedule.

---

## When to Use

- "Change a setting", "update my comp floor", "raise my floor", "edit excluded companies"
- "Change my writing style", "update form defaults", "update how did you hear about us"
- "Turn on browser automation", "turn off status polling", "revoke consent for LinkedIn"
- "Switch the session browser", "use the extension", "use Playwright instead"
- "Configure", "settings", "what are my settings", "show my config"
- Any time you want to change a gate or preference **without** re-running the full `ingest-profile` onboarding interview

`ingest-profile` is the heavyweight first-run interview; `configure` is the lightweight always-available alternative for targeted changes after setup is complete.

---

## STEP 1 — Show Current State

Before offering to change anything, run these checks and report what they show:

```
rolester doctor
rolester modes status
rolester automation status
```

Report a brief summary of each setting's current value and where it lives. Never print `current_base` — it is a private gate input and must never appear in any output, shared artifact, or report from this skill.

---

## STEP 2 — Ask What to Change

Ask the user what they want to change. Route to the correct CLI or owning skill from the table below. If they name multiple things, address them in order.

---

## Routing Table

### Settings with a dedicated CLI

Run the CLI confirm-first. The default is a **dry run** — it shows the exact line that will change without writing. Add `--write` to commit. Consequential changes also require `--confirm`.

| What to change | Command | Friction |
|---|---|---|
| Comp floor (walk-away minimum) | `rolester gate comp-floor <N> --write --confirm` | confirm-first |
| Comp target (negotiation anchor) | `rolester gate comp-target <N> --write --confirm` | confirm-first |
| Comp expected (form-field value) | `rolester gate comp-expected <N> --write` | write-and-report |
| Excluded company | `rolester gate exclude-company "<Name>" --write --confirm` | confirm-first |
| Cut signal | `rolester gate cut-signal "<signal>" --write` | write-and-report |
| Keep signal | `rolester gate keep-signal "<signal>" --write` | write-and-report |
| Honesty: do not claim a tool | `rolester gate do-not-claim "<tool>" --write` | write-and-report |
| Honesty: do not fabricate a claim | `rolester gate do-not-fabricate "<claim>" --write` | write-and-report |
| Usage mode (compute/scope) | `rolester modes set usage <lean\|standard\|full> --write` | write-and-report |
| Application mode (pursuit posture after discovery) | `rolester modes set application <selective\|balanced\|high-volume> --write` | write-and-report |
| Record ToS consent for a platform | `rolester automation consent <platform> --write` | write-and-report |
| Withdraw ToS consent for a platform | `rolester automation revoke <platform> --write` | write-and-report |
| Enable a capability (globally or per-platform) | `rolester automation enable <capability> [platform] --write` | write-and-report |
| Disable a capability | `rolester automation disable <capability> [platform] --write` | write-and-report |
| Session browser provider | `rolester automation session <extension\|playwright> --write` | write-and-report |

**Capabilities:** `status_polling`, `authenticated_search`, `messaging`, `one_click_apply`, `profile_optimize`, `profile_apply`, `mail_access`.

**Platforms per capability:**
- `status_polling`: greenhouse, workday, ashby, lever
- `authenticated_search`: linkedin, indeed, wellfound, glassdoor
- `messaging`: linkedin, wellfound
- `one_click_apply`: linkedin
- `profile_optimize`: linkedin
- `profile_apply`: linkedin
- `mail_access`: gmail, outlook, webmail (`webmail` is provider-agnostic verification-code access; Gmail/Outlook also support webmail ingest)

A capability runs on a platform only if all three conditions are true: the capability's global switch, that platform's per-capability switch, and that platform's one-time ToS consent. This is the three-part AND from `mayRun()` in `src/core/automation/consent.mjs` — never re-derive the predicate here.

**ToS warning:** automating a logged-in platform may violate that platform's terms of service. The user must read those terms themselves before recording consent. Surface this before running any `consent` command.

**Dry-run first.** For every CLI command above, run it once without `--write` so the user sees the exact change before it commits. Only add `--write` (and `--confirm` where required) after an explicit yes.

**Mode semantics:** `usage_mode` changes compute/scope for discretionary work; it never lowers core gate/tailor/track/comms quality. `application_mode` changes what Rolester does after discovery — promote, review, apply, or hold. Discovery should remain recall-oriented by default so plausible roles are not missed; application mode gates what happens next. Neither mode relaxes honesty, privacy, comp, consent, or application-limit gates.

### Settings without a dedicated CLI — route to the owning skill

Do NOT hand-edit these files. Route the user to the skill that owns the write path.

| What to change | Route to |
|---|---|
| Search sources / job boards | `setup-searches` skill |
| Identity / contact info (`profile.yml` name/email/phone/location) | `ingest-profile` — re-run the identity step |
| Writing style (`writing-style.md` and `workspace/writing-samples/`) | `ingest-profile` — re-run the writing samples step (STEP 14) |
| Form defaults (`form-defaults.yml` applicant facts, `auto_submit`) | `ingest-profile` — re-run the form defaults step (STEP 11) |

For `ingest-profile`-owned settings: tell the user which step to target. `ingest-profile` supports resuming from a specific step — it will not restart the whole interview.

---

## Session Browser Provider

The session browser is the Layer 3 interactive provider (`docs/BROWSER.md`). Two options:

- **Extension (recommended default):** Claude-in-Chrome or equivalent. It already holds the user's logins and password store, so authenticated portals just work. No credentials are stored by Rolester.
- **Playwright (fallback):** A persistent profile at `~/.rolester/board-profiles/<platform>`. The user signs in once per platform; the session persists across runs.

Switch the provider with:

```
rolester automation session <extension|playwright> --write
```

Dry-run by default; `--write` commits. In DB mode this writes `candidate_automation`; in legacy mode the first `--write` scaffolds `candidate/automation.yml` from the template if it doesn't exist yet. The change is schema-validated in both modes.

`rolester doctor` now surfaces the configured provider and a best-effort presence probe (whether the provider looks reachable). See `docs/BROWSER.md` for the full substrate map and the Browser Automation Contract in `AGENTS.md` for the permission model.

---

## STEP 3 — Re-validate After Any Change

After every write, run:

```
rolester doctor
```

For changes to candidate config files, also run:

```
rolester ingest --check
```

Report what changed. If validation fails, surface the exact error and fix it before closing.

---

## Rules

- **Never a new mutation path.** configure reads state and routes. Every write goes through the CLI or the owning skill — never a direct YAML or SQLite edit from this skill.
- **`current_base` is private.** Never print it, never let it appear in any output or artifact. It is stored in candidate profile config with `current_comp_shareable: false` and is never an outbound value.
- **Confirm-first on consequential writes.** Dry-run first, show the exact line that will change, get an explicit yes before adding `--write --confirm`. Consequential gates: comp floor/target, broad company exclusions.
- **Write-and-report on low-blast-radius writes.** Cut/keep signals, expected comp, honesty boundaries, automation switches — dry-run first, then `--write` on confirmation.
- **ToS is the user's call.** Warn before every `consent` command. Never record consent automatically.
- **Everything stays local.** No data leaves the machine. No automation runs on a schedule. Every automated session is user-initiated.
- **Never auto-run browser automation.** configure surfaces the CLI commands; the user confirms each one.
- **Domain-neutral.** No hardcoded role titles, companies, tools, or candidate-specific values in this skill. All candidate values live in SQLite in DB mode and compatibility config files only in legacy/export mode.
