---
name: research-comp
description: Web-search market comp for a role+location → cited workspace/research/comp-bench-*.md that feeds evaluate-job COMP CHECK/ANCHOR and a confirm-first gate write-back.
metadata:
  tier_1_inputs:
    - profile.compensation floor/target
    - profile.candidate.domain
    - role/location params
    - modes verdict
  tier_2_inputs:
    - per-source WebSearch/WebFetch bodies
---

# research-comp

Benchmark market compensation for a role+location via web search. Produces a cited `workspace/research/comp-bench-<role-slug>-<loc-slug>-<yyyy-mm>.md` artifact, emits a COMP BENCHMARK addendum block (when invoked from `evaluate-job`), and proposes — never auto-applies — gate write-backs when market data shows candidate targets are misaligned.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section. Bare `candidate/`, `workspace/`, `config/`, and `.internal/` paths below are symbolic; resolve them per AGENTS.md's Path Resolution rule.

> **Agent voice.** Read `candidate/modes.yml#agent_voice` (default `standard`) before producing the comp benchmark summary. Apply the register from AGENTS.md#mode-switches. The benchmark artifact is always written in full — register governs the in-chat presentation: `exec-summary` = floor/midpoint/ceiling numbers + 1-line confidence note; `standard` = scannable table of sources + band + alignment note; `technical` = per-source analysis + confidence rationale; `verbose` = full artifact + sourcing discussion.

---

## Inputs

| Source | Fields read |
| --- | --- |
| `candidate/profile.yml` | `compensation.minimum_base`, `compensation.target_base`, `compensation.expected_base`, `compensation.oe_min_base`, `compensation.oe_max_base`, `location.home`, `candidate.domain` — **NEVER `compensation.current_base`** |
| `candidate/targeting.yml` | `role_buckets[]` (role family, priority) |
| Active job file `workspace/jobs/*.md` | `role`, `location`, `company` (when invoked from `evaluate-job`) |
| `workspace/research/<company>.md` | Company-size tier (if present; used to calibrate level/band) |

---

## STEP 0 — Load config

Read `candidate/profile.yml`. Extract:

- `compensation.minimum_base` — the comp floor for below-floor comparisons.
- `compensation.target_base` — the comp target for above/at/below comparisons.
- `compensation.expected_base`, `compensation.oe_min_base`, `compensation.oe_max_base` — for context only; do not emit these in the artifact.
- `candidate.domain` — used in STEP 2 to select domain-appropriate sources.
- `location.home` — fallback market when no job-frontmatter location is available.

**Never read `compensation.current_base`.** It is a private gate input and must be absent from every artifact, emitted line, and draft this skill produces.

Then check usage mode:

```
careerrat modes allows research:comp --explicit
```

Use `--explicit` when the user asked for this benchmark. Their request authorizes this
one run and must not trigger another override question or change their saved usage mode.
For an automatic handoff from another skill, omit `--explicit`; stop if that verdict is
`skip`. If the explicit verdict is `downshift`, use one credible source or a non-stale
existing benchmark. If it is `run`, continue normally.

---

## STEP 1 — Resolve benchmark parameters

Determine the four parameters that define this benchmark:

1. **Role title** — from the active job frontmatter (`role:` field) if invoked from `evaluate-job`; otherwise from `candidate/targeting.yml#role_buckets[]` (highest-priority bucket). If ambiguous, ask.
2. **Location / market** — from the active job frontmatter (`location:` field); fall back to `profile.yml#location.home`. Normalize to a market slug (e.g. `san-francisco-ca`, `remote-us`, `new-york-ny`).
3. **Level / seniority** — infer from the role title (e.g., "Senior", "Staff", "Director"). Note if unclear.
4. **Company-size tier** — if `workspace/research/<company>.md` exists, read it for headcount/stage; otherwise note "tier unknown".

Derive the artifact stem:

```
comp-bench-<role-slug>-<loc-slug>-<yyyy-mm>
```

where `<yyyy-mm>` is today's year-month (ISO).

---

## STEP 2 — WebSearch market comp (≥3 distinct sources)

**[DELEGATE: subagent]** Source gathering parallelizes — fan out subagents across the
domain-appropriate sources (parallel `WebSearch`/`WebFetch`, no one-browser limit), each
returning its recorded data points (`{source, url, title, fetchedISO, dataPoints:[…], confidence}`).
The orchestrator already cleared STEP 0's mode/privacy gate; subagents do not re-gate, read
AGENTS.md, or write files. Collect every returned point before STEP 3 — the percentile
synthesis needs the full set. Degrade to inline sequential search when no subagent primitive
exists. See the **Delegation Contract** in AGENTS.md.

Use `WebSearch` to gather market compensation data. Select sources appropriate to `profile.yml#candidate.domain`:

- **Tech / software** — levels.fyi, Glassdoor, LinkedIn Salary, Blind, Comprehensive.io, Radford/Aon survey summaries, Dice, Indeed.
- **Finance / consulting** — Management Consulted, Wall Street Oasis, Glassdoor, 10x Management, BLS Occupational Outlook, LinkedIn Salary.
- **Healthcare / clinical** — MGMA, AMN Healthcare, Indeed, Glassdoor, BLS.
- **Creative / marketing** — Glassdoor, LinkedIn Salary, AAF/ANA salary surveys, Indeed, Robert Half Creative.
- **Other domains** — prefer Glassdoor + LinkedIn Salary + one trade-association or BLS-linked source.

Do not default to levels.fyi when `candidate.domain` is not tech; a bare assumption that every candidate is a software engineer is wrong.

**Per source, record:**

- URL
- Title / publication
- Fetched date (today ISO)
- Cited data point(s): floor, midpoint, ceiling or band (annotate with level/location qualifier)
- Confidence: `high` (primary salary database or verified survey), `med` (community self-report or aggregated reviews), `low` (anecdotal, thin sample, or older than 18 months)

Minimum 3 distinct sources. If fewer than 3 distinct sources exist for this role+location, note "insufficient public data for `<role>` in `<location>`" rather than guessing.

---

## STEP 3 — Synthesize the benchmark range

From the gathered data points derive:

- **`floor`** — 25th-percentile or lowest credible band floor across sources (null if insufficient data).
- **`midpoint`** — 50th-percentile or median across sources (null if insufficient data).
- **`ceiling`** — 75th-percentile or highest credible band ceiling across sources (null if insufficient data).
- **`currency`** — `"USD"` unless the market is non-US (use appropriate ISO code).
- **`confidence`** — `high` if ≥2 high-confidence sources agree within 15%; `med` if sources broadly agree but differ or are self-report; `low` if only 1 source or high disagreement.

**Conflict rule:** when sources disagree by more than 20% on the midpoint, do not silently average. Show a RANGE-OF-RANGES and mark each figure `[CONFLICT: source A says $X–$Y; source B says $P–$Q]`. Pick the range of ranges as the synthesized band and set `confidence: low`.

**Sparse data rule:** if fewer than 3 usable data points were found, write "insufficient public data for `<role>` in `<location>`" in the artifact body. Set `floor`, `midpoint`, and `ceiling` to `null` and `confidence: low`. Do not guess.

---

## STEP 4 — Compose the artifact draft

Write the following to a temp file (e.g. `/tmp/comp-bench-draft.md`). Every market figure must carry a source marker with a colon: `[source: "Title" (https://url), fetched <ISO>, confidence: high|med|low]`. Markdown links (`[Title](url)`) are also acceptable. A bare bracket marker with no colon is citation residue and will be refused by `record`.

```markdown
---
type: comp-benchmark
role: "<role title>"
role_slug: "<slug>"
location: "<market/location>"
company: "<company if role-at-company, else null>"
fetchedAt: "<today ISO>"
staleness_days: 30
sources:
  - url: "https://..."
    title: "..."
    fetchedAt: "<ISO>"
    confidence: high|med|low
benchmark:
  floor: <number or null>
  midpoint: <number or null>
  ceiling: <number or null>
  currency: "USD"
  confidence: high|med|low
---

## Market range

<Synthesized floor / midpoint / ceiling with citation markers per figure. Show RANGE-OF-RANGES and CONFLICT markers where applicable.>

## Sources & method

<For each source: URL, title, date fetched, data points extracted, confidence level. At least 3 entries, each with a citation marker. Note any source conflicts explicitly.>

## vs. candidate targets

<Compare market floor/midpoint/ceiling against profile.minimum_base and profile.target_base only. State "above / at / below" for each. Never print the candidate's current_base or any dollar figure attributed to their current compensation.>

## Open questions

<Unresolved items: level ambiguity, location cost-of-living adjustment needed, company-size tier unknown, thin data, etc.>

## Privacy Note

Market data only; no private candidate compensation inputs are present in this artifact.
```

**Do not write `current_base` anywhere in the draft.** The `record` guard refuses a literal `current_base` token; also refuse to print the candidate's current-compensation number in the "vs. candidate targets" section — compare against `minimum_base` and `target_base` only.

### Conversational web handoff

In conversational chat, this skill runs as an embedded session under the `chat` tool
profile (`CHAT_RUNTIME_TOOLS`), which has no Bash — there is no shell to run `careerrat
research record ... --write` from. Once the draft above is complete and clean (same
frontmatter, same citation, conflict, and `current_base` requirements — nothing about the
artifact itself changes), emit it as one exact fenced block instead of writing to a temp file:

```careerrat:discovery
{"kind":"comp_benchmark_result","role":"<role title>","location":"<market/location>","stem":"comp-bench-<role-slug>-<loc-slug>-<yyyy-mm>","benchmark":{"floor":<number or null>,"midpoint":<number or null>,"ceiling":<number or null>,"currency":"USD","confidence":"high|med|low"},"markdown":"<the full artifact text, frontmatter and body>"}
```

The app renders this as a real Save to workspace / Discard control. Saving calls the
confirm-first `research.record` intent, which runs the write server-side through the exact
same `computeResearchWrite`/`writeResearch` guards (citation-hygiene, placeholder lint,
`current_base` privacy) STEP 5's CLI path uses — so a bad artifact is refused there too, not
silently accepted. Do not tell the user the benchmark is saved until they confirm; a prose
reply is never itself a write. Skip STEP 5's CLI commands entirely in this mode — the
confirmed intent already logs the Activity Pulse event and updates `meta.lastUpdatedAt`, the
same as `record --write` does. STEP 5's `careerrat research record` CLI path stays exactly as
written below for a one-shot, non-embedded (external-agent) run, where there is a real shell.
STEP 6's COMP BENCHMARK addendum and STEP 7's gate proposal still apply either way — they
read from the now-saved artifact, not from how it got saved.

---

## STEP 5 — Record the artifact

**External-agent / one-shot CLI runs only.** In conversational chat, use the Conversational
web handoff above instead — skip straight to STEP 6.

**Dry-run first** (validates frontmatter, ≥1 cited source, placeholder lint, `current_base` guard):

```
careerrat research record "<role title>" --name comp-bench-<role-slug>-<loc-slug>-<yyyy-mm> --file /tmp/comp-bench-draft.md
```

Inspect the dry-run output. If `record` reports any refusal (missing citation, placeholder bracket, `current_base` token, missing required frontmatter), fix the draft and re-run dry.

**Commit when clean:**

```
careerrat research record "<role title>" --name comp-bench-<role-slug>-<loc-slug>-<yyyy-mm> --file /tmp/comp-bench-draft.md --write
```

Log the benchmark to the Activity Pulse feed (see **Activity Pulse** in AGENTS.md). The summary describes market data only — never the candidate's current compensation:

```
careerrat activity append --type research --actor agent \
  --title "Comp benchmark — <Role> (<location>)" --summary "<floor / midpoint / ceiling synthesized>" \
  --role "<Role>" --write
```

After `--write` succeeds, delete the temp draft:

```
rm /tmp/comp-bench-draft.md
```

The canonical artifact lands at:

```
workspace/research/comp-bench-<role-slug>-<loc-slug>-<yyyy-mm>.md
```

`record` is the **only** write path. Never write the canonical file directly.

---

## STEP 6 — Emit COMP BENCHMARK addendum (when invoked from evaluate-job)

When this skill is called from `evaluate-job` STEP 5 (COMP CHECK) or STEP 7 (COMP ANCHOR), emit the following block immediately after STEP 5 completes, so evaluate-job can incorporate it into its COMP and COMP ANCHOR verdicts:

```text
COMP BENCHMARK (market data, cited):
  Floor: $<N>  Mid: $<N>  Ceiling: $<N>  [confidence: <level>]
  Sources: <N> — workspace/research/comp-bench-<stem>.md
  vs profile.minimum_base: <above/at/below>   vs profile.target_base: <above/at/below>
```

If data was insufficient, emit:

```text
COMP BENCHMARK: insufficient public data for <role> in <location> — workspace/research/comp-bench-<stem>.md
```

When not invoked from `evaluate-job` (standalone run), emit the same block as a top-level output line.

**Negotiation data handoff:** the `benchmark.floor`, `benchmark.midpoint`, and `benchmark.ceiling` values in the canonical artifact (`workspace/research/comp-bench-<stem>.md`) are the cited market evidence consumed by the Negotiation Contract in `AGENTS.md`. The band powers two downstream uses: (1) the geographic-discount rebuttal, where the ROLE market midpoint rebuts a locale-discounted offer — `benchmark.floor` is used only when the offer is already above midpoint and the gap is narrow; `benchmark.ceiling` only when the role scope matches the top of the benchmarked band and the artifact explicitly supports it; default to midpoint; (2) the opening anchor for multi-round sequencing, cross-checked against `profile.compensation.target_base`. Skills that invoke negotiation logic must read `benchmark.*` from this artifact directly; they must not invent or estimate market figures. If no artifact exists for the role, they must run `research-comp` first rather than citing any number.

---

## STEP 7 — Confirm-first gate write-back proposal

When the market benchmark reveals that `profile.minimum_base` or `profile.target_base` is materially misaligned with market (e.g., floor is well above or below minimum_base, midpoint diverges from target_base by more than 15%), propose — never auto-run — the appropriate gate command:

```text
GATE PROPOSAL (confirm to apply):
  Market mid ($<N>) is <above|below> profile.target_base by ~<pct>%.
  To update the comp floor:   careerrat gate comp-floor <N>
  To update the comp target:  careerrat gate comp-target <N>
  Run with --write --confirm to commit. Do not auto-apply.
```

Show both commands only when both are misaligned. Show neither when the market and profile targets are in range. Never invoke `careerrat gate` automatically — only propose the commands.

---

## Required Output

**Standalone run:**

```text
COMP BENCHMARK (market data, cited):
  Floor: $<N>  Mid: $<N>  Ceiling: $<N>  [confidence: <level>]
  Sources: <N> — workspace/research/comp-bench-<stem>.md
  vs profile.minimum_base: <above/at/below>   vs profile.target_base: <above/at/below>
[GATE PROPOSAL block — only when misaligned]
```

**When invoked from evaluate-job:** emit the COMP BENCHMARK block between evaluate-job STEP 5 and STEP 7 so the calling skill can use the market data in its COMP and COMP ANCHOR verdicts.

---

## Privacy Invariant

> See **Gates › Privacy invariant (hard)** in AGENTS.md. Short form: `current_base` never appears in any emitted line, artifact draft, canonical research file, or gate proposal; outbound comp comparisons use `minimum_base` and `target_base` only.

---

## Citation & conflict rules

- Every market figure in the artifact body carries a source marker with a colon: `[source: "Title" (https://url), fetched <ISO>, confidence: high|med|low]`. Markdown links are also acceptable.
- A bare bracket marker with no colon (e.g., `[levels.fyi]`) is refused as placeholder residue.
- Conflicting ranges → show a RANGE-OF-RANGES with all sources, never silently average; mark `[CONFLICT: ...]`.
- Sparse data (fewer than 3 usable data points) → write "insufficient public data for `<role>` in `<location>`"; set `floor`/`midpoint`/`ceiling` to `null`; set `confidence: low`.

---

## Domain-neutrality rule

Source selection is driven by `profile.yml#candidate.domain` + the role title (STEP 2). Never assume the candidate is in tech. levels.fyi is appropriate only when `candidate.domain` is tech or software; for all other domains use domain-appropriate salary databases, industry surveys, or BLS-linked sources.
