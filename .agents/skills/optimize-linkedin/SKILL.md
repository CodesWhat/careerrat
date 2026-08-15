---
name: optimize-linkedin
description: Read the candidate's LinkedIn profile through the session browser, diff it against their targeting + evidence, and propose honest, evidence-backed rewrites of the headline / About / experience / skills / Featured — then, with a separate opt-in, write the approved edits back confirm-first per field. Dry-run preview is the default and always the first move. Opt-in, user-initiated, local-only. Capabilities = profile_optimize (read+suggest), profile_apply (write-back); platform = linkedin.
---

# optimize-linkedin

A LinkedIn profile pass driven through the session browser. It reads the candidate's
live profile, diffs it against their own truth bank (`targeting.yml` + `evidence.yml`),
and proposes honest, evidence-backed rewrites so the profile reads for the roles they
actually want. With a second, separate opt-in it can write the approved edits back.

**Two separately-gated capabilities on the `linkedin` platform, both defaults OFF:**

- **`profile_optimize` (read + suggest)** — reads the profile and produces a full
  before→after diff. Read-only. Never touches the live profile.
- **`profile_apply` (write the approved edits)** — applies the approved rewrites in the
  live profile through the session browser, **confirm-first PER FIELD**.

Reading/suggesting and writing carry different ToS exposure and intent, so they are
independently gated through the same `mayRun()` three-part AND — turning on suggestions
never implies write-back. Both halt on captcha / 2FA / login-wall.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

**Dry-run preview is the default and always the first move.** The skill always produces
the full read-only before→after set first — everything it would flag and change, nothing
touched — so the candidate sees the whole picture before a single field is written.
Applying is a deliberate opt-in second step, per field. This is the same dry-run-by-default
posture as `apply-job`'s `one_click_apply`: preview the diff, then write. It also means the
skill runs as a pure read-only audit even when `profile_apply` is off.

## STEP 0 — CONSENT GATE (hard stop)

Editing a public profile is modifying public-facing content. Never open a browser or
touch the profile until consent is confirmed.

Run:

```
careerrat automation status --json
```

Inspect `capabilities.profile_optimize` and `capabilities.profile_apply` for platform
`linkedin`. For each, `allowed: true` means all three conditions hold simultaneously: the
capability's global switch is on, `linkedin` is on for that capability, and `linkedin`
ToS consent is recorded. This is the three-part AND from `mayRun()` in
`src/core/automation/consent.mjs` — never re-derive it in prose.

Resolve the run mode from the two verdicts:

- **`profile_optimize` allowed** → run the read + suggest pass (STEPS 1–4). This is the
  whole skill for most users.
- **`profile_apply` ALSO allowed** → after the user approves specific fields in STEP 4,
  you may write those fields back (STEP 5). `profile_apply` allowed but `profile_optimize`
  not is not a valid run — you must read and propose before you can apply.
- **Neither allowed** → you can still run the **lean / no-browser fix-doc path** (see
  below), which needs no consent because it drives no logged-in session. For the
  browser-driven pass, explain how to opt in, then stop:

  1. Read LinkedIn's terms yourself to confirm automated profile reads (and, for
     write-back, automated edits) are acceptable to you.
  2. Record consent: `careerrat automation consent linkedin --write`
  3. Enable read+suggest: `careerrat automation enable profile_optimize --write` then
     `careerrat automation enable profile_optimize linkedin --write`
  4. Only if you also want write-back: `careerrat automation enable profile_apply --write`
     then `careerrat automation enable profile_apply linkedin --write`
  5. Verify: `careerrat automation status --json`

State clearly: both capabilities are OFF by default; enabling either is a deliberate
choice, and write-back is a separate switch from suggestions. The user reads the ToS
themselves — CareerRat records the decision but does not make it.

This skill is always user-initiated. Never run it unprompted or on a schedule.

## STEP 1 — LOAD THE CANDIDATE TRUTH BANK

The profile is rewritten **from the candidate's own data**, never invented. Read:

- `candidate/profile.yml` — `domain`, `toolchain`, `location.*`, and the outbound-safe
  comp fields. **`compensation.current_base` is private — it must never appear in any
  suggested or written profile copy.**
- `candidate/targeting.yml` — `role_buckets` / target titles, `keep_signals`,
  `cut_signals`. This is what the profile should *read for* — the target side.
- `candidate/evidence.yml` — the claim bank. **Every proposed line must trace to a claim
  here** (run `careerrat evidence list` if useful). No claim → no line. This is the same
  honesty firewall `tailor-application` enforces.
- `candidate/honesty.yml` — `education` policy, `tools.confirmed` / `tools.do_not_claim`,
  `claims.do_not_fabricate`. Overclaim caps apply to profile copy exactly as they do to a
  résumé.
- `candidate/writing-style.md` (+ `workspace/writing-samples/`) — voice/register, so the
  rewrite sounds like the candidate, not like corporate filler.

If `candidate/` is not set up, run `ingest-profile` first — there is no truth bank to
diff against otherwise.

## STEP 2 — OPEN THE PROFILE IN THE SESSION BROWSER (read-only)

Navigate to the candidate's own LinkedIn profile in the session browser. The session
browser is Layer 3 per `docs/BROWSER.md`. Keep the provider on `auto` unless the user
explicitly changes it; CareerRat resolves the current session browser and reuses its
signed-in session.

Snapshot or read the current page before reading anything. Drive the live DOM
turn-by-turn; never rely on hardcoded selectors — the same model as `apply-job` and
`ingest-messages`.

On a login wall, captcha, 2FA prompt, or any unexpected interstitial, halt immediately
and ask the user to complete it. Never bypass or automate around an auth challenge.

Save any screenshot or scraped fragment under `workspace/` only.

> **Lean / no-browser fix-doc path.** If no session browser is configured, the user wants
> suggest-only, or consent is off, skip the live session entirely. Work from a read-only
> source instead — a Layer-1 `WebFetch` of the public profile, or a profile the user
> pastes in — and produce the same before→after document (STEP 4). No browser, no consent
> needed, no write-back. This is the default tier and a valid complete run on its own.

## STEP 3 — READ THE CURRENT PROFILE SURFACES (capture verbatim)

Read and record the current text, per surface, so the diff is exact:

- **Headline** — the current line under the name.
- **About** — the full summary text.
- **Experience** — each role's title, employer, dates, and **description body**.
- **Skills** — the current skill list (note the 50-skill cap and which are pinned/top).
- **Featured** — the current Featured items (cards/links) and their titles/descriptions.
- **Licenses & certifications** — each credential, its issuer, and issue/expiry dates.
- **Open-to-work / job preferences** — the target-titles field (visible only to the user).
- **Contact info** — websites and their labels/types.

Capture each verbatim. Don't propose anything yet — STEP 4 owns the diff.

## STEP 4 — DIFF + PROPOSE (the dry-run preview — always produced first)

For each surface, write the candidate's current text beside an honest, evidence-backed
rewrite. Apply these rules — they are the crux of the skill:

**Honest-vs-target field rule (load-bearing).** Headline / About / Experience describe
what the candidate ACTUALLY is and has done — strictly honest, **no aspirational titles**.
Target titles the candidate is *seeking* (e.g. a role they want but haven't held) belong
in the **Open-to-work / job-preferences** field, never the headline. The mistake to avoid:
a target title in the headline and then absent from open-to-work. This is the honesty gate
applied to the profile surface.

**Trace every line to evidence.** No proposed bullet, metric, or claim without a backing
`evidence.yml` claim. Honesty caps from `honesty.yml` apply (nothing in `do_not_claim` /
`do_not_fabricate`; education policy honored). Profile copy is held to the same standard
as a tailored résumé.

**A flagged claim may be a stale evidence bank, not an overclaim.** When a claim already on
the profile does NOT trace to `evidence.yml`, do not default to softening or cutting it — the
evidence bank may simply be out of date (a repo gained stars, a feature, or more pulls since
the claim was last written). Verify the specific against the source first: the candidate's own
repo (`~/code/<repo>`, `gh repo view <owner>/<repo>`) or their public portfolio. If it
verifies, the fix is to **update `evidence.yml`** — record the grounded fact plus a dated
source note — so the honest copy is backed, NOT to weaken it. Only if it cannot be
substantiated do you soften or cut. Confirm with the candidate either way. (The firewall flags
for human review; it does not auto-delete honest work.)

**Expired-but-earned credentials are factual.** A lapsed license or certification is still
something the candidate genuinely earned — listing it is honest. The only dishonest move is
hiding or forward-dating the expiry to imply current validity. Surface an expired credential
as the candidate's choice — keep it shown-as-expired (transparent), recertify, or remove —
never silently make it read as current.

**Obfuscation / NDA convention.** Internal employer project names are typically NDA and
must not be made public. The source of truth for what is *already public* is the
**candidate's own public portfolio / OSS surface** — repos and products they ship under
their own name keep their **real** names and **real** public stats (stars, listings,
downloads). On LinkedIn the employer is usually named, so describe internal employer work
**generically** (no internal codenames, no project names) with sensitive specifics
redacted. Keep only safe, already-public metrics; **drop** dollar figures, exact internal
headcounts/record counts, vendor/system lists, and internal tool/channel counts. The
`current_base` privacy invariant holds on everything.

**Don't "fix" intentional styling.** A candidate's deliberate brand styling in the
headline (unusual separators, lowercase, symbols that match their portfolio) is a choice,
not broken markup. Never flag stylistic choices as bugs.

**Voice + length.** Keep the About short and in the candidate's register — no corporate
wall-of-bullets. Match `writing-style.md`.

**No placeholder brackets.** If a detail is unknown, go generic or omit it — never emit
`[Company]`, `[Role]`, `[Name]`, or any bracket token (the repo lint rejects them).

Write the full set to a document the candidate can act on, in the loose `_linkedin/`
bucket (per the Artifact Contract — a profile doc isn't a per-company round), e.g.
`~/Downloads/careerrat/_linkedin/linkedin-optimize-<yyyy-mm-dd>.md`, formatted current → proposed per
surface, with a one-line rationale and the backing evidence claim id for each change.
Present the same diff inline to the user.

**If `profile_apply` is off, you are done here** — this document is the deliverable. The
user applies the edits by hand. Do not push to write-back.

## STEP 5 — APPLY THE APPROVED EDITS (only if `profile_apply` is allowed)

Only with `profile_apply` allowed, and only after the user approves specific fields. This
is **confirm-first PER FIELD, never bulk-auto**: show the before→after for one surface,
get an explicit yes, write that one field, verify it, then move to the next. Nothing is
written silently.

Drive each surface live (snapshot/read before each action). Session-browser mechanics that
the live run proved out — apply them tool-agnostically (describe the technique, never name
a specific automation tool):

- **Find fields by their accessible label, not by coordinate scroll.** Edit modals often
  open scrolled to the bottom; scrolling by fixed offsets snaps past the target field. Use
  the browser's element-finder to locate the field (e.g. the Description textarea) by its
  label/role and act on it directly.
- **Clear then type:** focus the field, select-all, delete, then type the approved text.
- **If typing drops characters** (common on React-controlled inputs — you'll see mangled
  output like dropped or merged characters): set the field's value via an injected script
  using the element's **native value setter** and dispatch an `input` event (and a
  `change` event) so the framework registers it, then re-read the field to confirm the
  clean value landed. This is the reliable fallback when direct typing corrupts the text.
- **After Save, skip any upsell** the platform shows (e.g. a "people you may know" /
  connect prompt) — dismiss it, **never** take the upsell action.
- **Verify by reloading and re-reading.** List/summary views go stale after an edit;
  reload the page and read the field text back to confirm the change is live before
  reporting it done.
- **Featured items are link cards.** External links auto-pull a title/description that are
  then editable in the item's media-edit modal; edit the title/description there.
- **Contact info** supports multiple websites, each with a URL and a type/label; the email
  field is typically read-only (managed in account settings) — don't try to edit it here.
- **Open-to-work / job-preferences** title field is free-text and visible only to the
  user; editing the title can silently flip the job-alerts toggle, so re-check/restore that
  toggle after.

**If a field's edit UI fights the automation, stop forcing it** — hand that one field back
as a suggestion (it stays in the STEP 4 document) rather than risk a bad write. The same
honesty + `current_base` privacy invariants hold on everything written.

Never edit anything other than the candidate's own profile. This skill sends no messages,
no connection requests, no reactions.

## STEP 6 — VERIFY + LOG

For every field written in STEP 5, reload and re-read it live to confirm the new text is
present and correct (quote it back to the user). The before→after document from STEP 4
stays in `~/Downloads/careerrat/` as the record of the pass — write it regardless of whether
anything was applied.

Then log one event to the Activity Pulse feed (the dashboard's live timeline — see
**Activity Pulse** in AGENTS.md), actor `agent`:

```
careerrat activity append --type system --actor agent \
  --title "LinkedIn profile pass" \
  --summary "<N surfaces reviewed, M fields applied (or 'suggest-only')>" \
  --url "<profile url>" --write
```

If the pass surfaces nothing the candidate should act on, say so — don't manufacture
changes. The point is an honest profile that reads for the target roles, not a longer one.

---

## RULES

- **Opt-in, OFF by default, two separate gates.** Run a browser pass only where
  `careerrat automation status --json` shows the capability `allowed: true` for
  `linkedin`. `profile_optimize` gates reading + suggesting; `profile_apply` separately
  gates write-back. The `allowed` field encodes the three-part AND (global switch ·
  platform switch · ToS consent) from `mayRun()` in `src/core/automation/consent.mjs` —
  never re-derive the predicate in prose. Suggestions on never implies write-back.

- **Dry-run preview is the default and the first move.** Always produce the full read-only
  before→after set before writing anything. Applying is a deliberate, per-field opt-in
  second step. The skill is a complete read-only audit on its own.

- **Confirm-first per field on write.** Editing a public profile = modifying public-facing
  content. Show the before→after for each field and wait for an explicit yes before writing
  it. Never bulk-auto. If a field's edit UI fights, hand it back as a suggestion.

- **Honesty firewall (hard).** Every proposed or written line traces to an `evidence.yml`
  claim; `honesty.yml` overclaim caps and `do_not_claim` / `do_not_fabricate` apply; no
  fabrication. Profile copy is held to the same standard as a tailored résumé. The
  **honest-vs-target field rule**: honest descriptions in headline/About/experience, target
  titles only in open-to-work.

- **Stale evidence ≠ overclaim.** A profile claim that doesn't trace to `evidence.yml` may
  mean the evidence bank is out of date, not that the profile overclaims. Verify against the
  source repo/portfolio first; if it's true, update `evidence.yml` rather than cutting honest
  copy. An expired-but-earned credential is factual — keep it shown honestly (as expired),
  never forward-dated to look current.

- **Obfuscation / NDA.** Internal employer projects are described generically (no
  codenames, no project names), sensitive specifics redacted, only safe public metrics
  kept. The candidate's own public portfolio / OSS work keeps its real names + real public
  stats. Source of truth for "what's already public" is the candidate's own surface, never
  a guess.

- **Privacy invariant (hard).** `compensation.current_base` must never appear in any
  suggested or written profile copy, or in any artifact under `workspace/` /
  `~/Downloads/careerrat/`. Outbound-safe comp fields are `expected_base`, `target_base`,
  and `minimum_base` only.

- **Don't "fix" intentional styling.** A candidate's deliberate brand styling is a choice,
  not a bug — never flag it.

- **Halt on auth challenges.** On captcha, 2FA, login wall, or any unexpected interstitial,
  halt and ask the user to resolve it. Never bypass or automate around an auth challenge.

- **Tool-agnostic browser prose.** Say "the session browser," "the browser's
  element-finder," "an injected script." Keep the provider on `auto`; never ask the user
  to choose a CLI, extension, or browser driver, and never name an MCP namespace or vendor
  tool.

- **Local-only.** Scraped profile text, screenshots, and the before→after document stay
  under `workspace/` or `~/Downloads/careerrat/`. Nothing goes outbound. No credentials are
  stored — the session browser holds the login.

- **Read-only on everything but the candidate's own profile fields.** No messages, no
  connection requests, no reactions, no edits to anyone else's content.

- **No placeholder brackets.** If a detail is unknown, go generic or omit it — never emit
  `[Company]`, `[Role]`, `[Name]`, or any bracket token anywhere.

- **Domain-neutral.** No hardcoded companies, roles, titles, codenames, or
  candidate-specific values in this skill. The skill is a field-agnostic procedure; what
  makes it conform to *this* candidate is their `candidate/*.yml` truth bank.
