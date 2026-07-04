---
name: research-company
description: Web-search a company across six domain-neutral axes → compose a cited workspace/research/<slug>.md artifact that feeds interview-prep and evaluate-job FIT context.
tier_1_inputs: [profile.candidate.domain, targeting.excluded_companies, research-prefs.yml, modes verdict, company name + freshness]
tier_2_inputs: [per-axis WebSearch/WebFetch bodies]
---

# research-company

Use this skill when the user asks to research, look up, or pull intel on a company
before an interview or application evaluation. Also use it automatically when
`interview-prep` or `evaluate-job` needs company context and no non-stale artifact
exists yet.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

> **Agent voice.** Read `candidate/modes.yml#agent_voice` (default `standard`) before producing the research summary presented to the user. Apply the register from AGENTS.md#mode-switches. The `workspace/research/<slug>.md` artifact is always written in full — register governs the **in-chat summary**: `exec-summary` = 3–5 bullet signals + file path; `standard` = short section-per-axis bullets + file path; `technical` = signal analysis + sourcing notes; `verbose` = full artifact mirrored in chat.

---

## STEP 0 — Load config

Read the following before doing anything else:

| File | Fields used |
| --- | --- |
| `candidate/profile.yml` | `candidate.domain`, `candidate.location` (string, for query context) — **NEVER read `compensation.current_base`** |
| `candidate/targeting.yml` | `role_buckets` (for domain/role context), `excluded_companies` |
| `candidate/research-prefs.yml` | `research_axes`, `staleness_days`, `max_searches_per_company` — **works if absent**; defaults are: the six axes below, 14 days, 6 searches |

Derive `candidate_domain` from `profile.yml#candidate.domain` (e.g. "logistics operations",
"financial services", "healthcare administration"). Substitute it wherever axes reference
`<domain>` below. Never hardcode a tech term.

Default six research axes (substitute `<domain>` and `<role>` from config):

1. **Overview** — company mission, size, funding stage or public status, headquarters
2. **Trajectory** — revenue trend, headcount growth or contraction, recent funding, IPO/M&A
3. **Recent Moves** — product launches, layoffs, leadership changes, press coverage (last 12–18 months)
4. **Reputation and Culture** — employee sentiment (Glassdoor, Blind, LinkedIn), DEI posture, stated values vs. reported reality
5. **Role-Relevant Challenges** — open problems or pain points in `<domain>` that `<role>` candidates are typically hired to solve
6. **Competitive Position** — main competitors, market share narrative, differentiation claims

If `candidate/research-prefs.yml` exists and specifies `research_axes`, use those instead.

Then check usage mode:

```
rolester modes allows research:company
```

If it returns `skip`, do not run web search by default; explain that lean usage mode
turns off multi-axis company research and offer to proceed only if the user explicitly
overrides. If it returns `downshift`, run a single overview query. If it returns `run`,
continue normally.

---

## STEP 1 — Resolve company and check freshness

1. Canonicalize the company name as given by the user or inferred from the JD.
2. Run:
   ```
   rolester research read "<Company>"
   ```
   - If the command returns a **non-stale** artifact (within `staleness_days`), show the
     user the artifact summary and offer two choices:
     - **Reuse** — proceed with the existing artifact; stop here.
     - **Refresh** — continue to STEP 2 and overwrite.
   - If the command returns a skip note ("no artifact" or "stale"), continue to STEP 2.

---

## STEP 2 — Run web searches per axis

**[DELEGATE: subagent]** The axes are independent, so this phase fans out — spawn one
subagent per axis (parallel; `WebSearch`/`WebFetch` has no one-browser limit). Hand each
its axis topic + company + `candidate_domain` and have it return a compact cited block
(`{axis, facts:[{claim, url, title, fetchedISO, confidence}]}`); merge them in STEP 3. The
orchestrator already cleared STEP 0's consent/mode gate and STEP 1 freshness — subagents
do not re-gate, do not read AGENTS.md, and do not write any file. Degrade to inline
sequential search when no subagent primitive exists. See the **Delegation Contract** in AGENTS.md.

Run one `WebSearch` query per axis, capped at `max_searches_per_company` (default 6).
Construct each query from the axis topic + company name + `candidate_domain` context.

Example query shapes (substitute real values — never paste these verbatim):
- Overview: `"<Company>" company overview size funding`
- Trajectory: `"<Company>" revenue growth headcount 2024 2025`
- Recent Moves: `"<Company>" layoffs product launch leadership news site:techcrunch.com OR site:reuters.com`
- Culture: `"<Company>" glassdoor reviews culture employee sentiment`
- Role-Relevant: `"<Company>" <domain> challenges open problems <role>`
- Competitive: `"<Company>" competitors market share differentiation`

For each search result:
- If the snippet is rich enough to cite a specific fact, use it directly.
- If the snippet is thin or ambiguous, `WebFetch` the top URL to read the full page.
- Record the URL, page title, fetch date (today's ISO date), axis, and confidence
  (high = primary source or credible outlet; med = aggregator or secondary; low = forum,
  anecdote, or single-source claim).

**Graceful degradation:** If a search returns zero usable results for an axis, note it
in `## Open Questions` ("No reliable sources found for [axis name]"). Do not retry in
a loop; move on.

---

## STEP 3 — Record per-claim provenance

As you collect facts, tag every claim with one of three markers:

**Verified evidence tier** — do NOT use for research. Research artifacts are NOT
`candidate/evidence.yml` and must never feed directly into resume claims, cover-letter
claims, or interview-packet assertions.

**Sourced-web fact** — a datum from a specific cited URL. Marker format (colon and
attribution are REQUIRED — a bare bracket with no colon is refused as placeholder residue):

```
[source: "<Title>" (<url>), fetched <ISO date>, confidence: high|med|low]
```

Markdown links `[Title](url)` are also accepted inline.

**Agent-inferred** — synthesis across multiple sources with no single owning URL.
Marker format (colon and attribution list are REQUIRED):

```
[AGENT-INFERRED from: <url1>, <url2> — candidate to verify]
```

**Conflicts** — when two sources disagree on a material fact, record BOTH; never
silently resolve:

```
[CONFLICT: <SourceA> says X (<urlA>, conf: high); <SourceB> says Y (<urlB>, conf: med). candidate to verify]
```

Count sourced URLs, inferred claims, and conflicts as you go — you will need the
totals for the Required Output block.

---

## STEP 4 — Compose the artifact to a temp draft

Compose the full artifact to a temporary draft file. Use a path outside
`workspace/research/` — for example `workspace/research/.<slug>.draft` — so it is
not itself listed by `rolester research list`. Do NOT write a `.md` file directly
into `workspace/research/`; the `record --write` command is the only write path.

The artifact must follow this exact structure:

```
---
type: company-research
company: "<Canonical Company Name>"
slug: "<company-slug>"
fetchedAt: "<today ISO date>"
researchedFor: "<role title if known, else 'general'>"
staleness_days: 14
sources:
  - url: "https://..."
    title: "..."
    fetchedAt: "<ISO date>"
    axis: "<axis name>"
    confidence: high|med|low
---

## Overview
<Paragraph. Every claim carries a [source: ...] or [AGENT-INFERRED from: ...] marker.>

## Company Trajectory
<Paragraph or bullets. Sourced markers on every claim.>

## Recent Moves (last 12–18 months)
<Bullets. Date each item. Sourced markers.>

## Reputation and Culture
<Paragraph. Include Glassdoor/Blind signals if found. Sourced or conflict markers.>

## Role-Relevant Challenges
<Bullets framed in candidate_domain terms — never hardcoded tech. Sourced markers.>

## Competitive Position
<Paragraph or bullets. Sourced markers.>

## Candidate Angle
<Entirely AGENT-INFERRED. Mark every sentence: [AGENT-INFERRED from: <urls> — candidate to verify].
This section connects observed company themes to role-relevant strengths the candidate
may choose to emphasize. It is synthesis, not sourced fact.
NEVER transfer any sentence from this section into evidence.yml, a resume,
a cover letter, or an interview-packet claim.>

## Open Questions
<Items where no reliable source was found, conflicts that need human resolution, or
axes that returned zero results. Format: "- <axis name>: <what is unknown>" — do NOT
wrap the axis in square brackets; a bare `[axis]` token is refused by the placeholder
lint as residue.>

## Privacy Note
Contains no candidate compensation data; no private compensation inputs are present in this artifact.
```

Frontmatter `staleness_days` must match `research-prefs.yml#staleness_days` (default 14).
The `sources[]` list must have at least one entry; `record --write` will refuse an artifact
with zero cited sources.

Every body claim must carry a provenance marker. A section with unmarked prose will be
refused by the placeholder lint.

---

## STEP 5 — Dry-run, fix, commit, clean up

1. Dry-run to validate and preview:
   ```
   rolester research record "<Company>" --file <path-to-draft>
   ```
   Read the output. If `record` refuses (placeholder residue, missing frontmatter field,
   zero sources, `current_base` leak), fix the draft and re-run. Do not proceed to `--write`
   until the dry run passes clean.

2. Commit:
   ```
   rolester research record "<Company>" --file <path-to-draft> --write
   ```

3. Log the research to the Activity Pulse feed (see **Activity Pulse** in AGENTS.md):

   ```
   rolester activity append --type research --actor agent \
     --title "Researched <Company>" --summary "<axes covered, e.g. 'product, funding, culture'>" \
     --company "<Company>" --write
   ```

4. Delete the draft file. The canonical artifact now lives at
   `workspace/research/<company-slug>.md`.

---

## STEP 6 — Confirm and hand off

Tell the user:
- The artifact is saved at `workspace/research/<company-slug>.md`.
- `interview-prep` will read it automatically when preparing a packet for this company.
- `evaluate-job` FIT context for this company is now available.
- If any axes landed in Open Questions, name them so the user can decide whether to
  supply missing context manually.

---

## STEP 7 — Handle mid-research exclusion

If the user states during the research flow that this company is a no ("I don't want
to apply there", "add them to the exclusion list", "this is a no"):

1. Confirm with the user before writing ("Add `<Company>` to excluded companies?").
2. On confirmation, run:
   ```
   rolester gate exclude-company "<Company>" --write --confirm
   ```
3. Echo the CLI confirmation. `rolester gate` writes SQLite in DB mode and legacy YAML only in legacy mode.
4. The research artifact can remain — it costs nothing and may be useful for competitive
   intel — but note to the user that `evaluate-job` will CUT any posting from this company.

---

## Required Output

Emit this block after STEP 5 completes:

```text
RESEARCH: <Canonical Company Name> — <company-slug>
AXES COVERED: <comma-separated list of axes researched>
SOURCES: <N> urls
CONFIDENCE: <X> high / <Y> med / <Z> low
CONFLICTS: <N>
ARTIFACT: workspace/research/<company-slug>.md
```

If any axis produced zero results, add:

```text
OPEN QUESTIONS: <axis1>, <axis2>
```

---

## Privacy Invariant

> See **Gates › Privacy invariant (hard)** in AGENTS.md. The artifact is treated as outbound — write it as if a recruiter could read it; `current_base` must never appear in any research artifact, summary, or Candidate Angle section.

---

## Inferred-Facts Rule (Citation-Hygiene Firewall)

Three fact tiers govern this skill. Understand and enforce all three:

**Tier 1 — Verified evidence** (`candidate/evidence.yml`): the only tier permitted in
resumes, cover letters, and interview-packet claims. Research never feeds this tier
directly. Never copy a finding from a research artifact into `evidence.yml` without the
candidate's explicit instruction and their own verification.

**Tier 2 — Sourced-web fact**: a datum from a cited URL, tagged with a `[source: ...]`
marker (colon and full attribution required). These are the body of the artifact.

**Tier 3 — Agent-inferred**: synthesis across sources, tagged `[AGENT-INFERRED from: <urls> — candidate to verify]`
(colon and url list required). The `## Candidate Angle` section is entirely Tier 3.

**The firewall:** Tier 3 claims — especially anything in `## Candidate Angle` — must
**never** be copied into `candidate/evidence.yml`, a resume, a cover letter, or an
interview-packet assertion. They are context for the candidate to verify, not sourced
facts. `evaluate-job` and `interview-prep` read research artifacts for FIT context only;
they do not promote research findings into evidence.

A bracket marker with no colon (e.g. a bare `[AGENT-INFERRED]` or `[source]`) is refused
by the placeholder lint as placeholder residue — every marker must carry its attribution.

---

## Domain-Neutrality Rule

This skill is field-agnostic. Read `profile.yml#candidate.domain` and substitute it into
every axis query. A candidate in healthcare gets "healthcare operations" queries; a candidate
in logistics gets "freight and logistics" queries. Never hardcode tech terms, engineering
jargon, or industry-specific language anywhere in the artifact. The six axes are neutral
skeletons; their queries and body prose interpolate `candidate_domain` and role context
from the candidate's own config. A no-config run (absent `research-prefs.yml`) is always
possible — all defaults are field-agnostic.

---

## Config dependencies

All fields below have agent-side defaults so absent files keep working:

- `candidate/research-prefs.yml#research_axes` — if absent, use the six default axes above.
- `candidate/research-prefs.yml#staleness_days` — if absent, default 14.
- `candidate/research-prefs.yml#max_searches_per_company` — if absent, default 6.
- `candidate/profile.yml#candidate.domain` — if absent, omit domain qualification from queries (still run all six axes).
- `candidate/targeting.yml#excluded_companies` — checked in STEP 7 only; if absent, no exclusion check is performed.
