# Browser Automation Substrate

CareerRat reaches the web three different ways. They are not interchangeable —
each is the right tool at a different layer. Skills and scripts should name the
layer they use and link here, so the agent always knows which capability to
reach for.

> This is the lightweight **substrate map**. The opt-in, consent-gated,
> authenticated automation model (status polling, in-platform
> messaging, supervised apply preparation, profile optimization, webmail access) is specified by the
> **Browser Automation Contract** in
> `AGENTS.md` and configured by `candidate/automation.yml` (see *Opt-in authenticated
> automation* below) — this doc describes the layers that contract builds on.

## The three layers

### Layer 1 — Static fetch (`WebFetch`)

Plain-HTML postings and boards: Greenhouse (`boards.greenhouse.io`), plain ATS
URLs, the pages behind RSS items. Cheapest path; always try it first when you
only need the posting text. If the body comes back empty or is an SPA shell,
escalate to Layer 3.

### Layer 2 — Headless capture & export (bundled Playwright Chromium)

The `playwright` npm dependency, driven **headless and in-process from Node
scripts** — no agent in the loop, no setup (Chromium ships with the package).
Used by:

- `npm run capture:search-sources` / `npm run capture:board` — bulk-scrape a
  board's listing DOM into the workspace.
- Document & packet PDF export (`careerrat export`, interview packets, tailored
  résumés/cover letters).

This is the layer for **batch, non-interactive** rendering where the agent does
not need to reason turn-by-turn. (For *authenticated* capture, M12 promotes the
persistent-profile variant of this model.)

### Layer 3 — Interactive, agent-driven automation (the "session browser")

For anything the agent drives step-by-step, such as rendering a JS page to read it
or filling an application up to the user-submit handoff. The agent **drives the live DOM**: it reads
the page (snapshot / read DOM) **before each action**, never relies on hardcoded
selectors, and stays confirm-first per the Public Default in `AGENTS.md`.

**Capture artifacts are scratch.** Screenshots and scraped page fragments from any
layer are throwaway: write them under `workspace/captures/` (gitignored) — never the
repo root or `workspace/` root, where stray PNGs are also backstop-ignored. Don't
commit them. Surface a screenshot in the app only by writing it to a deliberately
tracked path. See the **Browser Automation Contract** (Local-only + safety) in `AGENTS.md`.

**Write skill prose tool-agnostically** — say "use the session browser," not a
specific vendor tool or MCP namespace. `auto` is the default: it uses Orca's visible,
supervised browser inside an Orca workspace and CareerRat's app-owned Playwright browser
otherwise. If the selected provider cannot
execute the concrete workflow, CareerRat exposes a supervised/manual handoff instead of
claiming the browser ran.

Capabilities the agent uses at this layer (each maps to whichever provider is active):

| Capability | How |
| --- | --- |
| Open a page | navigate to the URL in the session browser |
| Read current DOM state | snapshot / read the page **before each interaction** |
| Read a JS-rendered body | evaluate `document.body.innerText` in the session browser |
| Fill a field | type into the mapped field (labels from `form-fill.mjs` recipes) |
| Attach a file | **modal-first** — open the Attach/Upload modal, *then* upload (direct upload fails silently on many ATS) |

## Which layer do I use?

| You need to… | Layer | How |
| --- | --- | --- |
| Read a plain-HTML JD body | 1 | `WebFetch` |
| Read a JS-rendered / SPA JD body | 3 | evaluate `document.body.innerText` in the session browser (or the Lever JSON API, below) |
| Bulk-scrape a board into the workspace | 2 | `npm run capture:search-sources` / `capture:board` |
| Export a résumé / packet to PDF | 2 | `careerrat export` (bundled Playwright) |
| Fill an application form up to submit | 3 | session browser, modal-first uploads, user-controlled submit |
| Drive a portal that needs the user's login | 3 | automatically selected session browser, with a supervised handoff when no provider is ready |
| Read one emailed verification code or opted-in webmail recruiting messages | 3 | session browser gated by `mail_access`; generic `webmail` for one-code reads, Gmail/Outlook for one-code reads and webmail ingest |

## Opt-in authenticated automation

Reading public posting bodies (above) needs no permission. But **logged-in** Layer-3
uses — polling your ATS dashboards for application status, reading in-platform DMs,
supervised apply preparation, profile optimization, and
webmail access — are gated. They are
**opt-in and default OFF**: with no `candidate/automation.yml`, none of them run.

The authenticated capabilities are live behind the switchboard: `status_polling`
(**`sync-status`** skill), `messaging` (**`ingest-messages`** skill), and
`authenticated_apply_preparation` (**supervised LinkedIn Easy Apply preparation**,
which always stops at the user-submit gate),
`profile_optimize` / `profile_apply` (**`optimize-linkedin`**), and `mail_access`
(generic `webmail` for one recent verification-code message; Gmail/Outlook for
verification-code reads and opted-in `ingest-mail` webmail reads).

The switchboard is `candidate/automation.yml` (gitignored; schema
`config/automation.schema.json`, template `templates/automation.example.yml`). A
capability runs on a platform **only if all three are true** — the capability's global
switch, that platform's per-capability switch, and that platform's one-time ToS
consent. Query it with `mayRun()` in `src/core/automation/consent.mjs`; never hardcode
the policy in skill prose.

Job sources use a simpler point-of-use flow instead of this switchboard. When a
configured source needs login, CareerRat asks one site-specific Yes/No question.
Yes opens the exact source URL in the visible CareerRat browser. No skips that
source and continues with the rest.

Toggle it through the CLI (dry-run by default, `--write` to commit;
comment-preserving and schema-validated):

```
careerrat automation status                          # the live matrix
careerrat automation consent <platform> --write      # record ToS consent
careerrat automation enable <capability> [platform] --write
```

No credentials are ever stored — the session browser (Orca, extension, or a Playwright
persistent profile) holds the logins. The full normative rules — ToS handling, "never
on a schedule," halt-on-captcha/2FA, local-only data — are the **Browser Automation
Contract** in `AGENTS.md`. The capabilities activate phase by phase as their skills
ship.

Application preparation fills safe, confirmed fields and attaches approved
documents. Voluntary demographic and self-identification fields stay blank by
default. The local-only **Profile > Application defaults** editor can keep them
blank or choose the form's decline option when available. Existing exact answers
stay hidden and may be used only when explicitly saved; CareerRat never infers
one. CareerRat halts on CAPTCHA or
two-factor authentication and never presses the final submit control.

`mail_access` has stricter mailbox-specific limits: for a verification-code flow,
read only the one recent matching message needed for the current application or
sign-in page. Generic `webmail` is limited to this verification-code flow; broader
mailbox ingest remains Gmail/Outlook-specific. Never browse the broader inbox, and
never send, delete, reply, archive, or intentionally mark messages read. Halt on a
mail login wall, mail 2FA prompt, captcha, or unexpected interstitial.

### Choosing the session-browser provider

Which provider drives the live session is itself a setting. `auto` is the
**recommended default** and selects a browser CareerRat can detect without asking the
candidate to understand their CLI or extension setup. It selects Orca inside an Orca
workspace and CareerRat's app-owned Playwright browser otherwise. Explicit overrides are
`extension`, `orca` (a supervised embedded browser
available inside Orca workspaces), or `playwright` (a supervised browser with persistent
local storage created on demand). Public application forms need no setup. If a particular
site requires an account, the candidate signs in when that site asks and CareerRat reuses
that session. It's a *how-it-runs* choice and
never affects `mayRun()` — provider does not gate whether a capability is allowed.
Change it the same safe way as the toggles (dry-run by default, schema-validated,
comment-preserving; first `--write` scaffolds the file):

```
careerrat automation session <auto|extension|orca|playwright> --write
```

`careerrat doctor` and Settings report both the configured choice and the effective
browser plus a best-effort "is it ready?" probe. Settings uses ordinary connection
language; the candidate never needs to identify a provider during onboarding.

The `extension` provider is agent-driven, turn-by-turn — there's no callable surface
for CareerRat to run a form-fill script against it, so app-side supervised apply
(`apply-job`) only ever runs over `orca` or the bundled `playwright` persistent
profile. When the configured provider is `extension`, apply falls back to the
agent-in-the-loop handoff instead of claiming a script ran the browser.

## SPA-host escalation

When a liveness check returns `spa_shell` (Wellfound, Lever, Ashby, and other
single-page boards), do not delete the link as dead — escalate per the result's
structured `escalationHint`:

- **`lever-json`** → fetch the result's `escalationUrl`
  (`https://api.lever.co/v0/postings/{company}?mode=json`; server-rendered JSON,
  no browser needed).
- **`browser-evaluate`** → Layer 3: render the page in the session browser and
  read `document.body.innerText`, then confirm the role still renders before acting.

## Adding a new board/ATS provider

See `docs/SOURCES.md` → "How to add a source provider" for the touch-points
(URL builder, capture extractor, SPA-host list).
