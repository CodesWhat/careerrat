# CareerRat Foundations Spec (locked interface)

This is the **single source of truth** for the new config fields, canonical
commands, and decisions that the schema/template/code changes (Foundations B+C) and
the skill ports must all reference identically. Do not invent alternate field names
or paths — use these exactly. Preserve all existing fields/structure; only ADD.

Back-compat rule: every new config field is **optional** with a sensible default
applied in code when absent, so existing `candidate/` setups and the demo keep
working. Keep existing tests green; update only assertions that encode a value this
spec deliberately changes (the FIT bands). Do not add large new test suites yet.

---

## 1. FIT bands — ONE canonical source (resolves the 3-way 85/70/67 conflict)

Canonical bands: **high ≥ 85, med ≥ 65, stretch < 65.**

- Store as `candidate/targeting.yml#fit_bands: { high_min: 85, med_min: 65 }`.
- Code reads bands from `targeting.fit_bands` and **defaults to `{high_min:85, med_min:65}`** when absent.
- `src/core/evaluate/gate.mjs#scoreFit` currently hardcodes `>=70` / `>=45` — change
  to read `targeting.fit_bands` (default 85/65). The existing scoring weights
  (baseline 50, +5/keep cap +30, +20 bucket, −10/cut) stay; under 85/65 they give a
  sensible spread (bucket+3 keeps = 85 high; bucket only = 70 med; <65 stretch).
- Update gate.mjs tests that assert tier at the old 70/45 boundaries to 85/65.
- The programmatic `scoreFit` is a **coarse proxy**; the agent's body-read FIT in
  `evaluate-job` is authoritative. Both use the same 85/65 bands.

---

## 2. New `candidate/profile.yml` fields (+ profile.schema.json)

Add under existing objects (all optional, `additionalProperties` already true):

```yaml
candidate:
  domain: "software engineering"   # NEW — the user's field/industry. Drives board
                                   # selection + role-family taxonomy. Examples:
                                   # "software engineering", "trucking/logistics",
                                   # "nursing", "finance". Demo keeps a tech value.
  toolchain: "markdown-only"       # NEW — render toolchain detected at onboarding.
                                   # enum: pandoc | libreoffice | word | markdown-only

compensation:
  expected_base: 165000            # NEW — the number to put in a salary FORM FIELD
                                   # (may differ from target_base negotiation anchor).
                                   # OUTBOUND-SAFE. Falls back to target_base if unset.
  oe_min_base: null                # NEW — OE bucket comp range (used when a role_bucket
  oe_max_base: null                # NEW — has priority "oe"); floor/target do NOT apply.
  relo_package_needs: ""           # NEW — free-text relo requirements (gate on relo offers).
  # current_base stays PRIVATE — never outbound (see Privacy).
```

profile.schema.json: add `domain` (string) and `toolchain` (string enum:
`pandoc|libreoffice|word|markdown-only`) under `candidate`; add `expected_base`,
`oe_min_base`, `oe_max_base` (number|null) and `relo_package_needs` (string) under
`compensation`. All optional.

---

## 3. New `candidate/targeting.yml` fields (+ targeting.schema.json)

Add (all optional):

```yaml
fit_bands:                # NEW — single source for FIT thresholds
  high_min: 85
  med_min: 65

role_families:            # NEW — OPTIONAL override for outcome role-family taxonomy.
  - name: "fde"           # If absent, code derives families from role_buckets names.
    patterns: ["forward deployed", "fde"]
  # ... domain-general; non-tech users define their own (e.g. "driver", "dispatcher").

reevaluation:             # NEW — thresholds that trigger reevaluate-strategy
  rejection_total: 7      # default 7 (typical range 5–8)
  rejection_per_family: 3 # default 3 in one family/fit-band
```

targeting.schema.json: add `fit_bands` (object: high_min, med_min numbers),
`role_families` (array of {name, patterns[]}), `reevaluation` (object:
rejection_total, rejection_per_family numbers). All optional; keep
`additionalProperties:false` at top level but ADD these properties.

---

## 4. `config/tracker.schema.json` additions

The dashboard + skills already write these but the schema doesn't validate them:

- applications[] items: add `conversations` (array of objects: `{date, kind, who,
  notes, recording}` — all optional strings; `recording` is the consent/source marker).
- applications[] items: confirm `artifacts` object allows `{jd, coverLetter, resume,
  resumeNote}` (strings) and `link` (string); add if missing.
- communications[] items: confirm `messages` array exists with item shape `{id,
  direction, at, from, to[], subject, summary, artifactPath}`; add if missing.
- top-level: confirm `sources` array allows `{id, kind, name, lastRunAt}` (the
  ingest-mail / scan watermark). Add if missing.

Keep additive + optional so existing tracker.json + demo validate clean.

---

## 5. `candidate/form-defaults.yml` (+ its schema/example)

Ensure these exist (add if absent): `expected_base` (number — mirrors
profile.compensation.expected_base for the form
field), `current_employer` (string), `current_title` (string), `eeo_default`
(string), `screening_answers` (map of recurring custom questions to pre-reviewed
answers), optional `confirm_current_role` / `confirm_current_disclosure` booleans,
and the applicant URLs (`linkedin`, `github`, `portfolio`). Final submission is
always user-controlled and has no configurable override.

---

## 6. Canonical command list (skills must name these EXACTLY)

These already exist — skills must stop calling them "future work":

| Purpose | Command |
| --- | --- |
| Validate tracker schema | `careerrat tracker --verify` |
| Snapshot tracker state | `careerrat tracker` |
| Tracker summary | `careerrat tracker --summary` |
| Follow-ups due | `careerrat tracker --followups` |
| Full sourced sweep | `npm run scan:sourced -- --write --summary --verify` |
| Targeted company sweep | `npm run scan:sourced -- --company "<Company>" --write --summary --verify` |
| Incremental delta | `npm run delta:sourced -- --source <provider> --repo-new-only --write` |
| Tracker integrity | `npm run verify:tracker` |
| Outcome analysis | `node scripts/analyze-outcomes.mjs --summary` (and no-flag for full JSON) |
| Placeholder lint | `node src/cli/lint-placeholders.mjs <path>` |
| Writing-style calibrate | `npm run calibrate:style` |
| Evaluate a saved job | `careerrat evaluate <path-to-job.md>` (exit 0=KEEP, 2=REVIEW, 1=CUT) |
| List/build searches | `careerrat searches` / `--from-targeting` / `--add-url` / `--add-query` |
| Generate config files | `careerrat ingest --write-config` |
| Write a stated gate back (safe) | `careerrat gate <type> <value>` (dry run; `--write`, or `--write --confirm` for confirm-first; `--list` for types) |
| Seed from résumé | `careerrat ingest --resume <path> --json` |
| Health check | `careerrat doctor` |

---

## 7. Domain-general code fixes (Foundation C — kill tech-hardcoding)

The product must work for trucking/nursing/anything. Fix in CODE, defaulting to
current behavior when candidate config is absent (back-compat):

1. **`src/core/tracker/outcome-analysis.mjs#classifyRoleFamily`** — currently
   hardcodes tech families (fde/applied-ai/solutions/iam-security/product/software).
   Change: accept an optional `targeting` arg; if `targeting.role_families` present,
   classify by those patterns; else derive families from `targeting.role_buckets`
   names; else fall back to the current hardcoded tech set (so existing behavior +
   tests hold). Non-tech roles must NOT all collapse to "other".
2. **search-sources generator** (`src/core/providers/search-sources.mjs` /
   `scripts`/`src/cli/searches.mjs` `--from-targeting` path) — currently hardcodes
   `HiringCafe` + `RemoteVibeCodingJobs` + `"AI engineer"` fallback + a tech
   `source_catalog`. Change: select boards/aggregator from `profile.domain` (+ an
   optional board list); the tech boards become ONE example set keyed by domain, not
   the unconditional default. If no domain-appropriate board is configured, omit the
   aggregator rather than emitting a nonsensical tech RSS entry.
3. **`scan-sourced.mjs#inferMode`** — currently hardcodes Bay-Area metros as relo
   triggers. Change: read relo/metro triggers from `profile.location.relocation`;
   keep the Bay-Area list only as a fallback when relocation is empty.
4. **`title_filter.negative`** in the search-sources generator — hardcodes
   `['Intern','Junior']`. Change: derive negatives from `targeting.cut_signals`
   (plus the Intern/Junior defaults only when cut_signals is empty).

Keep all existing tests green; where a test asserts the old hardcoded behavior with
NO candidate config, behavior is unchanged (defaults), so it should still pass.

---

## 8. Example templates (don't break the demo)

The demo persona (Jane Candidate, tech) stays — it's the coherent showcase. But:

- Add `candidate.domain` + `candidate.toolchain` to `profile.example.yml` with a
  comment: "illustrative — replace with your field/toolchain".
- Add the new comp fields (`expected_base`, OE range, relo) and the new
  `targeting.yml` blocks (`fit_bands`, `reevaluation`) to the example files so a new
  user sees the shape.
- Do NOT rip out Jane's tech titles — the de-coupling that matters is in the CODE
  (section 7), not the example persona.

---

## 9. Privacy invariant (every outbound-producing skill enforces)

`profile.compensation.current_base` is a private gate input. Outbound comp comes
only from `expected_base` (form field) / `target_base` (negotiation anchor) /
`minimum_base` (walk-away). Code and skills route around `current_base` by field
path — never echo it into a résumé, cover letter, form field, message, packet, or
shareable tracker note. `current_comp_shareable` stays `false` by default.
