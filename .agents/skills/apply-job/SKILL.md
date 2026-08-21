---
name: apply-job
description: End-to-end job application workflow — gates on app limits and evaluate-job verdict, tailors artifacts, builds the render, fills the ATS form (including LinkedIn Easy Apply one-click path), verifies submission, and updates the tracker.
---

# apply-job

Use this skill when the user asks to apply, submit, fill an application, or gives
a JD URL with clear application intent.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## Inputs

| File | Purpose |
| --- | --- |
| `application-limits` config (`candidate/application-limits.yml` only in legacy/export mode) | Per-company caps and cooldowns (step-zero gate) |
| `candidate/form-defaults.yml` | `auto_submit`, `expected_base` (primary salary form value), applicant contact facts |
| `candidate/targeting.yml` | `excluded_companies`, `cut_signals`, `fit_bands`, `role_buckets[].priority` (OE bucket policy) |
| `candidate/profile.yml` | `compensation.expected_base` (fallback when `form-defaults.yml#expected_base` absent), `compensation.oe_min_base`, `compensation.oe_max_base`, `candidate.toolchain`, contact facts |
| `candidate/honesty.yml` | `tools.confirmed`, `claims.do_not_fabricate`, education policy |
| `candidate/writing-style.md` + `workspace/writing-samples/` | Voice calibration for tailor step |
| `workspace/tracker.json` | Application row to update after submission |

---

## STEP 0 — Application-limits gate

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — every
write step below gives the `careerrat data <verb>` command (Data Write Contract,
AGENTS.md). Nonzero exit → legacy workspace (no DB yet) — every write step below
gives the existing direct JSON-edit instructions, unchanged.

DB mode: read application limits from `careerrat data candidate get --json`
(`application-limits.companies[]`). Legacy mode: read
`candidate/application-limits.yml` if present; skip silently when absent.

- Look up the target company by name.
- If `status: blocked` or the company's cap is already hit: halt. Report `reapply_after` date if set. Offer a bypass option (user must confirm explicitly to override).
- If `status: caution`: warn and confirm before proceeding.
- If a new cap or cooldown is stated by the user mid-flow (e.g. "limit me to 2 apps there per quarter"): use *confirm-first* friction. In DB mode write it with `careerrat data candidate limits upsert --data '<json row>'`; in legacy mode write the compatibility YAML. Echo the durable row that was written.

Run `careerrat tracker --summary` to confirm current application-limits context and echo the result.

---

## STEP 1 — Body-read gate (evaluate-job)

Check `workspace/tracker.json` for a cached evaluate-job result for this posting (field `fitBasis: 'evaluated'`):

- **Cache hit and not stale:** verify the GATE line is KEEP or user-approved REVIEW, then continue.
- **No cache or stale:** run `evaluate-job` and wait for its output.

Required gate output format (from AGENTS.md Gate Contract):

```
GATE: KEEP|CUT|REVIEW - reason
FIT:  high|med|stretch <score> - why | caveats: ... | priority: ...
COMP: clear|review|below-floor|OE-bucket - reason
COMP ANCHOR: <expected salary to state> - <rationale>
ACTION: apply-now|hold|manual|cut
```

- **GATE: KEEP** → proceed.
- **GATE: REVIEW** → confirm with user before proceeding.
- **GATE: CUT** →
  - **DB workspace:** run

    ```
    careerrat data app set-status <id> cut
    ```

    Then check for a backing comm thread (`jobs[id].comm` where `comm.status` is
    not already `closed`). If one exists, compose two calls back-to-back (there
    is no combined app+comm transaction, so "same write" becomes "same turn"):
    1. Patch the comm row locally (read the current shape from
       `workspace/tracker.json#communications[]`, set `status: "closed"`,
       `nextActionDue: null`, `nextAction: null`, `draft: null`, carrying every
       other field over unchanged), then persist the whole row:

       ```
       careerrat data comm upsert --data '<patched full comm row JSON>'
       ```

    2. Append the note:

       ```
       careerrat data comm append-message <comm-id> --data '{"direction":"note","at":"<ISO>","body":"Role cut — <reason from GATE line>. No further action."}'
       ```

    Then verify: `careerrat data verify` (re-exports + domain integrity) and
    `careerrat tracker --verify` (schema-level parity). Halt, stop.
  - **Legacy workspace (no DB):** write `status: cut` to the tracker row. In the same `tracker.json` write, check for a backing comm thread (`jobs[id].comm` where `comm.status` is not already `closed`). If one exists, set `comm.status = "closed"`, `comm.nextActionDue = null`, `comm.nextAction = null`, `comm.draft = null`, and append to `comm.messages[]`: `{ direction: "note", at: "<ISO>", body: "Role cut — <reason from GATE line>. No further action." }`. Run `npm run verify:tracker && careerrat tracker --verify && careerrat tracker` after the write. Halt, stop.

---

## STEP 2 — Comp and exclusions gate

Read `candidate/targeting.yml#excluded_companies`. If the company is on the list: halt and report.

Read `candidate/profile.yml#compensation.minimum_base` (the walk-away floor). If the posted compensation range is confirmed below the floor and the role does not qualify under an OE-bucket policy: cut.

**OE-bucket check:** scan `candidate/targeting.yml#role_buckets[]` for an entry whose `priority` is `oe`. If one matches this role, apply `candidate/profile.yml#compensation.oe_min_base` and `compensation.oe_max_base` as the floor/target range instead of `minimum_base`. If the offer falls within `[oe_min_base, oe_max_base]` the comp gate passes for this bucket regardless of the standard floor.

---

## STEP 3 — FIT rating confirmation

Confirm `evaluate-job` emitted a FIT line with a tier (high/med/stretch) and score. If it did not, read the **persisted `app.fitBucket`** from the tracker row (it reflects the bands in effect at evaluation time). Only if both the FIT line and `fitBucket` are absent, derive a tier from the gate-output score using `candidate/targeting.yml#fit_bands` (default: high ≥ 85, med ≥ 65, stretch < 65).

Apply priority logic:

- `high` → proceed to tailor immediately.
- `med` → confirm with user or hold per their stated preference.
- `stretch` → confirm with explicit justification before continuing.

---

## STEP 4 — Tailor

Check if `workspace/writing-samples/` contains files newer than `candidate/writing-style.md`. If so: run `npm run calibrate:style` first, then confirm it completed before continuing.

Read: `candidate/writing-style.md`, `candidate/honesty.yml`, `candidate/evidence.yml`. Then run `careerrat learnings read "<role>"` (the helper resolves the family from `targeting.yml` and exits 0 silently if no file exists yet — a missing file is normal).

Invoke `tailor-application` to produce `workspace/tailored/<Company>_<Role>.md` and a cover letter whenever the application accepts one (a cover-letter field — required or optional — or an email/attachment channel). Default to including a cover letter; it is a second ATS keyword-matching surface. Only skip it when the application has no way to accept one.

Run placeholder lint on every produced artifact:

```
node src/cli/lint-placeholders.mjs workspace/tailored/<Company>_<Role>.md
node src/cli/lint-placeholders.mjs workspace/tailored/<Company>_<Role>_cover.md
```

Block on any lint hit — do not proceed to Build until lint is clean.

---

## STEP 5 — Build

Read `candidate/profile.yml#candidate.toolchain` (enum: `pandoc | libreoffice | word | markdown-only`).

- `pandoc`: run `pandoc <artifact>.md -o <artifact>.docx`, then convert to PDF with `soffice --headless --convert-to pdf <artifact>.docx`. Confirm both files exist before proceeding.
- `libreoffice` / `word`: run `soffice --headless --convert-to pdf <artifact>` on the source file.
- `markdown-only`: skip the build; the `.md` file is the upload artifact.

After building, eyeball the output: page count reasonable, fonts render, no non-ASCII artifacts, no widow/orphan headings, hyphens display as bullets. Run lint-placeholders against the built PDF/DOCX path too if the tool supports it.

---

## STEP 6 — Auto-submit gate

Read `candidate/form-defaults.yml#auto_submit` (default: `false`).

- `auto_submit: false` (default): fill the form completely, then **stop and confirm** with the user before clicking the final submit button. Show a summary of what will be submitted.
- `auto_submit: true`: proceed to fill and submit without an extra pause.

Regardless of `auto_submit`: **immediately halt** (do not submit) if the page shows a captcha or Cloudflare human-check, an application-limit blocker, a required manual exercise (assessment, coding exercise, Ashby/Workday exercise, etc.), a required account creation or password reset, an ATS spam-rejection, or any auth prompt that is not a supported emailed verification-code flow. When halting on one of these blockers:

- **DB workspace:**
  1. Write the blocked state immediately:

     ```
     careerrat data app set-status <id> manual-apply
     careerrat data app set-fields <id> --data '{"note":"manual-apply: <blocker type> — <url>"}'
     ```

     (e.g. `"manual-apply: Cloudflare human-check — <url>"`, `"manual-apply: Ashby take-home exercise required — <url>"`, `"manual-apply: Workday account creation required — <url>"`, `"manual-apply: ATS spam-flag — contact recruiter directly — <url>"`). `manual-apply` means the human must finish applying; it is ACTIVE and stays visible on the dashboard, never archived. Run both calls back-to-back, never deferring the second.
  2. **Comm-thread write-back (blocker case):** check whether a backing comm thread exists — `jobs[id].comm` where `comm.status` is `needs-reply`, `drafted`, or `comm-due` and `comm.nextAction` or `comm.messages[]` references this application or posting. If one exists, compose two calls (there is no single partial-patch verb, so this is "same turn," never deferred):
     1. Patch the comm row locally (read the current shape, do NOT change `status` — the human still needs to act — rewrite `nextAction` to describe the manual step and advance `nextActionDue` forward by one day so it doesn't show overdue while the human clears the blocker), then persist:

        ```
        careerrat data comm upsert --data '<patched full comm row JSON>'
        ```

     2. Append the block-reason note:

        ```
        careerrat data comm append-message <comm-id> --data '{"direction":"note","at":"<ISO>","body":"Auto-submit blocked: <blocker type> — manual apply required at <url>"}'
        ```

  3. Report what was found and ask the user how to proceed.
  4. **Re-entry point:** when the user clears the blocker and returns, resume at STEP 7 (Fill) — the tail of the form is the re-entry point, not the beginning of the workflow. Re-read the current page state via the session browser before continuing.
- **Legacy workspace (no DB):**
  1. Write the blocked state to the application's tracker row immediately — set `status: "manual-apply"` (NOT "blocked") and add a `note` with the specific blocker type, any visible context text, and the apply URL so the human can finish (e.g. `"manual-apply: Cloudflare human-check — <url>"`, `"manual-apply: Ashby take-home exercise required — <url>"`, `"manual-apply: Workday account creation required — <url>"`, `"manual-apply: ATS spam-flag — contact recruiter directly — <url>"`). `manual-apply` means the human must finish applying; it is ACTIVE and stays visible on the dashboard, never archived.
  2. **Comm-thread write-back (blocker case):** in the same `tracker.json` write as step 1, check whether a backing comm thread exists — `jobs[id].comm` where `comm.status` is `needs-reply`, `drafted`, or `comm-due` and `comm.nextAction` or `comm.messages[]` references this application or posting. If one exists: do NOT flip `comm.status` to `waiting` (the human still needs to act), but append a `note`-direction entry to `comm.messages[]` recording the block reason and the manual-apply URL (e.g. `{ direction: "note", at: "<ISO>", body: "Auto-submit blocked: Cloudflare — manual apply required at <url>" }`), rewrite `comm.nextAction` to describe the manual step (e.g. `"Complete application manually — Cloudflare block at <url>"`), and update `comm.nextActionDue` forward by one day so the due date does not show as overdue while the human clears the blocker. Write app row + comm update atomically — no partial writes.
  3. Report what was found and ask the user how to proceed.
  4. **Re-entry point:** when the user clears the blocker and returns, resume at STEP 7 (Fill) — the tail of the form is the re-entry point, not the beginning of the workflow. Re-read the current page state via the session browser before continuing.

---

## STEP 7 — Fill

Read applicant facts from `candidate/form-defaults.yml`:

- `name`, `email`, `phone`, `location`, `linkedin`, `github`, `portfolio`
- `work_authorization`, `requires_sponsorship`
- `expected_base` — use this for any salary form field. **Never read or echo `profile.compensation.current_base` in any form field.**
- `current_employer`, `current_title` — these are pre-reviewed onboarding/form-default values. Fill them without per-application interruption unless `candidate/form-defaults.yml` sets `confirm_current_role: true` / `confirm_current_disclosure: true`, the page asks for a different/new disclosure, or the value is missing.
- `eeo_default` — use for EEO/demographic fields when present.
- `screening_answers` — exact pre-reviewed answers for recurring custom questions.

Navigate to the application URL using the session browser. Keep the provider on `auto`
unless the user explicitly changes it; CareerRat resolves the current session browser
(see `docs/BROWSER.md`). Take an accessibility snapshot of the current DOM before each
interaction to confirm page state.

**ATS detection:** call `hostnameToPortal(url)` (from `src/core/apply/form-fill.mjs`) on the application URL to identify the ATS. Use the matching `PORTAL_RECIPE` from that module as the canonical field-mapping reference for that platform. If the hostname is unknown, `genericMatch` applies — the patterns below are drawn from those generic defaults and the known recipes.

**Site gotchas (check FIRST):** call `portalQuirks(url)` (from `src/core/apply/form-fill.mjs`) and apply every returned quirk before and during the fill — it returns the platform's known traps (`PORTAL_RECIPES[portal].quirks` plus `DOMAIN_QUIRKS` for no-recipe hosts like Workday). Two cases change your whole approach: (1) `portal: "aggregator"` means the URL is a job board, **not** the apply form — extract the outbound "Apply on …" link, navigate to the real ATS, and re-run detection there; (2) Workday quirks mean account creation / RTF rejection — expect a manual-apply halt. This list is the durable home for per-site gotchas; when you learn a new reliable one, add it to the recipe's `quirks` (or `DOMAIN_QUIRKS`) so the next run inherits it, rather than relearning it.

**Field confirmation before fill:** call `buildFillPlan` with `formDefaults`, `profile`, and `honesty`. Treat `requiresConfirmation: true` as a hard pause, but do not create a pause just because a field is custom or unfamiliar. The resolver now fills configured `screening_answers`, routine availability/location questions, and honesty-backed tool yes/no questions before returning `skip`.

**Screening answer posture:** answer as the candidate from local context. Use `candidate/form-defaults.yml`, `candidate/profile.yml`, `candidate/honesty.yml`, `candidate/evidence.yml`, generated tailored artifacts, and the JD. If the answer is directly supported, fill it in first person and continue. Do not stop on vague/ordinary prompts like "Why are you interested?", "Years of experience?", "Are you open to travel?", or "Describe relevant experience" when the evidence/profile already supports a truthful answer. Stop only when the answer would require fabricating, guessing a number/date/security clearance/tool depth, revealing private current compensation, contradicting `honesty.yml`, or making a materially new disclosure that is not in onboarding data.

**Known ATS form patterns (domain-general — apply regardless of ATS platform):**

- **Async react-select dropdowns:** click the combobox to open, wait for options to render, filter by visible text, click the option by text. Never type then press Enter — this fires before async data loads.
- **Async location typeahead:** set via native-setter + `dispatchEvent`, wait for the suggestion list to appear, then click the matching suggestion.
- **File upload (modal-first pattern):** open the Attach or Upload modal first, then trigger the file-upload action via the session browser — direct upload without the modal fails silently on many ATS platforms.
- **Yes/No toggle buttons (commit pattern):** toggle to the opposite state, then toggle back to the intended state to commit React internal state. A single click may not register.
- **JS-rendered portals:** if the page body is blank after load, read `document.body.innerText` via the session browser's script-evaluate capability to confirm the page rendered before interacting.
- **Country/Location required field:** verify country and location fields are populated before attempting submit — a missing country silently blocks submission on several ATS platforms.

Do not fabricate values. Read honesty constraints from `candidate/honesty.yml` throughout the fill (STEP 10 governs this continuously).

If the posting is a LinkedIn Easy Apply (`isEasyApply(url)` returns true, or `hostnameToPortal(url) === "linkedin"` and the user explicitly asks to apply via LinkedIn), branch to STEP 7b instead of submitting here.

---

## STEP 7b — Authenticated one-click apply (LinkedIn Easy Apply)

Enter this step when `isEasyApply(url)` returns true OR `hostnameToPortal(url) === "linkedin"` and the user explicitly asked to apply via LinkedIn. Standard ATS postings proceed through STEP 7 unchanged.

### Consent gate (hard stop)

Run:

```
careerrat automation status --json
```

Inspect `capabilities.one_click_apply`. The applicable platform is `linkedin`. `allowed: true` means all three conditions are simultaneously true: the `one_click_apply` capability global switch is on, LinkedIn's per-capability switch is on, and LinkedIn's one-time ToS consent is recorded. This is the three-part AND from `mayRun()` in `src/core/automation/consent.mjs` — never re-derive it in prose.

If `capabilities.one_click_apply` does not show `allowed: true` for `linkedin`, explain exactly how to opt in, then **stop** — do not open a browser:

1. Read LinkedIn's terms of service yourself to confirm that automated Easy Apply is permitted under your account's usage.
2. Record consent: `careerrat automation consent linkedin --write`
3. Enable the capability global switch: `careerrat automation enable one_click_apply --write`
4. Enable for LinkedIn: `careerrat automation enable one_click_apply linkedin --write`
5. Verify: `careerrat automation status --json`

State clearly: this capability is OFF by default; enabling it is a deliberate choice. The user must read LinkedIn's ToS themselves before recording consent — CareerRat records the decision, it does not make it. This step is always user-initiated and must never run on a schedule or unattended.

### Session browser + live DOM

Open the job posting URL in the session browser tool-agnostically. Keep the provider on
`auto` unless the user explicitly changes it; CareerRat resolves the current session
browser and reuses its signed-in session (see `docs/BROWSER.md`). Snapshot or read the
current page state before each action. Drive the live DOM turn by turn — no hardcoded
selectors, same model as STEP 7.

If you encounter a login wall, captcha, platform 2FA / two-step-verification prompt, or any unexpected interstitial at any point: **halt immediately** — do not attempt to bypass or automate around it. Write the blocked state to the tracker row (`status: "manual-apply"`, note: `"manual-apply: LinkedIn 2FA / two-step-verification prompt — resume at <url>"` or similar), report to the user, and offer re-entry at the top of STEP 7b Fill once cleared. If the interstitial specifically says an emailed verification code was sent, use the STEP 8 verification-code protocol below instead of treating it as generic 2FA.

### Walk the Easy Apply modal

1. **Open the modal.** Click the "Easy Apply" button on the posting page. Snapshot the page to confirm the modal opened before proceeding.

2. **Step through `EASY_APPLY_STEPS`** (Contact info → Resume → Work authorization → Additional questions → Review → Submit). For each modal page:

   a. Snapshot the visible fields.

   b. Build the fill plan using the existing `buildFillPlan` / `resolveFieldValue` / `resolveScreeningAnswer` logic with `portal: "linkedin"` (`PORTAL_RECIPES.linkedin` from `src/core/apply/form-fill.mjs`). Pass `formDefaults`, `profile`, and `honesty`.

   c. Apply the same `requiresConfirmation` rule from STEP 7. Preconfigured `current_employer` and `current_title` values are normal fill values unless the config asks for confirmation or the page requests a new disclosure. **Never read or echo `profile.compensation.current_base` in any field.**

   d. Fill resolved fields. For the resume upload page, use the modal-first upload pattern documented in STEP 7 (open the Attach/Upload control within the modal before triggering the file action — direct upload without the modal fails silently).

   e. **Employer-custom screening questions:** use the screening answer posture above. If a safe resolved value exists from configured answers, profile, honesty, evidence, the tailored artifacts, or the JD, fill it and continue. If no safe value exists after checking those sources, then stop and ask the user. STEP 10 honesty rules apply continuously here.

   f. Advance to the next page by clicking a button whose visible text matches an entry in `EASY_APPLY_ADVANCE_LABELS` (from `src/core/apply/form-fill.mjs`). Snapshot after advancing to confirm the page changed.

3. **Submit-safety gate — honor STEP 6 exactly.**

   - `auto_submit: false` (default): after filling the entire modal through the Review page, **stop at the final submit button** (visible text like "Submit application" or "Submit") and confirm with the user — show a summary of every field that will be submitted — before clicking.
   - `auto_submit: true`: click the final submit button without an extra pause.

   Regardless of `auto_submit`: **immediately halt** (do not click Submit) on captcha, platform 2FA / two-step-verification prompt, an application-limit blocker, or a required exercise that cannot be completed in the modal. On halt:
   - **DB workspace (same composition as STEP 6's DB branch):**

     ```
     careerrat data app set-status <id> manual-apply
     careerrat data app set-fields <id> --data '{"note":"manual-apply: <blocker type> — <url>"}'
     ```

     (e.g. `"manual-apply: captcha — <url>"`, `"manual-apply: LinkedIn application limit reached — <url>"`). `manual-apply` is ACTIVE and stays visible on the dashboard. Then apply the same comm-thread write-back as STEP 6 (patch locally + `comm upsert`, then `comm append-message` with the block reason and URL; do NOT flip `comm.status` to `waiting`; rewrite `comm.nextAction`, advance `comm.nextActionDue` by one day).
   - **Legacy workspace (no DB):** Set `status: "manual-apply"` (NOT "blocked") and add a `note` with the specific blocker type and the apply URL (e.g. `"manual-apply: captcha — <url>"`, `"manual-apply: LinkedIn application limit reached — <url>"`) to the tracker row immediately. `manual-apply` is ACTIVE and stays visible on the dashboard.
     - **Comm-thread write-back (blocker case — same rule as STEP 6):** in the same `tracker.json` write, check for a backing comm thread (`jobs[id].comm` where `comm.status` is `needs-reply`, `drafted`, or `comm-due`). If one exists: append a `note`-direction entry to `comm.messages[]` with the block reason and URL, rewrite `comm.nextAction` to describe the manual step, and advance `comm.nextActionDue` by one day. Do NOT flip `comm.status` to `waiting`. Write atomically.
   - Report what was found and ask the user how to proceed.
   - **Re-entry point:** when the user clears the blocker, resume at STEP 7b Fill — re-read the current page state via the session browser before continuing.

### Verify

Continue into **STEP 8**. The LinkedIn Easy Apply success signal is the "Your application was sent" / "Application sent" confirmation modal that appears after the final submit click. Screenshot it. Never trust its absence — if the confirmation modal does not appear, do not mark the application as submitted. Report what the page shows and ask the user.

### Tracker

After STEP 8 confirms submission, continue into **STEP 9** with `channel: "LinkedIn"`.

---

## STEP 8 — Verify

After submitting, confirm the application advanced past the submit step:

1. Read the current URL and page text. Check both the URL path (segments: `/confirmation`, `/thank-you`, `/submitted`, `/complete`, `/success`) AND the visible page text ("Application received", "We got your application", "Thanks for applying", or similar) — a match on either constitutes a confirmation signal. `confirmationCheck(pageText, currentUrl)` in `src/core/apply/form-fill.mjs` encodes this logic; mirror that dual-signal check when evaluating manually.
2. **Verification-code protocol (M17):** if the page shows an emailed verification-code prompt (detected by `submitGuard`/BLOCKER_SIGNALS in `form-fill.mjs` — phrases such as "verification code", "enter the code", "check your email"), handle it through the narrow mail-access path:
   - Run `careerrat automation status --json` and inspect `capabilities.mail_access`.
   - Infer the mail platform from the recipient address when obvious using `inferMailAccessPlatformFromEmail()` from `src/core/automation/mail-access.mjs`: `gmail.com` / `googlemail.com` → `gmail`; `outlook.com` / `hotmail.com` / `live.com` / `msn.com` → `outlook`; other real email domains → `webmail`. If there is no recipient address, ask the user which provider holds the code. Use `webmail` for any provider other than Gmail/Outlook.
   - If `mail_access` is not `allowed: true` for that platform, halt and ask the user to provide the code manually. Also show the opt-in steps:
     1. Read the mail provider's terms yourself.
     2. `careerrat automation consent <gmail|outlook|webmail> --write`
     3. `careerrat automation enable mail_access --write`
     4. `careerrat automation enable mail_access <gmail|outlook|webmail> --write`
     5. `careerrat automation status --json`
   - If `mail_access` is allowed, use the session browser to open the provider and follow `buildVerificationCodeMailPlan()` / `classifyMailAccessBlocker()` / `extractVerificationCodes()` from `src/core/automation/mail-access.mjs`. For `webmail`, pass the visible provider name as `providerName` when known. Read only the specific recent verification-code message for this current application or sign-in flow. Do not browse the broader inbox. Do not send, delete, reply, archive, or mark messages read.
   - Halt immediately on a mail login wall, mail 2FA prompt, captcha, or unexpected interstitial. Set `status: "manual-apply"` with a note such as `"manual-apply: mail_access blocked — Gmail login wall, provide code manually"` and ask the user to provide the code manually.
   - Once the code is obtained, return to the original application page, enter the code, and continue verification.
3. Take a screenshot of the confirmation state. Save it under `workspace/captures/`
   (gitignored scratch) — never the repo root or `workspace/` root — and don't commit
   it. See the **Browser Automation Contract** (Local-only + safety) in AGENTS.md.
4. Never trust HTTP 200 alone — read the page content.
5. If no confirmation is found: do not mark as submitted. Report what the page shows and ask the user.

---

## STEP 9 — Update tracker and commit

**Row-write is the gating action (hard invariant).** An application is NOT applied
until its row exists in `workspace/tracker.json#applications[]`. Write the row
**first** — before logging the Activity Pulse event, before committing, before
telling the user the application is submitted. Never log an `applied` activity
event, never commit, and never report success for a posting that does not have a
verified row. In a batch apply session, write each row **immediately after its own
STEP 8 confirmation** — do not defer the row-writes to the end of the batch (that
is exactly how confirmed submissions end up with an `applied` activity event and
no tracker row). The Activity Pulse log, the commit, and the success report all
depend on 9b passing.

### 9a — Write (or create) the row

Locate the application row in `workspace/tracker.json`:

- Match `applications[]` entry by `id` field first; if no `id`, match by `company` + `role` (case-insensitive).
- If no matching row exists: create a new entry in `applications[]` with at minimum `company`, `role`, and `id` (generate a short slug, e.g. `<company-slug>-<role-slug>`). Do not halt — the row must exist before writing status.
  - **DB workspace:** create it with `careerrat data app upsert --data '{"id":"<slug>","company":"<Company>","role":"<Role>"}'` (full-row insert/replace), then continue with the field writes below against that same `<id>`.
  - **Legacy workspace (no DB):** create the entry directly in the `tracker.json` edit below.

**`app.note` validation (run before writing the row):** `note` is the INTERNAL submission one-liner — ≤60 chars, one topic, ATS/system + "submitted" only (e.g. `"Greenhouse — submitted, confirmation received."`). It must NOT contain application-form answer text, work-arrangement Q&A (onsite/hybrid/remote phrases), interview-loop descriptions, or language copied from the JD or form fields. Anything that fails this check routes to `statusNote` (live state text), `compNote` (comp intel), or is dropped entirely. A polluted `note` produces phantom interview Focus cards on the dashboard — prevent it here.

The matched (or newly created) row must end up with:

- `status: "awaiting"`
- `submittedDate: <today ISO date>`
- `channel: <source — e.g. "direct", "referral", "LinkedIn", "job board name">`
- `note: <ATS/system + "submitted" — one clause, ≤60 chars, e.g. "Greenhouse — submitted, confirmation received.">` (singular `note`, the app-level field — **not** `notes`, which is a `conversations[]` field; this is search/internal text and is never rendered on a card)
- `statusNote: <present-tense live state, ≤120 chars, e.g. "Applied via Greenhouse — awaiting review.">` (this is what the jobs card shows)
- Route everything else per the **Tracker Content Register** in AGENTS.md — comp/OTE caveats → `compNote`; why-it-fits/risks → `roleFit.why[]`/`roleFit.risks[]`. Never pack multiple topics into one field.
- `artifacts.jd`: the full posted job description body — **required**, never just the link (the live posting disappears when the req closes or the login expires; this embedded copy is the durable record). Carry it over from the `workspace/jobs/` file `evaluate-job` saved; if for some reason it's missing, capture it now per the **JD-body capture invariant** in AGENTS.md (escalate to the logged-in session browser before giving up) before writing the row.
- `artifacts.coverLetter`: the tailored cover letter text submitted
- `artifacts.resume`: the résumé filename used
- `artifacts.resumeNote`: one line on tailoring approach (e.g. "led with operations leadership + cost-reduction wins")
- `link`: the canonical posting URL

Apply the write per mode:

- **DB workspace:** compose two calls, back-to-back (there is no single verb covering every field above, so "one write" becomes "same turn — never leave the second call for later"):

  1. ```
     careerrat data app set-status <id> awaiting --note "<statusNote text>"
     ```

     Sets `status` and `statusNote` (via `--note`) in one atomic transaction, bumps the stamp, refreshes analytics (a new submission is outcome-changing per the Data Write Contract), and logs the activity event.

  2. ```
     careerrat data app set-fields <id> --data-file <patch.json>
     ```

     A shallow-merge patch (one level) carrying every field `set-status` doesn't cover: `submittedDate`, `channel`, `note` (the internal one-liner — **not** the same as `set-status`'s `--note`, which writes `statusNote`), `link`, `compNote` / `roleFit.why[]` / `roleFit.risks[]` (Content Register routing), and `artifacts: {jd, coverLetter, resume, resumeNote}` (merges one level into the existing `artifacts` object). Use `--data-file` rather than an inline `--data` string given the JD-body and cover-letter text length. Not outcome-changing — the preceding `set-status` call already refreshed analytics.

     `app register-artifact <id> --kind resume --path "<resume filename>" --note "<tailoring approach>"` is the more purpose-built verb for a single artifact (it stamps `artifacts.resume` + `artifacts.resumeGeneratedAt` + `artifacts.resumeNote` in one call) and is a reasonable substitute for the `resume`/`resumeNote` piece of the patch above — it fits well because a résumé filename is a short, path-like value. It's a poorer fit for `artifacts.jd` / `artifacts.coverLetter`, which hold full body **text** (not a path) that's awkward to pass through a single `--path` argv token, so those two stay in the `set-fields` patch. Don't run both against the same `artifacts` key in the same turn — pick one path per field.
- **Legacy workspace (no DB):** edit the matched (or newly created) row directly with the fields above, in one `tracker.json` write.

**Comm-thread write-back (submission case):** after setting the fields above, before closing the write, check whether this submission fulfills an open comm thread — `jobs[id].comm` where `comm.status` is `needs-reply`, `drafted`, or `comm-due` and `comm.nextAction` or `comm.messages[]` references this application or posting (the D.E. Shaw / Avature supplemental-form case: a recruiter-requested data-completion tracked in comm must flip to waiting in the same write that records the submission). If such a thread exists:

- `comm.status = "waiting"`
- `comm.nextActionDue = null`
- `comm.draft = null` (if a draft backed it)
- `comm.nextAction = "Awaiting review after submission"` (or similar present-tense state)
- append to `comm.messages[]`: `{ direction: "note", at: "<ISO>", body: "Submitted application via <ATS/channel>. Confirmation received." }`

- **DB workspace:** compose two calls, back-to-back in the same turn as the app calls above:
  1. Patch the comm row locally (read the current shape from `workspace/tracker.json#communications[]`, apply the `status`/`nextActionDue`/`draft`/`nextAction` rules above, carrying every other field over unchanged), then persist the whole row:

     ```
     careerrat data comm upsert --data '<patched full comm row JSON>'
     ```

  2. Append the note:

     ```
     careerrat data comm append-message <comm-id> --data '{"direction":"note","at":"<ISO>","body":"Submitted application via <ATS/channel>. Confirmation received."}'
     ```

- **Legacy workspace (no DB):** set the fields above in the SAME `tracker.json` write as the app-row change, and append the `comm.messages[]` note in that write too.

**One-write invariant:**

- **DB workspace:** the two app calls and the two comm calls each atomically persist and auto-export on their own — there is no single combined transaction, so the completeness guarantee is on running all four calls back-to-back in the same turn, never deferring any of them. Then run 9b once.
- **Legacy workspace (no DB):** the app row update and any comm-thread write-back above must land in a single `tracker.json` write. Do not write the app row, run verify, then write the comm record — that leaves ghost CTAs visible between writes. Write both, then run 9b once.

### 9b — Verify the row landed (gate)

- **DB workspace:** each `careerrat data <verb>` call in 9a already persisted and
  auto-exported `workspace/tracker.json` + `workspace/activity.jsonl` (Data
  Write Contract, AGENTS.md). Run:

  ```
  careerrat data verify
  careerrat tracker --verify
  ```

  `careerrat data verify` re-exports then runs the same domain-integrity check as
  `npm run verify:tracker`; `careerrat tracker --verify` covers the ajv
  schema-level check `data verify` doesn't run. Both must exit 0 **and** the row
  must now be present (confirm by `id`). If either fails or the row is missing,
  **stop** — fix it with another `app set-fields` / `comm upsert` call (never
  hand-edit `tracker.json`, it is a regenerated file) and re-run 9b. Do not
  proceed to 9c.
- **Legacy workspace (no DB):** run validation and snapshot in sequence:

  ```
  npm run verify:tracker
  careerrat tracker --verify && careerrat tracker
  ```

  Both must exit 0 **and** the row must now be present (confirm by `id`). If the row
  is missing or validation fails, **stop** — the application is not recorded. Fix the
  row write and re-run 9b before doing anything else. Do not proceed to 9c.

### 9c — Downloads copy (only after 9b passes)

Copy every submitted artifact to the company's Downloads folder — PDF for formatted documents, `.txt` for plain-text answers — under the per-company folder (Artifact Contract: organized by company, then by round). Use the real company name (no brackets). Example filenames:

- `~/Downloads/careerrat/<Company>/<Company> - Resume.pdf`
- `~/Downloads/careerrat/<Company>/<Company> - Cover Letter.pdf`
- `~/Downloads/careerrat/<Company>/<Company> - Application Answers.txt` (if short-answer fields were submitted)

If `tailor-application` already exported these files to the company folder this turn (it runs the same export), verify the files are present rather than re-copying. The contract is satisfied when the files exist — one copy is enough. `workspace/` remains the source of truth; `~/Downloads/careerrat/` is the convenience copy the candidate can find without opening the tracker. Unknown detail → generic slug; never a bracket placeholder.

### 9d — Log and commit (only after 9b passes)

Then log the submission to the Activity Pulse feed (the dashboard's live timeline — see
**Activity Pulse** in AGENTS.md). One event per submission; the id is content-derived, so
a re-run never double-logs:

- **DB workspace:** the 9a `app set-status` call already auto-logged one generic
  `status_change` event in the same transaction. For the richer, submission-specific
  type, log an additional event (this verb only logs, it never bumps the stamp):

  ```
  careerrat data activity append --data '{"type":"applied","actor":"agent","title":"Applied — <Company>","summary":"<Role> · via <channel>","refs":{"applicationId":"<application id>","company":"<Company>","role":"<Role>","url":"<posting URL>"}}'
  ```

- **Legacy workspace (no DB):**

  ```
  careerrat activity append --type applied --actor agent \
    --title "Applied — <Company>" --summary "<Role> · via <channel>" \
    --company "<Company>" --role "<Role>" --app-id <application id> --url "<posting URL>" --write
  ```

If any new application limit was learned during the apply flow (e.g. a blocker message or FAQ stating a reapply window): record it on the tracker row and, after confirmation, persist the durable limit with `careerrat data candidate limits upsert --data '<json row>'` in DB mode. Legacy compatibility writes remain confirm-first.

Commit with a Conventional Commits message (e.g. `feat(apply): submit <Role> at <Company>`).

**Interview recording (opt-in):** When the user books an interview, recommend
they record it with a tool such as Granola or equivalent. Surface the consent
caveat: in all-party-consent jurisdictions (e.g. many U.S. states, Germany, and
others) every participant must give explicit consent before recording starts —
never record automatically. If the user opts in and provides a transcript or
notes after the interview, use `interview-prep` STEP 5–6 to capture them; the
`conversations[]` entry should include `"recording": "<tool> (consent given)"`.
If no recording, omit the field or set it to `""`.

---

## STEP 10 — Honesty hard-stop (continuous, runs throughout all steps)

These constraints run throughout the entire workflow — not just at one step:

- Never claim tools, frameworks, or technologies not listed in `candidate/honesty.yml#tools.confirmed`.
- Never add an Education section or degree claim if `candidate/honesty.yml#education.add_education_section` is `false`.
- Never fabricate metrics, employers, projects, security clearances, or work authorization status.
- Never reveal `profile.compensation.current_base` in any form field, cover letter, résumé, tracker note, or outbound artifact.
- Never write superlatives or invented outcomes in tracker notes or cover letters. Evidence must trace to `candidate/evidence.yml` or stated user facts.
- If a form field asks for information the candidate has not provided and you cannot derive it safely: stop, surface the question, and wait for the user.
