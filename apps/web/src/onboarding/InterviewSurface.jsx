import { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert } from "../components/Toast.jsx";
import {
  extractResumeAi,
  extractResumeDocx,
  findChatBySkill,
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
import { FilePane } from "./FilePane.jsx";
import { OnboardingBar } from "./OnboardingBar.jsx";
import {
  SETUP_ITEM_LABELS,
  SETUP_ITEM_ORDER,
  setupCompletedCount,
  setupIsComplete,
  setupProgressFromState,
} from "./onboardingSetup.js";

const INTERVIEW_SKILL = "ingest-profile";

const SUGGESTION_CHIPS = [
  "I'm hunting applied AI roles",
  "Remote only, $200K floor",
  "Paste résumé text",
];

const RESUME_EXTENSIONS_AI = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);

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

// InterviewSurface — design frames 3a (centered opening) through 3b/3c
// (docked interview + dual-drive editing) and 3e (done, bar stays as the
// ask bar). One component, not four screens: docking is purely a layout
// change driven by whether a chat session exists yet (see the W4 spec's
// finalized "Bar reuse" section), and 3e is a state of the SAME chat/session
// (setupProgress.complete), not a navigation away from it.
export function InterviewSurface({ runtime }) {
  const [state, setState] = useState(null);
  const [chatId, setChatId] = useState(null);
  const [chatState, setChatState] = useState(null);
  const [messages, setMessages] = useState([]);
  const [starting, setStarting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const prevDoneRef = useRef({});
  const resumedRef = useRef(false);

  const reloadState = useCallback(async () => {
    const next = await getOnboardState();
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    void reloadState();
  }, [reloadState]);

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
    const flipped = SETUP_ITEM_ORDER.filter((key) => !prevDoneRef.current[key] && nextDone[key]);
    prevDoneRef.current = nextDone;
    if (flipped.length) {
      const claimCount = next?.data?.evidence?.claims?.length ?? 0;
      const receiptText = flipped
        .map((key) => {
          const label = SETUP_ITEM_LABELS[key].toUpperCase();
          if (key === "resume") return `RESUME ✓ · EVIDENCE DRAFTED · ${claimCount} CLAIMS`;
          return `${label} ✓ · TARGETING.YML UPDATED`;
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
      const text = extractAssistantText(data);
      if (text) setMessages((m) => [...m, { role: "assistant", text }]);
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
        <span className="onboarding-app__status">
          {docked
            ? `SETUP · ${setupCompletedCount(state)} OF 7 · INTERVIEW IN PROGRESS`
            : `ENGINE · ${runtime?.name?.toUpperCase() || "READY"}`}
        </span>
      </header>

      {!docked ? (
        <main className="onboarding-hero">
          <div className="onboarding-hero__copy">
            <h1>Set up your rat.</h1>
            <p>
              Tell it what you're hunting. It fills in the setup as you talk — and you can edit
              anything by hand, any time.
            </p>
          </div>
          {error ? <InlineAlert message={error} /> : null}
          <OnboardingBar
            mode="centered"
            placeholder="Tell it what you're hunting — or just drop your résumé in."
            onSend={handleSend}
            onDropResume={handleResumeDrop}
            busy={starting || uploading}
          />
          <div className="onboarding-suggestions">
            {SUGGESTION_CHIPS.map((chip) => (
              <span key={chip} className="onboarding-suggestions__chip">
                {chip}
              </span>
            ))}
          </div>
          <MiniProgressRow state={state} />
          <a className="onboarding-hero__escape-hatch" href="/settings">
            PREFER FORMS? OPEN THE CHECKLIST →
          </a>
        </main>
      ) : (
        <div className="onboarding-interview">
          <div className="onboarding-interview__chat">
            <div className="onboarding-transcript">
              {messages.map((m, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript log
                <TranscriptTurn key={i} message={m} />
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
          />
        </div>
      )}
      {docked ? (
        <OnboardingBar
          mode="docked"
          placeholder="Reply — or click any field in the file pane to edit it directly"
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

function TranscriptTurn({ message }) {
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
        R
      </span>
      <span className="onboarding-transcript__text">{message.text}</span>
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
        <span className="onboarding-app__status">SETUP · 7 OF 7 · DONE</span>
      </header>
      <main className="onboarding-done">
        <div>
          <h1>Your rat is set.</h1>
          <p>
            Setup's done — everything you told it is saved on this machine. It's already hunting.
          </p>
        </div>
        <div className="onboarding-done__row">
          <span className="onboarding-done__check" aria-hidden="true">
            ✓
          </span>
          <span className="onboarding-done__label">
            Setup complete <span className="onboarding-done__label-muted">· 7 of 7</span>
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
                {SETUP_ITEM_LABELS[key]} — {doneByKey[key] ? "done" : "not set"}
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
        placeholder='Ask your rat anything — "why did Stripe get cut?"'
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
    return `First sweep done — ${summary.boards ?? 0} boards, ${summary.roles ?? summary.totalRoles ?? 0} roles pulled`;
  }
  if (run?.status === "failed") {
    return "First sweep couldn't finish — retry from the Jobs tab anytime.";
  }
  return `First sweep running — ${summary.boards ?? 0} boards, ${summary.roles ?? summary.totalRoles ?? 0} roles pulled, gates next`;
}
