# Phase 7: Quick Onboarding and Auto Sourcing - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-07-05
**Phase:** 7-Quick Onboarding and Auto Sourcing
**Areas discussed:** Search-ready threshold, auto-source trigger, search mechanism, run surface, resume DOCX, manual reruns, source scope, checklist state, cadence recommendation

---

## Search-ready threshold

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal search gate | Resume plus role titles plus location/remote posture can start search; comp gates later evaluation/apply. | x |
| Stricter gate | Require comp/search posture before any search starts. | |

**User's choice:** Minimal search gate.
**Notes:** User said search is free to start and comp can gate later work.

---

## Auto-source trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-source when ready | Starting search is the point of job-hunt onboarding. | x |
| Button-only first search | Require an explicit manual click before the first run. | |

**User's choice:** Auto-source is core, refined to ask "search now?" with yes/default behavior.
**Notes:** The app should also ask how often to search during ingest.

---

## Search mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic app search | Use the app/search backend; do not start chat to search. | x |
| Discovery chat handoff | Keep quick start as a chat handoff to discovery/search skills. | |

**User's choice:** Deterministic app search.
**Notes:** User said, "we shouldn't chat to search."

---

## Run surface

| Option | Description | Selected |
|--------|-------------|----------|
| Checklist/task item | Show first search as part of setup/checklist state. | x |
| Standalone reminder CTA | Show a separate reminder or prompt to do it later. | |

**User's choice:** Checklist/task item.
**Notes:** User described it as a simple onboarding checklist item: did setup happen, did deep setup happen, did first search run.

---

## Resume DOCX

| Option | Description | Selected |
|--------|-------------|----------|
| Accept DOCX locally | Save original DOCX and extract text deterministically without AI. | x |
| AI-only DOCX | Feed DOCX to AI extraction. | |
| Reject DOCX | Ask for PDF/text/markdown only. | |

**User's choice:** Accept DOCX locally.
**Notes:** If extraction is garbled or empty, keep the original but ask for copy-paste/PDF/text and do not mark usable resume text ready.

---

## Manual reruns

| Option | Description | Selected |
|--------|-------------|----------|
| Jobs page button after setup | Show `Search jobs` on Jobs only after source setup exists. | x |
| Always visible Jobs page button | Always show the button and route missing source setup into tasks/errors. | |

**User's choice:** Jobs page button after setup.
**Notes:** First search belongs to onboarding; later searches belong on Jobs.

---

## Search source scope

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic unauthenticated sources only | Auto-run sources the app can hit without browser/auth consent. | x |
| Include authenticated/browser sources when consent exists | Broaden auto-run to browser-auth sources if already configured. | |

**User's choice:** Deterministic unauthenticated sources only.
**Notes:** Authenticated/browser sources can remain separate setup tasks.

---

## Checklist state

| Option | Description | Selected |
|--------|-------------|----------|
| Not started, Running, Completed, Failed | First search is the one checklist item that needs a running state. | x |
| Not started, Completed only | Keep errors elsewhere. | |

**User's choice:** Not started, Running, Completed, Failed.
**Notes:** General setup checklist items can stay simpler; first search needs running/failed because it is an actual run.

---

## Cadence recommendation

| Option | Description | Selected |
|--------|-------------|----------|
| User chooses with data-backed recommendation | Ask cadence and recommend based on data about best search days when available. | x |
| Fixed default | Ship a static default without presenting it as data-backed. | |

**User's choice:** User chooses with data-backed recommendation.
**Notes:** Recommendation should be "whatever the data says are the best days." If no data exists, planning should use a transparent default rather than fabricating evidence.

---

## the agent's Discretion

- Exact DB schema/API shape for first-search run state.
- Exact cadence recommendation algorithm and fallback default.
- Exact zero-results semantics, as long as the UI accurately distinguishes a completed run from missing setup or failure.

## Deferred Ideas

- Authenticated/browser source auto-runs.
- Hidden recurring scheduler unless Phase 7 also implements durable scheduling controls and run state.
