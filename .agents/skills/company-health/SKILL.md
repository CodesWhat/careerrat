---
name: company-health
description: Role-scoped company-health/sentiment signal — web-search layoff risk, hiring momentum, financials, sentiment, and leadership stability for the candidate's target function, score a healthy|watch|risky rating with provenance, persist it to the tracker, and cross-cut the fit score only where it hits a stated candidate need.
tier_1_inputs: [modes.company_health, targeting.role_buckets, targeting.priorities/must_haves, profile.candidate.domain, tracker row status + cached companyHealth freshness]
tier_2_inputs: [per-dimension WebSearch/WebFetch bodies]
---

# company-health

Use this skill when the user asks how risky, stable, or healthy a company is — layoffs,
financials, morale, "is this a safe place to land" — or when they ask to factor company
risk into a role. Also use it **automatically** when a tracked company reaches the
configured firing stage (default: the interview band), subject to the cost gate in STEP 1.

The question is never "is this a good company." It is **"is *my function* a risky place to
land at this company *right now*."** Role-scoped, time-stamped, judgment surface — a
healthy company that just gutted the function you'd join is a red flag; a wobbly company
doubling down on it may still be worth a shot.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Honesty
> Firewall, Privacy Invariant (`current_base` never outbound), Placeholder/Bracket Ban,
> Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, and the Tracker
> Write Contract (stamp → verify → snapshot → activity). Inline reminders at point-of-use
> are intentional. **One extra hard rail for this skill: the rating is an INTERNAL signal
> only — it must never appear in any outbound artifact** (cover letter, recruiter reply,
> LinkedIn). No "your company is in freefall" energy reaches a human at the company.

> **Agent voice.** Read `candidate/modes.yml#agent_voice` (default `standard`) before
> presenting the rating. Apply the register from AGENTS.md#mode-switches. The persisted
> `companyHealth` object is always written in full — register governs the **in-chat
> summary**: `exec-summary` = the rating + the one signal that drove it; `standard` =
> rating + per-dimension one-liners + as-of; `technical` = signal analysis + sourcing;
> `verbose` = the full rationale + evidence list.

---

## STEP 0 — Load config

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — every
write step below gives the `careerrat data <verb>` command (Data Write Contract,
AGENTS.md). Nonzero exit → legacy workspace (no DB yet) — every write step below
gives the existing direct JSON-edit instructions, unchanged.

Read before doing anything else. The skill must work with all of these absent (neutral
defaults shown).

| File | Fields used | Default if absent |
| --- | --- | --- |
| `candidate/modes.yml` | `company_health.{auto, fire_at_stage, manual_always, recheck_days}` | `auto:true, fire_at_stage:interview, manual_always:true, recheck_days:14` |
| `candidate/targeting.yml` | `role_buckets` / role families (the **target function**), `priorities` or `must_haves` (the candidate's stated **needs** — drive the cross-cut) | function = the role on the tracker row; no needs = no cross-cut |
| `candidate/profile.yml` | `candidate.domain`, `candidate.location` (query context only) — **NEVER read `compensation.current_base`** | derive domain from the role |

Derive `target_function` from the role family on the tracker row (or
`targeting.role_buckets`) — e.g. "AI/ML engineering", "supply-chain operations", "clinical
research". Substitute it wherever a dimension below references `<function>`. Never hardcode a
domain term.

Derive `candidate_needs` from `targeting.priorities`/`must_haves` (e.g. `stability`,
`growth`, `culture`, `comp`). These — and only these — decide whether the rating touches the
fit score (STEP 4). No declared needs ⇒ the rating stays a standalone signal.

---

## STEP 1 — Firing decision (cost gate)

Deep web research is expensive; do **not** run it on every applied company. Decide whether to
fire before spending a single search:

1. **Manual / explicit ask** → always run (when `manual_always: true`, the default). The user
   asked; honor it regardless of stage.
2. **Automatic** → run only when **both**:
   - `company_health.auto` is true, **and**
   - the tracked company has reached `fire_at_stage`. Map the coarse stage to the tracker
     status band: `applied` = any live row; `interview` = the row has entered the interview
     band (a real conversation / screen is booked or done — `conversations[]` non-empty or
     status at the screen band or deeper: `screen`/`interview`/`onsite`/`panel`/`offer` — a
     recruiter/phone screen counts, since `classifyStage` ranks `screen` at the interview
     threshold); `offer` = an offer is in hand.
     Default `interview` keeps the set tiny (only companies you actually reached).
3. **Freshness / decay** → if a `companyHealth` object already exists on the row and its
   `asOf` is newer than `recheck_days` ago, **reuse it** (do not re-research) unless the user
   forces a refresh or the row just crossed into the offer band. Older than `recheck_days`, or
   a major stage transition → re-research and bump `asOf`.

If the gate says "don't fire," say so briefly (e.g. "Skipping — auto-research fires at the
interview stage; run `company-health <Company>` to force it now.") and stop. Never burn
searches on a ghosted/early-funnel company by default.

---

## STEP 2 — Resolve company + function

- Resolve the canonical company name and whether it is **public or private** (changes the
  financial dimension's sources).
- Confirm the `target_function` from STEP 0. The whole rating hangs on it — a layoff that hit
  Sales is near-irrelevant to an Engineering candidate and decisive to a Sales one.
- Note `as_of` = today (the rating is stamped and decays from here).

---

## STEP 3 — Role-scoped research (the dimensions)

Run focused web searches (public sources only — no login-walled scraping), capped at
`max ~2 searches per dimension`. Weight every read toward `<function>`. Skip a dimension
cleanly if nothing credible surfaces (mark it `needs-more-info`, never fabricate).

| Dimension | What to find | Role-scoping |
| --- | --- | --- |
| **Layoff risk** | layoffs.fyi, WARN notices, RIF news (last 12–18 mo) | **Did it hit `<function>`?** Function-hit dominates the whole rating. |
| **Hiring momentum** | open-req count + trend *for `<function>`*, freezes, rescinded-offer chatter | Growing the team you'd join, or a backfill into a shrinking org? |
| **Financial health** | public: earnings, revenue trend, profitability, guidance, stock; private: last raise date + size vs headcount, down-/flat-round, stage-vs-headcount | Runway risk = staleness for private cos. |
| **Sentiment** | Glassdoor / Blind / news on morale + public perception ("how the world feels") | Prefer **trend over snapshot** + business-outlook / CEO approval over the star rating. Tempered — noisy/biased, down-weight. |
| **Leadership stability** | exec churn in the line you'd report into, reorg frequency | Is the function's leadership a revolving door? |
| **Acute catalysts** *(if present)* | lawsuit, breach, big customer loss, acquisition rumor, product flop | A live catalyst should dominate the signal. |
| **Is `<function>` strategic or a cost-center** *(synthesis)* | from the above + business model | Load-bearing function survives downturns; a side-bet gets cut first. |

Record each finding with its source + date for the evidence trail (STEP 5).

---

## STEP 4 — Score (standalone rating + selective cross-cut)

**4a — Per-dimension level.** Rate each researched dimension `good | mixed | poor` (or
`needs-more-info`) with a one-line note. `functionHit:true` on layoffs is a hard poor.

**4b — Overall role-scoped rating.** Roll up to one of:
- **`healthy`** — no function-scoped risk signals; financials/hiring/sentiment hold up.
- **`watch`** — mixed signals, or company-wide risk that hasn't reached `<function>` yet.
- **`risky`** — a function-scoped hit (layoff in your org, freeze on your reqs, cost-center
  in a downturn) or a live acute catalyst.
Bias toward `<function>`: a 4.5-Glassdoor company that just cut your exact org is `risky`, not
`healthy`.

**4c — Provenance.** `built-from-data` (≥3 dimensions with credible sources),
`needs-more-info` (thin), or `stale` (reused past `recheck_days`). Mirror `compEstimate`.

**4d — Cross-cut with candidate needs (the ONLY path to the fit score).** The rating is its
**own standalone score by default and does not touch fit.** It moves fit *only* where a poor
dimension intersects a `candidate_need`, the same way benefits feed fit only where the
candidate values them:

| Candidate need | Cross-cuts dimension(s) |
| --- | --- |
| `stability` (dependents, can't take a risky bet) | layoff risk, financial health |
| `growth` | hiring momentum, function-is-cost-center |
| `culture` / `morale` | sentiment, leadership stability |
| `comp` | financial health (offer-stage risk) |

- Intersection found → set a **small** `fitDelta` (negative; e.g. `-2` mixed, `-5` poor, per
  intersecting need). Record which needs in `crossCut[]`. Never a hard kill on its own — it
  pairs with `fit_floor` + the cold-family down-weight; a severe cross-cut can drag fit below
  floor *via the need it hits*, but health alone never gates.
- No intersection → `fitDelta: 0`, `crossCut: []`. The rating still shows as its own badge.

---

## STEP 5 — Persist to the tracker (Tracker Write Contract)

`dashboard-data.js` runs in the **browser** (no server imports / file reads — see the
dashboard data-pipeline constraint in AGENTS.md). So the rating must be DERIVED here and
PERSISTED onto `workspace/tracker.json`; the renderer only reads it. Mirror the
`compEstimate` provenance pattern.

1. On the company's `applications[]` row (or `sourced[]` row), set:

   ```jsonc
   "companyHealth": {
     "rating": "healthy|watch|risky",
     "forFunction": "<target_function>",
     "asOf": "YYYY-MM-DD",
     "provenance": "built-from-data|needs-more-info|stale",
     "crossCut": ["stability"],          // needs it intersected; [] if none
     "fitDelta": -5,                       // applied to fit ONLY via crossCut; 0 if none
     "dimensions": {
       "layoffRisk":     { "level": "poor",  "note": "...", "functionHit": true },
       "hiringMomentum": { "level": "mixed", "note": "..." },
       "financial":      { "level": "good",  "note": "..." },
       "sentiment":      { "level": "mixed", "note": "...", "trend": "down" },
       "leadership":     { "level": "good",  "note": "..." }
     },
     "rationale": "one-paragraph why, role-scoped",
     "signals": [ { "source": "...", "date": "YYYY-MM-DD", "summary": "...", "url": "..." } ]
   }
   ```

   - **DB workspace:**
     - **`applications[]` row:** `careerrat data app set-fields <id> --data-file <patch.json>` with `{"companyHealth": {...the object above...}}` (shallow merge one level — replaces the whole `companyHealth` object, which is what's wanted since it's always written in full). Use `--data-file` given the object's size (dimensions + signals).
     - **`sourced[]` row:** there is no single-field patch verb for `sourced[]` — read the current row from `workspace/tracker.json#sourced[]`, set `companyHealth` on it (carrying every other field over unchanged), and persist the whole row: `careerrat data sourced upsert-batch --data '[<patched full sourced row JSON>]'` (a one-element batch; this is outcome-changing per the Data Write Contract, so it also bumps the stamp and refreshes analytics in the same transaction).
   - **Legacy workspace (no DB):** open `workspace/tracker.json` and set the object above directly on the matching row.
2. Bump `meta.lastUpdatedAt` (the freshness stamp every writing skill bumps).
   - **DB workspace:** the `set-fields` / `upsert-batch` call in step 1 already bumped `meta.lastUpdatedAt` (and `meta.version`) in the same transaction — no separate action needed.
   - **Legacy workspace (no DB):** stamp it by hand in the same write as step 1.
3. Verify + snapshot (the dashboard handoff):
   - **DB workspace:** step 1's call already persisted and auto-exported `workspace/tracker.json` + `workspace/activity.jsonl`. Run:
     ```
     careerrat data verify
     careerrat tracker --verify
     ```
   - **Legacy workspace (no DB):**
     ```
     careerrat tracker --verify
     ```
   Fix and re-run until it passes clean. Render must never write `tracker.json`.

---

## STEP 6 — Log to Activity Pulse

- **DB workspace:** step 5's `app set-fields` / `sourced upsert-batch` call already auto-logged
  a generic event in the same transaction. For the richer, rating-specific type, log an
  additional event (this verb only logs, it never bumps the stamp):
  ```
  careerrat data activity append --data '{"type":"research","actor":"agent","title":"Company health: <Company> — <rating>","summary":"<function>-scoped: <the one driving signal>","refs":{"company":"<Company>"}}'
  ```
- **Legacy workspace (no DB):**
  ```
  careerrat activity append --type research --actor agent \
    --title "Company health: <Company> — <rating>" \
    --summary "<function>-scoped: <the one driving signal>" \
    --company "<Company>" --write
  ```

---

## STEP 7 — Hand off

Tell the user, in the configured voice register:
- The role-scoped rating + the as-of date + provenance.
- The one signal that drove it (e.g. "Eng RIF 3 weeks ago — your exact org").
- Whether it touched the fit score, and which need it cross-cut (or "standalone — didn't move
  fit").
- Consumers: `evaluate-job` reads `companyHealth.fitDelta` into scoring; the dashboard shows
  the badge on the card + the health section in the drawer; `research-company` embeds the
  section in a dossier when one is built.

---

## Required Output

Emit after STEP 5 completes:

```text
COMPANY HEALTH: <Company> — <healthy|watch|risky> for <function>
AS OF: <YYYY-MM-DD> (<provenance>)
DROVE IT: <the decisive dimension + note>
CROSS-CUT: <needs, or "none — standalone, fit unchanged">  | fitDelta: <N>
DIMENSIONS: layoffs <lvl> · hiring <lvl> · financial <lvl> · sentiment <lvl> · leadership <lvl>
```

If a dimension produced nothing credible:

```text
NEEDS MORE INFO: <dimension(s)>
```

---

## Honesty / freshness rails (hard)

- **Internal signal ONLY.** Never leaks into an outbound artifact — no defamation-y phrasing
  in anything a human at the company could read. This is the Honesty Firewall applied to a
  risk read.
- **Always stamped + decaying.** Show `asOf` + provenance; re-check past `recheck_days` or at
  the offer band; never present a lagging/noisy signal as certain.
- **Tempered sentiment.** Glassdoor/Blind are noisy and biased — down-weight them, prefer
  trend over snapshot, and never let a single bad review set the rating.
- **Judgment surface, not a hard cut.** The rating never kills a role by itself; it informs
  and, via a stated need, nudges. The candidate decides.

---

## Domain-Neutrality Rule

No hardcoded role families, companies, or domain terms in this skill's behavior. The
`<function>` and `candidate_needs` come entirely from `targeting.yml` / the tracker row. With
no config, the skill scopes to the role on the row and treats the rating as standalone
(zero `fitDelta`). See the Domain-Neutral Rule in AGENTS.md.
