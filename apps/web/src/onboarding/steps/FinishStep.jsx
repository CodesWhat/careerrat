import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../../app-shell/DashboardContext.jsx";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import {
  addBoard,
  saveCandidateFile as defaultSaveCandidateFile,
  startFirstSearchRun as defaultStartFirstSearchRun,
  previewBoards,
  writeConfig,
} from "../../lib/api.js";

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

const CADENCE_OPTIONS = [
  { mode: "daily", label: "Daily" },
  { mode: "every-3-days", label: "Every 3 days" },
  { mode: "weekly", label: "Weekly" },
  { mode: "manual", label: "Manual only" },
];

const CADENCE_LABELS = Object.fromEntries(
  CADENCE_OPTIONS.map((option) => [option.mode, option.label])
);

const FIRST_SEARCH_STATUS = {
  not_started: { label: "Not started", badgeClass: "badge--warn" },
  running: { label: "Running", badgeClass: "badge--warn" },
  completed: { label: "Completed", badgeClass: "badge--ok" },
  failed: { label: "Failed", badgeClass: "badge--error" },
};

const DEFAULT_CADENCE = { mode: "daily", recommended_from: "default" };

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
      label: "Complete Search setup",
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
    label: "Search jobs now",
    detail: blockers
      ? `Rolester can start the first deterministic search now. Gate and apply stay locked until ${blockers} are complete.`
      : "Rolester can start the first deterministic search now. Gate and apply are ready too.",
  };
}

function errorMessage(err, fallback) {
  return err?.body?.error || (err instanceof Error ? err.message : fallback);
}

function normalizeCadenceMode(mode) {
  const value = String(mode || "").trim();
  return CADENCE_LABELS[value] ? value : DEFAULT_CADENCE.mode;
}

function savedCadenceFromState(state) {
  const cadence = state?.data?.targeting?.search_preferences?.cadence;
  if (!cadence || typeof cadence !== "object") return DEFAULT_CADENCE;
  return {
    ...DEFAULT_CADENCE,
    ...cadence,
    mode: normalizeCadenceMode(cadence.mode),
  };
}

function cadenceRecommendation(runState) {
  const recommendation =
    runState?.summary?.cadenceRecommendation || runState?.metadata?.cadenceRecommendation;
  const mode = normalizeCadenceMode(recommendation?.mode);
  if (recommendation?.mode && mode !== DEFAULT_CADENCE.mode) {
    return { mode, from: "history" };
  }
  return { mode: DEFAULT_CADENCE.mode, from: "default" };
}

export function buildCadenceOptions(state, runState) {
  const selected = savedCadenceFromState(state);
  const recommended = cadenceRecommendation(runState);
  return CADENCE_OPTIONS.map((option) => ({
    ...option,
    selected: selected.mode === option.mode,
    recommended: recommended.mode === option.mode,
    recommendationLabel:
      recommended.mode === option.mode
        ? recommended.from === "history"
          ? "Recommended from recent search history"
          : "Default recommendation - no local history yet"
        : "",
  }));
}

function unwrapRun(value) {
  if (!value || typeof value !== "object") return null;
  if (value.run && typeof value.run === "object") return value.run;
  return value;
}

function runFromState(state, localRun = null) {
  return (
    unwrapRun(localRun) ||
    unwrapRun(state?.data?.sourcing?.firstSearchRun) ||
    unwrapRun(state?.data?.firstSearchRun) ||
    unwrapRun(state?.sourcing?.firstSearchRun) ||
    unwrapRun(state?.firstSearchRun)
  );
}

function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function firstSearchCounts(run) {
  const summary = run?.summary || {};
  return {
    sourcesAttempted: numberFrom(
      summary.sourcesAttempted,
      summary.attemptedSources,
      summary.deterministicSources?.attempted
    ),
    rolesFound: numberFrom(summary.rolesFound, summary.new, summary.offerCount),
  };
}

export function buildFirstSearchTask({ state, run } = {}) {
  const searchReady = state?.data?.setup?.readiness?.search_ready === true;
  const currentRun = unwrapRun(run);
  const status = currentRun?.status || "not_started";
  const normalizedStatus = FIRST_SEARCH_STATUS[status] ? status : "not_started";
  const statusMeta = FIRST_SEARCH_STATUS[normalizedStatus];
  const counts = firstSearchCounts(currentRun);
  const runError =
    currentRun?.error?.message ||
    currentRun?.error ||
    currentRun?.failure?.message ||
    currentRun?.summary?.error ||
    "";

  if (normalizedStatus === "running") {
    return {
      status: normalizedStatus,
      label: statusMeta.label,
      badgeClass: statusMeta.badgeClass,
      detail: "Searching deterministic public sources...",
      counts,
      canStart: false,
      canRetry: false,
      canDefer: false,
    };
  }

  if (normalizedStatus === "completed") {
    const zeroResultDetail =
      "Search completed. No matching roles found yet; refine titles or add a source, then search again from Jobs.";
    return {
      status: normalizedStatus,
      label: statusMeta.label,
      badgeClass: statusMeta.badgeClass,
      detail:
        counts.rolesFound > 0
          ? "Search completed. Review sourced roles from Jobs."
          : zeroResultDetail,
      counts,
      canStart: false,
      canRetry: false,
      canDefer: false,
      showSourcedLink: counts.rolesFound > 0,
    };
  }

  if (normalizedStatus === "failed") {
    return {
      status: normalizedStatus,
      label: statusMeta.label,
      badgeClass: statusMeta.badgeClass,
      detail: "First search failed. Review the source setup message, fix the issue, then retry.",
      error: typeof runError === "string" ? runError : "",
      counts,
      canStart: false,
      canRetry: true,
      canDefer: false,
    };
  }

  return {
    status: normalizedStatus,
    label: statusMeta.label,
    badgeClass: statusMeta.badgeClass,
    detail: searchReady
      ? "Complete Search setup, choose a cadence, then start the first deterministic search."
      : "Complete Search setup before starting the first deterministic search.",
    counts,
    canStart: searchReady,
    canRetry: false,
    canDefer: searchReady,
  };
}

function cadencePatch({ mode, existingSearchPreferences = {}, recommendedFrom = "default", now }) {
  return {
    search_preferences: {
      ...existingSearchPreferences,
      cadence: {
        mode: normalizeCadenceMode(mode),
        recommended_from: recommendedFrom === "history" ? "history" : "default",
        saved_at: now(),
      },
    },
  };
}

export async function saveCadencePreference({
  mode,
  existingSearchPreferences = {},
  recommendedFrom = "default",
  saveCandidateFile = defaultSaveCandidateFile,
  now = () => new Date().toISOString(),
} = {}) {
  return saveCandidateFile(
    "targeting",
    cadencePatch({ mode, existingSearchPreferences, recommendedFrom, now })
  );
}

export async function saveCadenceAndStartFirstSearch({
  mode,
  existingSearchPreferences = {},
  recommendedFrom = "default",
  saveCandidateFile = defaultSaveCandidateFile,
  startFirstSearchRun = defaultStartFirstSearchRun,
  setFirstSearchRun,
  now = () => new Date().toISOString(),
} = {}) {
  await saveCadencePreference({
    mode,
    existingSearchPreferences,
    recommendedFrom,
    saveCandidateFile,
    now,
  });
  const result = await startFirstSearchRun();
  const run = unwrapRun(result);
  if (run) setFirstSearchRun?.(run);
  return result;
}

export async function retryFirstSearch({
  startFirstSearchRun = defaultStartFirstSearchRun,
  setFirstSearchRun,
} = {}) {
  const result = await startFirstSearchRun({ retry: true });
  const run = unwrapRun(result);
  if (run) setFirstSearchRun?.(run);
  return result;
}

export function isSourceSetupReady({ state, firstSearchRun } = {}) {
  if (state?.searchSourcesPresent === true) return true;
  const run = unwrapRun(firstSearchRun);
  return run?.status === "running" || run?.status === "completed";
}

// Step 7 — Finish. The app's source setup state is the DB `search-sources`
// row. POST /api/onboard/write-config remains an explicit CLI/debug
// compatibility export for candidate YAML, search-sources.yml, and AGENTS.md.
// The "add your LinkedIn saved search" affordance is deliberately here, after
// source setup exists, so a source added through the DB-backed boards route
// is not overwritten by a later compatibility export. Ends with the explicit
// deeper-onboarding handoff: the wizard and richer evidence intake are separate
// entry points into the same candidate setup state, not one linear flow.
export function FinishStep({ state, reload, goBack }) {
  const dashboard = useDashboardSnapshot();
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(null);
  const [error, setError] = useState(null);
  const [quickStarting, setQuickStarting] = useState(false);
  const [savingCadence, setSavingCadence] = useState(false);
  const [localFirstSearchRun, setLocalFirstSearchRun] = useState(() => runFromState(state));
  const [selectedCadence, setSelectedCadence] = useState(() => savedCadenceFromState(state).mode);
  const [searchChoice, setSearchChoice] = useState("now");

  const [preview, setPreview] = useState(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const compatibilityExported = Array.isArray(written) && written.length > 0;
  const firstSearchRun = runFromState(state, localFirstSearchRun);
  const sourceSetupReady = isSourceSetupReady({ state, firstSearchRun });
  const readinessRows = buildReadinessRows(state);
  const searchReady = readinessRows.find((row) => row.key === "search_ready")?.ready;
  const gateReady = readinessRows.find((row) => row.key === "gate_ready")?.ready;
  const applyReady = readinessRows.find((row) => row.key === "apply_ready")?.ready;
  const quickStartAction = buildQuickStartAction(state);
  const cadenceOptions = buildCadenceOptions(state, firstSearchRun);
  const cadenceRecommendationLabel =
    cadenceOptions.find((option) => option.mode === selectedCadence)?.recommendationLabel ||
    "Default recommendation - no local history yet";
  const firstSearchTask = buildFirstSearchTask({ state, run: firstSearchRun });
  const existingSearchPreferences = state?.data?.targeting?.search_preferences || {};
  const selectedRecommendedFrom =
    cadenceOptions.find((option) => option.mode === selectedCadence)?.recommended === true
      ? cadenceRecommendation(firstSearchRun).from
      : "default";

  useEffect(() => {
    setLocalFirstSearchRun(runFromState(state));
    setSelectedCadence(savedCadenceFromState(state).mode);
  }, [state]);

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
      await refreshWorkspace();
    } catch (err) {
      setError(err?.body?.error || (err instanceof Error ? err.message : "write-config failed"));
    } finally {
      setWriting(false);
    }
  }

  async function handleStartFirstSearch() {
    setQuickStarting(true);
    setError(null);
    try {
      await saveCadenceAndStartFirstSearch({
        mode: selectedCadence,
        existingSearchPreferences,
        recommendedFrom: selectedRecommendedFrom,
        setFirstSearchRun: setLocalFirstSearchRun,
      });
      await refreshWorkspace();
    } catch (err) {
      setError(errorMessage(err, "first search failed"));
    } finally {
      setQuickStarting(false);
    }
  }

  async function handleDeferFirstSearch() {
    setSavingCadence(true);
    setError(null);
    try {
      await saveCadencePreference({
        mode: selectedCadence,
        existingSearchPreferences,
        recommendedFrom: selectedRecommendedFrom,
      });
      setSearchChoice("later");
      await refreshWorkspace();
    } catch (err) {
      setError(errorMessage(err, "Could not save cadence"));
    } finally {
      setSavingCadence(false);
    }
  }

  async function handleRetryFirstSearch() {
    setQuickStarting(true);
    setError(null);
    try {
      await retryFirstSearch({ setFirstSearchRun: setLocalFirstSearchRun });
      await refreshWorkspace();
    } catch (err) {
      setError(errorMessage(err, "Could not retry first search"));
    } finally {
      setQuickStarting(false);
    }
  }

  // Recompute once after DB source setup exists; compatibility exports are
  // intentionally not source-readiness signals.
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

      <Card
        title="First search"
        actions={
          <span className={`badge ${firstSearchTask.badgeClass}`}>{firstSearchTask.label}</span>
        }
      >
        <p>{quickStartAction.detail}</p>
        <div className="chip-row" role="radiogroup" aria-label="Cadence">
          {CADENCE_OPTIONS.map((option) => {
            const active = selectedCadence === option.mode;
            return (
              <label
                className={`chip ${active ? "badge--ok" : ""}`}
                key={option.mode}
                style={{ cursor: firstSearchTask.status === "running" ? "default" : "pointer" }}
              >
                <input
                  type="radio"
                  name="first-search-cadence"
                  checked={active}
                  disabled={firstSearchTask.status === "running"}
                  onChange={() => setSelectedCadence(option.mode)}
                />{" "}
                {option.label}
              </label>
            );
          })}
        </div>
        <p className="field__hint" style={{ margin: "8px 0 0" }}>
          {cadenceRecommendationLabel}
        </p>
        <p className="field__hint" style={{ margin: "4px 0 0" }}>
          Cadence: {CADENCE_LABELS[selectedCadence]}
        </p>
        <div className="chip-row" role="radiogroup" aria-label="Search now?">
          <label className={`chip ${searchChoice === "now" ? "badge--ok" : ""}`}>
            <input
              type="radio"
              name="first-search-choice"
              checked={searchChoice === "now"}
              disabled={!firstSearchTask.canStart || firstSearchTask.status === "running"}
              onChange={() => setSearchChoice("now")}
            />{" "}
            Search now?
          </label>
          <label className={`chip ${searchChoice === "later" ? "badge--muted" : ""}`}>
            <input
              type="radio"
              name="first-search-choice"
              checked={searchChoice === "later"}
              disabled={!firstSearchTask.canDefer || firstSearchTask.status === "running"}
              onChange={() => setSearchChoice("later")}
            />{" "}
            Not now
          </label>
        </div>
        <p className="field__hint" style={{ marginBottom: 0 }}>
          {firstSearchTask.detail}
        </p>
        {firstSearchTask.status === "completed" ? (
          <p className="field__hint">
            {firstSearchTask.counts.sourcesAttempted} sources attempted ·{" "}
            {firstSearchTask.counts.rolesFound} roles found
          </p>
        ) : null}
        {firstSearchTask.error ? <InlineAlert message={firstSearchTask.error} /> : null}
        <div className="links" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {firstSearchTask.canRetry ? (
            <Button onClick={handleRetryFirstSearch} disabled={quickStarting}>
              {quickStarting ? "Retrying…" : "Retry search"}
            </Button>
          ) : firstSearchTask.canStart ? (
            <>
              <Button
                onClick={searchChoice === "later" ? handleDeferFirstSearch : handleStartFirstSearch}
                disabled={quickStarting || savingCadence}
              >
                {quickStarting || savingCadence
                  ? "Saving…"
                  : searchChoice === "later"
                    ? "Not now"
                    : "Search jobs now"}
              </Button>
              {searchChoice === "later" ? (
                <Button
                  variant="secondary"
                  onClick={handleStartFirstSearch}
                  disabled={quickStarting}
                >
                  Search jobs now
                </Button>
              ) : null}
            </>
          ) : null}
          {firstSearchTask.showSourcedLink ? <Link to="/jobs">View sourced roles</Link> : null}
          <Link to="/onboarding">Continue deep onboarding</Link>
        </div>
      </Card>

      <Card title="Finish setup">
        <p>
          Your app source setup is saved in SQLite. Export compatibility files only for CLI/debug
          support.
        </p>
        <Button onClick={handleWriteConfig} disabled={writing}>
          {writing ? "Exporting…" : "Export compatibility files"}
        </Button>
        {compatibilityExported ? (
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
          writing samples — continue through the richer onboarding path when ready.
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
