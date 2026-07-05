import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../../app-shell/DashboardContext.jsx";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import {
  addBoard,
  previewBoards,
  startDiscoveryNext,
  startDiscoveryQuickStart,
  writeConfig,
} from "../../lib/api.js";
import { ChatPanel } from "../ChatPanel.jsx";

const READINESS_ROWS = [
  {
    key: "search_ready",
    label: "Search",
    readyDetail: "Rolester can start sourcing roles now.",
  },
  {
    key: "gate_ready",
    label: "Gate",
    readyDetail: "Jobs can be evaluated without guessing.",
  },
  {
    key: "apply_ready",
    label: "Apply",
    readyDetail: "Tailoring and application flows are unlocked.",
  },
  {
    key: "deep_ingest_complete",
    label: "Deep ingest",
    readyDetail: "Optional coaching context is complete.",
  },
];

const DISCOVERY_CHAT_SKILLS = ["research-boards", "discover-companies", "search-jobs"];
const NO_AI_DISCOVERY_HINT = "Add an AI key in the earlier step to use Roland's search.";
const NO_HANDOFF_DISCOVERY_HINT = "Discovery chat handoffs are unavailable in this runtime.";

function hasRuntimeDiscoveryHandoff(runtimeCapabilities) {
  return Object.hasOwn(runtimeCapabilities || {}, "discoveryChatHandoffs");
}

function missingDetail(values) {
  const missing = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!missing.length) return "Needs setup details.";
  const shown = missing.slice(0, 2).join(", ");
  const suffix = missing.length > 2 ? `, and ${missing.length - 2} more` : "";
  return `Needs ${shown}${suffix}.`;
}

function compactMissing(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function listSentence(values) {
  const items = compactMissing(values);
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function buildReadinessRows(state) {
  const setup = state?.data?.setup || {};
  const readiness = setup.readiness || {};
  const missing = setup.missing || {};
  return READINESS_ROWS.map((row) => {
    const ready = readiness[row.key] === true;
    return {
      key: row.key,
      label: row.label,
      status: ready ? "Ready" : "Needs setup",
      detail: ready ? row.readyDetail : missingDetail(missing[row.key]),
      ready,
    };
  });
}

export function buildQuickStartAction(state) {
  const setup = state?.data?.setup || {};
  const readiness = setup.readiness || {};
  const missing = setup.missing || {};
  if (readiness.search_ready !== true) {
    const blockers = listSentence(missing.search_ready);
    return {
      enabled: false,
      label: "Complete search setup",
      detail: blockers ? `Needs ${blockers}.` : "Complete search setup to source roles.",
    };
  }

  const gateApplyMissing = compactMissing([
    ...(missing.gate_ready || []),
    ...(missing.apply_ready || []),
  ]);
  const blockers = listSentence(gateApplyMissing);
  return {
    enabled: true,
    label: "Prepare sourcing",
    detail: blockers
      ? `Rolester can prepare source setup now. Gate and apply stay locked until ${blockers} are complete.`
      : "Rolester can prepare source setup now. Gate and apply are ready too.",
  };
}

function errorMessage(err, fallback) {
  return err?.body?.error || (err instanceof Error ? err.message : fallback);
}

export function extractDiscoveryGuidance(snapshot) {
  const guidance =
    snapshot?.data?.agentGuidance || snapshot?.agentGuidance || snapshot?.guidance || null;
  const nextSkill = String(guidance?.nextSkill || "").trim();
  if (!DISCOVERY_CHAT_SKILLS.includes(nextSkill)) return null;
  return {
    nextSkill,
    message: guidance?.message || `Ask your agent to run ${nextSkill} next.`,
    ctaLabel: guidance?.ctaLabel || `Run ${nextSkill}`,
  };
}

export async function runQuickStartHandoff({
  quickStart = startDiscoveryQuickStart,
  reload,
  refreshWorkspace,
} = {}) {
  const result = await quickStart();
  await (refreshWorkspace || reload)?.();
  return {
    result,
    chat: result.chat || null,
    chatError: result.chatError || null,
    guidance: extractDiscoveryGuidance(result),
  };
}

export async function runNextDiscoveryHandoff({
  continueDiscovery = startDiscoveryNext,
  refreshWorkspace,
} = {}) {
  const result = await continueDiscovery();
  await refreshWorkspace?.();
  return {
    result,
    guidance: extractDiscoveryGuidance(result),
    chat: result.chat || null,
    chatError: result.chatError || null,
  };
}

export function DiscoveryChatPanel({ discoveryChat, discoveryGuidance, quickStartResult }) {
  if (!discoveryChat) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <ChatPanel
        key={discoveryChat.chatId}
        skill={discoveryChat.skill || discoveryGuidance?.nextSkill || quickStartResult?.nextSkill}
        kickoffLabel="Run discovery"
        initialChatId={discoveryChat.chatId}
      />
    </div>
  );
}

// Step 7 — Finish. The app's source setup state is the DB `search-sources`
// row. POST /api/onboard/write-config remains an explicit CLI/debug
// compatibility export for candidate YAML, search-sources.yml, and AGENTS.md.
// The "add your LinkedIn saved search" affordance is deliberately here, after
// source setup exists, so a source added through the DB-backed boards route
// is not overwritten by a later compatibility export. Ends with the explicit
// /chat evidence-interview handoff the design doc calls for: the wizard and
// the deeper conversational interview are two independent entry points into
// the same candidate setup state, not one linear flow.
export function FinishStep({ state, reload, goBack, aiEnabled = true, runtimeCapabilities }) {
  const dashboard = useDashboardSnapshot();
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(null);
  const [error, setError] = useState(null);
  const [quickStarting, setQuickStarting] = useState(false);
  const [quickStartResult, setQuickStartResult] = useState(null);
  const [discoveryStarting, setDiscoveryStarting] = useState(false);
  const [discoveryChat, setDiscoveryChat] = useState(null);
  const [discoveryChatError, setDiscoveryChatError] = useState(null);

  const [preview, setPreview] = useState(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const compatibilityExported = !!written;
  const sourceSetupReady = compatibilityExported || !!state?.searchSourcesPresent;
  const readinessRows = buildReadinessRows(state);
  const searchReady = readinessRows.find((row) => row.key === "search_ready")?.ready;
  const gateReady = readinessRows.find((row) => row.key === "gate_ready")?.ready;
  const applyReady = readinessRows.find((row) => row.key === "apply_ready")?.ready;
  const quickStartAction = buildQuickStartAction(state);
  const discoveryGuidance = extractDiscoveryGuidance(dashboard.data) || quickStartResult?.guidance;
  const runtimeControlsDiscoveryHandoffs = hasRuntimeDiscoveryHandoff(runtimeCapabilities);
  const discoveryAiEnabled = runtimeControlsDiscoveryHandoffs
    ? runtimeCapabilities.discoveryChatHandoffs === true
    : aiEnabled !== false;
  const discoveryUnavailableHint =
    runtimeControlsDiscoveryHandoffs && runtimeCapabilities?.aiAvailable !== false
      ? NO_HANDOFF_DISCOVERY_HINT
      : NO_AI_DISCOVERY_HINT;

  async function refreshWorkspace() {
    await reload?.();
    await dashboard.refetch?.();
  }

  async function handleWriteConfig() {
    setWriting(true);
    setError(null);
    try {
      const result = await writeConfig();
      setWritten(result.written || []);
      await reload?.();
    } catch (err) {
      setError(err?.body?.error || (err instanceof Error ? err.message : "write-config failed"));
    } finally {
      setWriting(false);
    }
  }

  async function handleQuickStart() {
    setQuickStarting(true);
    setError(null);
    setDiscoveryChatError(null);
    try {
      const { result, chat, chatError } = await runQuickStartHandoff({ refreshWorkspace });
      setQuickStartResult(result);
      setWritten(result.written || []);
      setDiscoveryChat(chat);
      setDiscoveryChatError(chatError);
    } catch (err) {
      setError(errorMessage(err, "quick-start failed"));
    } finally {
      setQuickStarting(false);
    }
  }

  async function handleContinueDiscovery() {
    setDiscoveryStarting(true);
    setError(null);
    setDiscoveryChatError(null);
    try {
      const { chat, chatError } = await runNextDiscoveryHandoff({
        refreshWorkspace: dashboard.refetch,
      });
      setDiscoveryChat(chat);
      setDiscoveryChatError(chatError);
    } catch (err) {
      setDiscoveryChatError(errorMessage(err, "Could not continue discovery"));
    } finally {
      setDiscoveryStarting(false);
    }
  }

  // Recompute once after DB source setup exists. A compatibility export also
  // refreshes the DB search-sources row before writing YAML.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once on sourceSetupReady
  useEffect(() => {
    if (!sourceSetupReady) return;
    const titles = state?.data?.targeting?.role_buckets?.[0]?.titles ?? [];
    if (!titles.length) return;
    const profile = state?.data?.profile ?? {};
    previewBoards({
      keywords: titles[0],
      location: profile.location?.home ?? null,
      remote: !!profile.location?.remote,
      minimumBase: profile.compensation?.minimum_base ?? null,
      windowHours: 24,
    })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [sourceSetupReady]);

  async function handleAddLinkedIn() {
    if (!preview?.linkedin?.url) return;
    setAdding(true);
    setError(null);
    try {
      await addBoard({ url: preview.linkedin.url, label: "LinkedIn (from onboarding)" });
      setAdded(true);
    } catch (err) {
      setError(err?.body?.error || (err instanceof Error ? err.message : "Could not add source"));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error ? <InlineAlert message={error} /> : null}

      <Card title="Setup readiness">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 10,
          }}
        >
          {readinessRows.map((row) => (
            <div
              key={row.key}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 12,
                minHeight: 96,
              }}
            >
              <div className="field__hint" style={{ margin: 0 }}>
                {row.label}
              </div>
              <strong>{row.status}</strong>
              <p className="field__hint" style={{ margin: "6px 0 0" }}>
                {row.detail}
              </p>
            </div>
          ))}
        </div>
        <p className="field__hint" style={{ marginBottom: 0 }}>
          {searchReady && (!gateReady || !applyReady)
            ? "Search-ready: Rolester can source roles now while you finish setup for gating and applying."
            : "Complete the search row to start sourcing; gate and apply unlock when their rows are ready."}
        </p>
      </Card>

      <Card title="Quick start sourcing">
        {discoveryAiEnabled ? (
          <>
            <p>{quickStartAction.detail}</p>
            <Button
              onClick={handleQuickStart}
              disabled={!quickStartAction.enabled || quickStarting}
            >
              {quickStarting ? "Starting…" : quickStartAction.label}
            </Button>
          </>
        ) : (
          <p className="field__hint" style={{ margin: 0 }}>
            {NO_AI_DISCOVERY_HINT}
          </p>
        )}
        {quickStartResult ? (
          <p className="field__hint">
            Next agent: <code>{quickStartResult.nextSkill}</code>. {quickStartResult.nextMessage}
          </p>
        ) : null}
      </Card>

      <Card
        title="Discovery pipeline"
        actions={
          discoveryAiEnabled && discoveryGuidance ? (
            <Button
              variant="secondary"
              onClick={handleContinueDiscovery}
              disabled={discoveryStarting || dashboard.noDatabase}
            >
              {discoveryStarting ? "Starting…" : discoveryGuidance.ctaLabel}
            </Button>
          ) : null
        }
      >
        <p className="field__hint" style={{ marginTop: 0 }}>
          {!discoveryAiEnabled
            ? discoveryUnavailableHint
            : discoveryGuidance
              ? discoveryGuidance.message
              : "No discovery handoff is ready yet. Prepare sourcing first, then refresh this task."}
        </p>
        <div className="chip-row">
          {DISCOVERY_CHAT_SKILLS.map((skill) => (
            <span
              className={`chip ${discoveryGuidance?.nextSkill === skill ? "badge--ok" : ""}`}
              key={skill}
            >
              {skill}
            </span>
          ))}
        </div>
        {discoveryChatError ? <InlineAlert message={discoveryChatError} /> : null}
        <DiscoveryChatPanel
          discoveryChat={discoveryChat}
          discoveryGuidance={discoveryGuidance}
          quickStartResult={quickStartResult}
        />
      </Card>

      <Card title="Finish setup">
        <p>
          Your app source setup is saved in SQLite. Export compatibility files only for CLI/debug
          support.
        </p>
        <Button onClick={handleWriteConfig} disabled={writing}>
          {writing ? "Exporting…" : "Export compatibility files"}
        </Button>
        {written ? (
          <p className="field__hint">Exported compatibility files: {written.join(", ")}</p>
        ) : sourceSetupReady ? (
          <p className="field__hint">SQLite source setup is ready.</p>
        ) : null}
      </Card>

      {sourceSetupReady && preview?.linkedin?.url ? (
        <Card title="Add your LinkedIn saved search">
          <p className="field__hint" style={{ margin: 0 }}>
            Enabling this still requires the usual authenticated-search consent (
            <code>rolester automation consent linkedin --write</code>) before it can run.
          </p>
          <div className="board-preview">
            <a
              className="board-preview__url"
              href={preview.linkedin.url}
              target="_blank"
              rel="noreferrer"
            >
              {preview.linkedin.url}
            </a>
          </div>
          {added ? (
            <p className="field__hint">Added to DB source setup (disabled by default).</p>
          ) : (
            <Button variant="secondary" onClick={handleAddLinkedIn} disabled={adding}>
              {adding ? "Adding…" : "Add to my search sources"}
            </Button>
          )}
        </Card>
      ) : null}

      <Card title="What's next">
        <p>
          Your workspace is live. For a deeper interview — evidence bank, honesty boundaries,
          writing samples — the kind that improves tailored resumes, start the full setup chat.
        </p>
        <div className="links" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a href="/chat">Start the deeper interview</a>
          <Link to="/">Go to Home</Link>
          <Link to="/settings">Go to Settings</Link>
        </div>
      </Card>

      <div className="wizard-actions">
        <Button variant="secondary" onClick={goBack}>
          Back
        </Button>
        <span />
      </div>
    </div>
  );
}
