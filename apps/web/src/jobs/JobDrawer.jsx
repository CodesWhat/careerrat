// apps/web/src/jobs/JobDrawer.jsx — the M10 Jobs drawer: the 9-section
// content cut from the Tracker Content Register (AGENTS.md:311-369 / the M10
// design doc §3), built fresh (no reusable Drawer component existed in
// apps/web before this). `row` is one entry from dashboardData.jobs.rows —
// already the server-derived shape (dashboard-data.js's jobDetailFromRow, at
// row.drawer) for every READ-ONLY field below. Fields that need a
// read-modify-write (followUp, roleFit-shaped writes) instead fetch the RAW
// application row (getApplication) because appSetFields is a shallow
// one-level merge (verbs/app.mjs) — patching a nested object from anything
// less than its full current shape silently drops sibling keys.
import { useEffect, useState } from "react";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { CompanyAvatar } from "../components/CompanyAvatar.jsx";
import { Field, Select, TextArea, TextField } from "../components/form.jsx";
import { KeyIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  appendCommMessage,
  getApplication,
  getCommunications,
  markCommSent,
  mergeNestedField,
  promoteSourced,
  scheduleInterview,
  setAppFields,
  setAppStatus,
} from "../lib/api.js";
import { emitDashboardChanged } from "../lib/dashboard-events.js";

const STATUS_OPTIONS = [
  { value: "applied", label: "Applied" },
  { value: "screen", label: "Screen" },
  { value: "interview", label: "Interview" },
  { value: "onsite", label: "Onsite" },
  { value: "final", label: "Final" },
  { value: "offer", label: "Offer" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "withdrawn", label: "Withdrawn" },
];

// The canonical Round Vocabulary (AGENTS.md "Round Vocabulary (hard)") — the
// exact `conversations[].kind` strings the dashboard's stage classifier
// expects, never a numbered "Round 2".
const ROUND_OPTIONS = [
  { value: "recruiter screen", label: "Screen" },
  { value: "assessment", label: "Assessment" },
  { value: "technical", label: "Technical" },
  { value: "hiring manager", label: "Hiring manager" },
  { value: "onsite", label: "Onsite" },
  { value: "final", label: "Final" },
  { value: "offer", label: "Offer" },
];

function toDatetimeLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function JobDrawer({ row, onClose }) {
  const { refetch } = useDashboardSnapshot();
  const [app, setApp] = useState(null);
  const [comms, setComms] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);

  const isApplication = row.source === "application";

  async function loadRaw() {
    if (!isApplication) return;
    const [appRes, commsRes] = await Promise.all([getApplication(row.id), getCommunications()]);
    setApp(appRes.data);
    setComms((commsRes.data || []).filter((c) => c.applicationId === row.id));
  }

  useEffect(() => {
    let cancelled = false;
    setApp(null);
    setComms([]);
    setLoadError(null);
    setActionError(null);
    setNotice(null);
    if (!isApplication) return undefined;
    (async () => {
      try {
        const [appRes, commsRes] = await Promise.all([getApplication(row.id), getCommunications()]);
        if (cancelled) return;
        setApp(appRes.data);
        setComms((commsRes.data || []).filter((c) => c.applicationId === row.id));
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load application details");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.id, isApplication]);

  // Escape closes the drawer — the real keyboard equivalent of the
  // click-to-close overlay/backdrop below (which stays mouse-only, same as
  // CaptureBar.jsx's drag/drop wrapper: the drawer's own real controls,
  // the × button included, are each independently keyboard-operable).
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function runWrite(key, fn, successNote) {
    setBusyKey(key);
    setActionError(null);
    try {
      await fn();
      emitDashboardChanged();
      await Promise.all([refetch(), loadRaw()]);
      if (successNote) setNotice(successNote);
    } catch (err) {
      setActionError(err?.body?.error || (err instanceof Error ? err.message : `${key} failed`));
    } finally {
      setBusyKey(null);
    }
  }

  const drawer = row.drawer || {};

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop; Escape (above) is the keyboard equivalent
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop; Escape (above) is the keyboard equivalent
    <div className="job-drawer-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's click-to-close from firing; not itself an interactive control */}
      <div
        className="job-drawer"
        role="dialog"
        aria-label={`${row.company} — ${row.role}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="job-drawer__close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {/* 1. Header */}
        <div className="job-drawer__header">
          <CompanyAvatar name={row.company} domain={row.domain} size={40} />
          <div className="job-drawer__header-text">
            <h2 className="job-drawer__company">{row.company}</h2>
            <p className="job-drawer__role">{row.role}</p>
          </div>
          <span className="badge badge--muted">{drawer.stage || row.stageLabel}</span>
        </div>
        {row.statusNote ? <p className="field__hint">{row.statusNote}</p> : null}
        {drawer.link ? (
          <a className="job-drawer__link" href={drawer.link} target="_blank" rel="noreferrer">
            View posting
          </a>
        ) : null}
        {drawer.warn ? <InlineAlert tone="error" message={drawer.warn} /> : null}

        {loadError ? <InlineAlert message={loadError} /> : null}
        {actionError ? <InlineAlert message={actionError} /> : null}
        {notice ? <p className="field__hint">{notice}</p> : null}

        {/* 2. Interview panel */}
        {drawer.interview && (drawer.interview.chips?.length || drawer.interview.detail) ? (
          <Card title="Interview">
            {drawer.interview.chips?.length ? (
              <div className="chip-row">
                {drawer.interview.chips.map((c) => (
                  <span className="chip" key={c.label}>
                    <span className="field__label">{c.label}:</span>&nbsp;{c.value}
                  </span>
                ))}
              </div>
            ) : null}
            {drawer.interview.detail ? <p>{drawer.interview.detail}</p> : null}
          </Card>
        ) : null}

        {isApplication ? (
          <ScheduleInterviewCard
            app={app}
            busy={busyKey === "schedule"}
            onSchedule={(payload) =>
              runWrite(
                "schedule",
                () => scheduleInterview({ id: row.id, ...payload }),
                "Interview saved."
              )
            }
          />
        ) : null}

        {/* 3. Ready-to-send panel */}
        {isApplication ? (
          <ReadyToSendCard
            comms={comms}
            busyKey={busyKey}
            onSend={(commId) =>
              runWrite(`send-${commId}`, () => markCommSent({ id: commId }), "Marked sent.")
            }
          />
        ) : null}

        {/* Follow-up complete */}
        {isApplication && app?.followUp?.dueAt ? (
          <Card title="Follow-up">
            <p>{app.followUp.note || app.followUp.title || app.followUp.kind || "Follow-up due"}</p>
            <p className="field__hint">Due {app.followUp.dueAt}</p>
            <Button
              variant="secondary"
              disabled={busyKey === "followup"}
              onClick={() =>
                runWrite(
                  "followup",
                  () =>
                    setAppFields({
                      id: row.id,
                      patch: {
                        followUp: mergeNestedField(app, "followUp", { dueAt: null, draft: null }),
                      },
                    }),
                  "Follow-up marked done."
                )
              }
            >
              {busyKey === "followup" ? "Saving…" : "Mark follow-up done"}
            </Button>
          </Card>
        ) : null}

        {/* 4. Comp & Fit */}
        <CompFitCard
          row={row}
          drawer={drawer}
          app={app}
          isApplication={isApplication}
          busy={busyKey === "compNote"}
          onSaveCompNote={(value) =>
            runWrite(
              "compNote",
              () => setAppFields({ id: row.id, patch: { compNote: value } }),
              "Comp note saved."
            )
          }
        />

        {/* 5. Communications thread */}
        {isApplication ? (
          <CommsThreadCard
            comms={comms}
            busyKey={busyKey}
            onAddNote={(commId, text) =>
              runWrite(
                `note-${commId}`,
                () =>
                  appendCommMessage({
                    id: commId,
                    message: { direction: "note", summary: text, at: new Date().toISOString() },
                  }),
                "Note added."
              )
            }
          />
        ) : null}

        {/* 6. Signals & learnings */}
        {drawer.learnings?.length ? (
          <Card title="Signals & learnings">
            <ul className="job-drawer__list">
              {drawer.learnings.map((l, i) => (
                // learnings is a flat string list with no stable id.
                // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
                <li key={i}>{l}</li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* 7. Artifacts */}
        {drawer.artifacts?.length ? (
          <Card title="Artifacts">
            <ul className="job-drawer__list">
              {drawer.artifacts.map((a, i) => (
                // artifacts is a small fixed-shape list with no stable id.
                // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
                <li key={i}>
                  <strong>{a.kind}:</strong> {a.note}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* Notes */}
        {isApplication ? (
          <NotesCard
            app={app}
            busyKey={busyKey}
            onSave={(field, value) =>
              runWrite(
                field,
                () => setAppFields({ id: row.id, patch: { [field]: value } }),
                "Saved."
              )
            }
          />
        ) : null}

        {/* 8. Per-app activity timeline */}
        {drawer.timeline?.length ? (
          <Card title="Timeline">
            <ul className="job-drawer__timeline">
              {drawer.timeline.map((t, i) => (
                // timeline entries have no stable id (derived, re-ordered display list).
                // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
                <li key={i} className="job-drawer__timeline-item">
                  <span className="job-drawer__timeline-icon">
                    <KeyIcon iconKey={t.icon} />
                  </span>
                  <span>
                    <span className="job-drawer__timeline-title">{t.title}</span>
                    <span className="job-drawer__timeline-at">{t.at}</span>
                    {t.desc ? <span className="job-drawer__timeline-desc">{t.desc}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* 9. Status control */}
        <Card title="Status">
          {isApplication ? (
            <StatusControl
              currentStatus={app?.status || row.status}
              busy={busyKey === "status"}
              onSave={(to, note) =>
                runWrite(
                  "status",
                  () => setAppStatus({ id: row.id, to, note: note || undefined }),
                  "Status updated."
                )
              }
            />
          ) : (
            <>
              <p className="field__hint">
                This role is still in Sourced — gate it before promoting it into the active
                pipeline.
              </p>
              <Button
                disabled={busyKey === "promote"}
                onClick={() =>
                  runWrite("promote", () => promoteSourced({ id: row.id }), "Promoted to pipeline.")
                }
              >
                {busyKey === "promote" ? "Promoting…" : "Gate this role → promote to pipeline"}
              </Button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function ScheduleInterviewCard({ app, busy, onSchedule }) {
  const [at, setAt] = useState(toDatetimeLocal(app?.interviewAt) || "");
  const [round, setRound] = useState("recruiter screen");
  const [note, setNote] = useState("");

  useEffect(() => {
    setAt(toDatetimeLocal(app?.interviewAt) || "");
  }, [app?.interviewAt]);

  return (
    <Card title="Schedule / update interview">
      <div className="field-row">
        <Field label="Date & time" htmlFor="drawer-interview-at">
          <TextField id="drawer-interview-at" type="datetime-local" value={at} onChange={setAt} />
        </Field>
        <Field label="Round" htmlFor="drawer-interview-round">
          <Select
            id="drawer-interview-round"
            value={round}
            onChange={setRound}
            options={ROUND_OPTIONS}
          />
        </Field>
      </div>
      <Field label="Note (optional, ≤60 chars)" htmlFor="drawer-interview-note">
        <TextArea
          id="drawer-interview-note"
          rows={2}
          value={note}
          onChange={(v) => setNote(v.slice(0, 60))}
        />
      </Field>
      <Button
        variant="secondary"
        disabled={busy || !at}
        onClick={() => {
          if (!at) return;
          onSchedule({ at: new Date(at).toISOString(), round, note: note || undefined });
        }}
      >
        {busy ? "Saving…" : "Save interview"}
      </Button>
    </Card>
  );
}

function ReadyToSendCard({ comms, busyKey, onSend }) {
  const active = comms.filter(
    (c) => c.draft && (c.draft.subject || c.draft.body) && !["waiting", "closed"].includes(c.status)
  );
  if (!active.length) return null;
  return (
    <Card title="Ready to send">
      {active.map((c) => (
        <div className="job-drawer__draft" key={c.id}>
          {c.draft.subject ? <p className="job-drawer__draft-subject">{c.draft.subject}</p> : null}
          {c.draft.body ? <p className="job-drawer__draft-body">{c.draft.body}</p> : null}
          <Button disabled={busyKey === `send-${c.id}`} onClick={() => onSend(c.id)}>
            {busyKey === `send-${c.id}` ? "Marking sent…" : "Mark sent"}
          </Button>
        </div>
      ))}
    </Card>
  );
}

function CompFitCard({ row, drawer, app, isApplication, busy, onSaveCompNote }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(app?.compNote || drawer.compNote || "");

  useEffect(() => {
    setValue(app?.compNote || drawer.compNote || "");
  }, [app?.compNote, drawer.compNote]);

  return (
    <Card title="Comp & fit">
      <p className="field__hint">
        {row.compSummary || drawer.base || "No comp posted."}
        {drawer.compBasis ? ` · ${drawer.compBasis}` : ""}
      </p>
      {drawer.roleFit?.why?.length ? (
        <div>
          <span className="field__label">Why it fits</span>
          <ul className="job-drawer__list">
            {drawer.roleFit.why.map((w, i) => (
              // roleFit.why is a flat ≤3-item string list, no stable id.
              // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {drawer.roleFit?.risks?.length ? (
        <div>
          <span className="field__label">Risks</span>
          <ul className="job-drawer__list">
            {drawer.roleFit.risks.map((r, i) => (
              // roleFit.risks is a flat ≤3-item string list, no stable id.
              // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {isApplication ? (
        editing ? (
          <>
            <TextArea rows={2} value={value} onChange={(v) => setValue(v.slice(0, 140))} />
            <div className="job-drawer__inline-actions">
              <Button
                disabled={busy}
                onClick={() => {
                  onSaveCompNote(value);
                  setEditing(false);
                }}
              >
                {busy ? "Saving…" : "Save comp note"}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {value ? "Edit comp note" : "Add comp note"}
          </Button>
        )
      ) : null}
    </Card>
  );
}

function CommsThreadCard({ comms, busyKey, onAddNote }) {
  if (!comms.length) {
    return (
      <Card title="Communications">
        <p className="field__hint">No communication threads yet.</p>
      </Card>
    );
  }
  return (
    <Card title="Communications">
      {comms.map((c) => (
        <CommThread key={c.id} comm={c} busyKey={busyKey} onAddNote={onAddNote} />
      ))}
    </Card>
  );
}

function CommThread({ comm, busyKey, onAddNote }) {
  const [note, setNote] = useState("");
  const messages = comm.messages || [];
  return (
    <div className="job-drawer__thread">
      <p className="job-drawer__thread-subject">{comm.subject || comm.company}</p>
      <ul className="job-drawer__list">
        {messages.map((m, i) => (
          // thread messages render in order with no reordering; index is stable
          // for this render's lifetime and the list has no stable message id
          // guaranteed by the schema.
          // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
          <li key={i}>
            <span className="field__label">{m.direction}:</span> {m.summary || m.subject}
          </li>
        ))}
      </ul>
      <div className="job-drawer__inline-actions">
        <TextField
          id={`thread-note-${comm.id}`}
          placeholder="Add a note to this thread…"
          value={note}
          onChange={setNote}
        />
        <Button
          variant="secondary"
          disabled={busyKey === `note-${comm.id}` || !note.trim()}
          onClick={() => {
            onAddNote(comm.id, note.trim());
            setNote("");
          }}
        >
          {busyKey === `note-${comm.id}` ? "Adding…" : "Add note"}
        </Button>
      </div>
    </div>
  );
}

function NotesCard({ app, busyKey, onSave }) {
  const fields = [
    { key: "statusNote", label: "Status note (≤120 chars)", max: 120 },
    { key: "interviewNote", label: "Interview note (≤60 chars)", max: 60 },
    { key: "note", label: "Internal note (search only, ≤60 chars)", max: 60 },
  ];
  return (
    <Card title="Notes">
      {fields.map((f) => (
        <NoteField
          key={f.key}
          field={f.key}
          label={f.label}
          max={f.max}
          initial={app?.[f.key] || ""}
          busy={busyKey === f.key}
          onSave={onSave}
        />
      ))}
    </Card>
  );
}

function NoteField({ field, label, max, initial, busy, onSave }) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  return (
    <Field label={label} htmlFor={`note-${field}`}>
      <div className="job-drawer__inline-actions">
        <TextField
          id={`note-${field}`}
          value={value}
          maxLength={max}
          onChange={(v) => setValue(v.slice(0, max))}
        />
        <Button variant="secondary" disabled={busy} onClick={() => onSave(field, value)}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </Field>
  );
}

function StatusControl({ currentStatus, busy, onSave }) {
  const [to, setTo] = useState(
    STATUS_OPTIONS.some((o) => o.value === currentStatus) ? currentStatus : "applied"
  );
  const [note, setNote] = useState("");
  return (
    <>
      <div className="field-row">
        <Field label="New status" htmlFor="drawer-status">
          <Select id="drawer-status" value={to} onChange={setTo} options={STATUS_OPTIONS} />
        </Field>
      </div>
      <Field label="Note (optional)" htmlFor="drawer-status-note">
        <TextArea id="drawer-status-note" rows={2} value={note} onChange={setNote} />
      </Field>
      <Button disabled={busy} onClick={() => onSave(to, note)}>
        {busy ? "Saving…" : "Update status"}
      </Button>
    </>
  );
}
