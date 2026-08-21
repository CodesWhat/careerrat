# Search-shape eval — Phase 1 & 2 results

Status: Phase 1 and Phase 2 complete (fixtures-only, no live search/network). Phase 3
(the live pass) is out of scope for this run and was not executed — see "What wasn't
run" below.

Companion to `.planning/SEARCH-SHAPE-EVAL.md`, which owns the eval design and the
decision rule this doc evaluates. This doc reports numbers only; it does not modify
the plan doc, the scorer, the AI lane, or any skill.

## Harness

- `scripts/eval/phase1-deterministic.mjs` — runs `scoreSourcedOffer()` (the exported
  wrapper around `scoreSourcedOfferFromConfig` in `src/core/scoring/sourced-scanner.mjs`)
  against every posting in the labeled corpus, scored against
  `examples/demo-workspace/candidate/{targeting,profile}.yml`. Pure function calls, no
  network, no AI, deterministic, sub-second.
- `scripts/eval/phase2-ai-lane.mjs` — feeds the SAME corpus through the search-jobs
  skill's "AI Web Search mode" + "STEP 3 — Coarse triage" instructions, extracted
  **verbatim** from `.agents/skills/search-jobs/SKILL.md` at run time (never a
  hand-copied snapshot — see `scripts/eval/lib/skill-sections.mjs`), scored against the
  exact candidate context `buildSearchPromptContext()` (reused unmodified from
  `src/core/search/search-prompts.mjs`) builds for the demo workspace. Runs the live
  WebSearch/WebFetch half is skipped — each posting is handed to the model already
  "found" (title/company/location/url only, no JD body — see corpus provenance below),
  matching real STEP 3 triage timing. Invoked through the installed `claude` CLI runtime
  (`src/core/ai/installed-runtimes.mjs`'s `detectInstalledRuntimes()` +
  `buildInstalledRuntimeInvocation()`, reused unmodified; `--safe-mode`, no tools, a
  `--json-schema` constraining output to one triage result). If no installed CLI runtime
  is available, the script **stops** with a explicit message and a non-zero exit — it
  never simulates results. Both scripts are deterministic/re-runnable given the frozen
  corpus; Phase 2's exact bucket/score per call is **not** bit-for-bit reproducible run
  to run (live model sampling — see caveats below), though the aggregate pattern
  reported here reproduced consistently across a 3-posting smoke test and the full run.
- `tests/fixtures/eval/search-shape-corpus.json` — the labeled corpus. Full provenance,
  disclosures (agent-judged labels, synthetic company/URL fields), and the one synthetic
  control entry are documented in the fixture's own `_meta` block.

Re-run either phase:

```sh
node scripts/eval/phase1-deterministic.mjs --out /tmp/phase1.json
node scripts/eval/phase2-ai-lane.mjs --out /tmp/phase2.json          # costs real $ — see below
node scripts/eval/phase2-ai-lane.mjs --limit 5 --out /tmp/phase2.json  # cheap smoke test
```

Neither script's output is committed — see "Why the raw JSON isn't checked in" below.
This doc's tables are the durable record of the run.

## Corpus

62 postings: 61 transcribed from "happy path" samples across **36 distinct** vendored
provider conformance fixtures (`tests/fixtures/career-ops/providers/*.conformance.mjs`,
out of 73 total suites — roughly half of all supported provider types), plus 1
author-added synthetic control (`sc-01`, testing the `excluded_companies` code path).
Every entry's `title`/`provider`/`sourceFixture`/`sourceLine` is a direct citation back
to the fixture file; `company`/`location`/`url` are disclosed as agent-assigned where
the fixture didn't name a real employer (most of them — see corpus `_meta`).

**No posting carries a JD body.** The 73 vendored provider suites test ATS *list*-endpoint
wire parsing (title/url/location/date), not JD prose — none of them embed a realistic
multi-paragraph description in their happy-path samples, because the endpoints they
model don't return one either. This is not a corpus-building shortcut: it's the actual
state of the world at the moment `search-jobs` STEP 3 coarse triage runs in production,
*before* STEP 4 fetches the JD body. Every score below is a title/company/location-only
triage, on both lanes, symmetrically.

My own label distribution: 13 high, 11 med, 38 stretch (agent-judged against
`examples/demo-workspace/candidate/targeting.yml` + `profile.yml`; disclosed as
Claude's own read, not a human's — see corpus `_meta.labeling_disclosure`).

## Phase 1 — deterministic scanner vs. my labels

| | count |
| --- | --- |
| Total postings | 62 |
| Agree | 38 |
| Disagree | 24 |
| **Agreement** | **61.3%** |
| **Disagreement** | **38.7%** |

By my label:

| my label | n | scorer agreed | agreement |
| --- | --- | --- | --- |
| high | 13 | 0 | 0.0% |
| med | 11 | 0 | 0.0% |
| stretch | 38 | 38 | 100.0% |

**Critical caveat, stated in numbers, not adjectives: the deterministic scorer output
`fitBucket: "stretch"` for all 62/62 postings (100%) in this corpus.** It never produced
`high` or `med` once. The 61.3% "agreement" figure above is therefore mathematically
identical to "the fraction of my own labels that happen to be stretch" (38/62 = 61.3%)
— it measures my label distribution, not the scorer's discrimination. On this corpus the
scorer behaved as a constant-output classifier.

Why: `scoreSourcedOfferFromConfig`'s keep/cut-signal matching (`keywordMatches`) is a
literal, whole-term substring check — the *entire* target string (a role-bucket title
like `"applied ai engineer"`, or a keep_signal sentence like `"customer-facing
deploy-and-adopt"`) must appear verbatim inside the offer's title+body. With no JD body
and short realistic titles ("Senior AI Engineer", "Head of Applied AI", "AI Engineer"),
none of them literally contain a full multi-word bucket title as a substring, so the
keep-signal path (`setBase(82, ...)`) never fires; cut-signal terms are equally
multi-word and never fire either. Every one of the 62 scored postings landed on the
scorer's base score alone (52 with no location bonus, 57 with a remote/US location
match) plus the `comp-unposted` flag (which fired on all 62 — no posting carries comp
text) — never higher than 57, well under the med threshold of 65.

## Phase 2 — AI web-search lane vs. my labels, and vs. Phase 1

All 62 postings scored successfully (0 failures, 0 retries needed).

**AI vs. my labels:**

| | count |
| --- | --- |
| Total postings | 62 |
| Agree | 37 |
| Disagree | 25 |
| **Agreement** | **59.7%** |
| **Disagreement** | **40.3%** |

By my label:

| my label | n | AI agreed | agreement |
| --- | --- | --- | --- |
| high | 13 | 0 | 0.0% |
| med | 11 | 0 | 0.0% |
| stretch | 38 | 37 | 97.4% |

AI `fitBucket` output distribution: stretch 53 (85.5%), med 8 (12.9%), high 1 (1.6%).

**AI vs. deterministic (Phase 1) — the decision-rule metric:**

| | count |
| --- | --- |
| Total postings both lanes scored | 62 |
| Agree | 53 |
| Disagree | 9 |
| **Agreement** | **85.5%** |
| **Disagreement** | **14.5%** |

Confusion (deterministic → AI):

| deterministic | AI | count |
| --- | --- | --- |
| stretch | stretch | 53 |
| stretch | med | 8 |
| stretch | high | 1 |

All 9 disagreements, in full:

| id | title | mine | deterministic | AI |
| --- | --- | --- | --- | --- |
| gh-03 | Staff SWE (Cloudflare) | med | stretch | high |
| ashby-01 | Head of Applied AI | high | stretch | med |
| arb-01 | Staff AI Engineer | high | stretch | med |
| gem-01 | AI Engineer | high | stretch | med |
| him-01 | Staff AI Engineer | high | stretch | med |
| join-01 | Senior AI Engineer | high | stretch | med |
| rmtv-01 | Staff AI Engineer | high | stretch | med |
| wkbl-02 | Tech Lead | stretch | stretch | med |
| wn-01 | Senior AI Engineer | high | stretch | med |

**Unexpected finding, worth stating plainly: the AI lane was far more conservative than
either the plan doc's hypothesis or my own labels predicted.** Given the deterministic
scorer's literal-substring blind spot documented above, I expected the AI lane's natural-
language judgment to correctly promote the obviously-AI-titled postings ("Senior AI
Engineer", "AI Engineer", "Staff AI Engineer" — 7 of these appear in the corpus) to
`high`. It promoted exactly **one** posting to `high` across the whole run (and that one,
`gh-03` "Staff SWE" at Cloudflare, isn't even AI-titled — my own label for it was only
`med`). The other AI-titled postings it nudged to `med`, not `high`, and several
identically-titled ones ("Staff AI Engineer" at `flow-01`, `gob-01`) it left at `stretch`
entirely. `aiSourceEvidence` text (e.g. for `sc-01`, the excluded-company control:
`"Acme Defense Contractors Inc. appears verbatim in candidate excluded_companies;
generic \"Software Engineer\" title matches no role bucket..."`) shows the model is
reasoning about the actual rules given, not pattern-matching on the word "AI" — it
appears to be hedging toward `med` precisely because STEP 3 calls for "a coarse honest
estimate" and no JD body is available to confirm the bucket's specific criteria (customer-
facing, deploy-and-adopt). That is arguably *better-calibrated* than my own agent labels,
which credited a bare "AI Engineer" title as `high` on title semantics alone — meaning
disagreement with "my labels" here may reflect my own labels being the less rigorous
side of that comparison, not an AI-lane defect. `sc-01` (excluded-company control) fired
`excluded-company` correctly on both lanes.

Every one of the 62 AI calls emitted `comp-unposted` (correctly — no posting in the
corpus carries comp text), the same flag the deterministic scorer applied to all 62. This
is the one rule flag both lanes fired identically and universally, and a useful sanity
check that the AI lane is actually applying STEP 3's rule set rather than free-associating.

**Companion structural finding (independent of the fitBucket numbers above, found while
building the harness):** `buildSearchPromptContext()` (`src/core/search/
search-prompts.mjs`), which is what the AI lane's candidate context actually is, reads
per-bucket `role_buckets[].fit_signals` / `.down_signals` — **not** the top-level
`targeting.yml#keep_signals` / `#cut_signals` the deterministic scorer uses, and not
`role_buckets[].notes` either. `examples/demo-workspace/candidate/targeting.yml` defines
`keep_signals`/`cut_signals` at the top level and `notes` per bucket (no bucket-level
`fit_signals`/`down_signals` at all), so the AI lane's real candidate context for this
run carried **only** role-bucket titles + `excluded_companies` + location posture +
comp floor — confirmed directly from `phase2-ai-lane.mjs`'s logged
`candidateContext` output. Every qualitative keep/cut signal ("customer-facing
deploy-and-adopt", "core platform SWE with no AI surface", etc.) that a human reading
`targeting.yml` would use is invisible to both lanes for a workspace shaped like the
demo one — the deterministic scorer because keyword matching against those sentences
structurally can't fire from a title, the AI lane because the field it reads was never
populated. This is a real gap in `buildSearchPromptContext()`/the demo workspace's
config shape, not a byproduct of this eval's methodology, and it's worth a look
independent of whatever this eval recommends about the fit-scoring lane split.

## Cost and wall-clock

| | Phase 1 (deterministic) | Phase 2 (AI lane) |
| --- | --- | --- |
| Total cost | $0 (pure function calls) | $6.4359 |
| Avg cost / posting | $0 | $0.1038 |
| Total wall-clock | <50ms for all 62 | 599,297ms (~9m 59s) |
| Avg wall-clock / posting | <1ms | 9,666ms (~9.7s) |

Phase 2 ran sequentially (one installed-CLI subprocess at a time); wall-clock would drop
with concurrency but cost would not. `--safe-mode` (no project CLAUDE.md/MCP/skills
loaded) keeps cache-creation input tokens to ~3-3.5k per call instead of the ~50k+ a full
project-context call would cost — confirmed empirically before committing to the full
62-call run (a same-prompt test at full project context cost $1.05/call; the harness's
actual `--safe-mode` calls averaged $0.104/call, a ~10x reduction).

## Decision rule (from `.planning/SEARCH-SHAPE-EVAL.md`)

> if Phase 2 shows the LLM disagreeing with the deterministic scorer on more than 10 to
> 15 percent of postings both can see, **and** Phase 3 shows a materially higher
> dead-link rate in the AI lane, port the upstream discipline in

Measured Phase 2-vs-deterministic disagreement: **14.5%** (9/62) — inside the stated
10-15% band, at its high edge, not clearly over it.

**Phase 3 was not run in this task (fixtures-only, no network, per the assignment
scope).** The decision rule is an AND of two conditions; without Phase 3's dead-link-rate
measurement, the rule as literally written cannot be conclusively resolved either way —
there is no dead-link data to compare.

## Recommendation

Given the decision rule can't be fully evaluated without Phase 3, this is a directional
recommendation, not a resolution of the rule:

**Run Phase 3, and lean toward porting the upstream discipline in once it's run**, for
three numeric/structural reasons independent of whether Phase 3's dead-link gap turns
out to be large:

1. The 14.5% Phase 2-vs-deterministic disagreement sits at the top of the stated 10-15%
   band, not comfortably below it — this alone is a weak "maybe" signal on its own terms.
2. The deterministic scorer's 100%-stretch output on this corpus (zero postings promoted
   to high or med, out of 62, including 7 explicitly AI-titled roles) is independent
   evidence of a real scoring blind spot for title-only triage in an AI-focused
   targeting config — the literal-substring keep/cut-signal match structurally cannot
   fire without either a JD body or a title that happens to contain a full multi-word
   bucket title verbatim. This isn't a Phase-3-contingent finding; it reproduces from
   the scorer's own matching logic and the demo targeting.yml's own field shapes.
3. The AI lane, even AI operating with a materially narrower candidate context than a
   human would have (see the `buildSearchPromptContext()` gap above — no keep/cut
   signals reached it at all), still applied more differentiated judgment (med for 7 of
   9 disagreements, versus the scorer's flat stretch) and did so at a real but bounded
   cost (~$0.10/posting, ~10s/posting at the safe-mode/no-tools scoring-only step
   measured here — a live search+triage call would cost more).

Before acting on this, two follow-ups fall out of the harness build, both flagged as
independent of the eval's outcome and out of scope for this task to fix: (a) the
`buildSearchPromptContext()` keep/cut-signal gap documented above, and (b) confirming
whether this eval's specific 14.5%/100%-stretch pattern is an artifact of the demo
workspace's particular targeting shape (very AI-specific bucket titles, sentence-length
keep_signals) or holds across other configured targeting styles — this run used the
one demo workspace named in the assignment and did not test alternate configs.

## What wasn't run

- **Phase 3 (live pass)** — needs network; explicitly out of scope for this task.
- **Recall of postings the deterministic adapters can't reach at all** (novel-company
  discovery) — that's a Phase 3 question, not measurable from a frozen fixture corpus.
- **Concurrent/batched Phase 2 calls** — the harness runs sequentially; wall-clock (not
  cost) would improve with concurrency, not measured here.

## Why the raw JSON isn't checked in

`scripts/eval/phase1-results.json` / `phase2-results.json` (the scripts' default output
paths) are regenerable by running the harness and are not committed: Phase 2's raw
output embeds the resolved absolute path to whichever installed CLI ran it, which
`tests/release-safety.test.mjs`'s "operational scripts do not hardcode an absolute
personal-home path" check correctly flags for anything under `scripts/`. The harness
itself was fixed to redact that path from its own JSON output and console log (see
`phase2-ai-lane.mjs`), but the *results themselves* still aren't meant to be committed —
re-run the scripts for a fresh copy if needed. This doc is the durable, portable record
of the run.
