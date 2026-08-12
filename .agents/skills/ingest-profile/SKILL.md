---
name: ingest-profile
description: Interview a new candidate to produce all user-layer config files: profile, targeting, evidence, honesty boundaries, form defaults, writing style, personalized AGENTS.md, and seed search sources. Run on first setup or any major profile change.
---

# ingest-profile

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

> **Agent voice.** Read `candidate/modes.yml#agent_voice` (default `standard`) before producing any summary or explanation output. Apply the register semantics from AGENTS.md#mode-switches. This skill's interview is conversational by design, but **step confirmations, progress summaries, and section wrap-ups** must respect the register — e.g. `exec-summary` means a one-line "Got it — moving to targets" not a paragraph recap. Capture the voice preference in STEP 0a before the main interview so the rest of the session uses it.

## When to Use

- The `candidate/` directory is missing or any required file is absent.
- The user says "set me up", "start fresh", or "update my profile".
- `careerrat ingest --check --json` reports schema failures or placeholder values.
- The AGENTS router detects an incomplete workspace and routes here.
- The user says "resume setup" or "continue onboarding" — resume from `workspace/setup-state.json`.

---

> **Tip — voice input works well here.** This interview involves a lot of narrative (work history, targets, constraints, comp thinking). If typing is friction, use any dictation or voice-to-text tool — macOS built-in Dictation, Wispr Flow, or any speech-to-text — to speak your answers directly into the chat. Nothing to install; just an option.

## STEP 0 — LOAD WHAT'S ALREADY KNOWN

Before asking anything:

1. **Resume detection.** Read `workspace/setup-state.json` if it exists (the agent writes it; there is no CLI for this file).
   - If present and `complete: false`: tell the user where they left off — show `mode`, `depth`, completed steps, and deferred steps. Resume from the next incomplete step rather than restarting. Re-confirm completed sections ("I already have you as X — still right?") rather than re-asking them in full.
   - If present and `complete: true`: setup is already done. Confirm which section the user wants to revisit and jump there directly.
   - If absent: this is a fresh setup — proceed normally.
2. Run `careerrat ingest --check --json` to see which fields fail validation or still hold placeholder values.
3. Read any existing `candidate/` files (`profile.yml`, `targeting.yml`, `honesty.yml`, `form-defaults.yml`, `application-limits.yml`, `evidence.yml`). Note what is already populated.
4. Check session memory and any pasted or attached documents (résumé, LinkedIn export, notes).
5. If the user supplied a résumé file path: run `careerrat ingest --resume <path> --json` to seed profile and evidence YAML from the parsed content.
6. For each section below, **open with a confirmation of what you already know** ("I have you as X — right?") rather than a cold question. Only ask for what is genuinely missing or unconfirmed.

---

## STEP 0a — SETUP MODE + DEPTH + VOICE + OPTIONAL AREAS

Ask these questions before the interview begins. Record answers into `workspace/setup-state.json` (the agent writes this file directly; no CLI mutation exists for it).

**Basic vs Advanced:**

> "Do you want **Basic** or **Advanced** setup?
> - **Basic** — read-only / manual job search. Nothing logs into a site on your behalf. You can switch on automation later anytime via `careerrat automation status`.
> - **Advanced** — you'll be offered authenticated browser automation (status polling, search, messaging, one-click apply, profile optimization, and session webmail access for verification codes / webmail mail ingest) and mail capture during setup. Each capability is still individually opt-in and defaults OFF until you explicitly consent."

Record the answer as `mode: "basic"` or `mode: "advanced"`.

**Deep vs Shallow:**

> "Do you want **Deep** (everything now) or **Shallow** (minimum-viable core now, rest deferred)?
> - **Deep** — go through every step in this skill now.
> - **Shallow** — capture just `identity`, `targets`, `comp`, and `form-defaults` now (enough to start gating and applying), then defer the remaining steps. You can resume at any time."

Record the answer as `depth: "deep"` or `depth: "shallow"`.

In **shallow** mode, mark these step keys as deferred immediately: `domain`, `projects-scan`, `work-history`, `keep-cut`, `location`, `authorization`, `education`, `exclusions`, `toolchain`, `writing-samples`, `capabilities`. The minimum-viable core steps (`identity`, `targets`, `comp`, `form-defaults`) stay in-scope now.

**Question style — simple vs advanced:**

> "For each section, do you want **Simple** questions (focused, fast, covers what matters most) or **Advanced** questions (deeper follow-ups, more edge cases, more nuance captured)?
> - **Simple** — one or two direct questions per topic. Good for most people.
> - **Advanced** — additional probing questions, e.g. per-arrangement comp floors, nuanced work preferences, edge cases on relocation. Adds ~15 min."

Record the answer as `question_style: "simple"` or `question_style: "advanced"`. Throughout the interview, **skip sub-questions and edge-case follow-ups** when `question_style: "simple"`. The core facts (identity, targets, comp floor, location, authorization) are captured regardless of style.

**Optional areas:**

> "There are a few optional areas I can cover during setup. Want me to go through any of these?
>   - **Benefits & perks** — what benefits matter most to you (health plans, 401k match, equity, PTO, parental leave, etc.)
>   - **Lifestyle & logistics** — commute tolerance, travel preferences, time-zone constraints, home-office setup needs
>   - **Work preferences** — management style, team size, IC vs. leadership track, async vs. sync culture
>   You can skip all of them and add them later via `configure`."

Record which areas the user opts into as `optional_areas: ["benefits", "lifestyle", "work-preferences"]` (an array of the keys they chose; empty array if none). These gate optional sub-questions later in the interview.

**Agent voice:**

> "Last one: how do you want me to talk to you during this job search?
> - **exec-summary** — short and sharp. Lead with the verdict. 1–3 lines.
> - **standard** — scannable bullets and short lines, takeaway first. Good for most people. (DEFAULT)
> - **technical** — more depth and jargon when the role calls for it. Still structured.
> - **verbose** — full detail: complete rationale, all signals, everything.
> This only controls how I talk to you, not how your applications or emails read."

Record the answer as `agent_voice: "exec-summary"` | `"standard"` | `"technical"` | `"verbose"`. If the user skips or is unsure, default to `"standard"`. Write it to `candidate/modes.yml` via:

```
careerrat modes set agent_voice <value> --write
```

(If modes.yml doesn't exist yet, the `--write` flag creates it from the template. Confirm: "Agent voice set to `<value>`.")

**Initialize `workspace/setup-state.json`:**

Write (or update) the file now with:

```json
{
  "mode": "basic|advanced",
  "depth": "deep|shallow",
  "question_style": "simple|advanced",
  "optional_areas": ["benefits", "lifestyle", "work-preferences"],
  "agent_voice": "standard",
  "updatedAt": "<ISO-8601>",
  "completed": [],
  "deferred": [],
  "complete": false,
  "automationOffered": false
}
```

Tell the user:

> "Progress is saved to `workspace/setup-state.json`. You can stop at any point and resume later — just re-run `ingest-profile` (or `careerrat ingest`) and setup will pick up where you left off."

---

## STEP 1 — DOMAIN + FIELD DETECTION

1. If `candidate.domain` is not already set in `profile.yml`, ask: "What field or industry are you searching in?" Use any detected context (résumé text, job titles, stated background) as the opening statement to confirm rather than cold-ask.
2. Write `candidate.domain` (free-text; e.g. `"software engineering"`, `"trucking/logistics"`, `"nursing"`, `"finance"`) to `profile.yml` under `candidate:`. This field gates board selection in STEP 15 (`--write-config`).
3. If the candidate has clearly distinct search tracks (primary + secondary), record both in `profile.yml` as a note or as additional context strings alongside `domain`.

---

## STEP 2 — IDENTITY + RESUME SOURCE

1. Confirm or capture: `full_name`, `email`, `phone`, `location.city`/`state`/`country`, `linkedin`, `github` (if applicable), `portfolio` (if applicable). Replace every placeholder string from the template (`Jane Candidate`, `jane@example.com`, `+1-555-0100`, etc.).
2. Ask where the source résumé lives (file path, paste, or URL) if not already provided.
3. **Corrupt/bad-paste gate:** If `careerrat ingest --resume <path>` produced empty contact or empty sections, say so and ask for a screenshot, plain-text paste, or different export before continuing. Never proceed on an unreadable parse.
4. Write all identity fields to `candidate/profile.yml`.

---

## STEP 2b — SCAN A PROJECTS FOLDER / REPO (evidence source — optional, re-runnable)

A résumé is one source of truth; the candidate's **actual work** is a better one.
When the user points at a code/projects folder or a repo ("scan `~/code`", "look at
my projects", "see what I've built"), mine it for real, verifiable accomplishments and
originate evidence claims from it. **Run this any time** — during onboarding to seed
the bank, or later to enrich it; it is not first-setup-only. The same claims then feed
résumés, cover letters, **and** the STAR+R story bank.

1. **Get the source(s).** Accept one or more local folder paths or repo URLs. For a
   local folder, enumerate the projects under it (each subdirectory, or the packages of
   a monorepo). For a GitHub user/URL, use the tools available to you (`gh`, `git`,
   `WebFetch`) to read the public repos. Confirm these are the candidate's **own** work
   before claiming any of it.
2. **Read real signals per project** (this is an agent-tool behavior — `Read`/`Glob`/
   `git log`/`WebFetch`, like evaluate-job's body read; no scanner code to invoke):
   README and docs, package/build manifests (stack + dependencies), the primary source
   modules (what it does), `git log`/contributor history (the candidate's actual
   involvement and span), tests/CI (rigor), and any scale or usage hints the repo
   genuinely shows. Degrade gracefully — skip a project you can't read and note it.
3. **Draft evidence claims, honestly.** For each project, draft a claim:
   `claim` (what was built), `evidence` (what in the repo backs it — "designed and
   shipped X; see repo"), `links` (the repo URL), `role_signals`, and `metrics` **only**
   where a real number is supported. **A repo proves the work exists and its shape — it
   does NOT prove impact.** Draw scope/architecture from the code; draw adoption,
   revenue, or performance numbers only from what the candidate confirms or a source
   actually shows. Never fabricate an outcome from the mere presence of code. When you
   cite file paths, render framework dynamic-route segments in colon form
   (`app/share/:id`, `api/generate/:model`) — the placeholder firewall reads a bracket
   token like `[id]` as an unfilled `[Name]`-style placeholder and will refuse the claim.
4. **Confirm before banking.** Evidence is the candidate's truth bank — present the
   drafted claims and let them correct, cut, or add metrics. Confirm-first, always.
5. **Bank each confirmed claim via the guarded helper** (dry-run, then commit). Write the
   claim to a temp YAML fragment and:
   ```
   careerrat evidence add --file <claim.yml>          # preview + firewall check
   careerrat evidence add --file <claim.yml> --write   # commit (append / upsert by id)
   ```
   The helper refuses a claim missing `id`/`claim`/`evidence`, carrying placeholder
   residue, or holding the private `current_base` field, and won't rewrite the bank
   unless the result passes the schema + a round-trip check. Re-scanning the same project
   updates its claim (upsert by id) rather than duplicating it.
6. **Hand off.** After banking, offer to draft STAR+R stories from the new claims
   (`interview-prep` STEP 2b) and note the claims are now available to résumés and cover
   letters too.

**Privacy + boundaries:** never read or record compensation from a scan (the helper
refuses `current_base`); never claim third-party or dependency code as the candidate's
own; a project's existence is evidence of building it, not of its business impact.

---

## STEP 3 — WORK HISTORY TRUTH BOUNDARIES

1. Ask which employers and titles are accurate as stated. Identify any gaps, overlaps, or tenure edge cases that need care.
2. Identify which metrics and outcomes are verified and citable with evidence.
3. Write each verified claim to `candidate/evidence.yml` under `claims[]`: include `claim`, `evidence`, `metrics`, `links`, `allowed_wording`, `forbidden_wording`.
4. Never invent facts; ask or omit.

---

## STEP 4 — TARGET ROLES + ADJACENT ROLES + OE BUCKET

1. Capture primary target title(s) and adjacent or stretch titles → write as `role_buckets[]` in `candidate/targeting.yml`. Each bucket needs `title`, `priority` (primary | adjacent | oe), and `comp_floor` (if different from the overall minimum).
2. Explicitly ask about over-employment (concurrent secondary role): "Are you open to OE — a concurrent secondary position?" If yes:
   - Add a `role_bucket` entry with `priority: oe`.
   - Capture OE comp range (STEP 6e).
3. Ask which job boards or aggregators the candidate typically uses. Write the answer as a candidate-specific board list. (These will be written to `config/search-sources.yml` via `--write-config` in STEP 15 so board selection reflects the candidate's domain, not a hardcoded tech list.)
4. Ask how fresh sourced postings should be: "When we search, do you want **since last run** (default), **24 hours**, **7 days**, **14 days**, or **30 days**?" Write the answer to `targeting.yml#search_preferences.posting_age`:
   - Since last run → `mode: "since-last-run"` and omit `days`.
   - Fixed window → `mode: "fixed-days"` and `days: <1|7|14|30 or user-specified positive number>`.
   This controls generated source recency (`config/search-sources.yml#searches[].recency`) and LinkedIn-style time-posted filters. It is separate from `targeting.yml#legitimacy.max_posting_age_days`, which only flags stale/evergreen postings during evaluation.
5. Ask which role families or seniority bands to exclude → write exclusions to `targeting.yml#cut_signals`.

**ONGOING GATE WRITE-BACK:** If the user volunteers a new exclusion, cut signal, or OE preference at any point, write it immediately per the Gate Write-Back Rule below.

---

## STEP 5 — KEEP + CUT SIGNALS

1. Ask: "What characteristics would make a role a priority?" Translate each stated preference into a concrete signal string in `targeting.yml#keep_signals`. Vague preferences ("good culture") are not signals; probe for specifics.
2. Ask: "What would immediately disqualify a posting?" Translate each answer into a concrete string in `targeting.yml#cut_signals`.
3. Hard cut signals: any one of these kills the posting (e.g. required clearance, mandatory on-site in a disqualifying city, specific excluded tool or practice).
4. Write-back any exclusion the user names to `targeting.yml#excluded_companies` immediately and confirm with "Written to targeting.yml: excluded_companies: [<name>]".

---

## STEP 6 — COMPENSATION (PRIVATE-FIRST)

Treat this section as private by default. Capture and write each field separately:

1. **(a) current_base** — Ask only if the user wants market guidance or negotiation suggestions. Store with `current_comp_shareable: false`. **NEVER surface current_base in any outbound artifact** (résumé, cover letter, form field, message, packet). This is a private gate input; all outbound comp comes from the fields below.
2. **(b) minimum_base** — Absolute walk-away floor; comp below this is a hard cut regardless of arrangement. Write to `profile.yml#compensation.minimum_base`.
3. **(b2) Arrangement floors (the comp gate)** — Comp tolerance usually changes with the work arrangement, so capture a base floor for each and write them to `profile.yml#compensation.comp_floors`. Ask explicitly: *"What base salary would each of these need to clear — fully remote, hybrid in your home metro, onsite in your home metro, and relocating to a new city?"* Write the four numbers as `comp_floors.remote`, `comp_floors.hybrid`, `comp_floors.onsite`, and `comp_floors.relocation` (the default relocation floor). Also write the home-metro match terms (city/state/region words that mean "no relocation") to `comp_floors.home_metro` so the gate can tell a home-metro role from a relocation. These are a **hard gate**: `evaluate-job` cuts any posting whose band tops out below the floor for its arrangement, and a relocation miss is a hard cut (not a soft hold). If the user gives one number for everything, set all four equal to it. Confirm: "These become the comp gate — postings under the floor for their arrangement get cut automatically."
4. **(c) target_base** — Default negotiation anchor (what to aim for in a salary conversation). Write to `profile.yml#compensation.target_base`.
4. **(d) expected_base** — The number to enter in a salary **form field** on an application. May differ from the negotiation anchor (e.g. anchor = $160K, form field = $165K). Write to `profile.yml#compensation.expected_base`. Also write to `form-defaults.yml#expected_base` so apply-job has a direct lookup. Confirm: "This is what goes on application forms — never your current salary."
5. **(e) OE range** — If an OE bucket was chosen in STEP 4: capture `oe_min_base` and `oe_max_base`. Write to `profile.yml#compensation`. The overall `minimum_base` does NOT apply to OE roles; each OE bucket has its own floor.
6. **(f) Additional comp context** — Ask about: `cash_over_equity` preference, equity tolerance, bonus tolerance, currency.
   - **Lifestyle-burden multiplier** (separate concept): "If a role requires more travel or on-site time than your norm, does your comp floor rise?" If yes, capture the premium amount or percentage as a free-text note in `profile.yml#compensation.relo_package_needs` under a key like `burden_premium` (e.g. `"$20K uplift for >2 days/week on-site"`). This feeds the lifestyle sliding-scale in `evaluate-job` and `apply-job`.
   - **Relocation package arithmetic** (distinct concept): if the candidate would consider relocation, ask what they need covered (e.g. "first + last + deposit", "moving company + 30-day temp housing"). Write as a separate note in `profile.yml#compensation.relo_package_needs` (free-text field, §2 of foundations-spec). If both burden premium and relo needs exist, store both as a combined string: `"burden: $20K uplift for >2d/wk; relo: first+last+deposit+moving"`.

7. **(g) Fit auto-drop floor** — Ask: "Below what fit score should roles auto-drop without asking you? (e.g. 80; leave blank to never auto-drop)" Write the answer as an integer to `targeting.yml#targeting.fit_bands.fit_floor`. This is optional — omit the field entirely when the user leaves it blank (no auto-drop, default behavior unchanged).

8. **(h) Unposted comp estimation** — No intake needed. When a job posting has no listed comp band, the gate automatically estimates a likely range from comparable roles already in the tracker (same role family + arrangement/metro). The estimate strengthens as more tracker rows accumulate. Nothing to capture here; it works from data the candidate already has.

9. **(i) Benefits & perks priorities** — **Gated: only ask if `setup-state.json#optional_areas` includes `"benefits"`.**

   > "Which benefits or perks actually matter to you — and in what order of priority? For example: health/dental/vision, 401k with employer match, equity/options, unlimited PTO, parental leave, learning budget, home-office stipend, commuter benefits. List the ones you care about, roughly in order."

   Write the response as `compensation.benefits_priorities: string[]` in `candidate/profile.yml`. Capture the user's own words — don't normalize to a fixed list. Example shape:

   ```yaml
   compensation:
     benefits_priorities:
       - "health/dental/vision (fully covered)"
       - "401k with 4%+ match"
       - "equity or profit-sharing"
       - "flexible PTO"
   ```

   This field informs comp negotiation framing and `email-comms` counter-offer drafts. If the user says "I don't care about benefits" or skips this, omit the field.

After writing all comp fields: run `grep -i current_comp_shareable candidate/profile.yml` and confirm the output shows `current_comp_shareable: false`. If absent or true, write/correct it before continuing. Report: "current_base stored private; expected_base and minimum_base available for outbound use."

---

## STEP 7 — LOCATION, HYBRID, LIFESTYLE

1. Capture: home city, state, country, timezone.
2. Remote / hybrid / on-site tolerance. If hybrid is acceptable: max commute days per week.
3. Travel tolerance (none / occasional / frequent / any).
4. Relocation cities (if any). For each relo city, ask if there is a per-city comp floor that differs from the default relocation floor (STEP 6 b2). When one differs, write it **structurally** as an entry in `profile.yml#compensation.comp_floors.relocation_by_metro[]` — `{ label, floor, match: [<location words for that metro>] }` — so the gate enforces it (free-text notes are NOT read by the gate). High-cost metros (e.g. Bay Area) commonly carry a higher floor than the default.
5. Any family or lifestyle constraints that affect geography or travel.
6. Write all location fields to `profile.yml#location`.

---

## STEP 8 — WORK AUTHORIZATION

1. Which countries is the candidate authorized to work in?
2. Requires sponsorship now or in the future?
3. Notice period (days/weeks) and earliest start date.
4. Write to `profile.yml#authorization`.

---

## STEP 9 — EDUCATION + DEGREE POLICY

1. Highest degree earned (or none).
2. Should an education section appear on the résumé?
3. How to handle postings where a degree is listed as required vs. preferred?
4. Write education facts to `honesty.yml#education`. Write `degree_policy` to `targeting.yml`.

---

## STEP 10 — EXCLUDED COMPANIES + CATEGORIES + APPLICATION LIMITS

1. Ask for named companies to never apply to and company categories to exclude (e.g. defense contractors, tobacco, crypto). Write each to `targeting.yml#excluded_companies`. Include an optional per-company `comp_override_threshold` if the user would reconsider at a sufficiently high offer.
2. Ask about headcount or funding-stage limits (if any) → add to `targeting.yml#cut_signals`.
3. If the user mentions a per-company application cap or cooldown they already know ("I applied to Acme 3 months ago, 6-month cooldown"): write it immediately to `candidate/application-limits.yml` and confirm.

---

## STEP 11 — FORM DEFAULTS

1. Default "how did you hear about us" source label.
2. Work authorization and sponsorship answers for ATS form fields.
3. Current employer and current title (as typically entered in ATS forms).
4. LinkedIn, GitHub, portfolio URLs (confirm these match profile.yml).
5. EEO/demographic default answer.
6. `auto_submit` — confirm explicitly: "Do you want applications submitted automatically when a form is filled, or do you want a confirm step every time?" Default is `false` (confirm-first). Only flip to `true` on explicit opt-in.
7. Write all fields to `candidate/form-defaults.yml`.

---

## STEP 12 — PUBLIC PROOF POINTS + HONESTY BOUNDARIES

1. Collect key projects with verifiable outcomes and metrics. For each: public link (repo, demo, article, talk, press, case study), allowed claim wording, any forbidden phrasing. Write to `candidate/evidence.yml`.
2. Ask: "What is your core edge or differentiator in your field?" Capture the answer as a lead claim in `evidence.yml`.
3. Skills and tools — capture in three buckets in `honesty.yml#tools`:
   - `confirmed`: proficient, can claim without qualification.
   - `adjacent`: learning or adjacent; qualify claims.
   - `do_not_claim`: not proficient; never assert on application or in interview.
4. Claims never to fabricate → write to `honesty.yml#claims.do_not_fabricate`.

---

## STEP 13 — TOOLCHAIN DETECTION

1. Run these checks and show the user the output:
   - `which pandoc`
   - `which soffice`
   - Check for a `.docx` résumé template in the repo root or `templates/`.
2. Based on results, propose a toolchain: `pandoc` | `libreoffice` | `word` | `markdown-only`.
3. Confirm with the user.
4. Write `candidate.toolchain` to `profile.yml#candidate.toolchain` (EXACT enum value: `pandoc`, `libreoffice`, `word`, or `markdown-only`). This field is read by `tailor-application` and `apply-job` to call the right build command.

---

## STEP 14 — WRITING SAMPLES

1. Instruct the user: "Drop any candidate-authored writing into `workspace/writing-samples/`. This includes emails, cover letters, docs, Slack posts, blog posts, PR descriptions."
2. Check: `ls workspace/writing-samples/`. If files are present, run `npm run calibrate:style` and confirm `candidate/writing-style.md` was written.
3. If no samples are present yet, note that the user can run `npm run calibrate:style` later after adding samples.

---

## STEP 14b — CAPABILITY OPT-IN (Advanced mode only)

**Basic mode:** skip this step entirely. Note once: "Browser automation and mail capture are available whenever you want them — run `careerrat automation status` to see the full capability matrix and enable what you need."

**Advanced mode:** surface each capability below, ask for each opt-in, then record decisions via the CLI (never hand-edit `candidate/automation.yml`). Everything stays OFF until the user explicitly goes through the CLI steps.

---

**Browser automation capabilities** (from `src/core/automation/consent.mjs`):

| Key | Label | What it does | Platforms | Needs |
|---|---|---|---|---|
| `status_polling` | Portal status polling | Reads application status from ATS dashboards (read-only) | greenhouse, workday, ashby, lever | Session browser + ToS consent per platform |
| `authenticated_search` | Authenticated search scanning | Runs logged-in saved-search scraping to surface new postings | linkedin, indeed, wellfound, glassdoor | Session browser + ToS consent per platform |
| `messaging` | In-platform messaging | Reads in-platform DMs into `communications[]` (read-only; replies go through `email-comms`) | linkedin, wellfound | Session browser + ToS consent per platform |
| `one_click_apply` | Authenticated one-click apply | Modal-driven apply under the `apply-job` submit gate; halts before final submit unless `auto_submit: true` | linkedin | Session browser + ToS consent |
| `profile_optimize` | LinkedIn profile optimize (read + suggest) | Reads your profile and proposes honest, evidence-backed rewrites of headline / About / experience / Featured (read-only; dry-run preview, also runs as a no-browser fix-doc) | linkedin | Session browser + ToS consent |
| `profile_apply` | LinkedIn profile apply (write back) | Writes the approved profile rewrites back through the session browser, **confirm-first per field**; separate switch from `profile_optimize` (suggestions on never implies write-back) | linkedin | Session browser + ToS consent + `profile_optimize` |
| `mail_access` | Session webmail access | Reads one specific recent verification-code email during apply/sign-in flows from any provider via `webmail`, or opted-in Gmail/Outlook recruiting messages for `ingest-mail`; never sends/deletes/replies or browses the broader inbox | gmail, outlook, webmail | Session browser + ToS consent per mail provider |

**Mail capability:**

| Capability | What it does | Platform | Needs |
|---|---|---|---|
| Mail capture (`ingest-mail`) | Reads job-search email locally from Apple Mail (read-only, no IMAP credentials leave the machine) | macOS Apple Mail only | macOS (`uname` must return `Darwin`); Apple Mail running; Automation access in System Settings → Privacy & Security |
| Webmail capture (`mail_access`) | Reads job-search email from Gmail/Outlook through the session browser when explicitly enabled. Generic `webmail` is for verification-code reads only, not inbox sync. | gmail, outlook | Session browser + ToS consent per mail provider |

---

**Session browser — install the extension first.** Prefer the **Chrome extension** (Claude-in-Chrome or equivalent): it already holds the user's logins and password store, so no credentials are ever stored by Rolester. The fallback is a **Playwright persistent profile** (`~/.rolester/board-profiles/<platform>`) that the user signs into once per platform. All skill prose says "use the session browser" — specific tool names are an implementation detail. See `docs/BROWSER.md` and the Browser Automation Contract in `AGENTS.md`.

**No credentials are ever stored by Rolester.** The browser session holds the logins.

---

**Opt-in process per capability + platform the user wants to enable:**

Warn the user: automating a logged-in platform may violate that platform's terms of service — they must read those terms themselves before proceeding. Then, for each capability+platform they choose:

```
careerrat automation consent <platform> --write
careerrat automation enable <capability> --write
careerrat automation enable <capability> <platform> --write
careerrat automation status
```

Dry-run is the default (prints the change without writing); `--write` commits. Run `careerrat automation status` at the end to confirm the live verdict. Rolester records the decision; it does not make it for you. **Never auto-run and never run on a schedule** — every automated session is user-initiated.

After running through all capabilities the user wants: set `automationOffered: true` in `workspace/setup-state.json` and append `capabilities` to `completed[]`.

---

## STEP 15 — VALIDATE + MATERIALIZE

Run these commands in sequence. Fix any failure before proceeding to the next.

1. Run `careerrat ingest --check --json`. Inspect the JSON output to identify any fields with placeholder values or schema errors. Fix each one before continuing.
2. Run `node src/cli/lint-placeholders.mjs candidate/` to confirm no template placeholder strings remain.
3. Run `careerrat ingest --write-config`. Confirm:
   - `config/search-sources.yml` was written with N search definitions (domain-appropriate, NOT hardcoded tech boards).
   - `candidate/AGENTS.md` was written.
   - Neither file contains `current_base` data — verify by grepping: `grep -i current_base candidate/AGENTS.md config/search-sources.yml`.
4. Run `careerrat doctor` to confirm overall workspace health (skill discoverability, schema validity, tracker state).
5. Once materialization succeeds and the user confirms they are satisfied: set `complete: true` and `updatedAt` in `workspace/setup-state.json` (read-modify-write).
6. **Shallow mode:** if `deferred[]` is non-empty, report which steps remain and how to resume them:

   > "Deferred steps: `<list>`. To continue, re-run `ingest-profile` (or `careerrat ingest`) and setup will resume from the first deferred step."

7. Report a summary: list every file written, call out any known limitations that apply to this candidate (e.g. board-preference persistence, `word` toolchain manual build), and confirm `current_base` did not appear in any outbound-facing file.

---

## STEP 16 — POST-ONBOARDING DISCOVERY HANDOFF

Onboarding complete means the candidate profile and baseline source config exist. It does
**not** mean the job market has been searched yet.

Hand off in this exact order:

```
setup-searches -> research-boards -> discover-companies -> search-jobs
```

1. `setup-searches` — confirm or refresh the baseline `config/search-sources.yml` from
   targeting and show `careerrat searches` readiness.
2. `research-boards` — find additional boards/aggregators for this candidate's domain.
   This is confirm-first; run it unless the user explicitly says the baseline sources are
   enough for now.
3. `discover-companies` — find employers and wire their Ashby/Greenhouse/Lever/Workable/
   SmartRecruiters boards into `config/sourced-scan.json`. This is confirm-first; run it
   before the first sweep unless the user explicitly wants a board-only search.
4. `search-jobs` — run the first sourced sweep only after the source and company discovery
   steps are complete or intentionally skipped.

End the onboarding summary with:

```
NEXT DISCOVERY ORDER: setup-searches -> research-boards -> discover-companies -> search-jobs
NEXT: run setup-searches, then research-boards, then discover-companies before the first search-jobs sweep.
```

---

## ONGOING GATE WRITE-BACK RULE

Any time the user states a new gate during this interview — an exclusion, cut signal, comp floor, honesty boundary, per-company cap, or cooldown — write it to the appropriate `candidate/` file **immediately** and confirm before moving on:

- Exclusion → `targeting.yml#excluded_companies`
- Cut or keep signal → `targeting.yml#cut_signals` / `keep_signals`
- Comp floor or anchor → `profile.yml#compensation` (minimum_base, target_base, or expected_base only — not current_base)
- Per-company cap / cooldown → `application-limits.yml`
- Honesty boundary → `honesty.yml`

**Friction level:**
- *Write-and-report* for unambiguous, low-blast-radius gates (one clear cut signal; a cap the user just named): write it, then echo `Written to <file>: <key: value>`.
- *Confirm-first* for consequential gates (broad company exclusion, lowering comp floor, large re-rank): propose the exact change, get a yes, then write.

A stated gate must never live only in chat. It must never be hardcoded into a skill.

---

## Rules

- **Persistence cadence.** After completing each major step, append its step key to `completed[]` in `workspace/setup-state.json` and refresh `updatedAt` (read-modify-write; keep the JSON minimal). Step keys: `domain`, `identity`, `projects-scan`, `work-history`, `targets`, `keep-cut`, `comp`, `location`, `authorization`, `education`, `exclusions`, `form-defaults`, `proof-points`, `toolchain`, `writing-samples`, `capabilities`, `materialize`, `discovery-handoff`. The `setup-state.json` shape also carries `question_style`, `optional_areas`, and `agent_voice` (set in STEP 0a). On a deliberate pause, do the same and tell the user: "Progress saved — re-run `ingest-profile` (or `careerrat ingest`) to resume."
- Never invent facts. Ask or omit — do not guess.
- Keep `current_base` private. Store it with `current_comp_shareable: false`. It must never appear in any résumé, cover letter, form field, ATS entry, recruiter message, interview packet, or shareable tracker note. This is enforced by field path: always read outbound comp from `expected_base`, `target_base`, or `minimum_base`.
- Keep `current_base` separate from `expected_base`. They are different fields and must never be conflated. `expected_base` is what goes on forms; `current_base` is a private gate input only.
- Translate stated preferences into explicit keep/cut signal lists in `targeting.yml`. Vague preferences are not signals.
- Replace all placeholder identity values from the templates (`Jane Candidate`, `jane@example.com`, `+1-555-0100`, etc.). `careerrat ingest --check --json` runs `lint:placeholders` and will reject any file that still contains known placeholder strings.
- Treat all `candidate/` files as private user-layer data — they are gitignored and must never be committed to the system repo.
- Never surface domain-specific assumptions (tech/AI titles, specific cities, specific tool names) from skill prose. Every candidate-specific value lives in their config files.

---

## Outputs

| Output file | Written by | Schema |
|---|---|---|
| `candidate/profile.yml` | direct edit (confirmed from template) | `config/profile.schema.json` |
| `candidate/targeting.yml` | direct edit (confirmed from template) | `config/targeting.schema.json` |
| `candidate/evidence.yml` | direct edit, or `careerrat evidence add` (STEP 2b folder/repo scan) | `config/evidence.schema.json` |
| `candidate/honesty.yml` | direct edit (confirmed from template) | `config/honesty.schema.json` |
| `candidate/form-defaults.yml` | direct edit (confirmed from template) | `config/form-defaults.schema.json` |
| `candidate/application-limits.yml` | direct edit on gate capture | (schema if present) |
| `candidate/writing-style.md` | `npm run calibrate:style` from `workspace/writing-samples/` | — |
| `candidate/AGENTS.md` | `careerrat ingest --write-config` | — |
| `config/search-sources.yml` | `careerrat ingest --write-config` (domain-appropriate boards) | `config/search-sources.schema.json` |
| `workspace/setup-state.json` | this skill (the agent writes it directly — no CLI mutation) | none — small JSON progress record |

---

## Config notes

- **Comp fields are schema-backed (shipped).** `compensation.expected_base`,
  `oe_min_base`, `oe_max_base`, and `relo_package_needs` all exist in
  `profile.schema.json` (Foundation B) — write them as their native types
  (numbers for the comp values, string for `relo_package_needs`), not as freeform
  notes.
- **Board selection is domain-gated (shipped).** `careerrat ingest --write-config`
  routes through `generate-search-sources.mjs`, which gates tech aggregators (e.g.
  RemoteVibeCodingJobs) behind `isTechDomain(candidate.domain)` and keeps
  HiringCafe as a general aggregator. Still spot-check the written
  `config/search-sources.yml` against the candidate's stated boards (STEP 4) so the
  source list matches their field — but it is no longer a hardcoded tech list.
- **Posting-age search preference is schema-backed.** `targeting.yml#search_preferences.posting_age`
  feeds generated source recency. `mode: "since-last-run"` keeps incremental search
  behavior; `mode: "fixed-days"` plus `days: <positive number>` always scans that
  posting-age window. Do not confuse this with `legitimacy.max_posting_age_days`,
  which is a stale-posting review signal after a posting is found.
- **`candidate/application-limits.yml` is intentionally schema-less.** There is no
  `application-limits.schema.json`; the file is freeform YAML (per-company caps,
  cooldowns, reevaluation thresholds) consumed directly by the skills. Write it
  from `templates/application-limits.example.yml` and validate its structure
  against that template by eye.
