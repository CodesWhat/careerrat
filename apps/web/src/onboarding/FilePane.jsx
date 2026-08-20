import { useState } from "react";
import { ChipInput, NumberField, TextArea, TextField } from "../components/form.jsx";
import { CheckIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { parseResumeText, removeEvidenceClaim, saveCandidateFile } from "../lib/api.js";
import {
  buildSetupItemViewModels,
  detailLineFor,
  locationModePreferencesConfirmed,
  setupProgressFromState,
} from "./onboardingSetup.js";
import { flattenPatchLeaves } from "./patchFields.js";
import { normalizeRoleBuckets, RoleLaneFields } from "./steps/RoleLaneEditor.jsx";

// FilePane — Paul's live notes (design 3b/3c; Paul is the mascot). Rows map 1:1 to the 7 setup
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
export function FilePane({
  state,
  runtime,
  onReload,
  onFieldSaved,
  pendingBlocks = [],
  companyProposals = [],
  onDecideCompanyProposal,
  processingResumeName = null,
}) {
  const [editingKey, setEditingKey] = useState(null);
  const [overridingKey, setOverridingKey] = useState(null);
  const doneByKey = setupProgressFromState(state);
  const items = buildSetupItemViewModels(doneByKey);

  async function commitPatch({ key, entry, patch, summary }) {
    // `entry: null` is the established bypass an editor uses when it already
    // made its own API call(s) directly (ResumeRowEditor/EvidenceRowEditor,
    // and now AuthorizationRowEditor's decline path) — skip the generic
    // save rather than calling saveCandidateFile(null, patch).
    if (entry) await saveCandidateFile(entry, patch);
    await onReload?.();
    setEditingKey(null);
    onFieldSaved?.({ key, summary });
  }

  // Lane A / R6 — clears a recorded decline (declined_fields.<key> = null)
  // and opens that row's editor so the user can answer now.
  async function handleOverrideDecline(key) {
    setOverridingKey(key);
    try {
      await saveCandidateFile("form-defaults", { declined_fields: { [key]: null } });
      await onReload?.();
      setEditingKey(key);
    } finally {
      setOverridingKey(null);
    }
  }

  return (
    <aside className="file-pane">
      <div className="file-pane__heading">
        <span className="file-pane__title">PAUL'S NOTES</span>
        <span className="file-pane__subtitle">UPDATES AS YOU TALK</span>
      </div>
      <PendingNotes blocks={pendingBlocks} />
      {processingResumeName ? <ResumeReadingState fileName={processingResumeName} /> : null}
      <CandidateSnapshot
        state={state}
        hasPending={pendingBlocks.length > 0}
        hideEmpty={!!processingResumeName}
      />
      {items.map((item) => (
        <FilePaneRow
          key={item.key}
          item={item}
          state={state}
          runtime={runtime}
          editing={editingKey === item.key}
          overridingKey={overridingKey}
          onOpen={() => setEditingKey(item.key)}
          onClose={() => setEditingKey(null)}
          onCommit={commitPatch}
          onOverrideDecline={handleOverrideDecline}
          companyProposals={companyProposals}
          onDecideCompanyProposal={onDecideCompanyProposal}
        />
      ))}
    </aside>
  );
}

function ResumeReadingState({ fileName }) {
  return (
    <section className="file-pane__resume-reading" role="status" aria-live="polite">
      <span className="file-pane__resume-reading-label">READING RÉSUMÉ</span>
      <strong>{fileName}</strong>
      <span>Your profile will fill in as Paul reads it.</span>
    </section>
  );
}

function pendingAuthorizationValue(patch) {
  const authorization = patch?.work_authorized === true ? "Authorized" : "Not authorized";
  const sponsorship = patch?.requires_sponsorship ? "Sponsorship needed" : "No sponsorship needed";
  return `${authorization} · ${sponsorship}`;
}

function pendingLeafValue(leaf) {
  const numeric = Number(leaf.value);
  if (/base|salary|compensation/i.test(leaf.label) && Number.isFinite(numeric) && numeric >= 1000) {
    return `$${numeric.toLocaleString("en-US")}`;
  }
  return leaf.value;
}

function pendingNoteEntries(blocks) {
  const entries = [];
  for (const block of blocks) {
    if (!block || block.hidden || block.status === "resolved") continue;
    if (block.kind === "candidate_patch") {
      for (const leaf of flattenPatchLeaves(block.payload?.patch)) {
        if (leaf.value) entries.push({ label: leaf.label, value: pendingLeafValue(leaf) });
      }
    } else if (block.kind === "authorization") {
      entries.push({ label: "Work authorization", value: pendingAuthorizationValue(block.patch) });
    } else if (block.kind === "company_add" && block.payload?.name) {
      entries.push({ label: "Company", value: block.payload.name });
    } else if (block.kind === "evidence_claim" && block.payload?.claim) {
      entries.push({ label: "Evidence", value: block.payload.claim });
    }
  }
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.label}\u0000${entry.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function PendingNotes({ blocks }) {
  const entries = pendingNoteEntries(blocks);
  if (!entries.length) return null;
  return (
    <section className="file-pane__pending" aria-label="Details awaiting confirmation">
      <span className="file-pane__pending-title">WAITING FOR YOUR CONFIRMATION</span>
      <dl className="file-pane__pending-list">
        {entries.map((entry) => (
          <div className="file-pane__pending-item" key={`${entry.label}-${entry.value}`}>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CandidateSnapshot({ state, hasPending = false, hideEmpty = false }) {
  const profile = state?.data?.profile ?? {};
  const candidate = profile.candidate ?? {};
  const location = candidate.location || profile.location?.home;
  const facts = [candidate.email, candidate.phone, location].filter(Boolean);
  const links = [
    ["LinkedIn", candidate.linkedin],
    ["GitHub", candidate.github],
    ["Portfolio", candidate.portfolio],
  ]
    .map(([label, href]) => [label, safeProfileHref(href)])
    .filter(([, href]) => href);
  const hasDetails = !!(candidate.full_name || candidate.headline || facts.length || links.length);

  if (!hasDetails) {
    if (hideEmpty) return null;
    return (
      <div className="file-pane__candidate file-pane__candidate--empty">
        {hasPending
          ? "Confirm these notes to add them to your saved profile."
          : "Your details will fill in here as you talk to Paul."}
      </div>
    );
  }

  return (
    <section className="file-pane__candidate" aria-label="Candidate profile">
      {candidate.full_name ? (
        <strong className="file-pane__candidate-name">{candidate.full_name}</strong>
      ) : null}
      {candidate.headline ? (
        <span className="file-pane__candidate-headline">{candidate.headline}</span>
      ) : null}
      {facts.length ? (
        <div className="file-pane__candidate-facts">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
      ) : null}
      {links.length ? (
        <div className="file-pane__candidate-links">
          {links.map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer">
              {label}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function safeProfileHref(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const EDITABLE_KEYS = new Set([
  "resume",
  "roles",
  "companies",
  "evidence",
  "guardrails",
  "quickFacts",
  "authorization",
]);

// Lane A / R6 — the setup item that can be recorded as declined (never
// re-asked) instead of answered.
const DECLINABLE_KEYS = new Set(["authorization"]);

function FilePaneRow({
  item,
  state,
  runtime,
  editing,
  overridingKey,
  onOpen,
  onClose,
  onCommit,
  onOverrideDecline,
  companyProposals,
  onDecideCompanyProposal,
}) {
  const detail = detailLineFor(item.key, { state, runtime });
  const editable = EDITABLE_KEYS.has(item.key);
  const declinedFields = state?.data?.["form-defaults"]?.declined_fields || {};
  const declined = DECLINABLE_KEYS.has(item.key) && !!declinedFields[item.key];

  if (editing) {
    return (
      <div className="file-pane__row file-pane__row--editing">
        <div className="file-pane__row-head">
          <span className="file-pane__row-title">{item.label}</span>
          <span className="file-pane__editing-tag">EDITING</span>
        </div>
        <RowEditor
          itemKey={item.key}
          state={state}
          onCommit={onCommit}
          onCancel={onClose}
          companyProposals={companyProposals}
          onDecideCompanyProposal={onDecideCompanyProposal}
        />
      </div>
    );
  }

  // Lane A / R6 — a declined field replaces the normal pending/done row
  // entirely until the user explicitly overrides it. Never shows UP NEXT or
  // an EDIT hint — there's nothing pending to click into.
  if (declined) {
    return (
      <div className="file-pane__row file-pane__row--declined">
        <span className="file-pane__row-copy">
          <span className="file-pane__row-title">{item.label}</span>
          <span className="file-pane__row-detail">Declined, won't ask again</span>
        </span>
        <button
          type="button"
          className="file-pane__row-override"
          onClick={() => onOverrideDecline(item.key)}
          disabled={overridingKey === item.key}
        >
          {overridingKey === item.key ? "…" : "Answer now"}
        </button>
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

function RowEditor({
  itemKey,
  state,
  onCommit,
  onCancel,
  companyProposals,
  onDecideCompanyProposal,
}) {
  if (itemKey === "resume")
    return <ResumeRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "roles")
    return <RolesRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "companies")
    return (
      <CompaniesRowEditor
        state={state}
        onCommit={onCommit}
        onCancel={onCancel}
        companyProposals={companyProposals}
        onDecideCompanyProposal={onDecideCompanyProposal}
      />
    );
  if (itemKey === "evidence")
    return <EvidenceRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "guardrails")
    return <GuardrailsRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "quickFacts")
    return <QuickFactsRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
  if (itemKey === "authorization")
    return <AuthorizationRowEditor state={state} onCommit={onCommit} onCancel={onCancel} />;
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

function ResumeRowEditor({ state, onCommit, onCancel }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const claimCount = state?.data?.evidence?.claims?.length ?? 0;

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
      {state?.sourceResumePresent ? (
        <span className="file-pane__resume-status">
          Uploaded résumé parsed into your profile and {claimCount} evidence claim
          {claimCount === 1 ? "" : "s"}.
        </span>
      ) : null}
      <span className="field__hint">
        {state?.sourceResumePresent
          ? "Paste new text to replace the uploaded résumé."
          : "Paste résumé text, or attach a file in the bar below."}
      </span>
      <TextArea
        value={text}
        onChange={setText}
        rows={5}
        placeholder={
          state?.sourceResumePresent
            ? "Paste replacement résumé text here…"
            : "Paste résumé text here…"
        }
      />
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

  // Server-side, normalizeSearchTracks (src/core/db/verbs/candidate.mjs)
  // silently drops any lane with no titles — no error, the lane just
  // vanishes. Block that here instead so the user sees why the lane
  // didn't save (ISSUE-006). Same check SettingsPage's roleLanesInvalid
  // uses for the same reason (ISSUE-022).
  const roleLanesInvalid = workingBuckets.some((bucket) => !bucket.titles?.length);

  async function handleSubmit(e) {
    e.preventDefault();
    if (roleLanesInvalid) return;
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
      {roleLanesInvalid ? (
        <InlineAlert message="Add at least one complete role lane with a job title." />
      ) : null}
      <EditorActions onCancel={onCancel} saving={saving} />
    </form>
  );
}

function CompaniesRowEditor({
  state,
  onCommit,
  onCancel,
  companyProposals = [],
  onDecideCompanyProposal,
}) {
  const [companies, setCompanies] = useState(
    () => state?.data?.targeting?.company_preferences?.examples ?? []
  );
  const [saving, setSaving] = useState(false);
  const [decidingId, setDecidingId] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onCommit({
        key: "companies",
        entry: "targeting",
        patch: { company_preferences: { confirmed: true, examples: companies } },
        summary: `${companies.length} focus example${companies.length === 1 ? "" : "s"} · broad discovery on`,
      });
    } finally {
      setSaving(false);
    }
  }

  // Lane A / R2 — accept unions the proposed name into tracked_companies via
  // onDecideCompanyProposal (InterviewSurface owns the union write + the
  // decision call together, since a decision needs the batch's current
  // {batchId, proposalId, expectedVersion} triple this editor doesn't
  // track). Never edits the local `companies` chip list directly — that
  // list only reflects THIS form's own unsaved edits.
  async function handleDecide(proposal, action) {
    setDecidingId(proposal.proposalId);
    try {
      await onDecideCompanyProposal?.(proposal, action);
    } finally {
      setDecidingId(null);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="file-pane__editor">
      <span className="field__hint">
        Focus examples guide discovery. CareerRat still searches beyond them.
      </span>
      <ChipInput values={companies} onChange={setCompanies} placeholder="e.g. Stripe" />
      {companyProposals.length ? (
        <>
          <span className="field__hint">Suggested: accept to add, reject to dismiss.</span>
          <ul className="file-pane__proposal-list">
            {companyProposals.map((proposal) => (
              <li key={proposal.proposalId} className="file-pane__proposal-row">
                <span className="file-pane__proposal-name">{proposal.name}</span>
                <span className="file-pane__proposal-actions">
                  <button
                    type="button"
                    className="file-pane__proposal-accept"
                    disabled={decidingId === proposal.proposalId}
                    onClick={() => handleDecide(proposal, "approve-supported-ats")}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="file-pane__proposal-reject"
                    disabled={decidingId === proposal.proposalId}
                    onClick={() => handleDecide(proposal, "reject")}
                  >
                    Reject
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
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
      <span className="field__hint">Dealbreakers: anything matching one of these gets cut.</span>
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
          ? "Claims pulled from your résumé. Remove any that don't fit."
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
  const savedMinimumBase = Number(state?.data?.profile?.compensation?.minimum_base);
  const [home, setHome] = useState(location.home || "");
  const [remote, setRemote] = useState(
    locationModePreferencesConfirmed(state) && !!location.remote
  );
  const [hybrid, setHybrid] = useState(!!location.hybrid);
  const [onsite, setOnsite] = useState(!!location.onsite);
  const [minimumBase, setMinimumBase] = useState(
    Number.isFinite(savedMinimumBase) && savedMinimumBase > 0 ? savedMinimumBase : null
  );
  const [validationError, setValidationError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!Number.isFinite(Number(minimumBase)) || Number(minimumBase) <= 0) {
      setValidationError("Add the lowest base salary you would accept.");
      return;
    }
    setSaving(true);
    try {
      await onCommit({
        key: "quickFacts",
        entry: "profile",
        // No `...location` spread — the server's deepMerge already merges
        // this partial location object onto the existing doc, preserving
        // any field this editor doesn't own (relocation, travel_tolerance).
        // `remote` is included only when the candidate actually touched the
        // toggle, so an untouched ambient default never gets written back
        // as a confirmed answer.
        patch: {
          location: {
            home,
            remote,
            hybrid,
            onsite,
            mode_preferences_confirmed: true,
          },
          compensation: { minimum_base: Number(minimumBase) },
        },
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
      <span className="field__hint">
        Minimum base salary: your walk-away number, not your current pay.
      </span>
      <NumberField
        value={minimumBase}
        onChange={(value) => {
          setMinimumBase(value);
          if (Number(value) > 0) setValidationError("");
        }}
        min={1000}
        step={1000}
        placeholder="e.g. 160000"
        aria-label="Minimum base salary"
      />
      {validationError ? <span className="field__error">{validationError}</span> : null}
      <EditorActions onCancel={onCancel} saving={saving} />
    </form>
  );
}

// Lane A / R3, R6 — authorization row. A save where both toggles are off is
// itself an explicit "no/no" answer, so it also records the decline
// (declined_fields.authorization) alongside the profile write in the SAME
// submit — otherwise candidate.mjs's authorizationDeclared() (day-1 DB
// defaults already seed false/false) could never tell "answered no" apart
// from "never asked" without this procedural write. "Decline to answer"
// records the decline with no profile write at all — the field stays
// whatever it was, just never re-asked.
function AuthorizationRowEditor({ state, onCommit, onCancel }) {
  const auth = state?.data?.profile?.authorization ?? {};
  const [workAuthorized, setWorkAuthorized] = useState(!!auth.work_authorized);
  const [requiresSponsorship, setRequiresSponsorship] = useState(!!auth.requires_sponsorship);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await saveCandidateFile("profile", {
        authorization: {
          work_authorized: workAuthorized,
          requires_sponsorship: requiresSponsorship,
        },
      });
      if (!workAuthorized && !requiresSponsorship) {
        await saveCandidateFile("form-defaults", {
          declined_fields: { authorization: { declined_at: new Date().toISOString() } },
        });
      }
      await onCommit({
        key: "authorization",
        entry: null,
        patch: null,
        summary: workAuthorized ? "authorized" : "not authorized",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDecline() {
    setSaving(true);
    try {
      await saveCandidateFile("form-defaults", {
        declined_fields: { authorization: { declined_at: new Date().toISOString() } },
      });
      await onCommit({ key: "authorization", entry: null, patch: null, summary: "declined" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="file-pane__editor">
      <span className="field__hint">Work authorization for the roles you're targeting.</span>
      <div className="file-pane__toggle-row">
        <label className="file-pane__toggle">
          <input
            type="checkbox"
            checked={workAuthorized}
            onChange={(e) => setWorkAuthorized(e.target.checked)}
          />
          Authorized to work
        </label>
        <label className="file-pane__toggle">
          <input
            type="checkbox"
            checked={requiresSponsorship}
            onChange={(e) => setRequiresSponsorship(e.target.checked)}
          />
          Needs sponsorship
        </label>
      </div>
      <div className="file-pane__editor-actions">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={handleDecline}
          disabled={saving}
        >
          Decline to answer
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
