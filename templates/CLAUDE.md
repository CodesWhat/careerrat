# CareerRat Claude Instructions

Follow `AGENTS.md`. It is the source of truth for intent routing, the body-read
gate, artifact completeness, and submit safety.

Key rule: when the user asks to apply, run the `apply-job` workflow. `apply-job`
must run or verify `evaluate-job` before tailoring, filling, or submitting.

When the user asks to draft, reply to, follow up on, summarize, or negotiate a
job-search email or recruiter message, run `email-comms` and update tracker
communication state.
