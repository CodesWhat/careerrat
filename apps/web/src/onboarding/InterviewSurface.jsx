import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { InlineAlert } from "../components/Toast.jsx";
import {
  createCompanyProposals,
  decideCompanyProposal,
  extractResumeAi,
  extractResumeDocx,
  findChatBySkill,
  getAutomationSettings,
  getCompanyProposals,
  getOnboardState,
  getSourcingRun,
  parseResumeText,
  saveCandidateFile,
  saveEvidenceSeed,
  sendChatMessage,
  startChat,
  startFirstSearchRun,
} from "../lib/api.js";
import { useEventSource } from "../lib/sse.js";
import { buildAutomationModePatch } from "../settings/AutomationControls.jsx";
import { ConfirmDialog, ConfirmPill } from "./ConfirmPill.jsx";
import { unionCompanyNames } from "./companyUnion.js";
import { parseConfirmBlocks } from "./confirmBlocks.js";
import { FilePane } from "./FilePane.jsx";
import { renderInlineMarkdown } from "./inlineMarkdown.jsx";
import { OnboardingBar } from "./OnboardingBar.jsx";
import {
  SETUP_ITEM_FILE,
  SETUP_ITEM_LABELS,
  SETUP_ITEM_ORDER,
  setupCompletedCount,
  setupIsComplete,
  setupProgressFromState,
  setupTotal,
} from "./onboardingSetup.js";

const INTERVIEW_SKILL = "ingest-profile";

// The two ways in, as actions rather than sample text. "upload" opens the file
// picker (dropping a résumé anywhere on the hero does the same thing); "send"
// posts its label immediately so Paul answers and the conversation starts
// without the user having to compose the admission themselves.
const SUGGESTION_CHIPS = [
  { label: "Upload my résumé", kind: "upload" },
  { label: "I don't have a résumé. Help me start another way.", kind: "send" },
];

const RESUME_EXTENSIONS_AI = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);

// Receipt copy for a resolved candidate_patch pill — keyed by the same
// closed payload.doc enum confirmBlocks.js validates against.
const CANDIDATE_PATCH_DOC_LABELS = {
  profile: "Profile",
  targeting: "Targeting",
  honesty: "Honesty",
  "form-defaults": "Form defaults",
};

function extractAssistantText(data) {
  const content = data?.message?.content;
  if (!Array.isArray(content) || !content.length) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function fileExtension(name) {
  return String(name || "")
    .split(".")
    .pop()
    ?.toLowerCase();
}

// Lane A / R1, R4 — immutably flips one parsed confirm block's status within
// the transcript's messages array (pending -> saving -> resolved|error), by
// [messageIndex, blockIndex] coordinates assigned when the block was parsed.
// Never mutates the block in place: React state must see a new reference to
// re-render the pill.
function setBlockStatus(messages, messageIndex, blockIndex, status, extra = {}) {
  return messages.map((message, i) => {
    if (i !== messageIndex || message.role !== "assistant" || !message.blocks) return message;
    return {
      ...message,
      blocks: message.blocks.map((block, j) =>
        j === blockIndex ? { ...block, status, ...extra } : block
      ),
    };
  });
}

// InterviewSurface — design frames 3a (centered opening) through 3b/3c
// (docked interview + dual-drive editing) and 3e (done, bar stays as the
// ask bar). One component, not four screens: docking is purely a layout
// change driven by whether a chat session exists yet (see the W4 spec's
// finalized "Bar reuse" section), and 3e is a state of the SAME chat/session
// (setupProgress.complete), not a navigation away from it.
export function InterviewSurface({ runtime, onRequestEngineScreen }) {
  const [state, setState] = useState(null);
  const [chatId, setChatId] = useState(null);
  const [chatState, setChatState] = useState(null);
  const [messages, setMessages] = useState([]);
  const [starting, setStarting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [automationStatus, setAutomationStatus] = useState(null);
  const [companyProposals, setCompanyProposals] = useState({ batchId: null, items: [] });
  // Engine re-entry (user QA: "a way to go back to the engine screen" once
  // detection auto-selects a CLI and skips EngineScreen entirely). The chip
  // click never navigates directly — it opens this confirm dialog first,
  // since going back genuinely costs the on-screen conversation (see the
  // dialog copy below and OnboardingPage's forceEngineScreen flag, which
  // owns the actual navigation).
  const [engineDialogOpen, setEngineDialogOpen] = useState(false);
  // A résumé can be dropped anywhere on the hero, not just on the bar, so the
  // drag state lives up here. `heroFileInputRef` is the bar's hidden file
  // input, borrowed so the upload chip opens the same picker.
  const [heroDragOver, setHeroDragOver] = useState(false);
  const heroFileInputRef = useRef(null);
  // Bug 3 fix ("already-done steps get announced as if they just happened")
  // — null means "not yet seeded". checkProgressDelta's first diff must
  // compare against whatever setup was already complete BEFORE this session
  // (e.g. the engine, picked in an earlier session), not against an empty
  // baseline — otherwise every already-done item reads as newly-flipped on
  // turn one. Seeded synchronously here (a one-time lazy ref init, safe to do
  // during render) the moment `state` first loads, rather than in a
  // useEffect, so it's ready before any SSE-driven checkProgressDelta call
  // can run.
  const prevDoneRef = useRef(null);
  if (prevDoneRef.current === null && state) {
    prevDoneRef.current = setupProgressFromState(state);
  }
  const resumedRef = useRef(false);

  const reloadState = useCallback(async () => {
    const next = await getOnboardState();
    setState(next);
    return next;
  }, []);

  // Lane A / R1, R4 — automationStatus backs the consent_capability pill's
  // "requires advanced mode" gate and its code-owned capability/platform
  // labels (automationStatus().capabilities[].label/summary — the same
  // route AutomationControls.jsx already reads, never a duplicated
  // frontend copy of CAPABILITIES).
  const reloadAutomationStatus = useCallback(async () => {
    try {
      const next = await getAutomationSettings();
      setAutomationStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  // Lane A / R2, R6 — the latest pending company-proposal batch (GET
  // /api/discovery/company-proposals?status=pending returns { data: { batch
  // } }, a single batch object — not an array). FilePane's Companies editor
  // renders companyProposals.items as accept/reject chips; batchId +
  // per-proposal version travel with each item so a decision call can
  // include the {batchId, proposalId, expectedVersion} optimistic-
  // concurrency triple the backend requires (see
  // src/core/discovery/company-proposal-decisions.mjs).
  const reloadCompanyProposals = useCallback(async () => {
    try {
      const res = await getCompanyProposals({ status: "pending" });
      const batch = res?.data?.batch ?? null;
      setCompanyProposals({
        batchId: batch?.batchId ?? null,
        items: (batch?.proposals ?? []).map((p) => ({
          proposalId: p.proposalId,
          name: p.company?.name || "",
          version: p.version,
        })),
      });
    } catch {
      setCompanyProposals({ batchId: null, items: [] });
    }
  }, []);

  useEffect(() => {
    void reloadState();
  }, [reloadState]);

  useEffect(() => {
    void reloadAutomationStatus();
  }, [reloadAutomationStatus]);

  useEffect(() => {
    void reloadCompanyProposals();
  }, [reloadCompanyProposals]);

  // Resumability (spec's "Decided defaults" section): reopening /onboarding
  // reconnects to a live session rather than starting a fresh interview.
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    (async () => {
      try {
        const existing = await findChatBySkill(INTERVIEW_SKILL);
        if (existing?.chatId) {
          setChatId(existing.chatId);
          setChatState(existing.state || "running");
        }
      } catch {
        // No live session — stay on the centered 3a opening.
      }
    })();
  }, []);

  // Once a turn settles back to idle, diff setupProgress against its
  // pre-turn snapshot and render any newly-done item as a receipt line
  // (design's "ROLES ✓ · TARGETING.YML UPDATED") — derived client-side from
  // state, not parsed out of tool_use payloads (per the spec's own fallback
  // instruction, this is preferred over forking ingest-profile itself).
  const checkProgressDelta = useCallback(async () => {
    const next = await reloadState();
    const nextDone = setupProgressFromState(next);
    const prevDone = prevDoneRef.current || {};
    const flipped = SETUP_ITEM_ORDER.filter((key) => !prevDone[key] && nextDone[key]);
    prevDoneRef.current = nextDone;
    if (flipped.length) {
      const claimCount = next?.data?.evidence?.claims?.length ?? 0;
      const receiptText = flipped
        .map((key) => {
          const label = SETUP_ITEM_LABELS[key].toUpperCase();
          // Bug 2 fix ("receipt lines state things that are not true") — a
          // résumé receipt must reflect what actually happened: real evidence
          // only got drafted when a résumé was genuinely uploaded
          // (sourceResumePresent), never when the user said they had none.
          if (key === "resume") {
            if (next?.sourceResumePresent) {
              return `RESUME ✓ · EVIDENCE DRAFTED · ${claimCount} CLAIM${claimCount === 1 ? "" : "S"}`;
            }
            return "RESUME ✓ · BUILT FROM YOUR ANSWERS";
          }
          // Every other item names the file it actually writes (or none, for
          // engine, which writes no candidate file at all) — never a
          // hardcoded "TARGETING.YML UPDATED" regardless of reality.
          const file = SETUP_ITEM_FILE[key];
          return file ? `${label} ✓ · ${file.toUpperCase()} UPDATED` : `${label} ✓`;
        })
        .join(" · ");
      setMessages((m) => [...m, { role: "receipt", text: receiptText }]);
    }
  }, [reloadState]);

  function handleEvent(type, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (type === "assistant") {
      const assistantRaw = extractAssistantText(data);
      if (assistantRaw) {
        // Lane A / R1, R4 — strip any confirm fences out of the display text
        // and attach the validated blocks so TranscriptTurn can render a
        // ConfirmPill per block. A turn that is ONLY a confirm block (no
        // other prose) still gets a transcript entry — text renders empty.
        const { text, blocks } = parseConfirmBlocks(assistantRaw);
        if (text || blocks.length) {
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              text,
              blocks: blocks.map((block) => ({ ...block, status: "pending" })),
            },
          ]);
        }
      }
    } else if (type === "chat_state") {
      if (data?.state) {
        setChatState(data.state);
        if (data.state === "idle") void checkProgressDelta();
      }
    } else if (type === "error") {
      setError(data?.message || "The interview hit a snag.");
    }
  }

  // Receipts come from diffing /api/onboard/state on idle (checkProgressDelta),
  // not from tool events — so only the event types handleEvent actually reads.
  useEventSource(chatId ? `/api/chat/events?id=${encodeURIComponent(chatId)}` : null, {
    types: ["assistant", "chat_state", "error"],
    onEvent: handleEvent,
    enabled: !!chatId,
  });

  // The centered->docked trigger (spec, decided): the first user-initiated
  // conversation event — sending a message OR dropping a résumé — never the
  // assistant's own greeting.
  async function ensureChatStarted(kickoffText) {
    if (chatId) return chatId;
    setStarting(true);
    setError(null);
    try {
      const session = await startChat(INTERVIEW_SKILL, { input: kickoffText });
      setChatId(session.chatId);
      setChatState(session.state);
      return session.chatId;
    } catch (err) {
      if (err?.status === 409 && err.body?.chatId) {
        setChatId(err.body.chatId);
        setChatState("running");
        return err.body.chatId;
      }
      setError(
        err?.body?.error || (err instanceof Error ? err.message : "Could not start the interview.")
      );
      return null;
    } finally {
      setStarting(false);
    }
  }

  async function handleSend(text) {
    const existingId = chatId;
    const id = await ensureChatStarted(text);
    if (!id) return;
    setMessages((m) => [...m, { role: "user", text }]);
    if (existingId) {
      try {
        await sendChatMessage(id, text);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Message failed to send");
      }
    }
  }

  async function handleResumeDrop(file) {
    setError(null);
    const label = `dropped my résumé (${file.name})`;
    const id = await ensureChatStarted(`I just ${label}.`);
    if (!id) return;
    setMessages((m) => [...m, { role: "user", text: `Dropped résumé: ${file.name}` }]);
    setUploading(true);
    try {
      const ext = fileExtension(file.name);
      let result;
      if (RESUME_EXTENSIONS_AI.has(ext)) {
        result = await extractResumeAi(file);
      } else if (ext === "docx") {
        result = await extractResumeDocx(file);
      } else {
        const text = await file.text();
        result = await parseResumeText(text, { save: true });
      }
      const seed = result?.data ?? result;
      const candidatePatch = seed?.profileSeed?.candidate ?? {};
      const claims = (seed?.evidenceSeed?.claims ?? []).map(({ claim, evidence }) => ({
        claim,
        evidence,
      }));
      if (Object.keys(candidatePatch).length) {
        await saveCandidateFile("profile", { candidate: candidatePatch });
      }
      if (claims.length) {
        await saveEvidenceSeed(claims);
      }
      // A parsed résumé also carries targeting.yml progress (role_buckets,
      // keep_signals, tracked_companies) — otherwise free setup progress
      // gets thrown away on every upload. candidateConfigPatch's deepMerge
      // replaces any array in a patch wholesale rather than merging it
      // (companyUnion.js), so tracked_companies goes through the same union
      // helper company_add uses (never a replace); role_buckets and
      // keep_signals have no such merge helper, so those two only write when
      // the candidate hasn't already entered anything there, rather than
      // risk clobbering a hand-entered answer with the résumé's version.
      const targetingSeed = seed?.targetingSeed ?? {};
      const existingTargeting = state?.data?.targeting ?? {};
      const targetingPatch = {};
      if (targetingSeed.tracked_companies?.length) {
        const nextCompanies = unionCompanyNames(
          existingTargeting.tracked_companies,
          targetingSeed.tracked_companies
        );
        if (nextCompanies.length) targetingPatch.tracked_companies = nextCompanies;
      }
      if (targetingSeed.role_buckets?.length && !existingTargeting.role_buckets?.length) {
        targetingPatch.role_buckets = targetingSeed.role_buckets;
      }
      if (targetingSeed.keep_signals?.length && !existingTargeting.keep_signals?.length) {
        targetingPatch.keep_signals = targetingSeed.keep_signals;
      }
      if (Object.keys(targetingPatch).length) {
        await saveCandidateFile("targeting", targetingPatch);
      }
      await checkProgressDelta();
      await sendChatMessage(
        id,
        `[SYSTEM] The résumé "${file.name}" was uploaded and parsed (${claims.length} claims extracted). Continue the interview using it.`
      );
    } catch (err) {
      setError(err?.body?.error || (err instanceof Error ? err.message : "Résumé upload failed."));
    } finally {
      setUploading(false);
    }
  }

  // Dual drive (design 3c) — a manual file-pane edit becomes a chat event
  // the assistant acknowledges next turn. Reuses the plain
  // POST /api/chat/message endpoint (no new runtime surface — see the W4
  // spec's server-scope item 3), rendered locally as a system pill.
  async function handleFieldSaved({ key, summary }) {
    const label = SETUP_ITEM_LABELS[key] || key;
    const pillText = `YOU EDITED · ${label.toUpperCase()}${summary ? ` · ${summary.toUpperCase()}` : ""}`;
    setMessages((m) => [...m, { role: "system-pill", text: pillText }]);
    if (chatId) {
      try {
        await sendChatMessage(
          chatId,
          `[SYSTEM] The user manually edited ${label} (${summary || "no summary"}). Acknowledge this and build on it.`
        );
      } catch {
        // Best-effort — the field is already saved; the assistant simply
        // won't get a chance to acknowledge this particular edit.
      }
    }
  }

  // Lane A / R1-R4 — dispatches one confirm block's write, per kind. Returns
  // the resultSummary string a resolved pill displays. Every write here goes
  // through the SAME REST endpoints the file pane's manual editors already
  // use (saveCandidateFile et al.) — this never adds a new agent tool; the
  // pill click is the human action that turns the model's proposal into a
  // real write.
  async function runConfirmAction(block) {
    if (block.kind === "authorization") {
      await saveCandidateFile("profile", { authorization: block.patch });
      // R3: candidate.mjs's authorizationDeclared() only treats an explicit
      // true/true-style answer or a recorded decline as "declared" (day-1
      // DB defaults already seed false/false, so that pair alone can't mean
      // "declared" server-side without this procedural write) — an
      // authorization pill that resolves to false/false is itself the
      // user's explicit "no/no" answer, so it also records the decline.
      if (block.patch.work_authorized === false && block.patch.requires_sponsorship === false) {
        await saveCandidateFile("form-defaults", {
          declined_fields: { authorization: { declined_at: new Date().toISOString() } },
        });
      }
      await checkProgressDelta();
      return "Work authorization saved";
    }
    if (block.kind === "consent_mode") {
      const patch = buildAutomationModePatch(automationStatus, block.payload);
      await saveCandidateFile("automation", patch);
      await reloadAutomationStatus();
      await checkProgressDelta();
      return block.payload === "advanced" ? "Advanced mode on" : "Basic mode kept";
    }
    if (block.kind === "consent_capability") {
      // Defense in depth — the pill is already disabled in the UI until
      // advanced mode is on (R1); this guards the same call reaching here
      // from a stale render.
      if (automationStatus?.mode !== "advanced") {
        throw new Error("Advanced mode must be turned on first.");
      }
      const { capability, platform } = block.payload;
      // R1 — one write sets capabilities.<cap>.platforms.<platform>=true,
      // capabilities.<cap>.enabled=true, and consent.<platform>=true together.
      await saveCandidateFile("automation", {
        capabilities: { [capability]: { enabled: true, platforms: { [platform]: true } } },
        consent: { [platform]: true },
      });
      await reloadAutomationStatus();
      await checkProgressDelta();
      return "Permission granted";
    }
    if (block.kind === "companies_suggest") {
      await createCompanyProposals({});
      await reloadCompanyProposals();
      return "Suggestions ready: check the file pane";
    }
    if (block.kind === "company_add") {
      // R2 — union with the existing list, never a replace.
      const existing = state?.data?.targeting?.tracked_companies ?? [];
      const next = unionCompanyNames(existing, [block.payload.name]);
      await saveCandidateFile("targeting", { tracked_companies: next });
      await reloadState();
      return `Added ${block.payload.name}`;
    }
    if (block.kind === "candidate_patch") {
      // The generic write-anything-to-a-candidate-doc kind (confirmBlocks.js
      // closes payload.doc to profile/targeting/honesty/form-defaults) — the
      // agent has no write tools, so this is the only way answers outside
      // the five narrow kinds above ever get saved. Same REST endpoint every
      // other branch here uses; the pill click is still the human action.
      await saveCandidateFile(block.payload.doc, block.payload.patch);
      await checkProgressDelta();
      return `${CANDIDATE_PATCH_DOC_LABELS[block.payload.doc]} saved`;
    }
    if (block.kind === "evidence_claim") {
      // The generic evidence-capture kind — mirrors handleResumeDrop's own
      // saveEvidenceSeed call for claims volunteered mid-interview instead
      // of parsed off a résumé.
      await saveEvidenceSeed([{ claim: block.payload.claim, evidence: block.payload.evidence }]);
      await checkProgressDelta();
      return "Evidence saved";
    }
    throw new Error(`Unknown confirm kind "${block.kind}"`);
  }

  async function handleConfirmAction(messageIndex, blockIndex, block) {
    setMessages((m) => setBlockStatus(m, messageIndex, blockIndex, "saving"));
    try {
      const resultSummary = await runConfirmAction(block);
      setMessages((m) =>
        setBlockStatus(m, messageIndex, blockIndex, "resolved", { resultSummary })
      );
    } catch (err) {
      const message = err?.body?.error || (err instanceof Error ? err.message : "Save failed.");
      setMessages((m) => setBlockStatus(m, messageIndex, blockIndex, "error", { error: message }));
    }
  }

  // Lane A / R4, R6 (Decline UX) — the pill-level "I'd rather not say" action
  // for authorization/consent_mode blocks (see DECLINABLE_KINDS in
  // ConfirmPill.jsx). This is the only path that lets a decline made INSIDE
  // the chat actually get recorded: the agent has no write tools of its own,
  // so without this a user who tells the agent "I'd rather not say" has no
  // way to turn that into a real declined_fields write short of switching to
  // the file pane. Writes ONLY form-defaults.declined_fields — for
  // consent_mode this deliberately never touches automation.setup_mode, so
  // declining consent can't leave automation half-configured. Fires the same
  // [SYSTEM] chat-note pattern handleFieldSaved uses for a manual file-pane
  // edit, so the agent's next turn acknowledges the decline instead of
  // re-asking, and checkProgressDelta so the item flips to "Declined".
  async function runDeclineAction(block) {
    const key = block.kind === "consent_mode" ? "consent" : "authorization";
    await saveCandidateFile("form-defaults", {
      declined_fields: { [key]: { declined_at: new Date().toISOString() } },
    });
    await checkProgressDelta();
    if (chatId) {
      try {
        await sendChatMessage(
          chatId,
          `[SYSTEM] The user declined to answer ${SETUP_ITEM_LABELS[key].toLowerCase()} (won't ask again). Acknowledge this and move on.`
        );
      } catch {
        // Best-effort — the decline is already recorded; the assistant
        // simply won't get a chance to acknowledge it this turn.
      }
    }
    return "Noted, won't ask again";
  }

  async function handleDeclineAction(messageIndex, blockIndex, block) {
    setMessages((m) => setBlockStatus(m, messageIndex, blockIndex, "saving"));
    try {
      const resultSummary = await runDeclineAction(block);
      setMessages((m) =>
        setBlockStatus(m, messageIndex, blockIndex, "resolved", { resultSummary })
      );
    } catch (err) {
      const message = err?.body?.error || (err instanceof Error ? err.message : "Save failed.");
      setMessages((m) => setBlockStatus(m, messageIndex, blockIndex, "error", { error: message }));
    }
  }

  // Lane A / R2, R6 — FilePane's companies-proposal accept/reject chips call
  // this. Accept unions the proposal's company name into
  // targeting.tracked_companies (never a replace — companyUnion.js) and
  // records the decision as "approve-supported-ats" with userConfirmed:true
  // (a human click in the file pane relaxes the same confidence-tier bar
  // the backend applies to an unattended auto-approve); reject just records
  // "reject". Either way the proposal disappears from the pending list on
  // the next reload.
  async function handleCompanyProposalDecision(proposal, action) {
    await decideCompanyProposal({
      batchId: companyProposals.batchId,
      proposalId: proposal.proposalId,
      action,
      expectedVersion: proposal.version,
      ...(action === "approve-supported-ats" ? { userConfirmed: true } : {}),
    });
    if (action === "approve-supported-ats") {
      const existing = state?.data?.targeting?.tracked_companies ?? [];
      const next = unionCompanyNames(existing, [proposal.name]);
      await saveCandidateFile("targeting", { tracked_companies: next });
      await reloadState();
    }
    await reloadCompanyProposals();
  }

  if (!state) return null;

  const docked = !!chatId;
  const complete = setupIsComplete(state);

  if (complete) {
    return (
      <CompletionScreen
        state={state}
        runtime={runtime}
        onSend={handleSend}
        reloadState={reloadState}
      />
    );
  }

  return (
    <div className="onboarding-app">
      <header className="onboarding-app__header">
        <div className="onboarding-app__brand">
          CareerRat<span className="onboarding-app__brand-dot">.</span>
        </div>
        <div className="onboarding-app__header-status">
          {docked ? (
            <span className="onboarding-app__status">
              SETUP · {setupCompletedCount(state)} OF {setupTotal(state)} · INTERVIEW IN PROGRESS
            </span>
          ) : null}
          <button
            type="button"
            className="onboarding-engine__link"
            onClick={() => setEngineDialogOpen(true)}
          >
            ENGINE · {runtime?.name?.toUpperCase() || "READY"}
          </button>
        </div>
      </header>
      {engineDialogOpen ? (
        <ConfirmDialog
          title="Change engine?"
          body="Setup answers save as you go, so nothing there is at risk. The chat conversation on screen isn't saved though. Coming back here clears it."
          onCancel={() => setEngineDialogOpen(false)}
          onConfirm={() => {
            setEngineDialogOpen(false);
            onRequestEngineScreen?.();
          }}
        />
      ) : null}

      {!docked ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: whole-screen drop target; the upload chip and the bar's attach button are the keyboard/click equivalents
        <main
          className={`onboarding-hero${heroDragOver ? " onboarding-hero--drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setHeroDragOver(true);
          }}
          onDragLeave={(e) => {
            // Leaving for a child element still fires dragleave on the parent;
            // only clear when the pointer has actually left the hero.
            if (!e.currentTarget.contains(e.relatedTarget)) setHeroDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setHeroDragOver(false);
            const file = e.dataTransfer?.files?.[0];
            if (file) handleResumeDrop(file);
          }}
        >
          <div className="onboarding-hero__copy">
            <h1>This is Paul.</h1>
            <p>
              He runs your job hunt. Drop your résumé anywhere on this page to start, or just tell
              him what you're after. He fills in the setup as you talk, and you can edit anything by
              hand, any time.
            </p>
          </div>
          {error ? <InlineAlert message={error} /> : null}
          <OnboardingBar
            mode="centered"
            placeholder="Tell Paul what you're hunting, or paste your résumé text here."
            fileInputRef={heroFileInputRef}
            onSend={handleSend}
            onDropResume={handleResumeDrop}
            busy={starting || uploading}
          />
          <div className="onboarding-suggestions">
            {SUGGESTION_CHIPS.map((chip) => (
              <button
                key={chip.label}
                type="button"
                className="onboarding-suggestions__chip"
                onClick={() => {
                  if (chip.kind === "upload") heroFileInputRef.current?.click();
                  else handleSend(chip.label);
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <MiniProgressRow state={state} />
          <Link className="onboarding-hero__escape-hatch" to="/settings">
            PREFER FORMS? OPEN THE CHECKLIST →
          </Link>
        </main>
      ) : (
        <div className="onboarding-interview">
          <div className="onboarding-interview__chat">
            <div className="onboarding-transcript">
              {messages.map((m, i) => (
                <TranscriptTurn
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript log
                  key={i}
                  message={m}
                  index={i}
                  automationStatus={automationStatus}
                  onConfirmBlock={handleConfirmAction}
                  onDeclineBlock={handleDeclineAction}
                />
              ))}
              {chatState === "running" ? (
                <div className="onboarding-transcript__thinking">Thinking…</div>
              ) : null}
            </div>
            {error ? <InlineAlert message={error} /> : null}
          </div>
          <FilePane
            state={state}
            runtime={runtime}
            onReload={reloadState}
            onFieldSaved={handleFieldSaved}
            companyProposals={companyProposals.items}
            onDecideCompanyProposal={handleCompanyProposalDecision}
          />
        </div>
      )}
      {docked ? (
        <OnboardingBar
          mode="docked"
          placeholder="Reply, or click any field in the file pane to edit it directly"
          onSend={handleSend}
          busy={starting || uploading || chatState === "running"}
        />
      ) : null}
    </div>
  );
}

function MiniProgressRow({ state }) {
  const doneByKey = setupProgressFromState(state);
  return (
    <div className="onboarding-progress-row">
      {SETUP_ITEM_ORDER.map((key) => (
        <span
          key={key}
          className={`onboarding-progress-row__item${doneByKey[key] ? " onboarding-progress-row__item--done" : ""}`}
        >
          <span className="onboarding-progress-row__dot" aria-hidden="true" />
          {SETUP_ITEM_LABELS[key].toUpperCase()}
        </span>
      ))}
    </div>
  );
}

function TranscriptTurn({ message, index, automationStatus, onConfirmBlock, onDeclineBlock }) {
  if (message.role === "receipt") {
    return <div className="onboarding-transcript__receipt">{message.text}</div>;
  }
  if (message.role === "system-pill") {
    return (
      <div className="onboarding-transcript__pill-row">
        <span className="onboarding-transcript__pill">{message.text}</span>
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className="onboarding-transcript__turn onboarding-transcript__turn--user">
        {message.text}
      </div>
    );
  }
  return (
    <div className="onboarding-transcript__turn onboarding-transcript__turn--assistant">
      <span className="onboarding-transcript__avatar" aria-hidden="true">
        P
      </span>
      <div className="onboarding-transcript__body">
        {message.text ? (
          <span className="onboarding-transcript__text">{renderInlineMarkdown(message.text)}</span>
        ) : null}
        {message.blocks?.length ? (
          <div className="onboarding-transcript__pills">
            {message.blocks.map((block, blockIndex) => (
              <ConfirmPill
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed per-turn block list, no stable id
                key={blockIndex}
                block={block}
                automationStatus={automationStatus}
                onConfirm={() => onConfirmBlock(index, blockIndex, block)}
                onDecline={() => onDeclineBlock(index, blockIndex, block)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// CompletionScreen — design 3e. Not a separate route: it's what
// InterviewSurface renders once state.setupProgress.complete is true. The
// bar stays mounted (docked, "ask-bar placeholder" copy) — after this,
// navigating anywhere else in the app shows the same W3 AppShell AskBar,
// same session continuity server-side, no client handoff needed.
function CompletionScreen({ state, runtime, onSend, reloadState }) {
  const [expanded, setExpanded] = useState(false);
  const [run, setRun] = useState(state?.data?.sourcing?.firstSearchRun ?? null);
  const kickedOffRef = useRef(false);
  const doneByKey = setupProgressFromState(state);

  useEffect(() => {
    if (kickedOffRef.current || run?.status) return;
    kickedOffRef.current = true;
    void startFirstSearchRun().catch(() => {
      // Best-effort — a failed kickoff just leaves the row absent; the user
      // can still trigger a sweep from the Jobs tab.
    });
  }, [run?.status]);

  useEffect(() => {
    if (run?.status !== "running" && run?.status !== undefined && run?.status !== null) return;
    const interval = setInterval(async () => {
      try {
        const latest = await getSourcingRun({ purpose: "first-search" });
        const nextRun = latest?.run ?? latest;
        setRun(nextRun);
        if (nextRun?.status && nextRun.status !== "running") clearInterval(interval);
      } catch {
        // Transient poll failure — try again on the next tick.
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [run?.status]);

  return (
    <div className="onboarding-app">
      <header className="onboarding-app__header">
        <div className="onboarding-app__brand">
          CareerRat<span className="onboarding-app__brand-dot">.</span>
        </div>
        <span className="onboarding-app__status">
          SETUP · {setupTotal(state)} OF {setupTotal(state)} · DONE
        </span>
      </header>
      <main className="onboarding-done">
        <div>
          <h1>Your rat is set.</h1>
          <p>
            Setup's done. Everything you told it is saved on this machine. It's already hunting.
          </p>
        </div>
        <div className="onboarding-done__row">
          <span className="onboarding-done__check" aria-hidden="true">
            ✓
          </span>
          <span className="onboarding-done__label">
            Setup complete{" "}
            <span className="onboarding-done__label-muted">
              · {setupTotal(state)} of {setupTotal(state)}
            </span>
          </span>
          <button
            type="button"
            className="onboarding-engine__link"
            onClick={() => setExpanded((v) => !v)}
          >
            SEE WHAT IT KNOWS
          </button>
        </div>
        {expanded ? (
          <ul className="onboarding-done__disclosure">
            {SETUP_ITEM_ORDER.map((key) => (
              <li key={key}>
                {SETUP_ITEM_LABELS[key]}: {doneByKey[key] ? "done" : "not set"}
              </li>
            ))}
          </ul>
        ) : null}
        {run ? (
          <div className="onboarding-done__row">
            <span className="onboarding-done__spinner" aria-hidden="true" />
            <span className="onboarding-done__label">{firstSweepLabel(run)}</span>
            <span className="onboarding-done__engine">
              AI · {runtime?.name?.toUpperCase() || "ENGINE"}
            </span>
          </div>
        ) : null}
      </main>
      <OnboardingBar
        mode="docked"
        placeholder='Ask your rat anything: "why did Stripe get cut?"'
        onSend={async (text) => {
          await onSend(text);
          await reloadState();
        }}
      />
    </div>
  );
}

function firstSweepLabel(run) {
  const summary = run?.summary || {};
  if (run?.status === "completed") {
    return `First sweep done: ${summary.boards ?? 0} boards, ${summary.roles ?? summary.totalRoles ?? 0} roles pulled`;
  }
  if (run?.status === "failed") {
    return "First sweep couldn't finish. Retry from the Jobs tab anytime.";
  }
  return `First sweep running: ${summary.boards ?? 0} boards, ${summary.roles ?? summary.totalRoles ?? 0} roles pulled, gates next`;
}
