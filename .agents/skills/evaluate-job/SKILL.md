---
name: evaluate-job
description: Body-read gate for a single job posting — fetch, save, check limits/comp/fit, emit GATE/FIT/COMP/ACTION, and write calibrated fit back to the tracker. Run before any tailoring or submission.
---

# evaluate-job

Mandatory gate before tailoring or applying. Produces an authoritative body-read verdict that overrides any scanner triage estimate.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

> **Agent voice.** Read `candidate/modes.yml#agent_voice` (default `standard`) before producing the gate verdict output. Apply the register from AGENTS.md#mode-switches. The gate block (GATE/FIT/COMP/COMP ANCHOR/ACTION) is always emitted in full regardless of register — it is structured data, not prose. Register governs the **surrounding explanation**: `exec-summary` means emit the gate block + one sentence; `standard` means gate block + short bullets on signals; `technical` means gate block + signal analysis; `verbose` means gate block + full rationale.

---

## STEP 0 — FETCH JD BODY

Obtain the full job-description text and capture it locally **now**. The live page
is not a durable record: reqs close, postings get pulled, and login sessions expire
(a board you're signed into today you may be locked out of next week). A saved URL
alone is worthless once any of those happens. So the captured body in
`workspace/jobs/` is the durable copy — never settle for a link when you could have
grabbed the text.

- **Greenhouse and plain ATS/career-site URLs** → `WebFetch <url>`.
- **JS-rendered portals** (Ashby, Stripe, Databricks, Datadog, and similar single-page-app boards) → render the page in the session browser and read `document.body.innerText` (see `docs/BROWSER.md`).
- **Login-gated postings** (the URL renders a sign-in wall, a "this job is no longer accepting applications" stub, or a generic careers page instead of the role — common on LinkedIn, Workday tenants, internal/referral links, and members-only boards) → **do not declare it closed.** Escalate to the session browser, which already holds the user's existing logins (prefer the Chrome extension; fall back to a signed-in Playwright profile — see `docs/BROWSER.md`), navigate to the posting, and read `document.body.innerText` to capture the real body while the session is still valid. If a login wall, captcha, or 2FA blocks even the browser, do not bypass it — capture whatever role text is visible on screen, note `partial: login-gated` in the frontmatter, and ask the user to paste the JD; save their pasted text as the body.
- **Already saved** `workspace/jobs/*.md` → read that file; skip fetch.
- **Genuinely gone** (a true 404 / removed posting, confirmed unreachable even via the logged-in session browser) → write a one-line note to `workspace/jobs/<company>-<role-slug>-CLOSED.md` (frontmatter: `status: closed`) and emit `GATE: CUT - posting unavailable`. Stop. A WebFetch failure alone is **not** "gone" — it usually means login-gated or JS-rendered; exhaust the session-browser path above before ever writing a CLOSED stub.

---

## STEP 1 — SAVE JD

Write `workspace/jobs/<company>-<role-slug>-<reqId>.md` for **every** posting evaluated, KEEP and CUT alike.

Frontmatter schema (all fields from spec; use `null` when unknown):

```yaml
---
company: ""
role: ""
reqId: ""
comp: ""          # raw comp string from JD, or null
location: ""
mode: ""          # remote | hybrid | onsite
source: ""        # url or "paste"
fitScore: null    # filled in STEP 6
fitBucket: null   # filled in STEP 6
fitBasis: "evaluated"
history:
  - date: ""
    event: "saved"
---
```

Append the **full JD body** below the frontmatter — the complete role text, not a summary, excerpt, or link. This is mandatory for every posting; the saved body is the only copy that survives the page closing or the login expiring. If STEP 0 could only recover a partial body (login-gated, user-pasted), save what you have and set `partial: true` in the frontmatter so it's visibly incomplete rather than silently lossy. Add a `<!-- gate: KEEP|CUT|REVIEW - reason -->` comment at the end after the verdict is reached.

Mirror the same body onto the tracker row so it travels with the application: when this posting has (or gets) an `applications[]` row, set `artifacts.jd` to the full body text (the saved `workspace/jobs/` file stays the source of truth; `artifacts.jd` is the embedded durable copy the dashboard can render without the live page).

- **DB workspace:** `careerrat data app set-fields <id> --data-file <patch.json>` with `{"artifacts": {"jd": "<full body text>"}}` (shallow merge one level — merges into the existing `artifacts` object without disturbing `artifacts.resume`/`artifacts.coverLetter`). Use `--data-file` given the body length. Not outcome-changing.
- **Legacy workspace (no DB):** edit `workspace/tracker.json` directly and set `artifacts.jd` on the matching `applications[]` row.

---

## STEP 2 — LOAD CANDIDATE CONFIG

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — every
write step below gives the `careerrat data <verb>` command (Data Write Contract,
AGENTS.md). Nonzero exit → legacy workspace (no DB yet) — every write step below
gives the existing direct JSON-edit instructions, unchanged.

**Fan-out digest short-circuit.** If this run was dispatched as a `search-jobs`
STEP 7 subagent and its prompt already carries a STEP 0 digest (the parsed
`targeting.yml`, `profile.yml`, application-limits company set, and a
company-history summary for this posting's company), use that digest for the
rows below marked **from digest** instead of re-reading those files — the
orchestrator already loaded them once and a subagent re-read is wasted context.
Still read `honesty.yml`, `modes.yml`, and the `learnings/` file yourself; the
digest never carries them. Running standalone (no digest in the prompt) — the
normal case for a directly-invoked `evaluate-job` — read every file below as
usual.

Read the following files (all under `candidate/`):

| File | Fields used |
| --- | --- |
| `targeting.yml` **(from digest, if supplied)** | `keep_signals`, `cut_signals`, `excluded_companies`, `degree_policy`, `fit_bands` (default `{high_min:85, med_min:65}`), `role_buckets[].priority` |
| `profile.yml` **(from digest, if supplied)** | `compensation.comp_floors` (arrangement floors: `remote`/`hybrid`/`onsite`/`relocation` + `home_metro` + `relocation_by_metro[]` — the HARD comp gate; relocation miss = cut), `compensation.minimum_base` (fallback floor), `compensation.target_base`, `compensation.expected_base`, `compensation.oe_min_base`, `compensation.oe_max_base`, `location.remote`, `location.relocation`, `location.travel_tolerance` — **NEVER read `compensation.current_base` for any outbound purpose** |
| `honesty.yml` | honesty boundaries (education policy, do_not_claim, do_not_fabricate) — always a fresh read; never part of the STEP 0 digest |
| `modes.yml` | optional `application_mode`; absent = `balanced`. Read via `careerrat modes status`. It changes pursuit posture after discovery/evaluation, never the evidence/honesty/comp gates. Always a fresh read. |
| `application-limits` config **(from digest, if supplied)** | `companies[].status`, `companies[].reapply_after`, `companies[].cooldown_days`, `companies[].bypass` |
| `learnings/<role-family>.md` | if present — prior outcomes for this track. Read via `careerrat learnings read "<JD title>"` — the helper classifies the family from `targeting.yml` (role_families → role_buckets → neutral-slug ladder), prints the file, or skips silently when absent. Always a fresh read; never part of the STEP 0 digest. |

Also read any **company research** artifact for FIT context (it lives under
`workspace/research/`, not `candidate/`): `careerrat research read "<company>"` —
skips silently when absent. Use its sourced signals to sharpen the FIT narrative in
STEP 6; treat anything marked `[AGENT-INFERRED ...]` as a hypothesis, never an
evidence-backed claim. If absent and the user wants company context, suggest
`research-company`.

Application mode is post-discovery posture, not search recall. `selective` means
medium body-read fits require manual review rather than immediate apply; `balanced`
uses normal gate behavior; `high-volume` may queue more medium scanner hits upstream
but does not relax this skill's honesty, comp, legitimacy, or consent gates.

---

## STEP 3 — APPLICATION-LIMITS PRE-CHECK

Look up the posting company in application limits. If a STEP 0 digest was supplied (see
STEP 2), use its application-limits company set instead of a fresh lookup. Otherwise, in DB
mode read `careerrat data candidate get --json` and use `application-limits.companies[]`;
in legacy mode read `candidate/application-limits.yml` if present.

- **`status: blocked` and today < `reapply_after`** → emit `ACTION: hold - <bypass note from config>` and stop. Do not proceed to gate.
- **`status: caution` and within `cooldown_days` window** → note in output, continue evaluation, and set `ACTION: manual` unless overridden by a later step.
- **No entry or `status: open`** → continue.

---

## STEP 3.25 — TRACKER COMPANY-HISTORY PRE-CHECK

Open `workspace/tracker.json` and review same-company history before assigning priority.
This is mandatory even when application limits have no formal cap. If a STEP 0 digest was
supplied (search-jobs fan-out — see STEP 2), its company-history summary already covers
this posting's company; use it instead of opening `workspace/tracker.json` again, and only
open the file directly when running standalone or when the digest's summary is silent on
this company.

Check:

- `applications[]` where `company` matches the posting company.
- `sourced[]` where `company` matches the posting company, excluding the current req/URL when this is a re-evaluation.
- Exact duplicates by req ID, URL, and normalized company+role.

Rules:

- **Exact req/URL/company+role already exists as an application** → do not create or promote another row. Emit `ACTION: hold` or `manual` with the duplicate reason.
- **Exact req/URL/company+role already exists in `sourced[]`** → update that row instead of adding another one.
- **Same company has an active application** (`awaiting`, `screen`, `interview`, `blocked`, or any non-terminal status) → carry `COMPANY HISTORY:` into the verdict and force `ACTION: manual`, unless the user explicitly says parallel applications are allowed or a recruiter bypass exists.
- **Same company has a recent rejection/pass** (within the last 90 days, unless application limits define a different cooldown) → carry `COMPANY HISTORY:` and force `ACTION: manual`; body-read fit can still be high, but the assistant must review positioning before applying again.
- **Same company has only prior cut/closed sourced rows** → carry a concise caution. This does not automatically block `apply-now` when the current req is distinct and live, but the prior row must be visible in the tracker note.
- **Formal app-limit block/caution from STEP 3 wins** over softer company history.

Emit when any same-company history exists:

```text
COMPANY HISTORY: caution|duplicate - <active apps / recent rejections / prior sourced rows>
```

This step exists because job-level dedupe is not enough: the application assistant owns
the company-level review before deciding whether a prospect is actually ready to apply.

---

## STEP 3.5 — LEGITIMACY PRE-CHECK (Block G)

Before the body-read gate, screen the posting for ghost-job / evergreen / staffing-
farm / staleness signals. This is a **flag, never an auto-cut**: a suspect posting
goes to REVIEW so you and the body-read decide.

A deterministic pass runs inside the gate — `careerrat evaluate <path> --json`
returns `result.legitimacy` — reading thresholds and phrase lists from
`targeting.yml#legitimacy` (defaults are field-agnostic; no config needed). It checks:

- **Evergreen / talent-pipeline** language ("talent community", "general application",
  "keep your resume on file", "future openings") — a strong tell.
- **Staffing-agency / recruiter-farm** language ("on behalf of our client", "staffing
  agency") — a strong tell.
- **Staleness** — posting older than `max_posting_age_days` (from `postedAt`/`dateOpened`).
- **Thin JD** — body shorter than `min_body_chars`.
- **Recurring** across scans — when a scan-history record is available.

Add your own body-read judgment (the deterministic check is a floor, not a ceiling):
a real role names a specific team, a charter, and concrete responsibilities; a ghost
posting is vague, perpetually open, or routes to a generic "talent pool". A single
mild signal (just old, just short) is not conclusive; a strong tell, or two mild
ones, is `suspect`.

- **`suspect`** → carry into the gate as `GATE: REVIEW`, `ACTION: manual`, and emit the
  `LEGITIMACY:` line below. Promote to `CUT` only if the posting is unambiguously a
  pipeline with no real opening, or the user's config says so.
- **`clear`** → continue silently.

Emit only when not clear:

```text
LEGITIMACY: suspect - <signals>
```

---

## STEP 4 — BODY-READ GATE

Read the **requirements/qualifications** section specifically (not only responsibilities).

Check against `targeting.cut_signals` and `targeting.excluded_companies`:

- Any single hard cut signal match → `GATE: CUT - <signal>`. Write the gate comment to the saved JD file and stop.
- Company in `excluded_companies` → `GATE: CUT - excluded company`. Stop.
- Degree requirement: apply `targeting.degree_policy` — never treat a degree requirement as a disqualifier unless the policy says so.
- No cut signals, requirements plausible → `GATE: KEEP - <summary>` or `GATE: REVIEW - <reason for ambiguity>`.

Emit:

```text
GATE: KEEP|CUT|REVIEW - <reason>
```

On `CUT`: open the saved JD file and set `fitBucket: "cut"` in its YAML frontmatter (the field is at line 10 of the frontmatter block, or search for `fitBucket:`). Skip STEP 5–10, stop.

---

## STEP 5 — COMP CHECK

Extract the comp band from the JD (may be missing; note "unlisted" if so).

1. **OE bucket check**: if the matching `role_buckets[]` entry has `priority: oe`, emit `COMP: OE-bucket - use profile.compensation.oe_min_base / oe_max_base range`. The regular floor does not apply to OE buckets.
2. **Arrangement-floor check (HARD GATE)**: the floor is **not** a single number — it depends on the posting's work arrangement, read from `profile.compensation.comp_floors` (set at ingestion). The deterministic check in `careerrat evaluate <path> --json` already resolves this via `resolveCompFloor`; honor its `comp.verdict` / `comp.relo` and do not loosen it. Resolution:
   - **Remote** posting → floor = `comp_floors.remote`.
   - **Onsite/hybrid in the home metro** (JD location matches `comp_floors.home_metro`) → floor = `comp_floors.onsite` / `comp_floors.hybrid`.
   - **Onsite/hybrid requiring relocation** (location not in `home_metro`) → floor = the matching `comp_floors.relocation_by_metro[].floor`, else `comp_floors.relocation`. This is a **relocation floor**.
   - If `band.max < floor` → `COMP: below-floor`. **When the miss is a relocation floor, it is a hard CUT, not a hold** — relocating for under-floor comp is a real-cost no-go. Emit `COMP: below-floor - relocation to <metro> requires $<floor>; band tops at $<max>` and set `ACTION: cut`.
   - Falls back to `minimum_base` for any arrangement when `comp_floors` is absent.
3. If band is unlisted or spans a wide range requiring body-read judgment:
   - **Estimate from tracker comparables first.** The gate runs `estimateCompFromComparables()` automatically — it finds roles in `workspace/tracker.json` (both `sourced[]` and `applications[]`, including rejected rows) in the same role family (`classifyRoleFamily`) and same arrangement/metro area, and computes a low/mid/high range from those with a real posted band. If enough comparables exist, `comp.verdict` will be `"estimated"` or `"estimated-below-floor"` and `comp.estimate` will carry `{lowK, midpointK, highK, sampleSize, tier, confidence, basis}`:
     - **`estimated`** (estimate midpoint clears the arrangement floor) → `COMP: review - estimated $<low>K–$<high>K (mid $<mid>K) from <N> comparables; confirm live before anchoring`. This is ADVISORY; action stays `manual`, never a hard cut.
     - **`estimated-below-floor`** (estimate midpoint falls under the arrangement floor) → `COMP: review - estimated $<low>K–$<high>K (mid $<mid>K) likely below floor; hold unless strong non-cash benefits`. ADVISORY; action is `hold`, never a hard cut. An estimate is a guess, not a posted band — never trigger `cut` on an estimate.
     - **Persist the estimate** onto the tracker `sourced[]` row as `compEstimate` so the dashboard renders it with provenance ("Built from data"). Shape: `{source:"comparables", lowK, midpointK, highK, floorK, askK, sampleSize, tier, confidence, basis, asOf}`. Stamp `asOf` with today's date (`YYYY-MM-DD`) so staleness is detectable — the dashboard surfaces it as "as of <date>".
       - **DB workspace:** there is no single-field patch verb for `sourced[]` — read the current row from `workspace/tracker.json#sourced[]`, set `compEstimate` on it (carrying every other field over unchanged), then persist the whole row: `careerrat data sourced upsert-batch --data '[<patched full sourced row JSON>]'` (a one-element batch).
       - **Legacy workspace (no DB):** edit `workspace/tracker.json` directly and set `compEstimate` on the matching `sourced[]` row.
     - **Freshness / decay (mirror `company_health`).** A comp estimate drifts as the tracker accumulates comparables. If the row already carries a `compEstimate` whose `asOf` is newer than `modes.comp_estimate.recheck_days` ago (default 30), reuse it as-is — don't recompute. Older than that, or the row just crossed into a deeper stage (screen/interview/offer), re-run the estimate and bump `asOf`. Never leave an estimate un-dated.
     - The `renderGateBlock` output includes a `COMP ESTIMATE: $<low>K–$<high>K (mid $<mid>K) - <N> <tier> comparables...; confidence <X> (confirm live before anchoring)` line when an estimate exists. Emit it in the Required Output block.
     - The estimate strengthens as more tracker rows accumulate (tighter tier match: `family` → `arrangement` → `metro`; higher confidence: `low` → `medium` → `high`). Encourage the user to confirm the real band in the first screen call to ground the anchor.
   - **No comparables available** → fall back to a market benchmark artifact. Run `careerrat research list` (or `read --name comp-bench-<role-slug>-<loc-slug>-<yyyy-mm>`) to find a non-stale `comp-benchmark` artifact for this role+location. If one exists, fold its `benchmark` floor/mid/ceiling in as the market reference → `COMP: review - market data: <floor>/<mid>/<ceiling> [artifact]`. If neither comparables nor a benchmark artifact exist, emit `COMP: review - band unclear` and offer to benchmark it via `research-comp`.
4. Otherwise → `COMP: clear - band max <X> clears the <arrangement> floor`.

Emit:

```text
COMP: clear|review|below-floor|OE-bucket - <reason>
```

---

## STEP 6 — FIT RATING

Read FIT bands from `targeting.fit_bands` (default: `high_min: 85`, `med_min: 65`).

**Fit-floor auto-drop (config-driven).** If `targeting.fit_bands.fit_floor` is set, a body-read score below that threshold is an automatic hard CUT — emit `GATE: CUT - fit <score> below your fit floor <fit_floor> (auto-drop)` and `ACTION: cut`. No manual triage, no hold, no review. This takes precedence over the med-tier review logic. The threshold is domain-neutral and lives entirely in config; when `fit_floor` is absent, nothing auto-drops and the default behavior below applies unchanged.

Score the role using the programmatic proxy as a starting point (`careerrat evaluate <path-to-job.md>` exits 0=KEEP, 2=REVIEW, 1=CUT), then **override with the body-read assessment** — the agent's judgment is authoritative.

Factor in:
- Matched `keep_signals` (raises score)
- Matched `cut_signals` (lowers score; a hard match is a CUT, not a deduction)
- Title-bucket alignment from `role_buckets`
- Location burden (onsite / travel → note caveat)
- `candidate/learnings/<role-family>.md` — if past outcomes in this family show a filter pattern, adjust the score and note it in caveats
- `companyHealth.fitDelta` on the tracker row (if present + non-stale) — the role-scoped company-health cross-cut (see below)

**Company-health cross-cut (config-driven, never a hard kill).** If the tracker row carries a non-stale `companyHealth` object (written by `company-health`), apply its `fitDelta` to the score. `fitDelta` is already `0` when the rating didn't cross-cut any stated candidate need, and a small negative (e.g. `-2`..`-5`) when it did — e.g. a layoff in the candidate's own function when they need `stability`. Name the crossing in caveats: `caveats: company-health watch — eng RIF cross-cuts your stability need (-5)`. `companyHealth` alone NEVER triggers a CUT; it only nudges the score, and can drag fit below `fit_floor` *only via the need it intersects* (the floor does the dropping, not the health rating). A `stale` rating (older than `recheck_days`) is informational — surface it but don't apply `fitDelta`; suggest a `company-health` refresh. When no `companyHealth` exists, nothing changes.

Band mapping:
- score ≥ `high_min` (85) → `high`
- score ≥ `med_min` (65) → `med`
- score < `med_min` → `stretch`

Emit:

```text
FIT: high|med|stretch <score> - <why> | caveats: <...> | priority: apply-now|hold|manual|cut
```

Update the saved JD file frontmatter: set `fitScore: <N>` and `fitBucket: <high|med|stretch>`.

---

## STEP 7 — COMP ANCHOR

On `GATE: KEEP` or `GATE: REVIEW`, emit the expected salary to state on application forms and in conversations.

- Base anchor: `profile.compensation.expected_base`; fall back to `profile.compensation.target_base` if unset.
- Adjust **up** for high cost-of-living location (e.g., CA/Bay area — read from job location).
- Adjust **up** for onsite or heavy-travel burden (read `profile.location.travel_tolerance` and lifestyle adjustment from STEP 5).
- OE bucket: use `profile.compensation.oe_min_base` / `oe_max_base` range instead.
- **NEVER emit `profile.compensation.current_base` in any line, note, or artifact.**

Emit:

```text
COMP ANCHOR: <expected salary to state> - <rationale>
```

---

## STEP 8 — ACTION

Combine `GATE` + `COMP` + `FIT` + app-limits + company-history result into a single `ACTION` verdict:

| Condition | ACTION |
| --- | --- |
| fit score below `targeting.fit_bands.fit_floor` | `cut` — auto-drop; no manual triage (config-driven; absent = no auto-drop) |
| GATE=KEEP, COMP=clear, FIT=high or med | `apply-now` |
| GATE=KEEP or REVIEW, COMP=review or unlisted | `manual` (verify comp before submitting) |
| COMP=below-floor on a **relocation** floor (`comp.relo`) | `cut` — hard gate; relocating for under-floor comp is a no-go (do not promote to apply-now) |
| COMP=estimated-below-floor (no posted band, estimate under floor) | `hold` — advisory only; confirm real band before deciding |
| GATE=KEEP, COMP=below-floor (remote/home metro, not relo) | `hold` (negotiable; unless user overrides) |
| GATE=REVIEW | `manual` (user decides) |
| app-limits: blocked | `hold` |
| app-limits: caution | `manual` |
| exact duplicate already applied/sourced | `hold` or `manual` (update existing row; do not create another) |
| same-company active app or recent rejection | `manual` (review company history before applying again) |
| GATE=CUT | `cut` |

Emit:

```text
ACTION: apply-now|hold|manual|cut
```

Note: `hold` and `manual` are **not APPS** — do not add to the applications list until actually submitted.

---

## STEP 9 — TRACKER WRITE-BACK

If this sourced role came from `search-jobs` triage (has a row in `workspace/tracker.json`):

1. Open `workspace/tracker.json`.
2. **For sourced roles (in `sourced[]`):** locate the row in the `sourced[]` array where `company` and `role` match the JD.
   - **GATE: CUT** → set `status: "cut"`. The role is now archived (drops off the active board but stays in `sourced[]`, recoverable). Do not create an `applications[]` row — but still complete the validate + snapshot (sub-step 4 below) and log the Activity event; a cut is a tracker-visible change and the dashboard must reflect it.
   - **GATE: KEEP or REVIEW** → set `status: "reviewed-hold"`. The role has passed the gate and sits on the active board as ready-to-apply.
   - Also set `fitScore`, `fitBucket`, and `fitBasis: "evaluated"` on the sourced row.
   - Also write company-history cautions from STEP 3.25 into `warn`/`note`, and set `action: "manual"` when same-company active/recent history forced manual review.
   - **DB workspace:** the role stays in `sourced[]` here — this is a field patch, not a promotion (`sourced promote` is for the later apply-time move into `applications[]`). There is no single-field patch verb for `sourced[]`, so read the current row from `workspace/tracker.json#sourced[]`, apply every field above (carrying the rest of the row over unchanged), and persist the whole row in one call:
     ```
     careerrat data sourced upsert-batch --data '[<patched full sourced row JSON>]'
     ```
     This is outcome-changing per the Data Write Contract — it bumps the stamp, logs its own activity event, and refreshes analytics in the same transaction.
   - **Legacy workspace (no DB):** edit `workspace/tracker.json` directly and set the fields above on the matching `sourced[]` row.
3. **For roles evaluated directly (not from a sourced[] row):** scan `applications[]` for an entry where `id` matches the reqId (if known), else where `company` and `role` match. If no matching row exists, do **not** create one here — `applications[]` rows are created at submission; skip to STEP 10.
   - In that object set `fitScore: <N>`, `fitBucket: "<high|med|stretch>"`, `fitBasis: "evaluated"`.
   - **DB workspace:** `careerrat data app set-fields <id> --data '{"fitScore":<N>,"fitBucket":"<high|med|stretch>","fitBasis":"evaluated"}'`. Not outcome-changing (no analytics refresh) — this is a fit-score annotation on an existing row, not a status transition.
   - **Legacy workspace (no DB):** edit `workspace/tracker.json` directly and set the fields above on the matching `applications[]` row.
4. Validate and snapshot:
   - **DB workspace:** sub-step 2's `sourced upsert-batch` call (or sub-step 3's `app set-fields` call) already persisted and auto-exported `workspace/tracker.json` + `workspace/activity.jsonl` (Data Write Contract, AGENTS.md). Run:
     ```
     careerrat data verify
     careerrat tracker --verify
     ```
     `careerrat data verify` re-exports then runs the same domain-integrity check as `npm run verify:tracker`; `careerrat tracker --verify` covers the ajv schema-level check `data verify` doesn't run. Both should pass clean.
   - **Legacy workspace (no DB):** run in sequence:
     ```
     careerrat tracker --verify
     careerrat tracker
     ```
     These are two complementary checks and both should be run: `careerrat tracker --verify` validates JSON shape/structure against config/tracker.schema.json (required keys, field presence), while `npm run verify:tracker` validates domain integrity (status recognizability, score range 0–100, modes, channels, duplicate company-role pairs). Neither replaces the other.

This promotes the row from a coarse scanner estimate to an authoritative body-read fit.

Then log the verdict to the Activity Pulse feed (the dashboard's live timeline — see
**Activity Pulse** in AGENTS.md). One event per evaluation:

- **DB workspace:** sub-step 2/3's call already auto-logged its own generic event
  (`sourced` sweep-style or `status_change`-style) in the same transaction. For
  the richer, evaluation-specific type, log an additional event (this verb only
  logs, it never bumps the stamp):
  ```
  careerrat data activity append --data '{"type":"evaluated","actor":"agent","title":"Evaluated — <Company>","summary":"<GATE verdict>: <short reason>","refs":{"applicationId":"<application id>","company":"<Company>","role":"<Role>","url":"<posting URL>"}}'
  ```
- **Legacy workspace (no DB):**
  ```
  careerrat activity append --type evaluated --actor agent \
    --title "Evaluated — <Company>" --summary "<GATE verdict>: <short reason>" \
    --company "<Company>" --role "<Role>" --app-id <application id> --url "<posting URL>" --write
  ```

---

## STEP 10 — GATE WRITE-BACK (new limits discovered)

If a new application blocker was encountered during this evaluation (e.g., a posted cap, cooldown, or portal blocker that should affect future roles), capture it on the tracker row and persist it after confirmation. DB mode writes use `careerrat data candidate limits upsert --data '<json row>'`; legacy mode writes `candidate/application-limits.yml`.

**Write-back friction rule**: blocker facts are low-blast-radius to record on the row, but durable application-limit config is confirm-first.

---

## Required Output

**CUT path** (emitted at STEP 4 when any hard cut signal fires; no further output):

```text
GATE: CUT - <signal or reason>
ACTION: cut
```

**KEEP / REVIEW path** (block after all steps complete; the `LEGITIMACY:` line
appears only when the posting is suspect — see STEP 3.5):

```text
GATE: KEEP|REVIEW - <reason>
FIT: high|med|stretch <score> - <why> | caveats: <...> | priority: apply-now|hold|manual|cut
COMP: clear|review|below-floor|OE-bucket - <reason>
COMP ANCHOR: <expected salary> - <rationale>
LEGITIMACY: suspect - <signals>            # only when suspect
COMPANY HISTORY: caution|duplicate - <signals>  # only when same-company history exists
ACTION: apply-now|hold|manual|cut
```

---

## Privacy Invariant

> See **Gates › Privacy invariant (hard)** in AGENTS.md. Short form: `current_base` never appears in any emitted line, JD note, tracker field, or artifact; outbound comp anchors on `expected_base` / `target_base` (internal walk-away: `minimum_base`).

---

## Gate-Config Write-back Rule

> See **Gates › Write-back rule** in AGENTS.md for the friction model (write-and-report vs confirm-first), the routing table, and the `careerrat gate` mechanism. STEP 9–10 apply it to this skill's writes.

---

## Config dependencies

All fields below are shipped (Foundations B+C); each has a code-side default so candidate configs without them keep working:

- `targeting.fit_bands` — `gate.mjs#scoreFit` reads these and defaults to `{high_min:85, med_min:65}` when absent. The programmatic score is a coarse proxy; the body-read FIT in this skill is authoritative, and both use the same 85/65 bands.
- `targeting.fit_bands.fit_floor` (optional) — roles with a body-read fit score below this threshold are automatically cut (action "cut") without manual triage. Domain-neutral: when absent, no roles auto-drop and default behavior applies.
- `profile.compensation.expected_base` — falls back to `target_base` if absent.
- `profile.compensation.comp_floors` — also read by `estimateCompFromComparables()` to select the arrangement floor when checking whether a tracker-derived comp estimate clears the gate.
- `profile.compensation.oe_min_base` / `oe_max_base` — emitted only when the matching `role_buckets[].priority === 'oe'`; if unset, note "OE range not configured — use target_base as anchor."
- `profile.location.travel_tolerance` — lifestyle adjustment in STEP 5 reads it; if absent, no lifestyle uplift is applied.
