---
name: interview-prep
description: Build interview packets, script live comp answers, and capture post-interview debriefs and durable lessons from a saved JD, tracker record, candidate evidence, and interview invite context.
---

# interview-prep

Use this skill when a submitted role advances to recruiter screen, technical
screen, hiring-manager interview, panel, assessment, or offer conversation.
Also use it when the user pastes interview notes, a transcript, or a debrief.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section. Bare `candidate/`, `workspace/`, `config/`, and `.internal/` paths below are symbolic; resolve them per AGENTS.md's Path Resolution rule.

> **Agent voice.** Read `candidate/modes.yml#agent_voice` (default `standard`) before producing packet summaries, prep briefs, or debrief summaries. Apply the register from AGENTS.md#mode-switches. `exec-summary` = verdict + 2–3 bullet signals; `standard` = scannable packet with section headers; `technical` = full signal analysis + coaching depth; `verbose` = everything including full question lists and story texts.

---

## STEP 0 — Read context

Read all of the following before doing anything else:

1. `workspace/tracker.json` — find the application row for this company/role.
   Note `status`, `conversations[]`, `artifacts.jd`, `fitScore`, `note`.
   **Mine every prior `conversations[]` entry on this row for what THIS company
   has told you they want.** The `processNote` and `learnings[]` fields capture
   stated priorities, "big bets," what each interviewer emphasized, and objections
   heard in earlier rounds. This is the richest, most company-specific signal you
   have, richer than the JD, because it came straight from their mouths. Carry it
   forward: the packet must anchor its examples and answers to these stated
   priorities, not just generic fit. Prep compounds round over round, every round's
   debrief (STEP 5/6) is meant to make the next round's packet sharper.
2. `candidate/profile.yml` — read `compensation.target_base`,
   `compensation.minimum_base`, `compensation.expected_base`,
   `compensation.current_comp_shareable`. **`current_base` is private — never
   read it into any outbound section.**
3. `candidate/targeting.yml` — read `role_buckets` (for role-family fallback),
   `role_families` (if present, for classifyRoleFamily override). Also note
   `profile.location.travel_tolerance` (in `candidate/profile.yml`) for the
   travel/onsite burden used in comp evaluation. (`lifestyle_burden` is a
   planned field not yet in the schema — use `travel_tolerance` in its place.)
4. `candidate/evidence.yml` — evidence claims for the JD signal match and
   do-not-overclaim sections.
5. `candidate/honesty.yml` — `tools.do_not_claim`, `claims.do_not_fabricate`,
   education policy.
6. Derive the role family by calling `classifyRoleFamily(role)` from
   `src/core/tracker/outcome-analysis.mjs`. If it returns `'other'`, use the
   first matching `role_buckets[].name` from `candidate/targeting.yml` as the
   family key (e.g. `dispatcher`, `nurse`, `driver`). If no bucket matches,
   leave the family as `other`.
7. Read prior lessons for this role family before building the packet — they
   sharpen fit signals, likely questions, and comp anchoring. Run:

   ```sh
   careerrat learnings read "<role title or family>"
   ```

   A missing file is normal — the CLI prints a skip note to stderr and exits 0.
8. Read any company research artifact before building the packet — it sharpens the
   Positioning Thesis and the questions-to-ask. Run:

   ```sh
   careerrat research read "<company>"
   ```

   A missing file is normal (skip note to stderr, exit 0). If present, fold its
   sourced signals into the Positioning Thesis and Questions To Ask as **context to
   assess** — never as evidence-backed claims. Treat anything marked
   `[AGENT-INFERRED ...]` as a hypothesis for the candidate to verify, not a fact to
   assert. If the artifact is flagged stale, note it and consider re-running
   `research-company`. Never copy a research finding into an evidence/résumé claim.
9. Read the STAR+R **story bank** before building the packet — it holds reusable
   behavioural answers that already trace to evidence. Run:

   ```sh
   careerrat stories match "workspace/jobs/<jd-file>.md.json"
   ```

   (or `--signals "a,b,c"` when you don't have the JD JSON path). A missing or empty
   bank is normal. The matched stories become the packet's **Prepared Stories**
   section (STEP 2); uncovered behavioural themes (`careerrat stories gaps`) are
   candidates to draft in STEP 2b. Never treat a story as more than its `evidence_ids`
   back.
10. Run `careerrat tracker --summary` to confirm funnel state.
11. Check usage mode before building a deep multi-audience packet:

   ```sh
   careerrat modes allows interview:packet:deep
   ```

   If it returns `downshift`, build one lighter packet focused on the actual next
   round rather than recruiter + hiring-manager + panel variants. If it returns
   `run`, proceed normally. Usage mode never changes honesty/evidence requirements.

---

## STEP 1 — Identify audience and round

Extract from the invite notes or user input:

- Round type: `recruiter screen | assessment | technical | hiring manager | onsite | final | offer`
- Interviewer name(s) and title(s) for each slot (track separately — prep
  differs by audience).
- Logistics: date/time/timezone, format (video/phone/on-site), duration.

If invite notes are missing or ambiguous, ask for them before proceeding.
Record the round type — it drives which sections of the packet expand.
When round type is `offer`, run STEP 3b (Live offer negotiation)
immediately after STEP 3 — before STEP 4.

---

## STEP 2 — Build and write the packet

There is no CLI wrapper for `renderInterviewPacket()`. Invoke it via a
one-off node script:

```js
// run as: node --input-type=module < /dev/stdin
import { renderInterviewPacket } from './src/core/interview/packet.mjs';
import { loadStories } from './src/core/interview/story-bank.mjs';
import { parseYaml } from './src/core/profile/yaml.mjs';
import { readFileSync } from 'node:fs';
const job      = JSON.parse(readFileSync('workspace/jobs/<jd-file>.md.json', 'utf8'));
const profile  = parseYaml(readFileSync('candidate/profile.yml', 'utf8'));
const evidence = parseYaml(readFileSync('candidate/evidence.yml', 'utf8'));
const honesty  = parseYaml(readFileSync('candidate/honesty.yml', 'utf8'));
const { stories } = loadStories({});  // candidate/stories.yml — [] when absent
const out = renderInterviewPacket({ job, profile, evidence, honesty, inviteNotes: '', audience: '<round-type>', stories });
process.stdout.write(out);
```

Or write the packet body inline in the agent response using the section
structure below, reading all inputs directly — whichever path is available.

**Privacy note:** `packet.mjs` does not emit `current_base` under any
condition — `buildCompAndLogistics()` only ever outputs `expected_base`,
`target_base`, and `minimum_base`. No stripping step is needed.

**Artifact privacy:** the packet is a candidate-private prep artifact — it
includes `minimum_base` (the walk-away floor). Do not hand it to a panel or
interviewer; save it only to `workspace/interview-prep/`.

Call `renderInterviewPacket()` from `src/core/interview/packet.mjs` with:

```js
{ job, profile, evidence, honesty, application, inviteNotes, audience }
```

Write the rendered output to:

```text
workspace/interview-prep/<company>-<role>.md
```

(Use the slug from the tracker row. Create `workspace/interview-prep/` if
absent.)

This `.md` is also the source for the dashboard Focus-card **"Open dossier"**
full-page preview — STEP 6 persists a copy onto `app.artifacts.interviewDossier`
so the featured interview always has a dossier to open.

**In-interview usability contract (hard).** A packet is read in two modes, and the
live mode wins. The candidate has this open *during the call* — build for that first:

- **Live layer (the cue card) — the priority, and it goes first.** One screen,
  glanceable *mid-sentence*: cues, keywords, triggers, and the hard numbers — never
  paragraphs. A story is a 3–5 word trigger + its one metric, not a script. Questions-
  to-ask are bare lines. Do-not-claim is a short list. The test: can the candidate find
  and use any item in the ~2 seconds they have *while still talking*? If using it means
  reading a paragraph, it fails the test and does not belong on the live layer.
- **Study layer (everything else) — pre-read only, and labeled as such.** The Positioning
  Thesis, JD Fit Map, and fuller answers exist to internalize *before* the call. They are
  never the thing referenced live.
- **No walls of text, no jargon, no speeches.** A blockquoted verbatim monologue cannot
  be read aloud while holding a conversation, and reads as canned if attempted. Scripted
  answers (section 5) are a *rehearsal aid in the study layer*; on the live card each one
  collapses to its trigger + number. Plain labels over jargon throughout. Scannable beats
  complete — a wall of correct bullets is study material, not a live reference.

The packet must contain these sections in order:

**Lead-off — Say-This / Never-Say-This Card.** The front page of the packet and
the one part meant to be memorized, not studied. Keep it to a single screen: the
3–5 highest-leverage things to *say close to verbatim* in this round, and the
traps to *never say*. This exists because the most common failure mode is not
missing prep — it is having the right answer somewhere in the packet and failing
to retrieve it under pressure. Pull each "say" line from the strongest backing in
`candidate/evidence.yml`:

- **Impact / adoption / "how do you measure success" answers must state the
     actual metric** from the backing claim (deflection rate, dollars saved, time
     cut, count served) — never a qualitative stand-in ("it's taking off,"
     "people love it") when a real number exists in the evidence bank.
- **The "can you do X / what are your weaknesses" answers** are scripted as a
     constructive reframe — what the candidate does ship and how — followed by a
     calm, factual boundary, never a self-deprecating disclaimer.
   The numbered sections below are the support; this card is what survives the room.

1. **Positioning Thesis** — one-paragraph framing of why this candidate for
   this role at this company. Sourced from evidence; no invented claims.
2. **Top Fit Signals** — 3–5 signal/evidence pairs drawn from JD language and
   `candidate/evidence.yml`. If `job.signals` is empty (sparse JD or non-tech
   domain), derive signals from JD body keywords and `role_buckets.notes` in
   `targeting.yml` rather than leaving the table blank.
3. **JD Fit Map** — the heart of the packet, and the section the candidate reads
   most. Ground it in the candidate-facing JD's **actual words**, not abstract
   signal tokens:
   - **Open with a plain read of the role** — 2–4 bullets that strip the buzzwords
     and say what the job actually is ("build AI products customers use; build
     internal AI tools; take on a few big bets"). The candidate should understand
     the role before seeing the mapping.
   - **Fit Snapshot table** — scannable: *quoted ask (their words)* → *one-line
     plain-language fit* → *strength (strong / partial / gap)*.
   - **Per-line expansion — only the 3–4 highest-leverage lines.** The snapshot
     table already covers everything; in prose, expand just the few lines that win
     or lose the round (the candidate's edge, a gap that just closed, the honest
     partials). Quote the JD's real line (from `## Requirements` / `## What You'll
     Do`), then give a **plain-language** "why you fit" (1–2 sentences a
     non-technical hiring manager follows), the backing `evidence.yml` claim id(s),
     and an honest confidence (**strong / partial / gap**). **Do not expand every
     line** — a wall of fit bullets is study material, not something usable in a
     30–45 minute call. Mark **partials and gaps explicitly** — never round a
     partial up to strong; the honest "here's where I'm light" framing is the value.
   The `job.signals[]` tokens are a matching aid for *finding* the right evidence —
   they are not what you show the candidate. Translate every match into the JD's
   own language and the candidate's real work.
4. **Prepared Stories (STAR+R)** — matched stories from `candidate/stories.yml`
   (`careerrat stories match`), rendered Situation/Task/Action/Result/Reflection.
   These are the answer anchors for the Likely Questions below. Omitted when the
   bank is empty. Each story already traces to evidence — use it as written; never
   improvise past its `evidence_ids`.
5. **Likely Questions — with scripted answers.** Every likely question MUST carry a
   **scripted, say-it-verbatim answer**, not just the question text. A bare question
   list is not done — the most common failure is having the right answer somewhere in
   the candidate's history and not retrieving it under pressure, so write the words.
   **These verbatim answers are study-layer material** (see the In-interview usability
   contract): for pre-call rehearsal only — on the live cue card each collapses to its
   trigger + metric, never the full script.
   The renderer scaffolds this for you: `buildLikelyQuestionsSection()` attaches each
   question's anchor automatically — a banked story (matched via the story's
   `prompts[]`), the Positioning Thesis (for the opener), the JD Signal Match row (for
   "experience with <signal>"), or a 🔴 **behavioural-gap** flag when nothing backs it.
   For each question:
   - Label `[JD-inferred]` or `[evidence-sourced]`, and keep the anchor line.
   - **Write the verbatim answer** under the anchor — anchored to a Prepared Story (by
     title) when one fits, else to specific evidence claims by name. For any impact /
     adoption / "how do you measure success" question, the answer must carry the
     **verbatim metric** from the backing claim, not a paraphrase — these are the
     questions candidates most often answer qualitatively and lose.
   - When you script an answer from a banked story that the renderer did **not**
     auto-match, add that question to the story's `prompts[]` (re-`add --write`) so it
     auto-anchors next loop.
   - **For every 🔴 behavioural-gap question, do NOT improvise an answer.** Route it to
     the seed-a-story flow (STEP 2b): surface **two evidence-grounded example angles to
     jog the candidate's memory**, ask them for the real anecdote, then draft + bank a
     STAR+R story and replace the flag with the scripted answer. A behavioural answer
     you can't trace to evidence is a question for the candidate, never a packet entry.
6. **Questions To Ask** — 4–6 questions tailored to audience (recruiter set ≠ HM
   set ≠ panel set). Expand this section when round is HM or later.
7. **Comp and Logistics Script** — use `profile.compensation.target_base` as the
   opening anchor; `minimum_base` as the private walk-away. **Never include
   `current_base` in this section regardless of `current_comp_shareable`.**
   Script a live answer for "what are your expectations?". If the posted band is
   below `profile.compensation.minimum_base`, note the gap and include a walk-away script.

   **Live verbal scripts (offer round)** — strategy from AGENTS.md
   Negotiation Contract; mechanics below. Include these scripts in the packet
   whenever `audience` is `offer`.

   *Privacy deflection — "what are you currently making?"*

   Deliver the following (substitute the candidate's `profile.compensation.target_base` value for the dollar figure):
   > "I keep current comp private, but I can tell you what I'm targeting:
   > $X. That reflects what comparable roles are paying in the market and
   > what makes this move compelling for me."

   *Opening anchor — "what are your expectations?"*

   Substitute the candidate's `profile.compensation.target_base` value and one impact claim from `candidate/evidence.yml` before placing this in the packet:
   > "I'm targeting $X. That's grounded in market data for this scope and my
   > track record of delivering `<a specific impact from evidence.yml>`."

   For OE roles substitute `profile.compensation.oe_max_base` as the anchor;
   `oe_min_base` is the walk-away (internal — never spoken). Never cite
   `minimum_base` / `oe_min_base` outbound.

   *Geographic-discount pushback* — if the employer cites candidate location or
   remote status to justify a lower number, use this script only when a
   `workspace/research/comp-bench-*.md` artifact exists for this role. Pull
   `benchmark.midpoint` from that artifact's frontmatter. Do not cite any market
   number that was not actually benchmarked.

   Substitute the `benchmark.midpoint` value from the comp-bench artifact before placing this in the packet:
   > "The market data I have puts the midpoint for this scope at $X, measuring
   > the role nationally for fully-remote positions. I'd rather anchor there.
   > Let me put a written counter together so you have the full picture — can I
   > send that over by tomorrow?"

   If no comp-bench artifact exists, omit the market-number sentence entirely
   and anchor on `profile.compensation.target_base` plus evidence-backed value only.

   *BATNA script* — use only when the candidate has a real competing offer or
   genuine alternative. **Never fabricate an offer, deadline, or number.** If
   there is no BATNA, omit this script block entirely from the packet and note
   plainly: "No BATNA — using market anchor + evidence-backed value approach."

   Before placing this in the packet, obtain the real deadline date from the
   candidate and substitute it for the date slot:
   > "I do have another offer in process — I'm not trying to use it as pressure,
   > but it is affecting my timeline. I need to respond to them by
   > `<the date the candidate confirms>`. I'd genuinely prefer this role, which
   > is why I want to make sure we can get to $X before I have to decide."

   Substitute `profile.compensation.target_base` for $X.

   *Multi-round verbal sequencing and the call-time hold rule* — see STEP 3b
   for the full round-by-round mechanics. The single most important rule:
   **do not accept or commit to a number on the call.** Acknowledge, then bridge
   to a written counter via `email-comms`.
8. **Do Not Overclaim** — verbatim from `honesty.yml`: tools not to claim,
   claims not to fabricate, education boundary. Segment by audience when known.
   Pair each boundary with its **constructive reframe** — the honest strength to
   lead with before stating the limit — so a `do_not_claim` line is delivered as
   "here's what I do bring, and here's the edge of it," never as a bare,
   self-deprecating disclaimer.
9. **Evidence Gaps** — signals the JD requires that have no backing claim in
   `evidence.yml`. Surface these so the user can add them before the interview.
10. **Sub-floor fit note (when applicable).** If the tracker row's `fitScore` is below the configured `targeting.fit_bands.fit_floor` — meaning this role would normally auto-drop but the candidate is in the loop anyway (inbound recruiter interest, referral, etc.) — surface it explicitly here: "This role scored <N>, which is below your fit floor of <fit_floor>. You're in the process regardless, so prep the specific gaps that drove the low score." Pull the gap signals from section 9 (Evidence Gaps) and the FIT caveats from the evaluate-job output. Omit this note when no `fit_floor` is configured or when the score meets the floor.

---

## STEP 2b — Draft and bank STAR+R stories (close coverage gaps)

The story bank compounds across loops — build it as you prep, don't restart each
round. After writing the packet, check behavioural coverage:

```sh
careerrat stories gaps
```

Every 🔴 behavioural-gap question from STEP 2 section 5 lands here. **Surface gaps to
the candidate with memory-joggers — do not leave them as a silent to-do, and never
fabricate a story to fill one.**

For each uncovered competency (or a Likely Question with no Prepared Story):

0. **Ask the candidate, with two example angles to jog their memory.** Don't ask a bare
   "tell me about a time you…" — the candidate often has the story but can't retrieve it
   cold. For each gap, scan `candidate/evidence.yml` for the 1–2 closest real projects
   and offer **two concrete example angles grounded in that evidence** ("Was it like X —
   driving Pearl adoption with no mandate? Or like Y — making the build-vs-buy case to
   leadership?"), then ask which is closest or for the real one. Use `AskUserQuestion`
   with the two angles as options (each a short evidence-grounded sketch) so the
   candidate can pick the closest or describe their own. This is the step that turns a
   gap into a bankable story.
1. Find the backing claim(s) in `candidate/evidence.yml` for the angle the candidate
   confirms. If no claim backs it, it is an **Evidence Gap** (STEP 2 section 9) — surface
   it for the candidate to fill; do **not** invent a story to cover it. If the candidate
   has built relevant projects that simply aren't in evidence yet, offer to scan them
   (`ingest-profile` STEP 2b, `careerrat evidence add`) to originate the claims first,
   then draft the story. New biographical detail the candidate gives you on the call
   (an origin, an outcome) is their real account — fold it into the narrative even when
   it isn't yet a separate evidence claim, but keep `evidence_ids` pointed at claims
   that exist.
2. Draft a STAR+R story from those claims: Situation/Task/Action/Result from the
   claim's `evidence` + `metrics`, Reflection in the candidate's voice. Use the
   candidate's real details; go generic only on specifics you genuinely don't have
   (never bracket placeholders). List every claim id used in `evidence_ids`.
3. Write the draft to a temp YAML file and propose it (dry run):

   ```sh
   careerrat stories add --file <draft.yml>
   ```

   The firewall refuses a story that cites no or unknown evidence, drops a STAR+R
   field, carries placeholder residue, or leaks comp. On the candidate's
   confirmation, commit (atomic upsert by id):

   ```sh
   careerrat stories add --file <draft.yml> --write
   ```

4. **Set `open_questions[]` for anything the story is still missing — don't block
   on it.** The candidate's account is truth: bank the story now, then list the
   thin spots (a metric to confirm, a concrete before/after, a version question, a
   detail that conflicts with committed code) as `open_questions` strings on the
   story. This is the "ingest sets the flag" rule — banking a story that lacks a
   detail must record that gap, never silently drop it or gate the bank on it.
   `stories add --write` auto-mirrors `open_questions` into
   `tracker.storyEnrichment`, which raises a self-clearing **"give me more context"**
   card in the dashboard Next Steps queue (one per thin story, "Give context"
   action). When the candidate fills a gap, drop that string from `open_questions`
   and re-`add --write`; the card clears on the next sync. (If you edit
   `stories.yml` outside the CLI, run `careerrat stories sync-enrichment --write`
   to refresh the mirror.) Frame each `open_questions` entry as the actionable ask
   you'd put to the candidate, not an accusation — the candidate's account is the
   source of truth; the gap is just what would sharpen it.

Never fabricate a story to fill a gap. A behavioural answer you can't trace to
evidence is a question for the candidate, not a packet entry.

---

## STEP 2c — Technical / system-design rounds (diagrams, the *why*, and probes)

When the round is a technical screen, system-design, data-architecture, or any
"whiteboard" / "design" round, the standard packet sections are not enough on
their own. **A talking-point list is not prep for a design round.** The candidate
has to walk in able to draw something and defend every box. Add:

1. **A "What they're scoring" rubric at the very top**, decoded from the round's
   own description (e.g. "can you justify every choice", "do you find the
   bottleneck", "do you design for failure", "do you communicate while building").
   The candidate should see the grading criteria before anything else.
2. **A reusable frame** they can run on any prompt: scope/users → rough scale
   numbers → components + request flow → data model + access → bottleneck +
   trade-off → failure modes. Plus the opening line that buys time to scope.
3. **Worked design walk-throughs — at least one grounded in the company's stated
   priorities / big bets (from STEP 0 item 1), plus one or two generic ones.**
   Each walk-through MUST carry all three of:
   - an **ASCII architecture diagram** in a fenced code block, simple enough to
     reproduce on a whiteboard;
   - the **reasoning behind every component choice, attached to that component** —
     *why this one, and what you gave up* — never collected in a separate list far
     from the decision. "Postgres" with no "why" next to it is exactly the failure
     this step exists to prevent;
   - the **likely follow-up probe and the scripted answer** ("if they push 'why
     not a dedicated vector DB' → ..."). Design interviewers always push on the
     choices; script the defense in advance.
4. **A "why" cheat sheet** — each default building-block choice (datastore, queue,
   gateway, cache, region strategy) with a one-line defense and the common probe,
   so the candidate can answer "why that?" for anything they end up drawing.
5. Ground every box in the candidate's **real systems** from `evidence.yml`, so the
   reasoning reads as experience, not a textbook. Keep the do-not-overclaim
   boundaries (STEP 2 section 8) visible for this round's stack, and script the
   honest-edge move ("I haven't run that at that scale, but here's how I'd reason
   about it, and the trade-off I'd watch") so the candidate never bluffs a number.
6. **A short plain-English glossary at the bottom — only the terms that earn it.**
   This is for genuinely specialized jargon where a crisp one-liner is useful:
   named techniques and niche terms like top-k, RRF, reranking. It is NOT a vocab
   dump. **Calibrate hard to the candidate's actual level** (read `evidence.yml` /
   `profile.yml`): cut anything they obviously know cold — general engineering
   concepts they use daily (queue, idempotency, dependency, CVE, fallback, access
   control, blast radius), and *especially* anything they built themselves (if
   they shipped an MCP server, "MCP" does not belong in their glossary). Listing
   terms a senior engineer knows reads as condescending and they'll call it out.
   Keep only the handful worth a simple phrasing — a memory jog, or a script for
   when a *less-technical* interviewer asks "explain that simply." If the round's
   interviewer is a domain expert and every term is in the candidate's wheelhouse,
   **skip the glossary entirely.** One conversational line per kept term, the way
   they'd say it out loud.

This section is additive: for a mixed round the behavioural sections (Prepared
Stories, Likely Questions) still apply. Write the per-round doc to
`workspace/interview-prep/<company>-<round-or-panel-slot>.md` and export each as
its own PDF (STEP 4b) so a multi-session panel gets one focused PDF per session.

---

## STEP 2d — Mock interview mode (agent-driven)

When the candidate wants to *rehearse* rather than read — "mock me," "run a mock
interview," "quiz me on this round," "let's practice" — the agent **drives a live
mock** instead of (or after) producing a doc. This is the highest-value prep for a
candidate who solves in the moment rather than from memorized scripts.

- **Role-play the interviewer for the specific round.** Use the saved JD, the round
  format from `conversations[].processNote`, and the named interviewer when known
  (match their angle — system design vs behavioural vs AI-fluency). Ask **one question
  at a time** and wait for the real answer. Never dump a question list.
- **Voice is fine.** The candidate can answer by dictation; keep agent turns short so
  it stays a conversation, not a wall. One question, one reaction, next question.
- **Tight feedback per answer — one or two specifics, not an essay.** Did the metric
  land, did they bury the lede, did they ramble past the point, did they open with a
  disclaimer instead of deriving, did they defer when they could have reasoned it out
  loud. Coach the *framing and retrieval*, never tell them to go memorize — see how the
  candidate actually works in `candidate/` context and the role-family learnings.
- **Close by updating the prep, not just talking.** Fold what surfaced into the live
  cue card (STEP 2), bank durable lessons via the learnings helper (STEP 7), and capture
  the rehearsal in `conversations[]` only if the candidate wants it tracked.
- The **formalized version** — book a mock as a calendar event, scored rubric, recorded,
  full voice loop — is on the roadmap. Until it ships, run the mock inline in the
  session; it works today.

---

## STEP 3 — Comp gate check

Read candidate config via the shared DB-first accessor (`profile.compensation.minimum_base`) — the single walk-away floor. In DB mode this comes from SQLite; YAML is legacy fallback only.

- If the posted band is at or above the floor: no action needed; include the
  standard comp script (target, not current).
- If the posted band is below the floor: include a walk-away script in the
  Comp and Logistics section and flag the gap to the user.
- **Unposted comp (estimated from comparables).** If the tracker row's `compEstimate.source === "comparables"` — meaning the role never had a posted band and the gate estimated it from comparable tracker rows — surface this at the top of the Comp and Logistics Script section: state the estimate range ("Our best guess from N comparable roles: $<low>K–$<high>K, mid $<mid>K; confidence <X>") and instruct the candidate to confirm the real band early in the first live conversation before anchoring on any number. We're prepping off a guess; the first screen call is the chance to ground it. If the estimate is `estimated-below-floor`, also flag the likely gap and include the walk-away script as a contingency.
- If the user states a new comp gate mid-session (e.g. "below $190K is a no"):
  - **Confirm-first** for broad changes (dropping the floor globally).
  - **Write-and-report** for unambiguous per-session adjustments.
  - Run `careerrat gate comp-floor <N> --write --confirm`, then echo the CLI confirmation.
    `careerrat gate` writes SQLite in DB mode and legacy YAML only in legacy mode; never hand-edit `candidate/profile.yml`.

---

## STEP 3b — Live offer negotiation (verbal channel)

*Run this step when the round type is `offer`. Strategy lives in
AGENTS.md Negotiation Contract; this step owns the verbal channel only.*

**The call-time hold rule.** Never accept or commit to a number on the call.
Acknowledge every offer warmly, then bridge to written:
> "That's helpful — I want to give this the consideration it deserves. Can I
> send you a written response by tomorrow?"

Then trigger `email-comms` to draft and send the counter.

**Pre-call checklist.** Before the offer call, confirm these inputs are loaded:

- `profile.compensation.target_base` — verbal anchor (OE roles: `oe_max_base`)
- `profile.compensation.minimum_base` — private walk-away, never spoken aloud
  (OE roles: `oe_min_base`)
- `profile.compensation.minimum_base` — the walk-away floor; trigger for the
  walk-away script when an offer falls below it.
- `workspace/research/comp-bench-<role>-<loc>-<yyyy-mm>.md` — frontmatter
  `benchmark.floor` / `midpoint` / `ceiling` / `confidence`; cite only if the
  file exists on disk
- `candidate/evidence.yml` — one or two impact claims to use as value evidence
- Competing offer details if real (date, number, company type); leave blank if
  none — never fabricate

**Round-by-round verbal sequencing.**

| Round | Candidate action | Script anchor |
|-------|-----------------|---------------|
| Round 1 — opening anchor | State `target_base` with one evidence claim. Bridge to written. | "I'm targeting $X based on `<one evidence claim>`. Let me send a written summary tonight." Substitute values before placing in packet. |
| Round 2 — employer counter | Acknowledge; do not counter on the call. Ask what's driving the number (budget ceiling? band?). Bridge again. | "Thank you — I want to understand the constraints. Is this the top of the approved band? Let me think through it and respond in writing." |
| Round 3 — written counter sent | `email-comms` owns this round. Return here only if a follow-up call is requested. |
| Round 4 — re-counter or close | If the gap is closeable, move to concession ladder. If below `minimum_base` / `oe_min_base`, execute walk-away script. |

**Concession ladder.** When base is constrained, offer to trade in this order
(adjust for `profile.compensation.cash_over_equity`):

1. Sign-on bonus (one-time, does not set base precedent)
2. Equity / vesting terms (when `cash_over_equity` is `false` and the role includes equity)
3. Start date (later start = more runway at current income)
4. Title (if a stronger title opens the next salary band)
5. Remote / relocation terms
6. Additional PTO or benefits with quantifiable value

Never trade base below `minimum_base` (or `oe_min_base`). State each concession
explicitly in the written counter via `email-comms`, not verbally.

**Geographic-discount rebuttal (verbal form).** If the employer cites candidate
location or remote status to justify a lower number:

1. Use this rebuttal only when a `workspace/research/comp-bench-*.md` artifact
   exists for this role. Pull `benchmark.midpoint` from its frontmatter. If no
   artifact exists, anchor on `target_base` only — do not invent a market number.
2. Substitute the `benchmark.midpoint` value before placing this in the packet:
   > "The market data I have for this scope puts the midpoint at $X. That figure
   > reflects the role's requirements rather than my zip code. Let me put a
   > written response together so you have the full picture — does tomorrow work?"
3. Bridge to written immediately. Do not debate on the call.

**BATNA use on the call.** Use only when a real competing offer or genuine
alternative exists. If no BATNA: note this plainly in the packet; use market
anchor + evidence + time as the only levers.

- State the BATNA once, neutrally, without pressure language.
- Before placing any BATNA script in the packet, obtain the real deadline date
  from the candidate. Never invent a deadline or emit a bracket token for it.
- Substitute the confirmed date before placing this in the packet:
  > "I have another offer I need to respond to by `<the date the candidate
  > confirms>`. I'd rather be here, which is why I want to resolve comp before
  > that date."
- If the employer cannot move by the deadline: honour the deadline; do not
  extend it to apply fake pressure.

**Walk-away script** — use when the offer falls below `profile.compensation.minimum_base`
(or `oe_min_base`).

State the floor value as a dollar figure (never say `minimum_base` aloud):
> "I appreciate the offer and the time everyone has invested. I need a base of
> at least $X to move forward. If that's outside what's possible right now, I
> completely understand — I'd rather be transparent than waste anyone's time."

After a walk-away, close the app row immediately — do not defer to a later STEP 5 pass. Write all of the following in a **single tracker.json edit**:

- `app.status → "rejected"` (employer declined to meet floor) or `"withdrawn"` (self-initiated)
- `jobs[].nextAction → null`
- `jobs[].nextActionDue → null`
- `jobs[].followUp → null` (if set)
- `comm.status → "closed"`
- `comm.nextActionDue → null`
- Append a terminal `conversations[]` entry: `{ "kind": "offer", "notes": "Walk-away executed — offer below comp floor.", ... }`

Run `careerrat tracker --verify` immediately after. Then write the outcome to the debrief file (STEP 5) and log lessons (STEP 7).

**After the call — hand off to email-comms.** Every substantive verbal exchange
(offer received, counter indicated, concession offered) must be persisted:

1. Trigger `email-comms` to draft the written counter. The counter email is the
   formal negotiation record — it supersedes anything said on the call.
2. Write the comm thread state in the **same tracker.json edit** as the call summary — do not leave the comm record in its pre-call state:
   - `comm.status → "waiting"` (ball is with employer while the written counter is drafted/sent)
   - `comm.nextActionDue → <counter due date, e.g. next business day ISO date>`
   - `comm.nextAction → "Await employer counter"`
   - `comm.draft → null` (no outbound draft pending — email-comms owns it)
   This clears the pre-call CTA and replaces it with the correct waiting state so the per-job action cell and Next Steps card reflect the live negotiation state.
3. Append the call summary to `conversations[]` in `workspace/tracker.json`
   (STEP 6 mechanics).
4. Confirm-first before any comp-boundary write-back:
   - Per-offer walk-away floor ("I won't go below $X on this one"): use
     `careerrat gate comp-floor <N> --write --confirm` and echo the CLI confirmation.
   - Permanent sourcing floor change: `careerrat gate comp-floor <N>` (dry-run);
     `careerrat gate comp-floor <N> --write --confirm` to commit.
   - Comp target change: `careerrat gate comp-target <N>` (dry-run);
     `careerrat gate comp-target <N> --write --confirm` to commit.

---

## STEP 4 — Lint the packet

Run:

```sh
node src/cli/lint-placeholders.mjs workspace/interview-prep/<company>-<role>.md
```

Fix every `[Company]`, `[Role]`, `<insert>`, or unfilled placeholder before
surfacing the packet. Do not mark the packet build-ready until lint passes
clean.

---

## STEP 4b — Export packet (PDF only)

After lint passes clean (STEP 4), render the styled PDF — the only export the
packet ships:

```sh
careerrat export workspace/interview-prep/<company>-<role>.md --pdf
```

Uses the Playwright Chromium bundled with the repo — no setup required. The PDF
carries the full editorial styling (navy masthead, the Fit Snapshot table,
callouts). **PDF only — do not also emit `--docx`.** The DOCX path runs through
pandoc, which strips the styling into a plain text copy that undersells the
packet; the PDF is the artifact to keep and share. If a prior run left a
`<company>-<role>.docx` next to the packet, delete it.

## STEP 5 — Post-interview debrief capture

*This step runs after the user returns from the interview and shares notes,
a transcript, or a debrief.*

Write a debrief file to:

```text
workspace/interview-prep/<company>-<role>-<yyyy-mm-dd>.md
```

Structure the debrief file with these sections verbatim:

```text
## Status
Outcome: <advancing / rejected / pending / offer / withdrawn>
Next step: <what and by when>
Process owner: <recruiter name, HM name>
Blockers: <open items>

## What They Tested
<skills, scenarios, case questions, or assessments the interviewer focused on>

## Stories That Landed
<which evidence claims or narratives the interviewer responded well to>

## Objections and Risks
<gaps flagged, concerns raised, pushback heard>

## Sharper Answers For Next Time
<what to say differently, with the revised framing>

## Comp-Level Strategy
<what comp signal emerged; what they said or didn't say; adjust anchor if warranted>

## Packet Updates Needed
<evidence gaps to fill, positioning to sharpen before next round>
```

**Outcome write-back — same write as conversations[] append.** After writing the debrief file and appending `conversations[]`, also update these fields **in the same tracker.json edit** — partial writes leave ghost CTAs:

- `app.status` → transition to the outcome stage: `"advancing"` (next round confirmed), `"rejected"`, `"offer"`, or `"withdrawn"` as matched by the debrief Status line. Do not leave it at the pre-debrief stage.
- `app.stage` → next-round label (e.g. `"Onsite"`, `"Technical"`) or terminal label (e.g. `"Rejected"`, `"Offer received"`).
- `jobs[].nextAction` → rewritten to the next concrete action (e.g. `"Prepare for panel — <date>"`) when advancing; set to `null` when terminal (rejected / withdrawn).
- `jobs[].nextActionDue` → next-round date when advancing; `null` when terminal or when the ball is with the employer (pending/offer-review).
- Comm thread (`comm.status`, `comm.nextActionDue`, `comm.nextAction`): update alongside the app fields — `comm.status → "waiting"` when pending/advancing and it is the employer's turn; `comm.status → "closed"` when terminal.
- `jobs[].followUp`: when the outcome is `advancing`, `pending`, or `offer`, write a follow-up so the Focus card auto-advances past the now-passed interview slot:

  ```json
  {
    "dueAt": "<interview date + 1 business day, ISO date>",
    "kind": "post-round-follow-up"
  }
  ```

  Compute the due date as the next business day (Mon–Fri) after the interview date in `app.interviewAt` (or `nextInterviewAt`). Use `"post-round-follow-up"` as the `kind` — never use the word "interview" in this field. When the outcome is terminal (`rejected` / `withdrawn`), set `followUp → null` to clear any prior entry.

**Bank what landed.** For each story under "Stories That Landed", record it back to
the bank so the next loop opens with it ranked. Re-`add` the story (an upsert by id)
with this round appended to its `landed` list:
`careerrat stories add --file <updated.yml> --write`. If a sharper framing emerged,
update the story's narrative too — still tracing to the same `evidence_ids`. A story
that didn't land or got refuted is a note for the candidate, not a silent edit.

When the debrief surfaces a detail that would strengthen a story but you don't have
yet (a number to confirm, a concrete before/after, a claim that conflicts with the
committed code), add it to that story's `open_questions[]` per STEP 2b step 4 — the
re-`add --write` mirrors it into `tracker.storyEnrichment` and the dashboard raises a
"give me more context" card. Don't gate the debrief on it; bank now, flag the gap.

**Recording:** If the user consented to recording, set `recording` to the source
(e.g. `"Granola (consent given)"`). Never auto-record. Remind the user that many
jurisdictions require all-party consent before recording (U.S. two-party-consent
states include CA, FL, IL, WA, and others) — they must obtain explicit consent
from all parties before recording starts. If no recording, leave `recording: ""`.

---

## STEP 6 — Append to tracker conversations[]

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — use the
`careerrat data <verb>` commands below (Data Write Contract, AGENTS.md). Nonzero
exit → legacy workspace (no DB yet) — follow the direct `workspace/tracker.json`
instructions in this step unchanged.

**DB workspace:** never hand-edit `workspace/tracker.json` or
`workspace/activity.jsonl`; they are generated exports. All content rules in
this step (conversation shape, Content Register routing, dossier gating, the
no-overwrite guard, atomic stage write-back) apply identically — only the write
mechanism changes:

- Append or replace `conversations[]`, row-level typed fields, and
  `artifacts.interviewDossier` by reading the current exported application row,
  building the full patched field set, and writing it with:

  ```bash
  careerrat data app set-fields <application-id> --data '<patch JSON>'
  ```

- When setting a confirmed future interview datetime and the existing value is
  absent or in the past, use the booking-aware verb first:

  ```bash
  careerrat data app schedule-interview <application-id> --at <ISO datetime> --round "<canonical round kind>" --note "<interviewNote>"
  ```

  Then use `app set-fields` for the conversation entry, dossier artifact,
  `stage`, `nextAction`, `nextActionDue`, `compNote`, `roleFit`, or other typed
  fields. If a future `interviewAt` / `nextInterviewAt` already exists and the
  invite context shows a different time, do not overwrite it here; flag the
  discrepancy and hand the reschedule to `schedule-meeting`.

- When the prep or debrief changes pipeline status, use:

  ```bash
  careerrat data app set-status <application-id> <status> --note "<statusNote>"
  ```

  Then use `app set-fields` for non-status typed fields that are not part of
  the status verb.

- When STEP 3b offer-call handling also resolves a communication thread, patch
  the full communication row and persist it with:

  ```bash
  careerrat data comm upsert --data '<patched full communication row JSON>'
  ```

- After DB writes, run:

  ```bash
  careerrat data verify
  careerrat tracker --verify
  ```

  Run `careerrat tracker` afterward only when a recovery snapshot is useful. Add
  a richer packet/debrief Activity Pulse event
  only if needed with `careerrat data activity append --data '<activity JSON>'`;
  the domain verbs already export and log their own audit events.

Locate the application row in `workspace/tracker.json`: match
`applications[].id` first; if no `id`, match by `applications[].company` +
`applications[].role`. If no row exists, halt and report — do not create a
stub row here; use `apply-job` to initialize the record first.

Append an entry to `conversations[]` on the matched row. Write **typed,
single-topic** fields per the **Tracker Content Register** in AGENTS.md — don't
concatenate comp, process, and coaching into `notes`:

> Round `kind` values follow the canonical Round Vocabulary in AGENTS.md — never numbered; a virtual onsite is `onsite`, not `final`; `final` only when the process is confirmed to end there.

```json
{
  "date": "<ISO date>",
  "kind": "recruiter screen | assessment | technical | hiring manager | onsite | final | offer",
  "who": "<name — title>",
  "notes": "<2 sentences max: what happened + immediate next step — ≤200 chars>",
  "compNote": "<1 sentence comp/band signal heard, ≤140 chars — else omit>",
  "processNote": "<1 sentence: next round + who + timing, ≤160 chars — else omit>",
  "learnings": [
    { "label": "<≤50 chars>", "note": "<≤100 chars>" }
  ],
  "recording": "<source or \"\">"
}
```

Then route the debrief sections to the right place:

- "Status / outcome + next step" → `conversations[].notes` (2 sentences).
- "Comp-Level Strategy" → `conversations[].compNote` **and** the row-level `app.compNote`.
- "What's next / process" → `conversations[].processNote`.
- "Objections / Sharper Answers / Coaching" → `conversations[].learnings[]` (labeled items, ≤5).
- Durable cross-role patterns → `candidate/learnings/<family>.md` only (STEP 7).

Also set the row-level `app.interviewNote` (≤60 chars, format
`<Round> — <Weekday> <Date> <Time> TZ with <First Name>`, e.g.
`Onsite loop — Tue 03-10 14:00 PT with Alex Rivera`) when this entry records a
scheduled/upcoming interview — that single line is what the Focus card shows.

**Persist the dossier for the Focus-card preview.** The dashboard promotes a row as the Focus interview **only** when `app.interviewAt` or `app.nextInterviewAt` is a structured ISO datetime that is in the future. Do NOT write `artifacts.interviewDossier` unless one of those fields is set and its datetime is in the future — writing a dossier onto a rejected, stale, or unscheduled row creates an orphaned artifact that can never appear on the Focus card. If neither field is set, do not generate a dossier: ask the user for the interview datetime, or hand off to `schedule-meeting` to book the slot and write the canonical datetime first, then return here.

When a future `interviewAt` / `nextInterviewAt` is confirmed, the dashboard auto-promotes the row as the featured/adaptive Focus item and its **"Open dossier"** button opens the prep packet full-page (NOT the generic job drawer). So whenever you build a packet (STEP 2) for a confirmed upcoming interview, also write the rendered packet onto the row so the preview has something to show:

```json
"artifacts": {
  "interviewDossier": {
    "title": "<Company — Role>",
    "round": "<round/audience, e.g. hiring manager>",
    "path": "workspace/interview-prep/<slug>.md",
    "generatedAt": "<ISO date>",
    "markdown": "<the full packet body written to the .md file>"
  }
}
```

`markdown` is the exact body you wrote to `workspace/interview-prep/<slug>.md` — it
stays candidate-private (tracker.json is gitignored), is rendered read-only, and is
never sent outbound. Refresh it on each re-prep so the preview never goes stale. If
no packet exists yet, leave the artifact unset — the modal shows a "prep this
interview" prompt rather than a broken preview.

**Stage write-back when a confirmed interview date is known.** When the invite has a confirmed date, write all of the following in the **same tracker.json edit** as the `interviewDossier` artifact — do not defer any field to a later write:

- `app.status` → the matching pipeline stage (e.g. `"interviewing"`)
- `app.stage` → the round label (e.g. `"Recruiter screen"`, `"Hiring manager"`, `"Onsite"`)
- `app.interviewAt` → full ISO datetime string including timezone (e.g. `"2026-07-10T14:00:00-07:00"`). Use `nextInterviewAt` when there are multiple confirmed future rounds and a current round is already set. **Never write `nextInterviewDate` — the dashboard does not read it.** **No-overwrite guard:** `schedule-meeting` is the booking authority for these fields. Only write `interviewAt` / `nextInterviewAt` when the current value is absent or is a past datetime — if a future datetime is already set and the invite context shows a *different* time, do not silently overwrite it; flag the discrepancy to the user and hand the reschedule to `schedule-meeting`.
- `jobs[].nextAction` → `"Attend interview — <date>"` (e.g. `"Attend interview — Thu Jul 10"`)
- `jobs[].nextActionDue` → the same ISO date

This makes the Focus card and Next Steps CTA reflect the actual next event. A partial write (dossier set, stage fields not updated) leaves a ghost CTA — write everything atomically.

**Legacy workspace (no DB):** after editing `tracker.json`, run in sequence:

```sh
careerrat tracker --verify
npm run verify:tracker
careerrat tracker
```

Both verify commands must pass clean before snapshotting.

Then log the packet or debrief to the Activity Pulse feed (see **Activity Pulse** in AGENTS.md):

```sh
careerrat activity append --type interview --actor agent \
  --title "Interview prep — <Company>" --summary "<packet built / debrief captured>" \
  --company "<Company>" --app-id <application id> --write
```

---

## STEP 7 — Write durable lessons to learnings file

Compose the entry body as markdown covering the durable patterns from this
interview:

- Positioning that landed (include the framing that worked)
- Objections heard with sharper answers for next time
- Comp signals (what the employer revealed about budget/flexibility)
- Recurring questions for this role type
- Keywords and titles that resonate

Capture only durable patterns. Do not record one-off conversational detail.
Keep it honest — never invent a lesson that didn't happen.

Write the composed body to a temp file, then dry-run (lint) and commit via the
learnings CLI (the helper creates `candidate/learnings/` and the family file on
first write):

```sh
# dry run — lints for placeholders and comp leaks, prints what would be appended
careerrat learnings append "<role>" --title "<short label>" --body-file <path>

# commit
careerrat learnings append "<role>" --title "<short label>" --body-file <path> --write
```

Never include `current_base` or "currently make" language in the entry body —
the CLI will refuse it.

---

## Rules

- **Separate sourced facts from JD-inferred prep.** Label likely questions and
  inferred signals explicitly; never present inference as evidence.
- **Use `candidate/evidence.yml` verbatim.** Never invent stories, metrics, or
  claims. Surface gaps so the user can fill them before the interview.
- **Select across the WHOLE evidence bank, ranked by relevance.** When building Top
  Fit Signals and the JD Fit Map, consider every claim in `candidate/evidence.yml` and
  pick those with the strongest, most role-specific overlap to the JD — not the first
  familiar matches. Recently added claims (a new repo/project appended to the bank) are
  easy to overlook, and a high-overlap claim must not be shadowed by an earlier one that
  merely shares a single signal. The `renderInterviewPacket()` scaffold now selects this
  way (diversity- and overlap-aware), but apply the same discipline when authoring
  sections by hand.
- **Stories trace to evidence and compound.** The STAR+R bank
  (`candidate/stories.yml`) is drafted from `evidence.yml`, never invented; reuse it
  across loops via `careerrat stories` and bank what lands. A behavioural gap with no
  backing evidence is an Evidence Gap, not a story.
- **Never include `current_base` in any packet section, debrief, or tracker
  note.** Anchor outbound comp on `target_base` (or `oe_max_base` for OE roles);
  `minimum_base` / `oe_min_base` are internal walk-away references, never
  surfaced outbound unless the user explicitly instructs. `expected_base` goes
  outbound only when a comp form requires it.
- **Segment prep by audience.** Questions to ask, likely questions, and the
  comp script differ by round type (recruiter ≠ HM ≠ panel ≠ offer). Expand
  sections as more audience context is known.
- **Write gates back when the user states them.** Any new gate (comp floor,
  exclusion, honesty boundary) stated mid-session must be written to the
  canonical config file — never left only in chat.
- **Domain-general.** The skill reads candidate config and makes no assumptions
  about industry, tech stack, or role type. If `job.signals` is sparse, derive
  from JD body and `targeting.yml#role_buckets` rather than leaving sections empty.
- **Don't bury the answers that win the round.** The few highest-leverage answers
  (impact metrics, the "can you do X"/weakness reframe) belong on the lead-off
  Say-This / Never-Say-This Card in memorizable form — a correct answer buried at
  packet depth is, in the room, the same as not having it. Surface verbatim numbers
  from `evidence.yml`; deliver every stated limit with its constructive reframe.
- **Every likely question gets a scripted answer or a surfaced gap — never a bare
  list.** A question with no banked story is not skipped and not improvised: it's
  flagged 🔴, the candidate is asked for the anecdote with two evidence-grounded
  example angles to jog memory, and the resulting story is drafted and banked before
  it becomes a packet answer. Shipping a packet that just lists the questions is the
  anti-pattern this skill exists to prevent.
- **Prep compounds: anchor each round to what prior rounds revealed.** A
  company's stated priorities and "big bets" (captured in `conversations[].processNote`
  and `learnings[]` from earlier rounds, per STEP 0 item 1) are the most
  company-specific signal there is, sharper than the JD. Read every prior round's
  entry before building, and anchor the packet's examples and answers to those
  priorities alongside the generic prep. Each interview's debrief (STEP 5/6) is meant
  to feed the next round's packet, that compounding loop is the point of capturing
  debriefs at all.
- **Design rounds need diagrams, the *why*, and the probe (STEP 2c).** For any
  technical or system-design round, every worked example carries an ASCII diagram
  the candidate can reproduce, the reasoning for each component choice attached to
  that choice (not a separate list), and the likely follow-up probe with its scripted
  answer. Include at least one example grounded in the company's stated priorities
  and one or two generic ones. A box with no defensible reason, or a talking-point
  list with no diagram, is not done.
- **Plain language, no buzzword chains.** Write every section so a smart
  non-specialist hiring manager follows it. Lead with what the thing *does* and
  *why it matters*, then name the tech once if it earns trust — at most one
  parenthetical of jargon. Never stack tools or acronyms back to back (not "hybrid
  RAG via Voyage + pgvector + RRF + Cohere rerank" — instead "Demo Docs Assistant searches the
  docs by keyword and by meaning at once, then re-ranks, so it finds the right
  answer even when the wording differs"). The candidate has to be able to *say* these
  sentences out loud in the room; buzzword strings don't survive a follow-up
  question. This applies to every section, the JD Fit Map most of all.

---

## Code dependencies (shipped)

- **`renderInterviewPacket()` audience param.** The packet renderer at
  `src/core/interview/packet.mjs` accepts `audience`
  (`recruiter`|`hiring-manager`|`technical`|`panel`) and emits an audience-focus
  section via `audienceFocusNote()`. Pass the round type so the packet's depth
  matches the audience.
- **`classifyRoleFamily()` domain-general families.** `classifyRoleFamily` in
  `outcome-analysis.mjs` accepts a `targeting` arg and resolves families from
  `targeting.role_families` → `role_buckets` → built-in tech fallback, so
  non-tech roles no longer collapse to `other`. STEP 0's `role_buckets[].name`
  derivation matches what the code does.
- **STAR+R story bank.** `renderInterviewPacket()` accepts an optional `stories`
  array (from `loadStories()` in `src/core/interview/story-bank.mjs`) and renders a
  "Prepared Stories (STAR+R)" section by matching stories to JD signals — rendering
  only provided stories, never inventing one. The bank is validated by
  `careerrat stories check`; every story traces to `evidence.yml` claim ids.
- **`buildLikelyQuestionsSection()` scripted-answer scaffold + gap flagging.** In
  `src/core/interview/packet.mjs`, this renders each likely question with a
  deterministic anchor: a banked story (matched via `findStoryForQuestion()` against
  the story's `prompts[]`), the Positioning Thesis (opener), the JD Signal Match row
  ("experience with <signal>"), or a 🔴 behavioural-gap flag when nothing backs it.
  Returns `{ markdown, gaps }`; `renderInterviewPacket()` appends a "Behavioural Gaps"
  section listing the unbacked questions. The renderer never authors the answer — it
  marks the anchor and instructs the agent to script the verbatim words (STEP 5) and
  to seed any gap via STEP 2b. Add a question to a story's `prompts[]` to make it
  auto-anchor next loop.
