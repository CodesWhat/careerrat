import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { mayRun } from "../automation/consent.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import {
  capturePacketQuestions,
  classifySelfIdentificationQuestion,
} from "../packet/questions.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import {
  buildFillPlan,
  confirmationCheck,
  EASY_APPLY_STEPS,
  findAdvanceButtonRef,
  hostnameToPortal,
  isEasyApply,
  isSsoOrAccountLabel,
  submitGuard,
} from "./form-fill.mjs";

const FIELD_ROLES = new Map([
  ["textbox", "text"],
  ["combobox", "select"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
]);
const PREPARE_ONLY_ADVANCE_LABELS = new Set(["next", "next step"]);

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function questionId(label, used) {
  const base = normalizeLabel(label).replaceAll(" ", "-").slice(0, 72) || "field";
  let id = `rendered-${base}`;
  let suffix = 2;
  while (used.has(id)) id = `rendered-${base}-${suffix++}`;
  used.add(id);
  return id;
}

// A NormalizedSnapshot (from an ops adapter) already carries `required` per
// ref. This fallback only fires when a raw, unnormalized snapshot is passed
// in directly (e.g. a caller working straight off ops-adjacent fixtures),
// parsing the same "[required, ref=eN]" markers an ops adapter parses once.
function requiredFromText(snapshotText, ref) {
  const marker = `ref=${ref}`;
  return String(snapshotText || "")
    .split(/\r?\n/)
    .some((line) => line.includes(marker) && /\[.*\brequired\b.*\]/.test(line));
}

export function renderedFieldsFromSnapshot(snapshotResult = {}) {
  const refs =
    snapshotResult.refs && typeof snapshotResult.refs === "object" ? snapshotResult.refs : {};
  const rawText = snapshotResult.pageText ?? snapshotResult.snapshot;
  const usedIds = new Set();
  const fields = [];
  for (const [ref, entry] of Object.entries(refs)) {
    const role = String(entry?.role || "").toLowerCase();
    const type = FIELD_ROLES.get(role);
    const label = String(entry?.name || "").trim();
    if (!type || !label) continue;
    fields.push({
      ref,
      id: questionId(label, usedIds),
      label,
      type,
      required:
        typeof entry?.required === "boolean" ? entry.required : requiredFromText(rawText, ref),
    });
  }
  return fields;
}

function uploadKind(label) {
  const normalized = normalizeLabel(label);
  if (/\b(resume|curriculum vitae|cv)\b/.test(normalized)) return "resume";
  if (/\bcover letter\b/.test(normalized)) return "coverLetter";
  return null;
}

function parsedSnapshotNodes(snapshotResult) {
  const rawText = snapshotResult?.pageText ?? snapshotResult?.snapshot;
  const nodes = [];
  const parents = [];
  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const match = rawLine.match(/^(\s*)-\s+([\w-]+)\s+"([^"]+)".*\bref=([\w-]+)/);
    if (!match) continue;
    const indent = match[1].length;
    while (parents.length && parents.at(-1).indent >= indent) parents.pop();
    const node = {
      indent,
      role: match[2].toLowerCase(),
      label: match[3].trim(),
      ref: match[4],
      required: /\[.*\brequired\b.*\]/.test(rawLine),
      parent: parents.at(-1) || null,
    };
    nodes.push(node);
    parents.push(node);
  }
  return nodes;
}

export function uploadTargetsFromSnapshot(snapshotResult = {}) {
  const targets = [];
  const usedKinds = new Set();
  for (const node of parsedSnapshotNodes(snapshotResult)) {
    if (node.role !== "button" || !/^(attach|upload(?: file)?)$/i.test(node.label)) continue;
    let context = node.parent;
    while (context && !uploadKind(context.label)) context = context.parent;
    const kind = uploadKind(context?.label || node.label);
    if (!kind || usedKinds.has(kind)) continue;
    targets.push({
      ref: node.ref,
      kind,
      label: context?.label || node.label,
      required: Boolean(node.required || context?.required),
    });
    usedKinds.add(kind);
  }
  return targets;
}

function answerSections(markdown) {
  const sections = new Map();
  const pattern = /^##\s+(.+?)\s*\n+([\s\S]*?)(?=\n+##\s+|$)/gm;
  for (const match of String(markdown || "").matchAll(pattern)) {
    const label = normalizeLabel(match[1]);
    const answer = String(match[2] || "").trim();
    if (!label || !answer || /^NEEDS YOU\b/i.test(answer) || /^Leave blank\b/i.test(answer)) {
      continue;
    }
    if (/^Attach the generated\b/i.test(answer)) continue;
    sections.set(label, answer);
  }
  return sections;
}

function safeWorkspaceArtifact(repoRoot, env, stored) {
  const value = String(stored || "").trim();
  if (!value || value.includes("\0") || isAbsolute(value)) return null;
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const rel = normalize(value.startsWith("workspace/") ? value.slice(10) : value);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) return null;
  const full = join(workspaceDir, rel);
  const escaped = relative(workspaceDir, full);
  if (escaped.startsWith("..") || isAbsolute(escaped) || escaped.split(sep).includes("..")) {
    return null;
  }
  return existsSync(full) ? full : null;
}

export function loadAnswerMap({ repoRoot, env, application }) {
  const stored = application?.artifacts?.answersSource || application?.artifacts?.answers;
  const path = safeWorkspaceArtifact(repoRoot, env, stored);
  if (!path || !/\.md$/i.test(path)) return new Map();
  try {
    return answerSections(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

function safePostingUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function fillPlan({ fields, config, application, answers }) {
  const portal = hostnameToPortal(application?.link || application?.url || application?.sourceUrl);
  const planned = buildFillPlan({
    fields,
    formDefaults: config?.["form-defaults"] || {},
    profile: config?.profile || {},
    honesty: config?.honesty || {},
    portal,
  });
  return planned.map((step, index) => {
    const field = fields[index];
    if (classifySelfIdentificationQuestion(field.label).excluded) {
      return { ...field, action: "exclude", value: null };
    }
    if (step?.action === "fill") return { ...field, ...step };
    const answer = answers.get(normalizeLabel(field.label));
    if (answer) return { ...field, action: "fill", value: answer, source: "packet.answers" };
    return { ...field, action: "skip", value: null };
  });
}

function currentField(step, snapshot) {
  // id + type + raw label: ids are derived from normalized labels with dedupe
  // suffixes, so a field vanishing between snapshots can shift a suffix onto a
  // same-label sibling. Raw-label equality narrows a shifted match to a field
  // that reads identically to the planned one; anything else goes unresolved
  // instead of being filled with the wrong value.
  return renderedFieldsFromSnapshot(snapshot).find(
    (field) => field.id === step.id && field.type === step.type && field.label === step.label
  );
}

function currentUploadTarget(step, snapshot) {
  return uploadTargetsFromSnapshot(snapshot).find((target) => target.kind === step.kind);
}

function browserInterventionBlockers(snapshot) {
  const blockers = [...submitGuard({ pageText: snapshot?.pageText }).blockers];
  const fields = renderedFieldsFromSnapshot(snapshot);
  if (
    fields.some((field) =>
      /\b(password|create (?:an? )?account|security answer)\b/i.test(field.label)
    )
  ) {
    blockers.push("account creation or password entry");
  }
  // findAdvanceButtonRef already refuses to click a social-login/sign-in
  // control as an "advance" (isSsoOrAccountLabel), which stops the loop from
  // wandering onto a third-party auth page. That alone leaves a page whose
  // only actionable control IS one of these reporting a generic "nothing to
  // advance" result, which hides the real reason from the human. Surfacing
  // it here instead gives the honest halt AGENTS.md's browser-automation
  // contract already promises for login/2FA/provider-ambiguity prompts, the
  // same way the password/account-creation field check above does for a
  // native (non-SSO) account gate.
  const refs = snapshot?.refs && typeof snapshot.refs === "object" ? snapshot.refs : {};
  const hasSsoControl = Object.values(refs).some(
    (entry) =>
      String(entry?.role || "").toLowerCase() === "button" && isSsoOrAccountLabel(entry?.name)
  );
  if (hasSsoControl) {
    blockers.push("third-party or account sign-in");
  }
  return [...new Set(blockers)];
}

function uploadArtifacts({ repoRoot, env, application, postingUrl }) {
  const artifacts = application?.artifacts || {};
  const workday = /(?:^|\.)myworkday(?:jobs)?\.com$/i.test(
    (() => {
      try {
        return new URL(postingUrl).hostname;
      } catch {
        return "";
      }
    })()
  );
  const candidates = {
    resume: workday
      ? [artifacts.resumeDocx, artifacts.resumePdf, artifacts.resume]
      : [artifacts.resumePdf, artifacts.resumeDocx, artifacts.resume],
    coverLetter: [artifacts.coverLetterPdf, artifacts.coverLetterDocx, artifacts.coverLetter],
  };
  return Object.fromEntries(
    Object.entries(candidates).map(([kind, values]) => {
      const path = values
        .map((stored) => safeWorkspaceArtifact(repoRoot, env, stored))
        .find((candidate) => candidate && /\.(?:pdf|docx)$/i.test(candidate));
      return [kind, path || null];
    })
  );
}

export function screenshotPath({ repoRoot, env, applicationId, data, format }) {
  if (String(format || "png").toLowerCase() !== "png") {
    throw new Error("Orca returned an unsupported confirmation screenshot format.");
  }
  const bytes = Buffer.from(String(data || ""), "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw new Error("Orca did not return a usable confirmation screenshot.");
  }
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const captureDir = join(workspaceDir, "captures");
  mkdirSync(captureDir, { recursive: true });
  const slug =
    String(applicationId || "application")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "application";
  const filename = `${slug}-submission-confirmation-${Date.now()}.png`;
  writeFileSync(join(captureDir, filename), bytes, { mode: 0o600 });
  return `workspace/captures/${filename}`;
}

// Mirrors of the ops action for a fill-plan step. Returns null when the step's
// type/value combination has no safe action (e.g. a checkbox step whose value
// isn't an affirmative yes/true/1) — the caller treats a null action the same
// as a field that changed out from under it: unresolved, nothing clicked.
function fieldOpFor(step) {
  if (step.type === "text") {
    return (ops, pageId) => ops.fillField({ pageId, ref: step.ref, value: String(step.value) });
  }
  if (step.type === "select") {
    return (ops, pageId) => ops.selectOption({ pageId, ref: step.ref, value: String(step.value) });
  }
  if (step.type === "checkbox" && /^(yes|true|1)$/i.test(String(step.value))) {
    return (ops, pageId) => ops.toggleField({ pageId, ref: step.ref, checked: true });
  }
  return null;
}

// Fill + upload + guard pass for a single form/modal-step snapshot. Shared by
// the single-page path and each iteration of the Easy Apply step loop — the
// only difference between them is what the caller does with a clean result
// (single-page always stops here; Easy Apply looks for an advance button).
async function fillStep({
  ops,
  pageId,
  snapshot,
  application,
  url,
  repoRoot,
  env,
  candidateConfigGetImpl,
  loadAnswerMapImpl,
}) {
  const config = candidateConfigGetImpl({ repoRoot, env });
  const answers = await loadAnswerMapImpl({ repoRoot, env, application });
  const fields = renderedFieldsFromSnapshot(snapshot);
  const plan = fillPlan({ fields, config, application, answers });

  const initialGuard = submitGuard({
    pageText: snapshot.pageText,
  });
  if (initialGuard.blockers.length) {
    return {
      blocked: true,
      blockers: initialGuard.blockers,
      mode: initialGuard.mode,
      filledCount: 0,
      uploadedCount: 0,
      unresolved: [],
    };
  }

  const unresolved = [];
  let filledCount = 0;
  for (const step of plan) {
    if (step.action === "exclude") continue;
    if (step.action !== "fill") {
      if (step.required) unresolved.push({ label: step.label, required: true });
      continue;
    }
    const freshSnapshot = await ops.snapshot({ pageId });
    const freshField = currentField(step, freshSnapshot);
    const action = freshField ? fieldOpFor({ ...step, ref: freshField.ref }) : null;
    if (!action) {
      unresolved.push({
        label: step.label,
        required: step.required,
        reason: "The field changed before it could be filled.",
      });
      continue;
    }
    try {
      await action(ops, pageId);
      filledCount += 1;
    } catch (error) {
      unresolved.push({
        label: step.label,
        required: step.required,
        reason: String(error?.message || "This field could not be filled.").slice(0, 240),
      });
    }
  }

  const uploads = uploadArtifacts({ repoRoot, env, application, postingUrl: url });
  let uploadedCount = 0;
  for (const target of uploadTargetsFromSnapshot(snapshot)) {
    const file = uploads[target.kind];
    if (!file) {
      if (target.required) unresolved.push({ label: target.label, required: true });
      continue;
    }
    const freshSnapshot = await ops.snapshot({ pageId });
    const freshTarget = currentUploadTarget(target, freshSnapshot);
    if (!freshTarget) {
      unresolved.push({
        label: target.label,
        required: target.required,
        reason: "The upload control changed before the file could be attached.",
      });
      continue;
    }
    try {
      await ops.upload({ pageId, ref: freshTarget.ref, files: file });
      uploadedCount += 1;
    } catch (error) {
      unresolved.push({
        label: target.label,
        required: target.required,
        reason: String(error?.message || "This file could not be attached.").slice(0, 240),
      });
    }
  }

  const finalSnapshot = await ops.snapshot({ pageId });
  const guard = submitGuard({
    pageText: finalSnapshot.pageText,
  });
  return { blocked: false, guard, filledCount, uploadedCount, unresolved, finalSnapshot };
}

// ref count + sorted label set: cheap fingerprint to detect a modal that
// didn't actually advance after an "advance" click was sent.
function snapshotFingerprint(snapshot) {
  const refs = snapshot?.refs || {};
  const labels = Object.values(refs)
    .map((entry) => normalizeLabel(entry?.name))
    .filter(Boolean)
    .sort();
  return `${Object.keys(refs).length}:${labels.join("|")}`;
}

// Parses just the hostname out of a snapshot's origin, defensively: origin
// can be undefined, empty, or not a URL at all (a stub ops implementation in
// tests, a browser surfacing something unexpected), and new URL() throws on
// any of those. Returns null rather than throwing so the cross-origin check
// below can fall through to the existing fingerprint-based behavior instead
// of blocking, or letting a throw escape the loop, on a parse failure it
// cannot interpret. Hostname, not the full origin string: path and query
// change constantly within one legitimate flow, so comparing anything wider
// than the host would block every normal advance, not just a wrong one.
function safeHostname(origin) {
  try {
    return new URL(String(origin || "")).hostname || null;
  } catch {
    return null;
  }
}

function easyApplyStepKey(stepIndex) {
  return EASY_APPLY_STEPS[stepIndex - 1]?.key ?? null;
}

// Cosmetic session fields the multi-step loop attaches once it has actually
// advanced past the first page (stepIndex > 1). A single-page ATS form (no
// advance button ever found) never sets these, matching the pre-generalization
// shape that callers (AskBar/JobDrawer) already treat as "not a stepped flow".
// stepKey is LinkedIn Easy Apply's own named-section vocabulary (contact →
// resume → work_auth → ...); it's only meaningful when the flow IS Easy Apply.
// A generic paginated ATS (Workday, SmartRecruiters' stepped wizard, or any
// other multi-page form) still gets a numeric stepIndex (genuinely portal-
// agnostic) but always reports stepKey: null rather than borrowing LinkedIn's
// section names for a page they don't actually describe.
function stepSessionFields(stepIndex, easyApply) {
  if (stepIndex <= 1) return {};
  return { stepIndex, stepKey: easyApply ? easyApplyStepKey(stepIndex) : null };
}

function isPrepareOnlyAdvance(snapshot, ref) {
  const label = normalizeLabel(snapshot?.refs?.[ref]?.name);
  if (!PREPARE_ONLY_ADVANCE_LABELS.has(label)) return false;
  return !/\b(review|confirm|submit|send)\b/.test(normalizeLabel(snapshot?.pageText));
}

// Shared by the entry-point confirmation check and the Easy Apply loop's
// post-advance confirmation check (an advance click can land on a
// confirmation page directly) — same screenshot + verified response either way.
async function submittedResult({
  ops,
  pageId,
  snapshot,
  applicationId,
  repoRoot,
  env,
  saveScreenshotImpl,
  providerLabel,
  confirmation,
}) {
  const screenshot = await ops.screenshot({ pageId });
  const path = saveScreenshotImpl({
    repoRoot,
    env,
    applicationId,
    data: screenshot.data,
    format: screenshot.format,
  });
  return {
    available: true,
    verified: true,
    state: "submitted",
    confirmation: confirmation.signal,
    currentUrl: snapshot.origin,
    session: { provider: providerLabel },
    artifacts: [
      {
        kind: "submission_confirmation",
        title: "Verified submission confirmation",
        path,
      },
    ],
  };
}

export function createApplyDriver({
  ops,
  providerLabel,
  repoRoot,
  env = process.env,
  captureQuestionsImpl = capturePacketQuestions,
  candidateConfigGetImpl = candidateConfigGet,
  loadAnswerMapImpl = loadAnswerMap,
  mayRunImpl = mayRun,
  saveScreenshotImpl = screenshotPath,
  maxFormSteps = 10,
} = {}) {
  const sessions = new Map();

  return async function execute({
    applicationId,
    application,
    postingUrl,
    questionCapture,
    prepareOnly = false,
  } = {}) {
    const url = safePostingUrl(postingUrl);
    if (!url) {
      return {
        available: false,
        verified: false,
        state: "unavailable",
        reason: "A valid HTTP application link is required.",
      };
    }

    const easyApply = isEasyApply(url);
    if (easyApply) {
      const permission = mayRunImpl({
        capability: "authenticated_apply_preparation",
        platform: "linkedin",
        root: repoRoot,
      });
      if (!permission.allowed) {
        const blockers = Array.isArray(permission.reasons) ? permission.reasons : [];
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: blockers.join("; ") || "LinkedIn Easy Apply permission is off.",
          currentUrl: url,
          session: { provider: providerLabel, blockers },
        };
      }
    }

    let pageId = sessions.get(String(applicationId));
    const reusedPage = Boolean(pageId);
    if (!pageId) {
      const opened = await ops.openTab({ url });
      pageId = String(opened?.pageId || "").trim();
      if (!pageId) throw new Error("The supervised browser did not return a browser page id.");
      sessions.set(String(applicationId), pageId);
    }

    let snapshot;
    try {
      snapshot = await ops.snapshot({ pageId });
    } catch (error) {
      // A cached page id can point at a tab that has since been closed. That
      // must not poison every later run for this application: drop the stale
      // entry, open a fresh tab, and retry once.
      if (!reusedPage) throw error;
      sessions.delete(String(applicationId));
      const reopened = await ops.openTab({ url });
      pageId = String(reopened?.pageId || "").trim();
      if (!pageId) throw new Error("The supervised browser did not return a browser page id.");
      sessions.set(String(applicationId), pageId);
      snapshot = await ops.snapshot({ pageId });
    }
    const confirmation = confirmationCheck({
      pageText: snapshot.pageText,
      currentUrl: snapshot.origin,
    });
    if (confirmation.submitted) {
      return submittedResult({
        ops,
        pageId,
        snapshot,
        applicationId,
        repoRoot,
        env,
        saveScreenshotImpl,
        providerLabel,
        confirmation,
      });
    }

    const interventionBlockers = browserInterventionBlockers(snapshot);
    if (interventionBlockers.length) {
      return {
        available: true,
        verified: false,
        state: "blocked",
        reason: `Stopped on ${interventionBlockers.join(", ")}.`,
        currentUrl: snapshot.origin || url,
        session: {
          provider: providerLabel,
          filledCount: 0,
          uploadedCount: 0,
          unresolved: [],
          blockers: interventionBlockers,
          submitMode: "manual",
        },
      };
    }

    // ----- Multi-step form advancement -----
    // Not LinkedIn-specific: LinkedIn Easy Apply's paginated modal was the
    // first shape this handled, but Workday-style multi-page wizards and
    // stepped ATS forms (SmartRecruiters' recipe note calls out its own
    // "resume upload is a distinct step") hit the exact same problem: fill
    // one page, confirm the page actually moved, repeat. Rather than a
    // parallel LinkedIn-only loop plus a single-shot path for everyone else,
    // one loop runs for every provider. A single-page ATS form falls out of
    // it naturally: findAdvanceButtonRef finds no advance button on its only
    // page, so the loop exits after one iteration exactly like the old
    // single-page path did. `easyApply` (URL-gated, checked above for the
    // authenticated preparation consent gate) only still matters for cosmetic step
    // naming. See stepSessionFields.
    let stepIndex = 0;
    // Sums fillStep's per-call counts across every page in this run:
    // AskBar/JobDrawer/workspace-agent render these as run totals, not the
    // final step's count alone.
    let totalFilledCount = 0;
    let totalUploadedCount = 0;
    for (;;) {
      stepIndex += 1;
      if (stepIndex > maxFormSteps) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `The application has more steps than CareerRat will advance automatically (limit ${maxFormSteps}).`,
          currentUrl: snapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved: [],
            blockers: ["step limit reached"],
            submitMode: "manual",
            stepIndex,
            stepKey: null,
          },
        };
      }

      const stepBlockers = browserInterventionBlockers(snapshot);
      if (stepBlockers.length) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `Stopped on ${stepBlockers.join(", ")}.`,
          currentUrl: snapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved: [],
            blockers: stepBlockers,
            submitMode: "manual",
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      const fields = renderedFieldsFromSnapshot(snapshot);
      if (questionCapture?.state !== "captured" && fields.length) {
        const captured = await captureQuestionsImpl({
          repoRoot,
          env,
          applicationId,
          source: "rendered",
          url: snapshot.origin || url,
          questions: fields,
        });
        return {
          available: true,
          verified: false,
          state: "questions-captured",
          questionCaptureUpdated: true,
          session: {
            provider: providerLabel,
            answerableCount: captured.questions?.length || 0,
            excludedCount: captured.excluded?.length || 0,
            demographicSectionPresent: captured.demographicSectionPresent === true,
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      const result = await fillStep({
        ops,
        pageId,
        snapshot,
        application,
        url,
        repoRoot,
        env,
        candidateConfigGetImpl,
        loadAnswerMapImpl,
      });
      totalFilledCount += result.filledCount;
      totalUploadedCount += result.uploadedCount;
      if (result.blocked) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `Stopped on ${result.blockers.join(", ")}.`,
          currentUrl: snapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved: [],
            blockers: result.blockers,
            submitMode: result.mode,
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      const { guard, unresolved, finalSnapshot } = result;
      const requiredUnresolved = unresolved.filter((item) => item.required);

      if (guard.blockers.length) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `Stopped on ${guard.blockers.join(", ")}.`,
          currentUrl: finalSnapshot.origin || snapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved,
            blockers: guard.blockers,
            submitMode: guard.mode,
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      // A step that adds required fields with no resolvable answer (a
      // page-specific question the profile/honesty/form-defaults context
      // can't answer) is a NEEDS YOU handoff, never a guess: block here,
      // naming the fields, rather than clicking advance past them.
      if (requiredUnresolved.length) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `Stopped on required fields the form still needs: ${requiredUnresolved
            .map((item) => item.label)
            .join(", ")}.`,
          currentUrl: finalSnapshot.origin || snapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved,
            blockers: [],
            submitMode: guard.mode,
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      // Re-snapshot and re-resolve the advance button immediately before
      // acting, same as every field/upload action in fillStep — finalSnapshot
      // can be stale by the time a step's fill pass finishes, and clicking a
      // ref resolved against a stale snapshot is the exact hazard the
      // submit/advance disqualification guard exists to avoid. Absence of an
      // advance button is itself meaningful, not just "not this shape yet":
      // a flow that ends on a review page with no further Next/Continue
      // control (only a disqualified Submit-flavored one, or none at all)
      // stops here awaiting-submit, same as a genuinely single-page form.
      const preAdvanceSnapshot = await ops.snapshot({ pageId });
      const advanceRef = findAdvanceButtonRef(preAdvanceSnapshot);
      if (!advanceRef) {
        return {
          available: true,
          verified: false,
          state: "awaiting-submit",
          reason:
            "Review the live form and submit it in the supervised browser, then ask CareerRat to verify it.",
          currentUrl: preAdvanceSnapshot.origin || finalSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved,
            blockers: guard.blockers,
            submitMode: guard.mode,
            ...(prepareOnly === true ? { prepareOnly: true } : {}),
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      const advanceLabel = String(preAdvanceSnapshot.refs?.[advanceRef]?.name || "").trim();
      if (prepareOnly === true && !isPrepareOnlyAdvance(preAdvanceSnapshot, advanceRef)) {
        return {
          available: true,
          verified: false,
          state: "awaiting-submit",
          reason: `Preparation stopped before "${advanceLabel}" because that control could submit the application.`,
          currentUrl: preAdvanceSnapshot.origin || finalSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved,
            blockers: guard.blockers,
            submitMode: "manual",
            prepareOnly: true,
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }
      const fingerprintBefore = snapshotFingerprint(preAdvanceSnapshot);
      await ops.clickButton({ pageId, ref: advanceRef });
      const nextSnapshot = await ops.snapshot({ pageId });

      // A click meant to advance the page can land on a confirmation page
      // directly (the driver's click-safety fixes make this unexpected, not
      // impossible): report reality instead of treating it as a stalled step.
      const postAdvanceConfirmation = confirmationCheck({
        pageText: nextSnapshot.pageText,
        currentUrl: nextSnapshot.origin,
      });
      if (postAdvanceConfirmation.submitted) {
        return submittedResult({
          ops,
          pageId,
          snapshot: nextSnapshot,
          applicationId,
          repoRoot,
          env,
          saveScreenshotImpl,
          providerLabel,
          confirmation: postAdvanceConfirmation,
        });
      }

      // Label matching cannot see where a click actually lands. "Continue" is
      // legitimate wizard vocabulary, but it is also what "Continue browsing
      // jobs", a consent wall, an interstitial, or an ATS-hosted redirect
      // says, and none of those advance the application: they leave it. The
      // fingerprint check below only proves the page changed, and a
      // navigation off the application changes the fingerprint too, so it
      // cannot tell a real advance from a wrong destination. This check
      // can: if the click moved the browser to a different hostname, stop
      // before ever filling anything there, naming both hosts so the human
      // can see where it went and decide. Ordered after the confirmation
      // check on purpose: a legitimate submit-and-confirm can land on a
      // different host too (an embedded Greenhouse form completing on
      // boards.greenhouse.io, for one), and confirmationCheck already handles
      // that path with a screenshot and a verified response, so it gets first
      // look. This check is the fallback for every other cross-origin
      // landing, and it deliberately over-blocks: a legitimate same-
      // application handoff to a new host reads the same as a wrong one from
      // here, so it stops either way and leaves the rest to the human, same
      // bias as browserInterventionBlockers' own SSO handling. A false
      // positive costs one manual step; a false negative is automated
      // form-filling on a page nobody vetted, which is the worse outcome.
      const beforeHost = safeHostname(preAdvanceSnapshot.origin);
      const afterHost = safeHostname(nextSnapshot.origin);
      if (beforeHost && afterHost && beforeHost !== afterHost) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `Clicking "${advanceLabel}" left the application: it moved from ${beforeHost} to ${afterHost}.`,
          currentUrl: nextSnapshot.origin || preAdvanceSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved,
            blockers: [],
            submitMode: guard.mode,
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      // The advance-confirmation problem this guards against: a click that
      // resolves without error is not evidence of anything by itself: a
      // validation-rejected step or a page that merely re-renders its own
      // state looks identical from the outside unless something the PAGE did
      // changed underneath it. Same discipline as playwright-ops.mjs's
      // requireDisplayChange (a control's own display value, not the value
      // this code just typed into it): here the fingerprint is built from the
      // refs/labels the page rendered, never from anything the fill pass
      // itself wrote: an unchanged fingerprint means the page didn't move,
      // whether that's a validation failure or a no-op click, so this blocks
      // instead of looping forever or reporting a false advance.
      const fingerprintAfter = snapshotFingerprint(nextSnapshot);
      if (fingerprintBefore === fingerprintAfter) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `The form did not advance after clicking "${advanceLabel}".`,
          currentUrl: nextSnapshot.origin || preAdvanceSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved,
            blockers: [],
            submitMode: guard.mode,
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      snapshot = nextSnapshot;
    }
  };
}
