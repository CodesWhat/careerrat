import { useState } from "react";
import { ChipInput, TextArea, TextField } from "../components/form.jsx";
import { CheckIcon } from "../components/icons.jsx";
import { parseResumeText, removeEvidenceClaim, saveCandidateFile } from "../lib/api.js";
import {
  buildSetupItemViewModels,
  detailLineFor,
  setupProgressFromState,
} from "./onboardingSetup.js";
import { normalizeRoleBuckets, RoleLaneFields } from "./steps/RoleLaneEditor.jsx";

// FilePane — "THE RAT'S FILE" (design 3b/3c). Rows map 1:1 to the 7 setup
// items; done/not-done comes from the server (state.setupProgress — see
// src/cli/onboard-route.mjs's computeSetupProgress), detail lines from
// onboardingSetup.js. Clicking a row with an editor opens it IN PLACE
// (dual drive, design 3c) — a 1.5px cobalt FULL border + EDITING tag, never
// an edge rail (apps/web/tests/design-system-regression.test.js's own
// "no accent border-left/border-right >= 2px" guard is written around this
// exact distinction). Saving calls the same candidate-file endpoints the old
// wizard steps used, then reports the change back through `onFieldSaved` so
// InterviewSurface can post it into the transcript as a system pill the
// assistant acknowledges next turn (server scope item 3 of the W4 spec —
// no new chat-runtime endpoint needed, just a normally-posted message).
export function FilePane({ state, runtime, onReload, onFieldSaved }) {
  const [editingKey, setEditingKey] = useState(null);
  const doneByKey = setupProgressFromState(state);
  const items = buildSetupItemViewModels(doneByKey);

  async function commitPatch({ key, entry, patch, summary }) {
    await saveCandidateFile(entry, patch);
    await onReload?.();
    setEditingKey(null);
    onFieldSaved?.({ key, summary });
  }

  return (
    <aside className="file-pane">
      <div className="file-pane__heading">
        <span className="file-pane__title">THE RAT'S FILE</span>
        <span className="file-pane__subtitle">LIVE · ~/CANDIDATE</span>
      </div>
      {items.map((item) => (
        <FilePaneRow
          key={item.key}
          item={item}
          state={state}
          runtime={runtime}
          editing={editingKey === item.key}
          onOpen={() => setEditingKey(item.key)}
          onClose={() => setEditingKey(null)}
          onCommit={commitPatch}
        />
      ))}
    </aside>
  );
}

const EDITABLE_KEYS = new Set([
  "resume",
  "roles",
  "companies",
  "evidence",
  "guardrails",
  "quickFacts",
]);

function FilePaneRow({ item, state, runtime, editing, onOpen, onClose, onCommit }) {
  const detail = detailLineFor(item.key, { state, runtime });
  const editable = EDITABLE_KEYS.has(item.key);

  if (editing) {
    return (
      <div className="file-pane__row file-pane__row--editing">
        <div className="file-pane__row-head">
          <span className="file-pane__row-title">{item.label}</span>
          <span className="file-pane__editing-tag">EDITING</span>
        </div>
        <RowEditor itemKey={item.key} state={state} onCommit={onCommit} onCancel={onClose} />
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`file-pane__row${item.done ? " file-pane__row--done" : " file-pane__row--pending"}`}
      onClick={editable ? onOpen : undefined}
      disabled={!editable}
    >
      <span className="file-pane__row-check" aria-hidden="true">
        {item.done ? <CheckIcon /> : null}
      </span>
      <span className="file-pane__row-copy">
        <span className="file-pane__row-title">{item.label}</span>
        {detail ? <span className="file-pane__row-detail">{detail}</span> : null}
      </span>
      {editable && item.done ? <span className="file-pane__row-edit-hint">EDIT</span> : null}
      {item.isNext ? <span className="file-pane__row-next">UP NEXT</span> : null}
    </button>
  );
}

function RowEditor({ itemKey, state, onCommit, onCancel }) {
  if (itemKey === "resume")
    return <ResumeRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "roles")
    return <RolesRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "companies")
    return <CompaniesRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "evidence")
    return <EvidenceRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "guardrails")
    return <GuardrailsRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "quickFacts")
    return <QuickFactsRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  return null;
}

function EditorActions({ onCancel, saving, saveLabel = "Save" }) {
  return (
    <div className="file-pane__editor-actions">
      <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
      <button type="submit" className="btn btn--primary" disabled={saving}>
        {saving ? "Saving…" : saveLabel}
      </button>
    </div>
  );
}

function ResumeRowEditor({ onCommit, onCancel }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await parseResumeText(trimmed, { save: true });
      onCommit?.({ key: "resume", entry: null, patch: null, summary: "pasted résumé text" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="file-pane__editor">
      <span className="field__hint">Paste résumé text — or drop a file into the bar below.</span>
      <TextArea value={text} onChange={setText} rows={5} placeholder="Paste résumé text here…" />
      <EditorActions onCancel={onCancel} saving={saving} />
    </form>
  );
}

function RolesRowEditor({ state, onCommit, onCancel }) {
  const [buckets, setBuckets] = useState(() =>
    normalizeRoleBuckets(state?.data?.targeting?.role_buckets ?? [])
  );
  const [saving, setSaving] = useState(false);
  const workingBuckets = buckets.length
    ? buckets
    : [
        {
          name: "Primary",
          priority: "primary",
          titles: [],
          notes: "",
          fit_signals: [],
          down_signals: [],
        },
      ];

  function updateBucket(index, patch) {
    setBuckets((current) => {
      const next = current.length ? [...current] : [...workingBuckets];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onCommit({
        key: "roles",
        entry: "targeting",
        patch: { role_buckets: normalizeRoleBuckets(workingBuckets) },
        summary: `${workingBuckets.length} role lane${workingBuckets.length === 1 ? "" : "s"}`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="file-pane__editor">
      {workingBuckets.map((bucket, index) => (
        <RoleLaneFields
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length small edit list, no stable id
          key={index}
          bucket={bucket}
          index={index}
          idPrefix="onboarding-pane-roles"
          onChange={(patch) => updateBucket(index, patch)}
        />
      ))}
      <EditorActions onCancel={onCancel} saving={saving} />
    </form>
  );
}

function CompaniesRowEditor({ state, onCommit, onCancel }) {
  const [companies, setCompanies] = useState(() => state?.data?.targeting?.tracked_companies ?? []);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onCommit({
        key: "companies",
        entry: "targeting",
        patch: { tracked_companies: companies },
        summary: `${companies.length} tracked compan${companies.length === 1 ? "y" : "ies"}`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="file-pane__editor">
      <span className="field__hint">Companies to watch closely — sweeps prioritize these.</span>
      <ChipInput values={companies} onChange={setCompanies} placeholder="e.g. Stripe" />
      <EditorActions onCancel={onCancel} saving={saving} />
    </form>
  );
}

function GuardrailsRowEditor({ state, onCommit, onCancel }) {
  const [signals, setSignals] = useState(() => state?.data?.targeting?.cut_signals ?? []);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onCommit({
        key: "guardrails",
        entry: "targeting",
        patch: { cut_signals: signals },
        summary: `${signals.length} dealbreaker${signals.length === 1 ? "" : "s"}`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="file-pane__editor">
      <span className="field__hint">Dealbreakers — anything matching one of these gets cut.</span>
      <ChipInput values={signals} onChange={setSignals} placeholder="e.g. Below $200K" />
      <EditorActions onCancel={onCancel} saving={saving} />
    </form>
  );
}

function EvidenceRowEditor({ state, onCommit, onCancel }) {
  const claims = state?.data?.evidence?.claims ?? [];
  const [busyId, setBusyId] = useState(null);

  async function handleRemove(id) {
    setBusyId(id);
    try {
      await removeEvidenceClaim(id);
      await onCommit?.({ key: "evidence", entry: null, patch: null, summary: "removed a claim" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="file-pane__editor">
      <span className="field__hint">
        {claims.length
          ? "Claims pulled from your résumé — remove any that don't fit."
          : "No claims yet."}
      </span>
      <ul className="file-pane__claim-list">
        {claims.map((claim) => (
          <li key={claim.id} className="file-pane__claim-row">
            <span className="file-pane__claim-text">{claim.claim}</span>
            <button
              type="button"
              className="file-pane__claim-remove"
              disabled={busyId === claim.id}
              onClick={() => handleRemove(claim.id)}
              aria-label="Remove claim"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="file-pane__editor-actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          Done
        </button>
      </div>
    </div>
  );
}

function QuickFactsRowEditor({ state, onCommit, onCancel }) {
  const location = state?.data?.profile?.location ?? {};
  const [home, setHome] = useState(location.home || "");
  const [remote, setRemote] = useState(!!location.remote);
  const [hybrid, setHybrid] = useState(!!location.hybrid);
  const [onsite, setOnsite] = useState(!!location.onsite);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onCommit({
        key: "quickFacts",
        entry: "profile",
        patch: { location: { ...location, home, remote, hybrid, onsite } },
        summary: "quick facts",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="file-pane__editor">
      <span className="field__hint">Home base</span>
      <TextField value={home} onChange={setHome} placeholder="City, State" />
      <div className="file-pane__toggle-row">
        <label className="file-pane__toggle">
          <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
          Remote
        </label>
        <label className="file-pane__toggle">
          <input type="checkbox" checked={hybrid} onChange={(e) => setHybrid(e.target.checked)} />
          Hybrid
        </label>
        <label className="file-pane__toggle">
          <input type="checkbox" checked={onsite} onChange={(e) => setOnsite(e.target.checked)} />
          On-site
        </label>
      </div>
      <EditorActions onCancel={onCancel} saving={saving} />
    </form>
  );
}
