# Phase 10: Local Packet Engine - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-07-06T13:43:32Z
**Phase:** 10-Local Packet Engine
**Areas discussed:** Gate verdict boundary, Packet workflow shape, Evidence and honesty rules, Application questions and EEO exclusion, Export and artifact stamping

---

## Gate Verdict Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Full skill runtime | Keep `evaluate-job` as the normal product route. | |
| Local API with bounded AI | Local route owns workflow and DB writes; bounded AI handles body-read judgment when needed. | yes |
| Deterministic only | Avoid AI entirely and only use hard rules/manual review. | |

**User's choice:** Evaluation is an AI call when real body-read judgment is needed.
**Notes:** The locked boundary is that the app should not default to the full `evaluate-job` skill runtime. It should use a local API and bounded/schema-validated AI for the model-shaped part.

---

## Packet Workflow Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Generate whole packet after pass | Once the job passes and the user is applying, create the needed materials. | yes |
| Generate individual artifacts only | User manually triggers resume, cover letter, and answers separately. | |
| Read-only packet view | Keep current packet route behavior and rely on skills for generation. | |

**User's choice:** If the role passes and the user is going to apply, the app should create the materials.
**Notes:** Regeneration can remain optional, but the main path is passed gate plus apply intent leading to packet generation.

---

## Evidence and Honesty Rules

| Option | Description | Selected |
|--------|-------------|----------|
| Confirmed evidence only | Use only fully reviewed evidence and block otherwise. | |
| All available local sources with honesty gates | Use local profile/resume/deep-ingest/JD/company/question sources and ask for more when needed. | yes |
| Freeform AI drafting | Let AI infer missing details from context. | |

**User's choice:** Use any sources the app has from onboarding, ingest, or interview work; ask for more when the sources are insufficient.
**Notes:** Generated artifacts must not invent facts. Missing evidence should become a user prompt or `NEEDS YOU` style marker.

---

## Application Questions and EEO Exclusion

| Option | Description | Selected |
|--------|-------------|----------|
| Capture and filter | Capture application-page questions and filter out EEO/demographic/disability sections. | yes |
| Manual paste only | Require user to paste all application questions. | |
| Answer every captured field | Draft answers for every field including sensitive self-ID sections. | |

**User's choice:** Capture questions from the application page and filter out the EEO ones.
**Notes:** Existing code already supports Greenhouse/Ashby/manual normalized questions and demographic section detection.

---

## Export and Artifact Stamping

| Option | Description | Selected |
|--------|-------------|----------|
| PDF default with DOCX when required | Surface PDF normally; offer DOCX only for required board/upload workflows. | yes |
| Always PDF and DOCX | Generate both formats for every packet. | |
| Markdown as user-facing format | Show markdown as the main output. | |

**User's choice:** PDF is the common path. DOCX should be an option only when required. Markdown can be saved internally and does not need to be surfaced to users.
**Notes:** The planner should decide the exact storage shape, but generated artifacts must be stamped through DB-owned paths/metadata.

---

## the agent's Discretion

- Exact route names, DB/table shape, packet manifest format, export libraries, UI layout, schemas, and test files.
- Exact mechanism for deciding when a cover letter is appropriate.
- Exact no-AI/manual fallback UX, as long as it does not fabricate packet content.

## Deferred Ideas

- Auto-submitting applications.
- Broad browser-authenticated apply/form-fill automation.
