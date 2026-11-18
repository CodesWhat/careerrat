// The submit gate for the terminal (agent-driven) apply path.
//
// The browser app's apply driver decides whether to press the final Submit from
// inside its own fill loop. An agent that fills the form itself has no such
// loop, so `careerrat apply submit <job-id>` calls runApplySubmit() instead:
// it reads the live form from the session browser, runs the same gates, and
// either presses Submit once or refuses with a machine-readable reason and
// hands the job to the person. The agent never presses Submit itself.
//
// evaluateSubmitGate() is pure (snapshot + application facts in, verdict out).
// It reuses the driver's own snapshot primitives so "required field", "required
// upload" and "positively labelled submit control" mean the same thing here.
import { loadAutomation, loadSubmitMode } from "../automation/consent.mjs";
import { resolveSession } from "../automation/session.mjs";
import { dbExists, openDb } from "../db/connection.mjs";
import {
  appMarkSubmitAttempt,
  appSetFields,
  appSetStatus,
  statusProvesApplicationWasSubmitted,
} from "../db/verbs/app.mjs";
import { getRow } from "../db/verbs/shared.mjs";
import { openAnswerNeedsFromGaps } from "../packet/answer-needs.mjs";
import { applicationPacketGatePasses } from "../packet/generate-operation.mjs";
import { classifyStage, isKnownStatusLabel } from "../tracker/dashboard.mjs";
import { renderedFieldsFromSnapshot, unrecognizedRequiredUploads } from "./apply-driver.mjs";
import { throwIfAborted } from "./cancellation.mjs";
import {
  confirmationCheck,
  findSubmitButtonRef,
  hostnameToPortal,
  snapshotHasAttestation,
  submitGuard,
} from "./form-fill.mjs";
import { employerApplyLink, isLinkedInUrl } from "./linkedin-link.mjs";
import { createOrcaOps, runOrcaCommand } from "./orca-ops.mjs";

const FIELD_ROLES = new Set([
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "radiogroup",
  "spinbutton",
]);

function refusal(code, message, items) {
  return { code, message, ...(items?.length ? { items } : {}) };
}

function httpOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function postingOrigins(application) {
  const origins = new Set();
  for (const field of ["applyUrl", "externalApplyUrl", "link", "url", "sourceUrl"]) {
    const origin = httpOrigin(application?.[field]);
    if (origin && !isLinkedInUrl(origin)) origins.add(origin);
  }
  const employer = httpOrigin(employerApplyLink(application));
  if (employer) origins.add(employer);
  return origins;
}

// Required controls that are still blank, using the same read the driver makes
// of the final snapshot: a required field whose live state is known and empty,
// plus any visible field with no label (it can't be matched, so it can't be
// called complete). Required controls whose live state can't be read come back
// separately as `unverified`: unknown is not the same as confirmed blank, and
// it is never treated as filled.
function requiredFieldState(snapshot) {
  const blanks = [];
  const unverified = [];
  for (const field of renderedFieldsFromSnapshot(snapshot)) {
    if (!field.required) continue;
    const entry = snapshot?.refs?.[field.ref] || {};
    if (entry.fileInput === true || entry.disabled === true || entry.decorative === true) continue;
    if (field.stateKnown !== true) {
      unverified.push({
        label: field.label,
        reason: "The live answer in this required field couldn't be verified.",
      });
      continue;
    }
    if (String(field.value || "").trim()) continue;
    blanks.push({ label: field.label, reason: "The required field is blank in the live form." });
  }
  let unlabeled = 0;
  for (const entry of Object.values(snapshot?.refs || {})) {
    const role = String(entry?.role || "").toLowerCase();
    if (!FIELD_ROLES.has(role) || entry?.field === false || entry?.disabled === true) continue;
    if (entry?.decorative === true || String(entry?.name || "").trim()) continue;
    unlabeled += 1;
    blanks.push({
      label: `Unlabeled field ${unlabeled}`,
      reason: "This field has no label, so it can't be checked.",
    });
  }
  return { blanks, unverified };
}

function isClosedStatus(status) {
  return isKnownStatusLabel(status) && classifyStage(status).id === "withdrawn";
}

// An application that is already submitted or closed out must never be handed
// back to the person as "finish and press Submit".
function submissionState(application) {
  if (application?.submitAttemptedAt || statusProvesApplicationWasSubmitted(application?.status)) {
    return "submitted";
  }
  if (isClosedStatus(application?.status)) return "closed";
  return null;
}

// Every required file input that is not confirmed attached, recognized kind or not.
function missingRequiredUploads(snapshot) {
  const missing = [];
  for (const [ref, entry] of Object.entries(snapshot?.refs || {})) {
    if (entry?.fileInput !== true || entry.disabled === true || entry.fileAttached === true) {
      continue;
    }
    if (entry.required !== true) continue;
    missing.push({ label: String(entry.name || "").trim() || "A required file upload", ref });
  }
  for (const item of unrecognizedRequiredUploads(snapshot)) {
    if (!missing.some((seen) => seen.ref === item.ref)) {
      missing.push({ label: item.label, ref: item.ref });
    }
  }
  return missing.map(({ label }) => ({ label, reason: "This required upload is not attached." }));
}

/**
 * Pure verdict. Returns { ok, submitRef, submitLabel, refusals[] }.
 * Every refusal that applies is reported, not just the first.
 */
export function evaluateSubmitGate({ snapshot, application, submitMode } = {}) {
  const refusals = [];
  const origin = httpOrigin(snapshot?.origin);
  const postingUrl = application?.link || application?.url || application?.sourceUrl || "";

  if (submitMode === "manual") {
    refusals.push(
      refusal(
        "MANUAL_SUBMIT_MODE",
        "Submit mode is manual (careerrat automation submit manual). The person presses Submit."
      )
    );
  }
  if (
    isLinkedInUrl(snapshot?.origin) ||
    (!employerApplyLink(application) && isLinkedInUrl(postingUrl))
  ) {
    refusals.push(
      refusal(
        "LINKEDIN_NEVER_AUTO_SUBMIT",
        "CareerRat never submits an application through LinkedIn. The person applies there."
      )
    );
  }
  const state = submissionState(application);
  if (state === "submitted") {
    refusals.push(
      refusal(
        "ALREADY_SUBMITTED",
        application?.submitAttemptedAt
          ? "Submit was already pressed once for this application. CareerRat won't press it again; check the site."
          : `This application is already past submission (status: ${application.status}). CareerRat won't press Submit again.`
      )
    );
  } else if (state === "closed") {
    refusals.push(
      refusal(
        "APPLICATION_CLOSED",
        `This application is closed (status: ${application.status}). CareerRat won't submit it.`
      )
    );
  }
  if (!applicationPacketGatePasses(application)) {
    refusals.push(
      refusal(
        "GATE_NOT_CLEARED",
        "This application has no KEEP verdict (or approved REVIEW) on record."
      )
    );
  }
  const needs = openAnswerNeedsFromGaps(application?.packetManifest?.gaps);
  if (needs.length) {
    refusals.push(
      refusal(
        "ANSWER_NEEDED",
        needs.length === 1
          ? "1 application question still needs your answer."
          : `${needs.length} application questions still need your answer.`,
        needs.map((need) => ({ label: need.question }))
      )
    );
  }
  if (!origin || !snapshot?.refs) {
    refusals.push(
      refusal("SESSION_UNREACHABLE", "Couldn't read an application page in the session browser.")
    );
  } else if (
    !isLinkedInUrl(origin) &&
    !postingOrigins(application).has(origin) &&
    !hostnameToPortal(origin)
  ) {
    refusals.push(
      refusal(
        "UNTRUSTED_ORIGIN",
        `The page is on ${origin}, which isn't the posting's site or a known application site.`
      )
    );
  }

  const guard = submitGuard({
    pageText: snapshot?.pageText,
    pageSignals: { attestation: snapshotHasAttestation(snapshot) },
  });
  if (guard.blockers.length) {
    refusals.push(
      refusal(
        "HUMAN_CHALLENGE",
        "The page shows a captcha, verification, attestation or other step a person has to handle.",
        guard.blockers.map((label) => ({ label }))
      )
    );
  }
  const { blanks, unverified } = snapshot?.refs
    ? requiredFieldState(snapshot)
    : { blanks: [], unverified: [] };
  if (blanks.length) {
    refusals.push(
      refusal(
        "REQUIRED_FIELDS_BLANK",
        blanks.length === 1
          ? "1 required field is still blank."
          : `${blanks.length} required fields are still blank.`,
        blanks
      )
    );
  }
  if (unverified.length) {
    refusals.push(
      refusal(
        "REQUIRED_FIELDS_UNVERIFIED",
        unverified.length === 1
          ? "1 required field's live answer couldn't be verified."
          : `${unverified.length} required fields' live answers couldn't be verified.`,
        unverified
      )
    );
  }
  const uploads = snapshot?.refs ? missingRequiredUploads(snapshot) : [];
  if (uploads.length) {
    refusals.push(refusal("UPLOAD_MISSING", "A required upload isn't attached.", uploads));
  }
  const submitRef = snapshot?.refs ? findSubmitButtonRef(snapshot) : null;
  if (snapshot?.refs && !submitRef) {
    refusals.push(
      refusal(
        "NO_SUBMIT_BUTTON",
        "Couldn't find exactly one positively labelled Submit application button."
      )
    );
  }
  return {
    ok: refusals.length === 0,
    submitRef: refusals.length === 0 ? submitRef : null,
    submitLabel: submitRef ? String(snapshot.refs[submitRef]?.name || "Submit").trim() : null,
    refusals,
  };
}

function handoffText(refusals) {
  return refusals
    .map((item) =>
      item.items?.length
        ? `${item.message} (${item.items.map((entry) => entry.label).join("; ")})`
        : item.message
    )
    .join(" ");
}

// Hands the job to the person: manual-apply status plus a note and next action
// naming what's missing. A row that is already submitted or closed keeps its
// status, interview fields and next action untouched and is not handed over.
function handToPerson({ repoRoot, env, id, application, refusals }) {
  const state = submissionState(application);
  if (state) {
    if (
      application?.submitAttemptedAt &&
      !statusProvesApplicationWasSubmitted(application?.status)
    ) {
      // Marker only (status still pre-submission): point at the site, leave status alone.
      appSetFields({
        repoRoot,
        env,
        id,
        patch: {
          statusNote: `manual-apply: ${handoffText(refusals)}`.slice(0, 500),
          nextAction:
            "Check the application on the site, then record it as Applied if it went through",
        },
      });
    }
    return { status: application?.status || null, handedToPerson: false };
  }
  const text = handoffText(refusals);
  const note = `manual-apply: ${text}`.slice(0, 500);
  appSetStatus({ repoRoot, env, id, to: "manual-apply", note: note.slice(0, 200) });
  appSetFields({
    repoRoot,
    env,
    id,
    patch: {
      statusNote: note,
      nextAction: "Finish the application in the browser and press Submit yourself",
    },
  });
  return { status: "manual-apply", handedToPerson: true };
}

function defaultOps({ repoRoot, env }) {
  let provider = "extension";
  try {
    provider = resolveSession({
      data: loadAutomation({ root: repoRoot, env }).data,
      repoRoot,
      env,
    }).provider;
  } catch {
    provider = "extension";
  }
  if (provider !== "orca") {
    return {
      provider,
      error:
        provider === "playwright"
          ? "The app-owned Playwright browser can't be reached from a separate CLI process, so CareerRat can't check or press Submit in it."
          : "The extension session browser is driven by the agent only; CareerRat can't reach that page from the CLI.",
    };
  }
  return {
    provider,
    ops: createOrcaOps({
      runOrcaImpl: (args, { signal } = {}) => runOrcaCommand(args, { env, cwd: repoRoot, signal }),
    }),
  };
}

const CONFIRMATION_POLLS = 6;
const CONFIRMATION_DELAY_MS = 1000;

/**
 * Inspect the live form for `id` and press Submit only if every gate passes.
 * Returns { ok, state, ... }. Never throws for a gate failure; a refusal is a
 * normal result and has already been recorded on the job.
 */
export async function runApplySubmit({
  repoRoot,
  env = process.env,
  id,
  pageId,
  opsImpl,
  loadSubmitModeImpl = loadSubmitMode,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
} = {}) {
  if (!id) throw new Error("apply submit: a job id is required");
  if (!dbExists({ repoRoot, env })) {
    throw new Error(
      "apply submit: this workspace has no database yet. Run careerrat ingest first."
    );
  }
  const application = getRow(openDb({ repoRoot, env }), "applications", id);
  if (!application) throw new Error(`apply submit: no application with id "${id}"`);

  let submitMode = "manual";
  try {
    submitMode = loadSubmitModeImpl({ root: repoRoot, env });
  } catch {
    // An unreadable setting must never read as auto.
    submitMode = "manual";
  }

  const resolved = opsImpl ? { ops: opsImpl, provider: "injected" } : defaultOps({ repoRoot, env });
  let snapshot = null;
  let sessionError = resolved.error || null;
  if (resolved.ops) {
    if (!pageId) {
      sessionError =
        "Pass the session browser page id with --page so CareerRat reads the form you filled.";
    } else {
      try {
        snapshot = await resolved.ops.snapshot({ pageId, signal });
      } catch (error) {
        throwIfAborted(signal);
        sessionError = `Couldn't read the page: ${String(error?.message || error).slice(0, 200)}`;
      }
    }
  }

  const verdict = evaluateSubmitGate({ snapshot, application, submitMode });
  if (sessionError) {
    const first = verdict.refusals.findIndex((item) => item.code === "SESSION_UNREACHABLE");
    if (first >= 0) verdict.refusals[first].message = sessionError;
    else verdict.refusals.push(refusal("SESSION_UNREACHABLE", sessionError));
    verdict.ok = false;
  }

  if (!verdict.ok) {
    const handoff = handToPerson({ repoRoot, env, id, application, refusals: verdict.refusals });
    return {
      ok: false,
      submitted: false,
      state: "refused",
      id,
      reasons: verdict.refusals,
      message: handoffText(verdict.refusals),
      handedToPerson: handoff.handedToPerson,
      status: handoff.status,
    };
  }

  // Durable "Submit is about to be pressed" marker first, exactly like the
  // driver: if this can't be recorded the click doesn't happen.
  // The marker write is an atomic claim: when another run already holds it,
  // this one must not click.
  let claim = null;
  let claimError = null;
  try {
    claim = appMarkSubmitAttempt({ repoRoot, env, id, at: new Date().toISOString() });
  } catch (error) {
    if (error?.committed === true) claim = error.result || { marked: true };
    else claimError = error;
  }
  if (!claimError && claim?.marked !== true) {
    // Another runtime holds the claim and may already have clicked. Don't hand
    // this to the person as manual-apply: that invites a second, manual submit.
    const reasons = [
      refusal(
        "SUBMIT_ALREADY_CLAIMED",
        "Another run is already submitting this application. Nothing was clicked here. Check its status before doing anything."
      ),
    ];
    return {
      ok: false,
      submitted: false,
      state: "submit-claimed",
      id,
      reasons,
      message: handoffText(reasons),
      handedToPerson: false,
      status: application?.status || null,
    };
  }
  if (claimError) {
    const reasons = [
      refusal(
        "SESSION_UNREACHABLE",
        `CareerRat couldn't record the attempt first, so it didn't press Submit: ${String(
          claimError?.message || claimError
        ).slice(0, 160)}`
      ),
    ];
    const handoff = handToPerson({ repoRoot, env, id, application, refusals: reasons });
    return {
      ok: false,
      submitted: false,
      state: "refused",
      id,
      reasons,
      message: handoffText(reasons),
      handedToPerson: handoff.handedToPerson,
      status: handoff.status,
    };
  }

  await resolved.ops.clickButton({ pageId, ref: verdict.submitRef, signal });

  let confirmed = false;
  let currentUrl = snapshot.origin;
  for (let poll = 0; poll < CONFIRMATION_POLLS && !confirmed; poll += 1) {
    await sleepImpl(CONFIRMATION_DELAY_MS);
    try {
      const after = await resolved.ops.snapshot({ pageId, signal });
      currentUrl = after.origin || currentUrl;
      confirmed = confirmationCheck({
        pageText: after.pageText,
        currentUrl: after.origin,
        refs: after.refs,
        allowProse: true,
      }).submitted;
    } catch {
      throwIfAborted(signal);
    }
  }

  if (confirmed) {
    return {
      ok: true,
      submitted: true,
      verified: true,
      state: "submitted",
      id,
      submitLabel: verdict.submitLabel,
      currentUrl,
      message: `Pressed "${verdict.submitLabel}" and the site showed a confirmation page.`,
      nextAction: "Record the application as Applied.",
    };
  }
  const message = `Pressed "${verdict.submitLabel}" but no confirmation page appeared. CareerRat won't press it again. Check the site.`;
  appSetFields({
    repoRoot,
    env,
    id,
    patch: {
      statusNote: "Submitted, but no confirmation page was seen.",
      nextAction: "Check the application on the site, then record it as Applied if it went through",
    },
  });
  return {
    ok: true,
    submitted: true,
    verified: false,
    state: "submitted-unverified",
    id,
    submitLabel: verdict.submitLabel,
    currentUrl,
    message,
    nextAction: "Check the site. Do not record Applied until a confirmation is seen.",
  };
}
