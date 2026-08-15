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
import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button, IconButton } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { CompanyAvatar } from "../components/CompanyAvatar.jsx";
import { Field, Select, TextArea, TextField } from "../components/form.jsx";
import { KeyIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  appendCommMessage,
  applyOnSite,
  draftCommunication,
  getApplication,
  getCommunications,
  getJobDescription,
  getPacket,
  markCommSent,
  mergeNestedField,
  promoteSourced,
  recordExternalApplication,
  runPacketGate,
  scheduleInterview,
  setAppFields,
  setAppStatus,
  setSourcedStatus,
} from "../lib/api.js";
import { emitDashboardChanged } from "../lib/dashboard-events.js";
import { resolveErrorCopy } from "../lib/errorCopy.js";
import { safeExternalHttpUrl } from "../lib/safeExternalUrl.js";
import { ArtifactViewerModal } from "./ArtifactViewerModal.jsx";
import { InterviewDossierCard } from "./InterviewDossierCard.jsx";
import { PacketDocumentsCard } from "./PacketDocumentsCard.jsx";
import { PacketGateCard } from "./PacketGateCard.jsx";
import { deriveJobCta } from "./useApplicationGates.js";

const STATUS_OPTIONS = [
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

// jobDetailFromRow's artifact list (dashboard-data.js) uses display labels,
// not the packet-route.mjs artifact `kind` param — map the clickable ones
// back to their GET /api/packet?id= key.
const VIEWABLE_ARTIFACT_KIND_BY_LABEL = { Resume: "resume", "Cover letter": "coverLetter" };

// Statuses that count as "gate passed, not yet applied" (Phase A's
// "Mark applied" one-click primary action) — mirrors sourcedPromote's own
// default post-promotion status (track-outcomes SKILL.md's canonical status
// vocabulary: reviewed-hold = "passed the evaluate-job gate; ready to
// pursue").
const PRE_APPLIED_STATUSES = new Set(["reviewed-hold"]);
const DRAWER_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function trapDrawerTab({ dialog, event, activeElement }) {
  if (!dialog || event?.key !== "Tab") return;
  const focusable = Array.from(dialog.querySelectorAll(DRAWER_FOCUSABLE)).filter(
    (element) => element.getAttribute?.("aria-hidden") !== "true"
  );
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const outside = typeof dialog.contains === "function" && !dialog.contains(activeElement);
  if (event.shiftKey && (activeElement === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

export function handleDrawerKeyDown({ event, viewerOpen, onClose, dialog, activeElement }) {
  if (viewerOpen) return;
  if (event?.key === "Escape") onClose();
  else trapDrawerTab({ dialog, event, activeElement });
}

// Threads a real retry callback through a resolveErrorCopy() result — the
// resolved `action` carries {label, retry: true} with no callback of its
// own, so every catch below that wants the "Try again" button to actually do
// something supplies the exact call that just failed.
function withRetryAction(resolved, onRetry) {
  return resolved.action?.retry
    ? { ...resolved, action: { ...resolved.action, onRetry } }
    : resolved;
}

function toDatetimeLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function applyOnSiteNotice(response) {
  const messages = (response?.data || response)?.messages || [];
  const last = messages[messages.length - 1];
  if (last?.metadata?.state === "applied" && last?.metadata?.submissionVerified === true) {
    return "Application submitted and verified.";
  }
  const questionCapture = last?.artifacts?.find(
    (artifact) => artifact.kind === "application_handoff"
  )?.questionCapture;
  const capturedCount = Number(questionCapture?.answerableCount) || 0;
  const questionNote =
    questionCapture?.state === "captured"
      ? ` Saved ${capturedCount} application question${capturedCount === 1 ? "" : "s"} for packet generation.`
      : questionCapture?.state === "site-required"
        ? " Use Ask to paste the employer questions when the site shows them."
        : "";
  return `Application site is ready.${questionNote} Nothing was marked Applied yet.`;
}

function applicationHandoffUrl(response) {
  const messages = (response?.data || response)?.messages || [];
  const last = messages[messages.length - 1];
  return safeExternalHttpUrl(
    last?.artifacts?.find((artifact) => artifact.kind === "application_handoff")?.url
  );
}

export function JobDrawer({ row, onClose, initialSection }) {
  const { refetch } = useDashboardSnapshot();
  const [app, setApp] = useState(null);
  const [comms, setComms] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [handoffUrl, setHandoffUrl] = useState(null);
  const [sourcedResolved, setSourcedResolved] = useState(false);
  const [viewer, setViewer] = useState(null); // {title, artifact} | null
  const [jdHint, setJdHint] = useState(null);
  const [jdMeta, setJdMeta] = useState(null); // {completeness} | null
  const drawerRef = useRef(null);
  const viewerOpenRef = useRef(false);
  const rowIdentity = `${row.source}:${row.id}`;
  const activeRowIdentityRef = useRef(rowIdentity);
  activeRowIdentityRef.current = rowIdentity;
  viewerOpenRef.current = Boolean(viewer);

  const isApplication = row.source === "application";

  async function loadRaw(expectedRowId = row.id, expectedRowIdentity = rowIdentity) {
    if (!isApplication) return;
    const [appRes, commsRes] = await Promise.all([
      getApplication(expectedRowId),
      getCommunications(),
    ]);
    if (activeRowIdentityRef.current !== expectedRowIdentity) return;
    setApp(appRes.data);
    setComms((commsRes.data || []).filter((c) => c.applicationId === expectedRowId));
  }

  // loadRaw is a plain closure over the row identity (already covered below), not
  // a stable reference — adding it to the array would re-fire this
  // reset-and-fetch effect on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRaw closes over row.id, already covered below
  useEffect(() => {
    let cancelled = false;
    setApp(null);
    setComms([]);
    setLoadError(null);
    setActionError(null);
    setNotice(null);
    setHandoffUrl(null);
    setBusyKey(null);
    setSourcedResolved(false);
    setJdHint(null);
    setJdMeta(null);
    if (!isApplication) return undefined;
    function retryLoad() {
      if (cancelled) return;
      setLoadError(null);
      loadRaw().catch((err) => {
        if (!cancelled) setLoadError(withRetryAction(resolveErrorCopy(err), retryLoad));
      });
    }
    (async () => {
      try {
        const [appRes, commsRes] = await Promise.all([getApplication(row.id), getCommunications()]);
        if (cancelled) return;
        setApp(appRes.data);
        setComms((commsRes.data || []).filter((c) => c.applicationId === row.id));
      } catch (err) {
        if (!cancelled) {
          setLoadError(withRetryAction(resolveErrorCopy(err), retryLoad));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.id, isApplication]);

  // Treat the drawer as a real modal: focus it on open, keep Tab navigation
  // inside it, close on Escape, then restore focus to the opener on cleanup.
  useEffect(() => {
    const dialog = drawerRef.current;
    const previouslyFocused = document.activeElement;
    dialog?.focus();
    function onKeyDown(e) {
      handleDrawerKeyDown({
        event: e,
        viewerOpen: viewerOpenRef.current,
        onClose,
        dialog,
        activeElement: document.activeElement,
      });
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus?.();
    };
  }, [onClose]);

  // Deep-link support for the Phase D "next-step" CTA (Pipeline-tab rows and
  // this drawer's own header): JobsPage passes the target section through
  // `initialSection` (?section= in the URL), and the CTA click handler below
  // re-uses this same scroll for an already-open drawer.
  const scrollToSection = useCallback((section) => {
    if (!section) return;
    document
      .getElementById(`drawer-section-${section}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    if (!initialSection) return;
    const timer = setTimeout(() => scrollToSection(initialSection), 0);
    return () => clearTimeout(timer);
  }, [initialSection, scrollToSection]);

  // Phase C item 8 — the existing (read-only) Artifacts card's Resume/Cover
  // letter chips open the same rendered view PacketDocumentsCard's chips do.
  async function handleViewArtifact(label) {
    const kind = VIEWABLE_ARTIFACT_KIND_BY_LABEL[label];
    if (!kind) return;
    setActionError(null);
    try {
      const packet = await getPacket(row.id);
      const artifact = packet?.artifacts?.[kind];
      if (!artifact) {
        setActionError({
          message: `${label} isn't available to preview yet.`,
          action: null,
          detail: null,
        });
        return;
      }
      setViewer({ title: `${label}: preview`, artifact });
    } catch (err) {
      setActionError(withRetryAction(resolveErrorCopy(err), () => handleViewArtifact(label)));
    }
  }

  // ISSUE-035 — the Artifacts card's Job description row opens the same
  // ArtifactViewerModal via GET /api/jobs/job-description (readJobDescriptionArtifact),
  // already shaped for the modal's `artifact.html` branch. JD_NOT_CAPTURED/
  // JD_FILE_MISSING are expected "nothing captured yet" states surfaced as an
  // inline hint next to the row, never the top-level actionError banner;
  // JD_TOO_LARGE/UNSAFE_ARTIFACT_PATH are defensive edge cases that fall back
  // to that generic banner instead.
  async function handleViewJobDescription() {
    setActionError(null);
    setJdHint(null);
    try {
      const res = await getJobDescription({ source: row.source, id: row.id });
      const artifact = res?.data?.artifact;
      setJdMeta(artifact ? { completeness: artifact.completeness } : null);
      setViewer({ title: "Job description: preview", artifact });
    } catch (err) {
      const code = err?.body?.code;
      if (code === "JD_NOT_CAPTURED" || code === "JD_FILE_MISSING") {
        setJdHint("No job description was captured for this role.");
      } else {
        setActionError(withRetryAction(resolveErrorCopy(err), handleViewJobDescription));
      }
    }
  }

  async function runWrite(key, fn, successNote) {
    const requestedRowId = row.id;
    const requestedRowIdentity = rowIdentity;
    const isCurrentRow = () => activeRowIdentityRef.current === requestedRowIdentity;
    setBusyKey(key);
    setActionError(null);
    try {
      const result = await fn();
      if (!isCurrentRow()) return;
      if (!isApplication && (key === "skip" || key === "promote")) setSourcedResolved(true);
      if (key === "apply-on-site") setHandoffUrl(applicationHandoffUrl(result));
      emitDashboardChanged();
      await refetch();
      if (!isCurrentRow()) return;
      await loadRaw(requestedRowId, requestedRowIdentity);
      if (!isCurrentRow()) return;
      if (successNote) {
        setNotice(typeof successNote === "function" ? successNote(result) : successNote);
      }
    } catch (err) {
      if (isCurrentRow()) {
        setActionError(
          withRetryAction(resolveErrorCopy(err), () => runWrite(key, fn, successNote))
        );
      }
    } finally {
      if (isCurrentRow()) setBusyKey(null);
    }
  }

  const drawer = row.drawer || {};
  const postingUrl = safeExternalHttpUrl(drawer.link);
  const sourcedActionable =
    !isApplication &&
    !sourcedResolved &&
    !row.terminal &&
    !["cut", "skipped", "dismissed", "ignored", "withdrawn"].includes(
      String(row.status || "").toLowerCase()
    );
  // Phase D's single derived next-step CTA — pure derivation from row/gate
  // state (no stored CTA field), so it self-clears once its condition no
  // longer holds (AGENTS.md's "completed-action clears its CTA" invariant).
  const evaluation = app?.evaluation || app?.packetGate || null;
  const drawerCta = deriveJobCta(row, evaluation);

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop; Escape (above) is the keyboard equivalent */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop; Escape (above) is the keyboard equivalent */}
      <div className="job-drawer-overlay" onClick={onClose}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's click-to-close from firing; not itself an interactive control */}
        <div
          ref={drawerRef}
          className="job-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={`${row.company}, ${row.role}`}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <IconButton label="Close" className="job-drawer__close" onClick={onClose}>
            ×
          </IconButton>

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
          {postingUrl ? (
            <a className="job-drawer__link" href={postingUrl} target="_blank" rel="noreferrer">
              View posting
            </a>
          ) : null}
          {drawer.warn ? <InlineAlert tone="error" message={drawer.warn} /> : null}
          {isApplication && drawerCta ? (
            <Button
              variant="secondary"
              className="job-drawer__cta"
              onClick={() => scrollToSection(drawerCta.section)}
            >
              {drawerCta.label}
            </Button>
          ) : null}

          {loadError ? (
            <InlineAlert
              message={loadError.message}
              action={loadError.action}
              detail={loadError.detail}
            />
          ) : null}
          {actionError ? (
            <InlineAlert
              message={actionError.message}
              action={actionError.action}
              detail={actionError.detail}
            />
          ) : null}
          {notice ? <p className="field__hint">{notice}</p> : null}
          {handoffUrl ? (
            <a className="job-drawer__link" href={handoffUrl} target="_blank" rel="noreferrer">
              Open application site
            </a>
          ) : null}

          {/* Evaluate (Phase B) — explicit-click packet gate, only meaningful once a
            role has been promoted into applications[] (packet gate is
            applicationId-keyed; sourced rows don't have one yet). */}
          {isApplication ? (
            <div id="drawer-section-evaluate">
              <PacketGateCard
                verdict={evaluation}
                busy={busyKey === "evaluate"}
                onEvaluate={() =>
                  runWrite(
                    "evaluate",
                    async () => {
                      await runPacketGate({ applicationId: row.id });
                    },
                    "Evaluated."
                  )
                }
              />
            </div>
          ) : null}

          {/* Documents (Phase C) — generate/export, explicit-click only. */}
          {isApplication ? (
            <div id="drawer-section-documents">
              <PacketDocumentsCard
                applicationId={row.id}
                gate={evaluation?.gate}
                onView={({ title, artifact }) => setViewer({ title, artifact })}
              />
            </div>
          ) : null}

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

          {/* Interview prep dossier (ISSUE-030) — build/read only, always shown for
            an application row; the backend (buildInterviewDossier) is the source of
            truth on whether prep is meaningful yet, so this never re-derives its own
            "is there really an interview scheduled" gate client-side. */}
          {isApplication ? <InterviewDossierCard applicationId={row.id} /> : null}

          {/* 3. Ready-to-send panel */}
          {isApplication ? (
            <ReadyToSendCard
              comms={comms}
              busyKey={busyKey}
              onSend={(commId) =>
                runWrite(`send-${commId}`, () => markCommSent({ id: commId }), "Recorded as sent.")
              }
            />
          ) : null}

          {/* Follow-up complete */}
          {isApplication && app?.followUp?.dueAt ? (
            <Card title="Follow-up">
              <p>
                {app.followUp.note || app.followUp.title || app.followUp.kind || "Follow-up due"}
              </p>
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
              onDraft={(commId) =>
                runWrite(
                  `draft-${commId}`,
                  () => draftCommunication({ id: commId }),
                  "Draft ready to review below."
                )
              }
            />
          ) : null}

          {/* 6. Signals & learnings */}
          {drawer.learnings?.length ? (
            <Card title="Signals & learnings">
              <ul className="job-drawer__list">
                {drawer.learnings.map((learning, i) => {
                  const label =
                    typeof learning === "string" ? learning : String(learning?.label || "");
                  const note =
                    typeof learning === "object" && learning ? String(learning.note || "") : "";
                  return (
                    // learnings have no stable persisted id.
                    // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
                    <li key={i}>
                      {label ? <strong>{label}</strong> : null}
                      {label && note ? ": " : null}
                      {note}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}

          {/* 7. Artifacts */}
          {drawer.artifacts?.length ? (
            <Card title="Artifacts">
              <ul className="job-drawer__list">
                {drawer.artifacts.map((a, i) => {
                  // a.path only ever exists for a real captured JD (dashboard-data.js's
                  // jobDetailFromRow) — the "source link only" fallback row never has one,
                  // so it stays plain text below.
                  const isViewableJd = a.kind === "Job description" && a.path;
                  return (
                    // artifacts is a small fixed-shape list with no stable id.
                    // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
                    <li key={i}>
                      <strong>{a.kind}:</strong>{" "}
                      {isViewableJd ? (
                        <>
                          {a.note}{" "}
                          <button
                            type="button"
                            className="job-drawer__link-button"
                            onClick={handleViewJobDescription}
                          >
                            View
                          </button>
                          {jdMeta?.completeness === "partial" ? (
                            <span className="badge badge--muted">Partial capture</span>
                          ) : null}
                          {jdHint ? <p className="field__hint">{jdHint}</p> : null}
                        </>
                      ) : VIEWABLE_ARTIFACT_KIND_BY_LABEL[a.kind] ? (
                        <button
                          type="button"
                          className="job-drawer__link-button"
                          onClick={() => handleViewArtifact(a.kind)}
                        >
                          {a.note}
                        </button>
                      ) : (
                        a.note
                      )}
                    </li>
                  );
                })}
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
          <div id="drawer-section-status">
            <Card title="Status">
              {isApplication ? (
                <>
                  {PRE_APPLIED_STATUSES.has(app?.status || row.status) ? (
                    <div className="job-drawer__inline-actions">
                      <Button
                        disabled={busyKey === "apply-on-site"}
                        onClick={() =>
                          runWrite(
                            "apply-on-site",
                            () => applyOnSite({ id: row.id }),
                            applyOnSiteNotice
                          )
                        }
                      >
                        {busyKey === "apply-on-site" ? "Applying…" : "Apply on site"}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busyKey === "record-external"}
                        onClick={() =>
                          runWrite(
                            "record-external",
                            () => recordExternalApplication({ id: row.id }),
                            "Recorded your external application."
                          )
                        }
                      >
                        {busyKey === "record-external" ? "Recording…" : "I applied elsewhere"}
                      </Button>
                    </div>
                  ) : null}
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
                </>
              ) : sourcedActionable ? (
                <>
                  <p className="field__hint">
                    This role is still in Sourced. Promote it to the active pipeline, or skip it.
                  </p>
                  <div className="job-drawer__inline-actions">
                    <Button
                      disabled={busyKey === "promote"}
                      onClick={() =>
                        runWrite(
                          "promote",
                          () => promoteSourced({ id: row.id }),
                          "Promoted to pipeline."
                        )
                      }
                    >
                      {busyKey === "promote" ? "Promoting…" : "Promote to pipeline"}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busyKey === "skip"}
                      onClick={() =>
                        runWrite(
                          "skip",
                          () => setSourcedStatus({ id: row.id, to: "cut" }),
                          "Skipped."
                        )
                      }
                    >
                      {busyKey === "skip" ? "Skipping…" : "Skip"}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="field__hint">
                  This sourced role is already skipped or resolved. Its Promote and Skip actions are
                  no longer available.
                </p>
              )}
            </Card>
          </div>
        </div>
      </div>
      <ArtifactViewerModal
        title={viewer?.title}
        artifact={viewer?.artifact}
        onClose={() => setViewer(null)}
      />
    </>
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
            {busyKey === `send-${c.id}` ? "Recording…" : "I sent this"}
          </Button>
        </div>
      ))}
    </Card>
  );
}

function toCompNumber(value) {
  // Number(null) is 0 (finite) — an absent value must stay null so the pin
  // renders "Needs info" instead of a fabricated $0K.
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatCompNumber(value) {
  const number = toCompNumber(value);
  return number == null ? "Needs info" : `$${Math.round(number)}K`;
}

function compBarBadge(drawer, state) {
  if (state === "built") {
    const parts = ["Built from data"];
    if (drawer.compSampleSize) {
      parts.push(`${drawer.compSampleSize} comp${drawer.compSampleSize === 1 ? "" : "s"}`);
    }
    if (drawer.compConfidence) parts.push(`${drawer.compConfidence} conf`);
    if (drawer.compAsOf) parts.push(`as of ${drawer.compAsOf}`);
    return parts.join(" · ");
  }
  if (state === "posted") return "Posted band";
  if (state === "needs-info") return "Needs more info";
  return drawer.compStateLabel || "";
}

function hasCompBarFields(drawer) {
  return [
    "floor",
    "ask",
    "marketLo",
    "marketP50",
    "marketHi",
    "compState",
    "compStateLabel",
    "compBasis",
    "compConfidence",
    "compSampleSize",
    "compAsOf",
  ].some((key) => drawer[key] != null && drawer[key] !== "");
}

function CompBar({ drawer }) {
  if (!hasCompBarFields(drawer)) return null;

  const floorValue = toCompNumber(drawer.floor);
  const askValue = toCompNumber(drawer.ask);
  const marketP50 = toCompNumber(drawer.marketP50);
  const hasMarket = drawer.compHasMarket !== false && marketP50 != null;
  const marketLo = hasMarket ? (toCompNumber(drawer.marketLo) ?? marketP50) : null;
  const marketHi = hasMarket ? (toCompNumber(drawer.marketHi) ?? marketP50) : null;
  const state = drawer.compState || (hasMarket ? "posted" : "needs-info");

  // The gauge scale is anchored off whatever real numbers are actually
  // present — never a fabricated placeholder floor/ask. When nothing anchors
  // the scale (no floor, no ask, no market), skip the track entirely and
  // fall back to the pins row, which already renders its own "Needs info"
  // state per pin.
  const anchors = [floorValue, askValue, marketLo, marketHi].filter((value) => value != null);
  const hasScale = anchors.length > 0;
  const lo = hasScale ? Math.min(...anchors) - 10 : 0;
  const hi = hasScale ? Math.max(...anchors) + 10 : 1;
  const range = hi - lo || 1;
  const pct = (value) => `${Math.max(0, Math.min(100, ((value - lo) / range) * 100)).toFixed(1)}%`;

  return (
    <div className="job-drawer__comp-bar" data-state={state}>
      <div className="job-drawer__comp-provenance">
        <span>{compBarBadge(drawer, state)}</span>
        {drawer.compBasis ? <small>{drawer.compBasis}</small> : null}
      </div>
      {hasScale ? (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: decorative range visualization, not a form control group
        <div aria-label="Compensation range" className="job-drawer__comp-track">
          {hasMarket ? (
            <>
              <span
                className="job-drawer__comp-market"
                style={{
                  left: pct(marketLo),
                  width: `${Math.max(0, ((marketHi - marketLo) / range) * 100).toFixed(1)}%`,
                }}
              />
              <span className="job-drawer__comp-p50" style={{ left: pct(marketP50) }} />
            </>
          ) : null}
          {askValue != null ? (
            <span className="job-drawer__comp-marker" style={{ left: pct(askValue) }} />
          ) : null}
        </div>
      ) : null}
      <div className="job-drawer__comp-pins">
        <CompPin label="Floor" value={floorValue} />
        <CompPin label="Mkt P50" value={hasMarket ? marketP50 : null} />
        <CompPin label="Your ask" value={askValue} />
        <CompPin label="Ceiling" value={hasMarket ? marketHi : null} />
      </div>
    </div>
  );
}

function CompPin({ label, value }) {
  return (
    <span className="job-drawer__comp-pin">
      <span>{label}</span>
      <strong>{formatCompNumber(value)}</strong>
    </span>
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
      <CompBar drawer={drawer} />
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

// ISSUE-038 — communication.capture-inbound (the only verb that CREATES a
// new communication row) requires an already-confirmed recruiter-email
// intake item; it isn't a "type text, hit save" form field. The real entry
// point for "Add thread" is therefore the same docked-AskBar paste-capture
// path ISSUE-016's Network empty state uses — paste a recruiter/hiring-team
// message there and intake classification + confirm does the rest. This is
// a deliberately duplicated two-line querySelector, not a shared helper: see
// ISSUE-016/ISSUE-038's overlap note (a shared lib/AskBar helper would force
// those two lanes to serialize on the same files for no real benefit).
function focusAskBar() {
  document.querySelector(".ask-bar__input")?.focus();
}

// Exported (unlike the drawer's other private sub-components) so
// JobDrawer.test.jsx can render these two directly with its hooks harness —
// the top-level JobDrawer render tree never invokes local function
// components while building its element tree (see that test file's own
// convention), so exercising CommThread's "Draft reply" click and
// CommsThreadCard's zero-thread CTA needs a direct call.
export function CommsThreadCard({ comms, busyKey, onAddNote, onDraft }) {
  if (!comms.length) {
    return (
      <Card title="Communications">
        <p className="field__hint">
          No communication threads yet. Paste a recruiter or hiring-team message into the ask bar to
          capture it here.
        </p>
        <Button variant="secondary" onClick={focusAskBar}>
          Paste a message
        </Button>
      </Card>
    );
  }
  return (
    <Card title="Communications">
      {comms.map((c) => (
        <CommThread key={c.id} comm={c} busyKey={busyKey} onAddNote={onAddNote} onDraft={onDraft} />
      ))}
    </Card>
  );
}

export function CommThread({ comm, busyKey, onAddNote, onDraft }) {
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
      {/* AI-drafts a reply and persists it as comm.draft — ReadyToSendCard above
        already renders any draft this produces (it just checks c.draft.subject/
        body), so there's no separate display path to wire here. Deliberately no
        send/deliver button anywhere in this drawer: communication.send needs a
        consented delivery executor that isn't connected yet (see the "I sent
        this" affordance on ReadyToSendCard for the honest "record it sent
        yourself" path). */}
      <div className="job-drawer__inline-actions">
        <Button
          variant="secondary"
          disabled={busyKey === `draft-${comm.id}`}
          onClick={() => onDraft(comm.id)}
        >
          {busyKey === `draft-${comm.id}` ? "Drafting…" : "Draft reply"}
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
    STATUS_OPTIONS.some((o) => o.value === currentStatus) ? currentStatus : "screen"
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
