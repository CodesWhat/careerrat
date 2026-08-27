# Chat-first durability and lifecycle audit

Date: August 27, 2026
Audited head: `9be7e8e` (`fix(search): keep AI searches running across navigation`)

## Verdict

The AI web-search lane now has the right lifecycle: the durable run owns the work, the SSE
response is only a view, reload follows the exact run, and server shutdown aborts the provider
before settling the run honestly. That fix does not make the rest of the chat-first app durable by
association.

Two other paths still advertise or implement background work without an app-owned worker
lifecycle:

1. first and manual deterministic searches can remain `running` for ten minutes after their worker
   died with the server; and
2. confirmed Universal Intake skill runs can remain `running` forever after a server exit.

Those are P0 release blockers. Several long foreground requests also preserve only the input or
final result, not the execution between them. Reload usually works if the same server process stays
alive, but an app restart can lose resume extraction, local company discovery, Deep Ingest analysis,
or a workspace-agent action with no exact operation to follow or reconcile.

This audit is read-only except for this report. It does not reopen the model-routing audit or the
choice audit, and it does not edit `docs/ROADMAP.md`.

## Lifecycle standard

A path is durable only when all of these are true:

1. It writes an operation record before returning a running or accepted state.
2. Work is owned by an app worker, not an HTTP request or renderer promise.
3. Closing a modal, changing threads, navigating, reloading, or losing SSE stops observation only.
4. The client can follow the exact operation ID and hydrate its progress and terminal result.
5. A lease or heartbeat distinguishes live work from an orphaned `running` row.
6. Ordered shutdown aborts the underlying provider/browser child, waits for it, and writes an
   honest terminal or resumable state.
7. Retry is idempotent or creates an explicitly linked new attempt. Unknown outcomes are never
   replayed blindly.
8. Model-backed work records the resolved provider/runtime, model, quality preset, reasoning
   effort, and routing-policy version at start. Resume and retry do not silently change that route.
9. The UI says what happened and what the candidate can do next in plain English.

An HTTP request that happens to continue after its browser response disappears is not a background
worker. An in-memory promise with a SQLite result written only at the end is not resumable.

## Surface map

| Surface | Durable anchors | Navigation or modal close | App/server restart | Result |
| --- | --- | --- | --- | --- |
| Onboarding conversation | SQLite skill-chat thread, messages, turn state; `.internal/onboarding-draft.json`; chat cursor replay | EventSource unsubscribe does not stop the session; reconnect replays events | Durable transcript resumes a new runtime session; setup draft reconciles with canonical chat | Sound |
| Onboarding résumé extraction | Upload file and eventual `source-resume` artifact | Buffered fetch normally continues in the server, but the renderer owns profile/evidence seeding after the response | No extraction operation, progress, lease, or completion reconciliation; a finished artifact can exist without the client applying its seed | P1 |
| First/manual deterministic search | SQLite `sourcing_runs`, input fingerprint, single-run guard, progress, write fencing, source dedupe | Route starts a detached promise; reload follows the exact durable run | Worker is not in the app lifecycle. A dead run remains live until a read crosses the ten-minute lease | P0 |
| AI web search | SQLite `sourcing_runs`, 30-second worker lease refresh, per-prompt progress, exact-run follow, write guard | SSE close stops writes only; worker continues | Ordered shutdown aborts provider and writes `AI_WEB_SEARCH_SERVER_STOPPED` | Fixed in `9be7e8e`; route provenance remains P1 |
| Local company proposals | Final pending batch and decisions are versioned in SQLite | Same-process request may finish, but no operation can be followed | Seeds, sequential resolution, and scans before `companyProposalBatchPut` are lost; retry starts from scratch | P1 |
| Discovery chat handoffs | Durable skill-chat transcript and turn state | Thread switch only drops the listener | Chat runtime shuts down children; transcript resumes in a new session | Sound |
| Public-intel company scan | Per-company public intel and review rows use stable IDs and are written as each seed finishes | Same-process request continues | Partial completed seeds survive, but there is no batch operation/progress record to distinguish partial from complete | P2 |
| Deep Ingest | Sources, chunks, proposals, decisions, confirmed lanes, and open thread are in SQLite; file upload is owned locally | Completed writes hydrate on return; modal/thread state is transient | Source scan and proposal build have no operation row. A restart loses in-flight analysis; a retry can create a new source/proposal set | P1 |
| Missions | Mission/step rows, attempt IDs, lease fencing, receipts, idempotency class, heartbeat, stale-attempt recovery | Duplicate run/resume requests share one server promise; UI rehydrates a running mission | A missing receipt becomes a paused `stale-outcome-uncertain` step instead of a blind replay | Sound, with P2 foreground-state cleanup |
| Mock interviews | Session, questions, answers, feedback, and errors are in SQLite; empty start and completed turns are reusable | Final writes rehydrate even if the response is lost | An answer written before AI survives; retry reuses it. No active-screen restore or explicit interrupted-turn marker | Sound core, P2 UX |
| Application preparation | Mission attempts and packet artifacts are durable; submit remains a human gate | Mission path keeps running; prepared browser tab is retained in memory | Mission recovery avoids unsafe replay, but browser session memory is gone. Direct workspace intents have no execution record | P1 direct path, P2 stale handoff copy |
| Desktop update | Preferences and last-check time are atomically persisted; main process owns download state | Renderer reload calls `getState`; dismissing a download does not stop it | Runtime phase/version/progress/readiness are memory-only. A recently downloaded update can relaunch as idle until the next check | P1 |
| Durable skill chats | Five chat skills persist transcript and turn state; SSE event replay; runtime shutdown aborts children | Disconnect removes only the listener | `awaiting-assistant` transcript automatically resumes a new runtime session | Sound |
| Workspace Ask and direct intents | User intent and successful/error result messages are durable | Same-process request may finish and appear after reload | Process death between input and result leaves an unanswered intent with no operation state or exact retry/reconciliation contract | P1 |
| Direct `/api/skill/run` | None beyond whatever the invoked skill writes | `res.close` intentionally aborts the provider | No recovery | Request-scoped by design; must never back a background claim |
| Universal Intake Lane B | Intake item and raw capture are durable | JSON confirm returns after changing the item to `running`; local provider promise continues | No worker registry, lease, shutdown abort, or stale recovery. `running` can be permanent | P0 |
| Foreground shell state | Canonical jobs, threads, missions, mock sessions, and Deep Ingest data are durable | Active thread, open modal/entity, filters, selections, and drafts are React state | Reload initializes `activeThread: "today"` and discards meaningful foreground state | P2; also covered by the choice audit |

## P0 findings

### P0.1 Deterministic search is detached, not restart-durable

`src/cli/sourcing-route.mjs#startBackground` and
`src/core/agent/workspace-agent.mjs#startSearchInBackground` fire
`runFirstSearchInBackground` without registering the worker with `tracker-dev`. The run itself has
good SQLite fencing and dedupe, but the app cannot abort or await its scan during shutdown. After a
process exit, `sourcingRunGet` keeps reporting the row as `running` until its last progress write is
more than ten minutes old. During that interval the Jobs UI follows a worker that no longer exists.

The fix should reuse the AI-search lifecycle shape:

- one app-owned registry keyed by sourcing run ID;
- a worker controller and 30-second lease refresh even when a source emits no progress;
- `res.close` or polling cancellation affects only the client follower;
- ordered shutdown aborts the scan, waits for child/fetch cleanup, and writes a people-shaped
  stopped/retry state;
- startup or the first read reconciles any run not owned by the current process immediately, rather
  than waiting ten minutes; and
- the existing input fingerprint, single-run guard, active-write fence, and source dedupe stay in
  force.

### P0.2 Universal Intake can be `running` forever

`src/cli/intake-route.mjs#executeLaneB` writes `status: "running"`, constructs a local
`AbortController`, starts `runSkillStream`, and returns. Nothing retains that controller or promise.
`tracker-dev` cannot abort or await it at shutdown, and `src/core/db/verbs/intake.mjs` has no lease or
stale-running recovery. A killed process leaves a permanent spinner/status with no truthful retry
transition. This is the clearest remaining false-background implementation.

Give confirmed intake execution a durable attempt record with worker ownership, heartbeat,
shutdown settlement, exact follow/retry, and a write fence. Preserve the raw capture and current
confirm-first contract. If Lane B is intentionally kept request-scoped, do not return `running` or
call it background; await it and present a foreground retry instead.

## P1 findings

### P1.1 Background model routes are not frozen or auditable

The AI search route calls `resolveAIRoute` as a preflight, but `sourcingRunStart` stores prompts and
the candidate-input fingerprint only. It does not store the resolved runtime/provider, model,
quality preset, reasoning effort, or routing-policy version. The per-prompt `runSkillStream` calls
resolve routing again, so changing Settings during one multi-prompt search can split a single run
across different runtime/model choices. A retry can also silently use a different route.

At operation start, persist a non-secret route snapshot and pass that frozen descriptor through
every provider call. Reload and reconnect should render it from the run. Exact resume/retry should
reuse it when still available. If preferences changed or the old route is unavailable, create a
new linked run with explicit copy such as “This retry will use Codex instead of Claude Code,” rather
than mutating the route identity of the prior run. Apply the same rule to every new durable
model-backed worker, including résumé extraction and company/Deep Ingest analysis.

The minimum persisted shape is:

- runtime/provider ID and adapter version;
- resolved model ID or explicit provider default;
- product quality preset and reasoning effort before adapter mapping;
- routing-policy version and capability-policy version; and
- `retryOf`/`resumedFrom` lineage when a later attempt is created.

### P1.2 Résumé extraction has a durable file but no durable extraction

`FirstRunController#handleResumeFile` uses a transient upload flag and an in-memory signature set.
For PDF/images, `/api/onboard/resume-ai` saves the upload and performs the long model call, then the
client separately calls `saveResumeSeed` to patch candidate/profile/evidence state. There is no
operation ID, progress record, exact follow, or startup reconciliation. A reload can lose the
response; a server restart loses the model call; and a server-completed `source-resume` artifact
does not prove the client applied the extracted seed.

Create the extraction operation before invoking the model, persist progress and route snapshot,
and commit the source artifact plus candidate seed server-side in one idempotent completion path.
Reload should find the operation by upload digest, follow it, and apply or display its terminal
state once. The unused request-shaped streaming sibling is not a durability substitute.

### P1.3 Local company discovery and Deep Ingest analysis commit too late

`createCompanyProposalBatch` generates seeds and sequentially resolves/scans every company before
the first batch write. Deep Ingest source scans and proposal builders similarly write only after
their long analyzer returns. Their final data and decisions are durable and version-safe, but the
work leading to them is an HTTP request with no followable identity. Restart loses all in-flight
progress. Repeating an unknown-outcome request can rescan everything and create new rows.

Create a batch/source operation first, persist per-item progress and route provenance, and use a
stable request digest as the idempotency key. Startup should resume only replay-safe analysis and
mark uncertain operations retryable. Completed sub-items should be reused. Closing the review
modal or changing threads must not discard the operation, and its terminal artifact should appear
without taking focus.

### P1.4 Workspace Ask has durable messages, not durable executions

`/api/workspace/message` and `/api/workspace/intent` await long work directly. The workspace agent
writes the user message/intent before model, packet, discovery, or browser work and writes the
result afterward. If the server exits between those writes, the thread contains an unanswered
intent but no operation status, lease, exact resume, or “stopped while working” receipt. This
matters most for direct application preparation outside a mission and other browser-backed
actions. A blind user retry may duplicate expensive work or encounter an unknown browser side
effect.

Add a durable turn/execution envelope to long workspace actions. It should distinguish queued,
running, awaiting-user, completed, failed, and outcome-uncertain; persist an idempotency key before
execution; and use mission-style receipts for side-effectful steps. Prefer routing application
preparation through the existing mission attempt machinery. Nothing here changes the hard human
submit gate.

### P1.5 Desktop update readiness is lost on app restart

The desktop updater correctly keeps download state in the main process across renderer reloads,
and it atomically persists enabled/skip/last-check preferences. Its runtime phase, version,
progress, and “ready to install” state are memory-only. After a relaunch, the controller starts at
idle. Because `lastCheckedAt` can defer the next automatic check for nearly 24 hours, a cached,
already-downloaded update can become invisible until the user checks again or the timer expires.

Persist a safe update operation snapshot or reconcile the updater cache immediately at startup.
An interrupted download should become “Download stopped. Try again,” and a verified cached update
should immediately restore “Restart and install.” Keep installation explicit.

## P2 findings

### P2.1 Foreground location and meaningful drafts are not restorable

`ChatFirstApp` initializes `activeThread: "today"`; active thread, browser tab, filters,
selections, open review/entity, composer text, Deep Ingest edit state, and modal state live in React.
Canonical entities survive, but the candidate loses where they were and any meaningful unsaved
work. This is already a release-gate item in the August 27 choice audit. Use URL state for location
and a bounded local/SQLite draft keyed by stable entity and prompt IDs. Background completion must
never steal route, focus, or composer state.

### P2.2 Restart-safe cores still expose stale transient affordances

Missions correctly pause an uncertain stale attempt instead of replaying it, mock interview
answers can resume, and application submission stays manual. The shell does not restore the active
mission/mock/application screen after restart, though. A persisted “Return to supervised
application” action can also outlive the in-memory browser tab and only explains the loss after a
click.

Restore the owning surface from URL/durable foreground state, render mission stale-recovery copy
directly from the recovered step, and change an expired browser CTA to “Prepare form again” before
the user clicks it.

### P2.3 Public-intel batches have durable partial writes but no batch truth

Public-intel scanning writes stable per-company records as each seed completes, so a restart does
not erase all progress. It has no batch record stating requested count, completed count, failures,
or terminal status. Add a light batch envelope so partial progress is distinguishable from a
completed scan and retries skip already-completed stable IDs.

### P2.4 Keep direct skill streaming explicitly foreground

`POST /api/skill/run` intentionally aborts on response close and has no durable execution record.
That is acceptable only while it remains a watched, foreground compatibility endpoint. Product UI
must use durable chat sessions, dedicated workflows, or an app-owned worker for anything described
as continuing in the background. Add a contract test that prevents background UI from binding to
this endpoint.

## Existing sound patterns to reuse

- AI web search now separates worker ownership from SSE observation and settles on shutdown.
- Missions use attempt IDs, fences, lease heartbeat, receipts, idempotency classification, and
  conservative stale-outcome recovery.
- Durable skill chat stores user input before model work, marks `awaiting-assistant`, resumes from
  transcript after restart, and treats SSE disconnect as listener cleanup only.
- Sourcing writes already have exact-run reads, active-write fencing, input fingerprints, and
  canonical result dedupe.
- Mock interview start/turn code reuses an empty session, saved answer, feedback, and next question
  instead of duplicating them after a lost response.
- Desktop update installation remains a separate explicit user action after verified download.

The missing work is not a new framework. It is one shared operation lifecycle applied consistently
to the paths that currently stop at an in-memory promise.

## Acceptance suite

For every operation promoted to background or resumable, run the same failure-injection matrix:

1. close the modal immediately after start;
2. switch thread and workspace tab while it runs;
3. reload before the first progress event and after at least one progress event;
4. drop SSE/fetch while keeping the server alive;
5. send graceful SIGTERM while a provider/browser child is active;
6. hard-kill the server after the durable start write;
7. restart before and after lease expiry;
8. click retry twice and retry from two renderer windows;
9. change selected runtime/model preference during the run;
10. complete while a different thread is active; and
11. verify no provider/browser child survives shutdown.

Each case must prove:

- one canonical operation and at most one active attempt;
- an exact terminal/recoverable state after restart;
- no duplicate domain write or external side effect;
- frozen, visible model-route provenance and explicit retry lineage;
- no focus, route, or draft hijack on background completion; and
- plain status/error copy with one concrete next action.
