---
name: ingest-profile
description: "Interview a new candidate to produce all user-layer config files: profile, targeting, evidence, honesty boundaries, form defaults, writing style, personalized AGENTS.md, and seed search sources. Run on first setup or any major profile change."
---

# ingest-profile

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

> **Agent voice.** Read candidate modes through the shared DB-first accessor (`modes.agent_voice`, default `standard`) before producing any summary or explanation output. Apply the register semantics from AGENTS.md#mode-switches. This skill's interview is conversational by design, but **step confirmations, progress summaries, and section wrap-ups** must respect the register — e.g. `exec-summary` means a one-line "Got it — moving to targets" not a paragraph recap. Do not ask for a voice mode during initial setup; keep the stored value or use `standard`.

> **Write mechanism depends on context.** This skill runs in two places, and only one has a shell:
>
> - **One-shot CLI context** — an agent shell exists. Every `careerrat ...` command named throughout this file runs directly, as written.
> - **Conversational chat context** (the onboarding screen, now the primary path) — tools are Read/Glob/Grep/Skill only. There is no shell, so every `careerrat ...` command in this file is unreachable. The only way to save anything is to emit a fenced confirm block, which renders as a pill the user clicks to write it:
>
>   ```careerrat:confirm
>   {"kind":"candidate_patch","summary":"Your name and contact details","payload":{"doc":"profile","patch":{"candidate":{"full_name":"Ada Lovelace","email":"ada@example.com"}}}}
>   ```
>
>   `doc` is one of `profile`, `targeting`, `honesty`, `form-defaults`; `patch` is the field(s) at their real schema path. For work-history/evidence claims, use the evidence-claim shape instead:
>
>   ```careerrat:confirm
>   {"kind":"evidence_claim","summary":"Ran a 12-person kitchen","payload":{"claim":"Ran a 12-person kitchen","evidence":"Candidate-stated during setup interview"}}
>   ```
>
> Per-step instructions below just say "confirm-block it" — that means emit the appropriate block above with that step's `doc`/`patch` (or `claim`/`evidence`) filled in. Where a step names only a `careerrat` command, use the confirm-block equivalent in chat context: same target field(s), same value(s).
>
> **Protected local setting.** The local Application defaults UI owns voluntary
> self-identification policy and exact answers. Never ask for, read, or patch voluntary self-identification. It is intentionally absent from agent-visible candidate context,
> including `form-defaults` reads and `candidate_patch` confirmation blocks.
>
> **Progressive notes are immediate.** In conversational chat, confirm-block each explicit fact immediately in the same response that acknowledges it. Do not wait for related identity or contact fields, the rest of a step, or the next turn. If the candidate says only their name, emit a profile patch for `full_name` now, then ask for the next genuinely missing fact. This is what fills Paul's Notes as the conversation unfolds; the block remains a proposal until the candidate clicks Confirm.
>
> **Every question is state-aware.** Before composing each response, inspect both saved candidate data and unresolved confirm blocks in the conversation. Never ask for a fact already present in canonical or pending state. A generic save receipt is not the source of truth; the current candidate snapshot and the actual pending block payloads are. Ask again only when the candidate explicitly corrects a value or the saved value is genuinely incomplete for the field being collected.
>
> **Every candidate-facing question must use plain English.** Ask about the real-life
> choice, not the internal field or recruiting label. When a question asks about an
> abstract choice, include two or three short, concrete examples in the same sentence.
> Tailor them to facts already known when possible; otherwise use domain-neutral examples.
> Examples help the candidate understand the question. They are not a fixed answer menu.
>
> **Conversational completion is a hard boundary.** When canonical state shows `setupProgress.complete: true`, initial setup is complete. If the candidate's latest message answers a question Paul asked before completion, emit its confirmation block before ending, even though the checklist just became complete. Never say a new fact is noted or saved unless it is already present in canonical state or the same response carries the confirmation block that can save it. Then acknowledge the candidate's latest message, ask no new initial-setup questions, and end with a concise statement rather than a question. Optional evidence, form defaults, toolchain choices, and other enrichment belong after onboarding and only when a later task needs them or the candidate asks for them.
>
> **Preserve compensation meaning.** If the candidate repeats a compensation value that matches a saved field and the transcript already establishes its meaning, preserve the stored compensation field. Never ask whether a repeated value is current_base or expected_base; current_base is private and must not be inferred or solicited. Ask about a different compensation concept only when it is required and genuinely missing.
>
> **List fields replace, they don't append.** A patch containing an array overwrites the whole stored array, so a block carrying one item of a list wipes every item saved before it. Whenever a patch targets a list field (`keep_signals`, `cut_signals`, `tools.*`, `claims.do_not_fabricate`, `benefits_priorities`, and any other array), send the **complete list** — every value gathered so far for that field, not just the newest one. Object fields deep-merge normally, so this only applies to lists.

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
   - If present and `complete: false`: tell the user where they left off by naming completed and deferred sections. Resume from the next incomplete step rather than restarting. Re-confirm completed sections ("I already have you as X — still right?") rather than re-asking them in full.
   - If present and `complete: true`: setup is already done. Confirm which section the user wants to revisit and jump there directly.
   - If absent: this is a fresh setup — proceed normally.
2. Run `careerrat ingest --check --json` to see which fields fail validation or still hold placeholder values.
3. Read existing candidate config through the agent-visible DB-first accessor. In legacy workspaces, the app runtime supplies the same sanitized view. Never read raw `candidate/form-defaults.yml`. Note what is already populated.
4. Check session memory and any pasted or attached documents (résumé, LinkedIn export, notes).
5. If the user supplied a résumé file path: run `careerrat ingest --resume <path> --json` to seed profile and evidence YAML from the parsed content. If `form-defaults#declined_fields.resume` is set or `setup-state.json` carries `resume_source: "none"`, they have already told us there is no résumé — skip every résumé prompt and run STEP 2a's conversational path instead.
6. For each section below, **open with a confirmation of what you already know** ("I have you as X — right?") rather than a cold question. Only ask for what is genuinely missing or unconfirmed.

---

## STEP 0a — START CLEANLY AND SAVE PROGRESS

Do not begin with mode, depth, question-style, optional-area, or voice menus. A new
candidate cannot make useful implementation choices before using the product. Setup
defaults to the full conversational setup with focused questions, standard agent voice,
and every external capability off.

Start from whatever the résumé and current session already established. Ask the first
missing candidate question, then save each settled answer immediately. If the user asks
for a shorter setup, set `depth: "shallow"` and defer nonessential sections at that
moment. Otherwise keep `depth: "deep"`. Optional benefits, lifestyle, and work-preference
details are captured only when the user naturally raises them or explicitly asks to add
them. A later explicit request to change agent voice still goes through
`careerrat modes set agent_voice <value> --write`.

Browser, mail, calendar, messaging, and application automation are capability-on-demand.
Do not enumerate them during initial setup and do not ask for a blanket automation mode.
When a concrete later task needs one, explain that one capability, show the platform-
specific consent confirmation, and leave every other capability off.

**Initialize `workspace/setup-state.json`:**

Write (or update) the file now with:

```json
{
  "depth": "deep",
  "question_style": "simple",
  "optional_areas": [],
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

1. If `candidate.domain` is not already set in candidate profile config, ask: "What field or industry are you searching in?" Use any detected context (résumé text, job titles, stated background) as the opening statement to confirm rather than cold-ask.
2. Write `candidate.domain` (free-text; e.g. `"software engineering"`, `"trucking/logistics"`, `"nursing"`, `"finance"`) through `careerrat data candidate patch profile --data ...` in DB mode. This field gates board selection in STEP 15 (`--write-config`).
3. If the candidate has clearly distinct search tracks (primary + secondary), record both in candidate profile/targeting config as structured context.

---

## STEP 2 — IDENTITY + RESUME SOURCE

1. Confirm or capture: `full_name`, `email`, `phone`, home location, `linkedin`, `github` (if applicable), `portfolio` (if applicable). Replace every placeholder string from the template (`Jane Candidate`, `jane@example.com`, `+1-555-0100`, etc.). The schema has no `location.city`/`state`/`country` object: write the display location as one string at `candidate.location`, and write the search home as one string at top-level `location.home`.
2. Ask where the source résumé lives (file path, paste, or URL) if not already provided.
3. **Corrupt/bad-paste gate:** If `careerrat ingest --resume <path>` produced empty contact or empty sections, say so and ask for a screenshot, plain-text paste, or different export before continuing. Never proceed on an unreadable parse.
4. **Save as you go, not at the end of the step.** Write each coherent group the moment it's settled — through `careerrat data candidate patch profile --data ...` in DB mode (legacy YAML is fallback only when no DB exists), or confirm-block it (`doc: "profile"`) in chat mode:
   - each explicitly stated name, email, or phone value immediately; never wait for all three
   - home location, once confirmed, with `candidate.location` and `location.home` both as strings
   - linkedin/github/portfolio, once confirmed (skip whichever don't apply)

   Don't hold any group back waiting on the others — an interruption mid-step should cost at most the group still in progress.

### STEP 2a — NO RÉSUMÉ (a supported way in, not a failure)

Some candidates have no résumé at all: first job, a long gap, a trade or shift-work
history that was never written down, a file lost two laptops ago. The onboarding screen
offers "I don't have a résumé. Help me start another way." as an opening move, so this
branch is a normal entry point and must never read as a problem to be solved.

Enter this branch when the candidate says they have no résumé, can't find one, or sends
that opening message.

1. **Take it in stride, in one line.** Something like: "No problem, plenty of people
   don't. We'll build it as we go — tell me about the work you've been doing." Do not
   apologize, do not explain the drawbacks, do not ask a second time later, and do not
   re-offer the upload at every step. Asking again reads as disbelief.
2. **Record it so nothing re-asks.** Write the decline immediately:

   ```
   careerrat data candidate patch form-defaults --data '{"declined_fields":{"resume":{"declined_at":"<ISO timestamp>"}}}'
   ```

   This is what lets the setup checklist count the résumé step as answered — without it
   the candidate is stuck one step short of complete forever. Also set
   `resume_source: "none"` in `workspace/setup-state.json` so a resumed session doesn't
   re-open the question.
3. **Offer the alternatives once, then move on.** In descending order of value: a
   LinkedIn profile URL or export, a projects folder or repo (STEP 2b, which mines real
   work), or simply answering questions. Let them pick one or none. Never require any.
4. **Get the work history by asking.** This step *is* the résumé for this candidate —
   there is no parsed document behind them, so anything not captured here does not exist
   anywhere. Walk employers one at a time, most recent first: what the place was, what
   they actually did there, roughly when they started and stopped, and what they'd point
   to as the thing they did best. Stop when they say that's all of it. Someone with no
   work history at all is still valid — take schooling, volunteer work, caretaking,
   military service, or self-taught projects as the history instead.
5. **Bank each employer as you finish it, not at the end of the walk.** The moment one
   employer's answers are in, write them before asking about the next:

   ```
   careerrat data candidate evidence --data '{"claim":"...","evidence":"Candidate-stated during setup interview"}'
   ```

   Batching to the end of the step means an interrupted session loses the whole history.
   Every claim originates from what the candidate said, so its `evidence` field reads as
   candidate-stated, not as a cited document. The Honesty Firewall applies unchanged: no
   metric they didn't give you, no title they didn't claim, no dates you inferred. Ask or
   omit.
   **This banking runs at every depth.** `work-history` is on STEP 0a's shallow-mode
   deferral list, but that deferral assumes a parsed résumé already seeded the bank. When
   STEP 2a ran, it did not — deferring here would leave a shallow-mode candidate with no
   evidence at all. Run it, then let STEP 3 confirm boundaries rather than re-collect.
6. **If they produce a résumé later**, run the normal parse (`careerrat ingest --resume
   <path>`), then clear the decline by patching `declined_fields.resume` to `null`. The
   banked conversational claims stay; reconcile duplicates by upsert rather than wiping
   the bank.

**Never do in this branch:** block any later step on the missing file, tell them their
setup is incomplete because of it, generate a résumé document and present it as theirs
without confirmation, or invent employers, dates, or numbers to fill the shape of a
résumé.

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

> **No résumé?** STEP 2a already gathered the history by asking. Don't re-walk it here —
> confirm what was captured and go straight to the truth boundaries below.

1. Ask which employers and titles are accurate as stated. Identify any gaps, overlaps, or tenure edge cases that need care.
2. Identify which metrics and outcomes are verified and citable with evidence.
3. Write each verified claim through `careerrat data candidate evidence --data ...` in DB mode: include `claim`, `evidence`, `metrics`, `links`, `allowed_wording`, `forbidden_wording`.
4. Never invent facts; ask or omit.

---

## STEP 4 — TARGET ROLES + ADJACENT ROLES + OPTIONAL OE BUCKET

1. Capture primary target title(s) and adjacent or stretch titles. Ask: **"What jobs should I search for first? For example, your current kind of work, a step up, or a related job you'd still be excited about."** Write the answer as `role_buckets[]` through `careerrat data candidate patch targeting --data ...` in DB mode. Every bucket must include a non-empty `name`, a priority (`primary` | `secondary` | `stretch` | `oe`), and a non-empty `titles` array.
2. Learn the candidate's **company thesis**, never a company allowlist. Ask one open question: **"What kinds of companies sound good to you? For example, a small growing company, a stable large employer, or an organization whose work you care about."** Translate only what the candidate actually says into `targeting.company_preferences`: `industries`, `organization_types`, `sizes`, `stages`, `business_models`, `values`, `geographies`, and named `examples`, plus `confirmed: true`. A named company is a priority example, not the boundary of the search; do not write it to `tracked_companies` unless its real supported ATS board is later resolved and approved by `discover-companies`. If the candidate has no preference, write `{ "confirmed": true }` so setup completes and say that broad discovery stays on. In DB mode write the settled object with `careerrat data candidate patch targeting --data '{"company_preferences":{...}}'`; in chat mode emit one `candidate_patch` confirmation block for the complete object. Explicitly confirm: "I'll use that to focus discovery, but every company you haven't ruled out can still show up."
3. Ask about over-employment only when the candidate naturally raises concurrent work or explicitly asks to configure it. Otherwise skip this question. If they opt in:
   - Add a `role_bucket` entry with `priority: oe`.
   - Capture OE comp range (STEP 6e).
4. **Job-board preferences belong to source setup.** In conversational chat, do not ask for job-board preferences during this interview because this surface has no durable write for them. setup-searches owns that question and its durable write immediately after profile setup. In a one-shot CLI context with a shell, the answer may be collected here only when the same run carries it directly into STEP 15's `careerrat ingest --write-config` and verifies the resulting `config/search-sources.yml`; otherwise defer it to `setup-searches` too.
5. Ask how fresh sourced postings should be: "When we search, do you want **since last run** (default), **24 hours**, **7 days**, **14 days**, or **30 days**?" Write the answer to candidate targeting config at `search_preferences.posting_age`:
   - Since last run → `mode: "since-last-run"` and omit `days`.
   - Fixed window → `mode: "fixed-days"` and `days: <1|7|14|30 or user-specified positive number>`.
   Write it via `careerrat data candidate patch targeting --data '{"search_preferences":{"posting_age":{"mode":"<mode>","days":<N>}}}'` in DB mode, or confirm-block it (`doc: "targeting"`) in chat mode. This controls generated source recency (`config/search-sources.yml#searches[].recency`) and LinkedIn-style time-posted filters. It is separate from `legitimacy.max_posting_age_days`, which only flags stale/evergreen postings during evaluation.
6. Ask: **"Are there any jobs or levels you don't want to see? For example, manager jobs, entry-level jobs, or temporary work."** Write exclusions through `careerrat gate cut-signal "<signal>" --write`.

**ONGOING GATE WRITE-BACK:** If the user volunteers a new exclusion, cut signal, or OE preference at any point, write it immediately per the Gate Write-Back Rule below.

---

## STEP 5 — KEEP + CUT SIGNALS

1. Ask: **"What would make one job worth applying to before another? For example, the kind of work, a schedule and pay that fit, or room to grow."** Translate each stated preference into a concrete signal string in candidate targeting config (`keep_signals`). If the candidate says something broad like "good culture," ask what that looks like to them in everyday terms. In DB mode write each one immediately with `careerrat gate keep-signal "<signal>" --write` (that command appends). In chat mode confirm-block it (`doc: "targeting"`, patch `keep_signals`) with the **full list** every time, per the list-fields rule at the top of this file. A block carrying one signal drops the rest.
2. Ask: **"What would make you skip a job right away? For example, required travel, a schedule you can't work, or an industry you won't join."** Translate each answer into a concrete string in candidate targeting config (`cut_signals`). Same mechanism as item 1: `careerrat gate cut-signal "<signal>" --write` appends in DB mode; in chat mode confirm-block the full `cut_signals` list.
3. Hard cut signals: any one of these kills the posting (e.g. required clearance, mandatory on-site in a disqualifying city, specific excluded tool or practice).
4. Write-back any exclusion the user names with `careerrat gate exclude-company "<Company>" --write --confirm` and echo the CLI confirmation.

---

## STEP 6 — COMPENSATION (PRIVATE-FIRST)

Treat this section as private by default. Capture and write each field separately:

1. **(a) current_base — THE MOST SENSITIVE FIELD IN THE SCHEMA.** Ask only if the user wants market guidance or negotiation suggestions. Ask: **"If you want advice based on what you earn now, what's your current base salary? I'll keep it private and never put it on an application."** **Always write `current_base` and `current_comp_shareable: false` together, in the same call — never write `current_base` alone:**

   ```
   careerrat data candidate patch profile --data '{"compensation":{"current_base":<N>,"current_comp_shareable":false}}'
   ```

   in DB mode, or confirm-block it in chat mode with both fields in the same patch:

   ```careerrat:confirm
   {"kind":"candidate_patch","summary":"Current base (private, never shared)","payload":{"doc":"profile","patch":{"compensation":{"current_base":120000,"current_comp_shareable":false}}}}
   ```

   **NEVER surface current_base in any outbound artifact** (résumé, cover letter, form field, message, packet, tracker note, or any other candidate-facing or employer-facing output). This is a private gate input only; all outbound comp comes from the fields below.
2. **(b) Compensation floor choice** — Ask one plain question first: **"Should I screen jobs by guaranteed pay, or by what you need to make in a full year including tips, commission, or cash bonuses?"** Offer **Guaranteed pay** and **Total annual earnings** as clickable choices when the surface supports them; typed answers mean the same thing.
   - **Guaranteed pay** → ask: **"What's the lowest guaranteed base pay you'd accept?"** Save `minimum_base` with `careerrat gate comp-floor <N> --write --confirm`.
   - **Total annual earnings** → ask: **"What's the least you need to make in a full year, including wages, tips, commission, or cash bonuses? Don't count equity or benefits."** Save `minimum_annual_earnings` with `careerrat gate comp-annual-floor <N> --write --confirm`.
   These are separate facts. Never turn tips, commission, or cash bonuses into guaranteed base pay, and never count equity or benefits toward annual cash earnings. A candidate may later save both floors.
3. **(b2) Arrangement floors (the comp gate)** — Comp tolerance usually changes with the work arrangement, so collect floors only for arrangements the candidate would accept. If saved targeting or cut signals already exclude full-time onsite work or relocation, do not ask for an onsite or relocation floor and do not invent one; preserve that arrangement as unavailable. Ask about each accepted arrangement one at a time. For example: *"What's the lowest base salary you'd accept for a fully remote job?"* On the next turn, ask the same plain question for hybrid, on-site, or relocation only if that arrangement is still in scope. Write the supplied numbers under their matching `comp_floors` keys (`remote`, `hybrid`, `onsite`, `relocation`) plus the home-metro match terms as `comp_floors.home_metro`, omitting disallowed arrangements, in one `careerrat data candidate patch profile --data ...` call in DB mode or one confirm block (`doc: "profile"`) in chat mode. These are a **hard gate**: `evaluate-job` cuts any posting whose band tops out below the floor for its allowed arrangement, while the saved cut signal rejects unavailable arrangements. If the user gives one number for every arrangement they accept, set each allowed arrangement equal to it. Confirm: "I'll automatically skip jobs whose listed pay is below the minimum you set for that kind of work."
4. **(c) target_base** — Ask: **"What base salary would you aim for when negotiating?"** This is the default negotiation anchor. Write it with `careerrat gate comp-target <N> --write --confirm`.
5. **(d) expected_base** — Ask: **"What base salary should I enter when an application form requires one? This is never your current salary."** This number may differ from the negotiation anchor. In a one-shot CLI context, write it with `careerrat gate comp-expected <N> --write` and also patch `form-defaults.expected_base` so apply-job has a direct lookup. In conversational chat, emit one form-defaults confirmation block for `expected_base`, not separate profile and form-defaults proposals; the web surface mirrors that confirmed value into profile compensation from the same click.
6. **(e) OE range** — If an OE bucket was chosen in STEP 4: capture `oe_min_base` and `oe_max_base`. Write with `careerrat data candidate patch profile --data '{"compensation":{"oe_min_base":<N>,"oe_max_base":<N>}}'` in DB mode, or confirm-block it (`doc: "profile"`) in chat mode. The overall `minimum_base` does NOT apply to OE roles; each OE bucket has its own floor.
7. **(f) Additional comp context** — Ask one question at a time. Start with: **"When a job offers salary, a bonus, and ownership in the company, which matters most to you? For example, more guaranteed salary, more potential upside, or a balance."** Ask the currency separately only when it is not already clear. Store the answers as the `cash_over_equity` preference, equity tolerance, bonus tolerance, and currency.
   - **Lifestyle-burden multiplier** (separate concept): Ask: **"Would you need more pay for a job with more travel or office days than you normally want?"** If yes, ask how much more on the next turn, then capture the premium amount or percentage under `relo_package_needs` with a key like `burden_premium` (e.g. `"$20K uplift for >2 days/week on-site"`). This feeds the lifestyle sliding-scale in `evaluate-job` and `apply-job`.
   - **Relocation package arithmetic** (distinct concept): if the candidate would consider relocation, ask what they need covered (e.g. "first + last + deposit", "moving company + 30-day temp housing"). Write as a separate note in `relo_package_needs` (free-text field, §2 of foundations-spec). If both burden premium and relo needs exist, store both as a combined string: `"burden: $20K uplift for >2d/wk; relo: first+last+deposit+moving"`. Write it with `careerrat data candidate patch profile --data '{"compensation":{"relo_package_needs":"<string>"}}'` in DB mode, or confirm-block it (`doc: "profile"`) in chat mode.

8. **(g) Fit auto-drop floor** — Ask first: **"Do you want me to hide weak matches automatically?"** If they say yes, ask next: **"What match score should I use as the cutoff? For example, 80 means jobs scoring below 80 stay out of your results."** Write the answer as an integer with `careerrat data candidate patch targeting --data '{"fit_bands":{"fit_floor":<N>}}'` in DB mode, or confirm-block it (`doc: "targeting"`) in chat mode. This is optional. Omit the field entirely when the user says no or leaves it blank.

9. **(h) Unposted comp estimation** — No intake needed. When a job posting has no listed comp band, the gate automatically estimates a likely range from comparable roles already in the tracker (same role family + arrangement/metro). The estimate strengthens as more tracker rows accumulate. Nothing to capture here; it works from data the candidate already has.

10. **(i) Benefits & perks priorities** — **Gated: only ask if `setup-state.json#optional_areas` includes `"benefits"`.**

   > "Which benefits or perks actually matter to you — and in what order of priority? For example: health/dental/vision, 401k with employer match, equity/options, unlimited PTO, parental leave, learning budget, home-office stipend, commuter benefits. List the ones you care about, roughly in order."

   Write the response as `compensation.benefits_priorities: string[]` with `careerrat data candidate patch profile --data '{"compensation":{"benefits_priorities":["<item>", "..."]}}'` in DB mode, or confirm-block it (`doc: "profile"`) in chat mode. Capture the user's own words — don't normalize to a fixed list. Example shape:

   ```yaml
   compensation:
     benefits_priorities:
       - "health/dental/vision (fully covered)"
       - "401k with 4%+ match"
       - "equity or profit-sharing"
       - "flexible PTO"
   ```

   This field informs comp negotiation framing and `email-comms` counter-offer drafts. If the user says "I don't care about benefits" or skips this, omit the field.

After writing all comp fields: read candidate profile config and confirm `current_comp_shareable: false`. If absent or true, write/correct it before continuing. Report which saved floor CareerRat will use: guaranteed `minimum_base`, `minimum_annual_earnings` from wages/tips/commission/cash bonuses, or both. Equity and benefits never clear either cash floor.

---

## STEP 7 — LOCATION, HYBRID, LIFESTYLE

Save each group the moment it's settled — through `careerrat data candidate patch profile --data ...` in DB mode, or confirm-block it (`doc: "profile"`) in chat mode — rather than holding everything to the end of the step.

1. Capture: home city, state, country, timezone. Save this group once confirmed.
2. Remote / hybrid / on-site tolerance. If remote is acceptable, explicitly ask whether the candidate is eligible for remote roles only within their home country or worldwide. Save that answer as `profile.location.remote_scope: "home-country" | "worldwide"` in the same write as `profile.location.remote`; older profiles without the field default to `home-country`. This scope applies only to fully remote roles. Hybrid and on-site eligibility stays limited to the saved home and relocation markets. If hybrid is acceptable: max commute days per week. Save this group once settled.
3. Travel tolerance (none / occasional / frequent / any). Save it once settled.
4. Relocation cities (if any). For each relo city, ask if there is a per-city comp floor that differs from the default relocation floor (STEP 6 b2). When one differs, write it **structurally** in candidate profile compensation as `comp_floors.relocation_by_metro[]` — `{ label, floor, match: [<location words for that metro>] }` — so the gate enforces it (free-text notes are NOT read by the gate). High-cost metros (e.g. Bay Area) commonly carry a higher floor than the default. Save this the same way, per relo city, as each is settled.
5. Ask about family or lifestyle constraints only when optional_areas includes lifestyle or the candidate raises one naturally. Otherwise skip this question. Save a constraint once settled.
6. Confirm every group above is written before moving to STEP 8 — nothing here should still be sitting in chat only.

---

## STEP 8 — WORK AUTHORIZATION

1. Which countries is the candidate authorized to work in?
2. Requires sponsorship now or in the future? Once both answers are in, save this authorization-status group immediately: `careerrat data candidate patch profile --data ...` in DB mode, or confirm-block it (`doc: "profile"`) in chat mode. Don't wait on notice period below.
3. Ask for the candidate's notice period in days or weeks. Save it immediately as `profile.authorization.notice_period` through `careerrat data candidate patch profile --data ...` in DB mode, or a `candidate_patch` confirm block with `doc: "profile"` in chat mode. Never save it under `form-defaults.notice_period`, which is not a supported field. Do not ask for an earliest possible start date during initial setup; collect availability later when a specific application or scheduling task needs it.
4. Confirm both authorization status and notice period are written before moving to STEP 9 — nothing here should still be sitting in chat only.

---

## STEP 9 — EDUCATION + DEGREE POLICY

1. Highest degree earned (or none). Save it immediately: `careerrat data candidate patch honesty --data ...` in DB mode, or confirm-block it (`doc: "honesty"`) in chat mode.
2. Should an education section appear on the résumé?
3. How to handle postings where a degree is listed as required vs. preferred? Once 2 and 3 are both answered, save them together as `degree_policy`: `careerrat data candidate patch targeting --data ...` in DB mode, or confirm-block it (`doc: "targeting"`) in chat mode.
4. Confirm both writes above landed before moving to STEP 10 — nothing here should still be sitting in chat only.

---

## STEP 10 — EXCLUDED COMPANIES + CATEGORIES + APPLICATION LIMITS

1. Ask for named companies to never apply to and company categories to exclude (e.g. defense contractors, tobacco, crypto). Write each named exclusion through `careerrat gate exclude-company "<Company>" --write --confirm`. Include an optional per-company `comp_override_threshold` only when the owning DB verb supports it; do not hand-edit YAML in DB mode.
2. Ask about headcount or funding-stage limits only when optional_areas includes work-preferences or the candidate raises one naturally. Otherwise skip this question. Add any settled limit to cut signals through `careerrat gate cut-signal "<signal>" --write`.
3. If the user mentions a per-company application cap or cooldown they already know ("I applied to Acme 3 months ago, 6-month cooldown"): after confirmation, write `careerrat data candidate limits upsert --data '<json row>'` in DB mode; legacy mode writes `candidate/application-limits.yml`.

---

## STEP 11 — FORM DEFAULTS

Save each item below through `careerrat data candidate patch form-defaults --data ...` in DB mode, or confirm-block it (`doc: "form-defaults"`) in chat mode, as soon as it's settled — don't hold it to the end of the step.

1. Default "how did you hear about us" source label. Save it immediately.
2. Work authorization and sponsorship answers for ATS form fields. In form-defaults work_authorization and requires_sponsorship are strings: use Yes or No, never booleans. Save this group once settled.
3. Current employer and current title (as typically entered in ATS forms). Save this group once settled.
4. LinkedIn, GitHub, portfolio URLs (confirm these match candidate profile config). Profile link fields are strings; use an empty string when the candidate has no link, never `null`. In conversational chat, emit one profile confirmation block for LinkedIn, GitHub, and portfolio, not a second form-defaults proposal; the web surface mirrors those confirmed links into form-defaults from the same click. In a one-shot CLI context, write both documents. Save this group once settled.
5. Do not handle voluntary self-identification here. After Paul finishes setup, the local Application defaults UI asks whether forms should leave those questions blank or choose a decline option. That policy and any exact answers stay outside agent context and are never proposed in chat.
6. Final submission is not a preference to collect or persist. CareerRat always stops before the final submit control, and only the user can submit. Never write a submission setting into form-defaults.
7. Confirm every supported item above is written before moving to STEP 12 — nothing here should still be sitting in chat only.

---

## STEP 12 — PUBLIC PROOF POINTS + HONESTY BOUNDARIES

1. Collect key projects with verifiable outcomes and metrics. For each: public link (repo, demo, article, talk, press, case study), allowed claim wording, any forbidden phrasing. Write through `careerrat data candidate evidence --data ...` in DB mode.
2. Ask: **"What do you do especially well that you'd want an employer to know? For example, fixing messy processes, helping a team through change, or making complicated work easier."** Capture the answer as a lead claim, written the same way as item 1: `careerrat data candidate evidence --data '{"claim":"<answer>","evidence":"Candidate-stated during setup interview"}'` in DB mode, or confirm-block it in chat mode:

   ```careerrat:confirm
   {"kind":"evidence_claim","summary":"Core differentiator","payload":{"claim":"Turns around understaffed teams without raising headcount","evidence":"Candidate-stated during setup interview"}}
   ```

3. Skills and tools — capture in three buckets in `honesty.yml#tools`:
   - `confirmed`: proficient, can claim without qualification.
   - `adjacent`: learning or adjacent; qualify claims.
   - `do_not_claim`: not proficient; never assert on application or in interview.
   Write all three buckets in one call: `careerrat data candidate patch honesty --data '{"tools":{"confirmed":["..."],"adjacent":["..."],"do_not_claim":["..."]}}'` in DB mode, or confirm-block it (`doc: "honesty"`) in chat mode. Any single `do_not_claim` item volunteered later in the interview also goes through `careerrat gate do-not-claim "<tool>" --write` per the Gate Write-Back Rule below; in chat mode, re-send the whole bucket (list-fields rule at the top of this file), not just the new tool.
4. Claims never to fabricate → write to `honesty.yml#claims.do_not_fabricate` with `careerrat gate do-not-fabricate "<claim>" --write` in DB mode, or confirm-block it (`doc: "honesty"`, patch `claims.do_not_fabricate`) in chat mode carrying the full list of claims, not one at a time.

---

## STEP 13 — TOOLCHAIN DETECTION

1. Run these checks and show the user the output:
   - `which pandoc`
   - `which soffice`
   - Check for a `.docx` résumé template in the repo root or `templates/`.
2. Based on results, propose a toolchain: `pandoc` | `libreoffice` | `word` | `markdown-only`.
3. Confirm with the user.
4. Write `candidate.toolchain` through `careerrat data candidate patch profile --data ...` in DB mode (EXACT enum value: `pandoc`, `libreoffice`, `word`, or `markdown-only`). This field is read by `tailor-application` and `apply-job` to call the right build command.

---

## STEP 14 — WRITING SAMPLES

1. Instruct the user: "Drop any candidate-authored writing into `workspace/writing-samples/`. This includes emails, cover letters, docs, Slack posts, blog posts, PR descriptions."
2. Check: `ls workspace/writing-samples/`. If files are present, run `npm run calibrate:style` and confirm `candidate/writing-style.md` was written.
3. When the candidate states writing preferences, emit one honesty confirmation block immediately,
   even when there are no sample files. Put the complete positive rules in `style.prefer` and the
   complete negative rules in `style.avoid`; do not merely acknowledge them in prose. In DB mode,
   write the same complete arrays through `careerrat data candidate patch honesty --data ...`.
4. If no samples are present yet, note that the user can run `npm run calibrate:style` later after
   adding samples. Stated preferences remain canonical honesty boundaries and are not replaced by
   that future calibration unless the candidate approves the change.

---

## STEP 14b — CAPABILITY REFERENCE (ON DEMAND, NOT AN ONBOARDING MENU)

Skip this during ordinary initial setup. Do not list capabilities and ask the candidate to
choose among them. Use this section only when a concrete user-requested task needs one of
the capabilities below. Explain that capability in plain language, ask for its platform-
specific consent, and record only that decision through the CLI. Everything else stays
off. Never hand-edit `candidate/automation.yml`.

---

**Browser automation capabilities** (from `src/core/automation/consent.mjs`):

| Key | Label | What it does | Platforms | Needs |
|---|---|---|---|---|
| `status_polling` | Portal status polling | Reads application status from ATS dashboards (read-only) | greenhouse, workday, ashby, lever | Session browser + ToS consent per platform |
| `messaging` | In-platform messaging | Reads in-platform DMs into `communications[]` (read-only; replies go through `email-comms`) | linkedin, wellfound | Session browser + ToS consent per platform |
| `one_click_apply` | Authenticated application fill | Modal-driven application filling under the `apply-job` submit gate; always halts before final submit so only the user can submit | linkedin | Session browser + ToS consent |
| `profile_optimize` | LinkedIn profile optimize (read + suggest) | Reads your profile and proposes honest, evidence-backed rewrites of headline / About / experience / Featured (read-only; dry-run preview, also runs as a no-browser fix-doc) | linkedin | Session browser + ToS consent |
| `profile_apply` | LinkedIn profile apply (write back) | Writes the approved profile rewrites back through the session browser, **confirm-first per field**; separate switch from `profile_optimize` (suggestions on never implies write-back) | linkedin | Session browser + ToS consent + `profile_optimize` |
| `mail_access` | Session webmail access | Reads one specific recent verification-code email during apply/sign-in flows from any provider via `webmail`, or opted-in Gmail/Outlook recruiting messages for `ingest-mail`; never sends/deletes/replies or browses the broader inbox | gmail, outlook, webmail | Session browser + ToS consent per mail provider |

**Mail capability:**

| Capability | What it does | Platform | Needs |
|---|---|---|---|
| Mail capture (`ingest-mail`) | Reads job-search email locally from Apple Mail (read-only, no IMAP credentials leave the machine) | macOS Apple Mail only | macOS (`uname` must return `Darwin`); Apple Mail running; Automation access in System Settings → Privacy & Security |
| Webmail capture (`mail_access`) | Reads job-search email from Gmail/Outlook through the session browser when explicitly enabled. Generic `webmail` is for verification-code reads only, not inbox sync. | gmail, outlook | Session browser + ToS consent per mail provider |

Saved job sources do not use this capability matrix. If a source needs a login,
ask “Do you want to log into <site> so I can use it?” with Yes and No choices at
that point. Yes opens the source in CareerRat's visible browser. No skips it and
continues the search.

---

**Session browser — use the connection already available.** Keep the provider set to
`auto` unless the user explicitly changes it. CareerRat selects Orca inside an Orca
workspace, then a compatible browser extension or a Playwright persistent profile
(`~/.careerrat/board-profiles/<platform>`) when available. The browser session holds the
user's logins; CareerRat never stores site credentials. All skill prose says "use the
session browser" because the concrete provider is an implementation detail. See
`docs/BROWSER.md` and the Browser Automation Contract in `AGENTS.md`.

**No credentials are ever stored by CareerRat.** The browser session holds the logins.

---

**Opt-in process per capability + platform the user wants to enable:**

Warn the user: automating a logged-in platform may violate that platform's terms of service — they must read those terms themselves before proceeding. Then, for each capability+platform they choose:

```
careerrat automation consent <platform> --write
careerrat automation enable <capability> --write
careerrat automation enable <capability> <platform> --write
careerrat automation status
```

Dry-run is the default (prints the change without writing); `--write` commits. Run `careerrat automation status` at the end to confirm the live verdict. CareerRat records the decision; it does not make it for you. **Never auto-run and never run on a schedule** — every automated session is user-initiated.

If a capability is enabled during setup because the user requested a task that needs it,
set `automationOffered: true` in `workspace/setup-state.json` and append `capabilities`
to `completed[]`. Otherwise leave the field false and continue without mentioning it.

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

## STEP 16 — BACKGROUND FIRST SEARCH + DISCOVERY HANDOFF

Do not wait for the full interview to finish before searching. As soon as the
canonical candidate state becomes `search_ready` (resume/no-resume decision,
target role, and usable remote/location posture), the conversational web surface
must generate or heal baseline deterministic sources and start or reuse the first
search in the background. This is code-owned onboarding work: while Paul continues
asking the remaining setup questions, the visible first-search task runs. He never tells
the candidate to repair missing sources later in Settings.

Full onboarding may finish only when baseline source config is durable and the
first search is `running` or `completed`. If source generation or the search cannot
continue, keep the candidate in Paul, name the exact missing fact or dependency,
and offer retry, guided repair, or **Pause setup**. A pause saves the current
checkpoint and resumes at that item; it is not graduation.

The deeper discovery sequence expands the already-running baseline search. Hand
off in this exact order:

```
setup-searches -> research-boards -> discover-companies -> search-jobs
```

1. `setup-searches` — confirm or refresh the baseline source config from targeting
   and show `careerrat searches` readiness. In conversational onboarding this must
   reconcile with the baseline sources already started by the app, not create a
   second first-search run.
2. `research-boards` — find additional boards/aggregators for this candidate's domain.
   This is confirm-first; run it unless the user explicitly says the baseline sources are
   enough for now.
3. `discover-companies` — find employers and wire boards supported by CareerRat's pinned
   73-adapter public provider catalog into source config. This is confirm-first; run it
   before the broadened sweep unless the user explicitly wants a board-only search.
4. `search-jobs` — continue or refresh the sourced sweep after broader source and
   company discovery. It is not the first moment any search may run.

End the onboarding summary with:

```
NEXT DISCOVERY ORDER: setup-searches -> research-boards -> discover-companies -> search-jobs
NEXT: inspect the running/completed baseline search, then expand it through setup-searches, research-boards, discover-companies, and search-jobs.
```

---

## ONGOING GATE WRITE-BACK RULE

Any time the user states a new gate during this interview — an exclusion, cut signal, comp floor, honesty boundary, per-company cap, or cooldown — persist it through the owning DB-aware command **immediately** and confirm before moving on:

- Exclusion → `careerrat gate exclude-company "<Company>" --write --confirm`
- Cut or keep signal → `careerrat gate cut-signal "<signal>" --write` / `careerrat gate keep-signal "<signal>" --write`
- Comp floor or anchor → `careerrat gate comp-floor <N> --write --confirm` for guaranteed base, `careerrat gate comp-annual-floor <N> --write --confirm` for annual cash earnings, `careerrat gate comp-target <N> --write --confirm`, or `careerrat gate comp-expected <N> --write` (not current_base)
- Honesty boundary → `careerrat gate do-not-claim "<tool>" --write` or `careerrat gate do-not-fabricate "<claim>" --write`
- Per-company cap / cooldown → `careerrat data candidate limits upsert --data '<json row>'` in DB mode; legacy mode writes `candidate/application-limits.yml`

**Friction level:**

- *Write-and-report* for unambiguous, low-blast-radius gates (one clear cut signal): write it, then echo the CLI confirmation.
- *Confirm-first* for consequential gates (broad company exclusion, lowering comp floor, large re-rank): propose the exact change, get a yes, then write.

A stated gate must never live only in chat. It must never be hardcoded into a skill.

---

## Rules

- **Persistence cadence.** After completing each major step, append its step key to `completed[]` in `workspace/setup-state.json` and refresh `updatedAt` (read-modify-write; keep the JSON minimal). Step keys: `domain`, `identity`, `projects-scan`, `work-history`, `targets`, `keep-cut`, `comp`, `location`, `authorization`, `education`, `exclusions`, `form-defaults`, `proof-points`, `toolchain`, `writing-samples`, `capabilities`, `materialize`, `discovery-handoff`. The `setup-state.json` shape also carries `question_style`, `optional_areas`, and `agent_voice` (set in STEP 0a), plus `resume_source` (`"none"` when STEP 2a ran, so a resumed session doesn't re-ask for a file that doesn't exist). On a deliberate pause, do the same and tell the user: "Progress saved — re-run `ingest-profile` (or `careerrat ingest`) to resume."
- Never invent facts. Ask or omit — do not guess.
- A missing résumé is never a blocker. If the candidate has none, run STEP 2a, record the decline so the checklist can complete, and never ask for the file again in the same setup.
- Keep `current_base` private. Store it with `current_comp_shareable: false`. It must never appear in any résumé, cover letter, form field, ATS entry, recruiter message, interview packet, or shareable tracker note. This is enforced by field path: always read outbound comp from `expected_base`, `target_base`, `minimum_base`, or `minimum_annual_earnings`.
- Keep `current_base` separate from `expected_base`. They are different fields and must never be conflated. `expected_base` is what goes on forms; `current_base` is a private gate input only.
- Translate stated preferences into explicit keep/cut signal lists in candidate targeting config. Vague preferences are not signals.
- Translate company preferences into the structured `company_preferences` thesis. Focus examples guide discovery; only explicit exclusions constrain the company universe.
- Replace all placeholder identity values from the templates (`Jane Candidate`, `jane@example.com`, `+1-555-0100`, etc.). `careerrat ingest --check --json` runs `lint:placeholders` and will reject any file that still contains known placeholder strings.
- Treat all candidate setup data as private user-layer data. In DB workspaces it lives in SQLite; compatibility `candidate/` files are export/fallback only and must never be committed to the system repo.
- Never surface domain-specific assumptions (tech/AI titles, specific cities, specific tool names) from skill prose. Every candidate-specific value lives in their config files.

---

## Outputs

| Output | Written by | Schema |
|---|---|---|
| `candidate_profile` / compatibility `candidate/profile.yml` | `careerrat data candidate patch profile --data ...` in DB mode; compatibility YAML only via `write-config`/legacy mode | `config/profile.schema.json` |
| `candidate_targeting` + search tracks/companies / compatibility `candidate/targeting.yml` | `careerrat data candidate patch targeting --data ...` in DB mode; compatibility YAML only via `write-config`/legacy mode | `config/targeting.schema.json` |
| `candidate_evidence_claims` / compatibility `candidate/evidence.yml` | `careerrat data candidate evidence --data ...`, or `careerrat evidence add` (STEP 2b folder/repo scan) | `config/evidence.schema.json` |
| `candidate_honesty` / compatibility `candidate/honesty.yml` | `careerrat data candidate patch honesty --data ...` in DB mode; compatibility YAML only via `write-config`/legacy mode | `config/honesty.schema.json` |
| `candidate_form_defaults` / compatibility `candidate/form-defaults.yml` | `careerrat data candidate patch form-defaults --data ...` in DB mode; compatibility YAML only via `write-config`/legacy mode | `config/form-defaults.schema.json` |
| `candidate_application_limits` / compatibility `candidate/application-limits.yml` | `careerrat data candidate limits upsert --data ...` in DB mode; compatibility YAML only via `write-config`/legacy mode | `config/application-limits.schema.json` |
| `candidate/writing-style.md` | `npm run calibrate:style` from `workspace/writing-samples/` | — |
| `candidate/AGENTS.md` | `careerrat ingest --write-config` | — |
| `config/search-sources.yml` | `careerrat ingest --write-config` (domain-appropriate boards) | `config/search-sources.schema.json` |
| `workspace/setup-state.json` | this skill (the agent writes it directly — no CLI mutation) | none — small JSON progress record |

---

## Config notes

- **Comp fields are schema-backed (shipped).** `compensation.expected_base`,
  `minimum_annual_earnings`, `oe_min_base`, `oe_max_base`, and `relo_package_needs` all exist in
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
- **Application limits are schema-backed in DB mode.** Use
  `careerrat data candidate limits upsert --data '<json row>'` for per-company
  caps/cooldowns. `candidate/application-limits.yml` is legacy/export
  compatibility only; do not hand-edit it in DB mode.
