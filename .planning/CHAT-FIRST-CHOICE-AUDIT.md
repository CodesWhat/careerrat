# Chat-first choice and durable-state audit

Status: open. Audited August 27, 2026 against the current [Vercel Web Interface
Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).
This audit covers onboarding, Ask, job threads, search coaching, Deep Ingest, source and
company proposals, application answers, missions, mock interviews, Settings, and model
selection. It does not reopen the AI-search lifecycle implementation in progress.

## What exists

The product has one good but narrow pattern. The latest plain yes/no question renders a
`fieldset` with semantic Yes and No buttons, and a click calls the same `onAnswer()` path as
typed text (`apps/web/src/chat-first/conversation-surfaces.jsx:363-500`). First-run uses the
same shape (`apps/web/src/chat-first/FirstRunExperience.jsx:527-595`). Generic workspace
message storage already preserves arbitrary JSON metadata
(`src/core/agent/workspace-thread.mjs:315-376`). Those are the seams to generalize.

Everything beyond binary answers is fragmented. The model/API contract only knows
`answerMode: "yes-no"` (`src/core/ai/chat-answer-mode.mjs:1-17`,
`src/core/db/verbs/chat-first.mjs:50-57`,
`src/core/db/verbs/skill-chat.mjs:107-166`). There is no typed single-select, multi-select,
rank, or confirm prompt that survives the model/API/storage/render boundary.

## P0

- `src/core/agent/workspace-agent.mjs:255-267,9141-9173`,
  `src/core/db/verbs/chat-first.mjs:780-906`,
  `src/core/db/verbs/skill-chat.mjs:107-166` - assistant replies persist only binary
  `answerMode`; choices, stable option IDs, selection mode, and resolution state are lost.
  Add one server-owned typed choice contract used by main, job, skill, mock, and onboarding
  replies. Do not infer selectable options from prose in JSX.
- `apps/web/src/chat-first/FirstRunController.jsx:176-257,763-877` - onboarding option cards
  are regenerated client-side and explicitly removed from serialized history. Clicking a
  confirmation runs the write directly, while typing the same label or “yes” goes back through
  the model. Both inputs must resolve the same prompt ID and normalized intent, with one
  idempotent write and one durable result.
- `apps/web/src/chat-first/ChatFirstApp.jsx:1803-1879`,
  `apps/web/src/chat-first/conversation-surfaces.jsx:1343-1425` - Deep Ingest renders
  Confirm/Defer/Reject, but typing one of those answers while the surface is active is captured
  as a new pasted source. Route click and text through the same proposal/version decision. A
  stale version must refresh the card without losing the user's answer.
- `apps/web/src/chat-first/WorkspaceBrowser.jsx:388-461,493-540` - a completed zero-result
  search only says to search again. Paul does not coach the user toward adjacent, credible role
  families. Generate three to five evidence-grounded suggestions, explain why each transfers,
  and render them as a multi-select prompt such as Event operations, Venue operations, and
  Customer operations. Clicking several or typing the same role names must create the same
  reviewable targeting proposal. Never broaden targets or rerun a search without confirmation.
- `apps/web/src/chat-first/chat-first-model.js:582-680`,
  `apps/web/src/chat-first/ChatFirstApp.jsx:1436-1473,1580-1587`,
  `apps/web/src/App.jsx:76-87` - active thread, browser tab, filters, drawers, review overlays,
  selected jobs, application-answer focus, and Deep Ingest edit state are memory-only. Reload or
  navigation loses the foreground task even when the backend work survives. Put stable
  presentation state in the URL, persist meaningful drafts, rehydrate by ID, and fall back
  clearly when a referenced item disappeared. Background completion may update a badge or
  notification, but must not steal the active route or replace the user's draft.
- `apps/web/src/chat-first/ProfileSettings.jsx:152-196,384-444`,
  `src/core/ai/ai-config.mjs:29-40,100-107`,
  `src/core/ai/call-ai.mjs:391-415,536-613` - users can choose a runtime, but not provider-neutral
  quality or thinking depth. Hidden configuration and the small/fast installed-runtime branch
  encode Claude-specific model names and behavior. Add Automatic, Fast, Balanced, and Best Paul
  quality plus Automatic, Low, Medium, and High thinking depth. Persist these as product
  preferences, then map them through each selected runtime's capability manifest. Never switch
  providers or describe one provider as the better product choice.
- `src/core/db/verbs/chat-first.mjs:780-819,869-906`,
  `src/core/coaching/plan.mjs:259-285` - all job-thread replies and some coaching use the cheap
  tier, even when the operation is high-value career coaching. Route by operation: strongest
  allowed quality for coaching and strategy; balanced for consequential evaluation; cheaper
  capable models for bounded fetch, extraction, classification, and search leads. The user's
  preference is the policy input, not a raw provider model name. Prove equivalent behavior on
  Claude Code and Codex.

## P1

- `apps/web/src/chat-first/conversation-surfaces.jsx:373-518` - yes/no is guessed from English
  text and `nextActions` only render after action receipts. Render the latest unresolved typed
  prompt instead. Keep “or just type it,” and retire it only after either click or text resolves
  the prompt.
- `src/core/agent/workspace-agent.mjs:888-993,1133-1166,1317-1353,4630-4726` - ambiguous jobs,
  companies, recruiters, and setting values are returned as prose plus `error.details.matches` or
  `error.details.options`. Turn these into the same single-select prompt instead of making the
  user retype an exact name. Validate labels and action references server-side so error JSON can
  never leak into chat.
- `apps/web/src/chat-first/source-review.jsx:99-145,201-294`,
  `apps/web/src/chat-first/company-proposal-review.jsx:67-165` - source and company review are
  repeated Add/Skip or Track/Skip cards with no text equivalent. Present a small conversational
  batch, allow multi-selection, and finish through one clear footer action. Keep per-item versioned
  decisions behind the batch so a retry is idempotent. Do not recreate the huge approve/deny wall.
- `apps/web/src/chat-first/company-proposal-review.jsx:120-165` - the modal lacks the focus-on-open,
  Escape, focus trap, and focus restoration already implemented by Source Review
  (`apps/web/src/chat-first/source-review.jsx:164-198`). Reuse that accessible dialog behavior.
- `apps/web/src/chat-first/conversation-surfaces.jsx:928-997`,
  `apps/web/src/chat-first/ChatFirstApp.jsx:1807-1820` - application gaps support natural direct
  Q-and-A or an Answer button followed by composer input, but the selected gap is not durable.
  Store the open question ID in the URL and bind both routes to the same `screening.answer-confirm`
  resolution. Resume the packet only after the saved answer is read back.
- `apps/web/src/chat-first/profile-settings-controller.js:70-90,436-469`,
  `apps/web/src/chat-first/conversation-surfaces.jsx:968-994`,
  `src/core/agent/workspace-agent.mjs:4613-4645` - LinkedIn, Indeed, and other portal access is
  hidden behind generic permission rows, and typed requests are refused with a Settings dead end.
  Keep consent confirm-first, but surface the exact required permission in context with a semantic
  Allow button and an equally valid typed confirmation. The server, not Paul, owns the consent
  copy and resulting setting mutation.
- `apps/web/src/chat-first/conversation-surfaces.jsx:632-703,1036-1154` - mission Pause/Resume and
  mock-interview End are click-only product choices. Give each a typed prompt/action reference so
  “pause this mission,” “resume,” and “end the interview” reach the same durable mutation. Normal
  mock answers remain free text; structured choices are only needed when Paul actually offers
  formats, lengths, or next steps.
- `apps/web/src/chat-first/ProfileSettingsController.jsx:31-91`,
  `apps/web/src/chat-first/ProfileSettings.jsx:364-444` - Settings tab, runtime picker, and unsaved
  drafts are local state. Deep-link the active settings panel, warn before discarding edited
  values, and make quality/thinking choices keyboard-operable radio groups with descriptions and
  a visible saved state.

## P2

- `apps/web/src/chat-first/WorkspaceBrowser.jsx:151-183` - browser tabs use `role="tab"` but do
  not implement roving focus, arrow-key movement, or `aria-controls`. Add the complete tab keyboard
  pattern and encode the active tab in the URL.
- `apps/web/src/chat-first/conversation-surfaces.jsx:790-842` - Approve & copy, Edit, and Coach me
  live are useful actions but are not described by the generic choice contract. Model them as
  typed next actions so a natural request resolves to the same operation; copying may remain a
  local side effect after the durable approval result exists.
- `apps/web/src/chat-first/conversation-surfaces.jsx:1475-1597` and
  `apps/web/src/chat-first/ProfileSettings.jsx:364-377` - submit gates and Settings dialogs need
  the same focus containment, Escape, restoration, and overscroll behavior as Source Review.
- `apps/web/src/chat-first/chat-first.css:26-33`,
  `apps/web/src/chat-first/profile-settings.css:85-90`,
  `apps/web/src/chat-first/first-run.css:653-661` - global visible focus styling is already in good
  shape. Preserve it when chips, radios, multi-select, and dialogs are consolidated.

## Surface inventory

| Surface | Click today | Natural text today | Durable today | Required shape |
| --- | --- | --- | --- | --- |
| Main/job/skill yes-no | Yes | Yes | Partial | Generalize the working pattern; use metadata, not prose inference |
| Onboarding suggestions | Yes | Goes through a different path | No | Same prompt resolution and write for both inputs |
| Ask ambiguity recovery | No | Retype a name | Error is durable | Single-select choices from stable entity IDs |
| Zero-result role expansion | No | Not offered | No | Coached multi-select proposal, confirm, rerun |
| Deep Ingest proposal | Yes | Misclassified as a new source | Decision only | Versioned prompt with click/text parity and edit recovery |
| Source/company proposals | Yes, per row | No | Decisions | Small multi-select batch plus conversational continuation |
| Application answer gaps | Focus helper | Yes | Answer, not focus | Deep-linked open gap and one answer-confirm path |
| Application permissions | In-context only for prepare | Refused | Setting after click | Server-owned inline consent prompt in every blocker |
| Mission pause/resume | Yes | Not reliably | Mission | Typed action references and resume-safe UI |
| Mock interview | End only | Answers | Session | Keep free text; type any offered format/next-step choices |
| Model/runtime settings | Runtime only | No | Runtime | Provider-neutral quality + thinking preferences |
| Browser filters/selections | Yes | Not applicable | No | URL state, stable IDs, non-hijacking background updates |

## Reusable contract

One normalized object should cross model output, API validation, durable message metadata, and
JSX. Models may propose the question and bounded labels, but only server code may attach an
allowlisted action reference.

```ts
type ChoicePrompt = {
  id: string;
  version: number;
  threadId: string;
  messageId: string;
  question: string;
  mode: "binary" | "single" | "multi" | "confirm";
  minSelections: number;
  maxSelections: number;
  allowText: true;
  options: Array<{
    id: string;
    label: string;
    description?: string;
    aliases?: string[];
    actionRef: {
      type: string;
      entity: { type: string; id: string };
      expectedVersion?: number;
      input?: Record<string, unknown>;
    };
  }>;
  submitLabel?: string;
  state: "pending" | "resolved" | "stale";
  selectedOptionIds?: string[];
  resolvedAt?: string;
};
```

Clicked option IDs and natural-language answers must both pass through one resolver, which returns
the normalized option IDs and executes the same action reference. The resolver must reject unknown
IDs, over-limit selections, changed entity versions, already-resolved prompts, and action types not
allowed on that surface. Resolution is idempotent by prompt ID and version.

Binary and non-mutating single choices can send immediately. Multi-select stages selections in
checkboxes or `aria-pressed` buttons and uses one explicit submit action. Any profile, targeting,
source, company, permission, application, or destructive mutation gets a separate confirmation.
Resolved prompts remain visible as a compact answer summary; stale prompts refresh with plain copy.

The renderer uses a `fieldset`/`legend`, native controls or semantic buttons, visible
`focus-visible`, an `aria-live` status for asynchronous resolution, keyboard-complete selection,
and a clear validation message when the minimum or maximum is not met. Only the latest pending
prompt in a thread is interactive. A background result never changes active focus or navigation.

## Acceptance gate

For every row in the surface inventory, test click and natural text against the same prompt and
assert the same normalized intent, one durable write, one result message, and no duplicate after
retry. Repeat after reload, app restart, background completion while viewing another screen, stale
entity versions, cancel, and offline recovery. Multi-select must cover a typed answer and clicks for
the same three adjacent roles. Keyboard-only QA must cover focus order, Space/Enter, arrow keys for
radio/tab groups, Escape and focus restoration in dialogs, and a screen-reader announcement for
pending/success/error.

Provider routing acceptance runs the same coaching, evaluation, extraction, classification, and
bounded web-search fixtures on Claude Code and Codex. Assert provider stays fixed, product quality
and thinking preferences persist after restart, operation classes select the intended native tier,
unsupported native knobs degrade to that provider's documented default, and the UI never ranks one
provider above the other.
