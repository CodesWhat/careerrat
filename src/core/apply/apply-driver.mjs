import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { mayRun } from "../automation/consent.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { validUploadArtifact } from "../documents/artifact-validation.mjs";
import {
  capturePacketQuestions,
  classifySelfIdentificationQuestion,
} from "../packet/questions.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { runAbortable, throwIfAborted, withAbortSignal } from "./cancellation.mjs";
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
  ["radio-group", "radio"],
]);
const APPLICATION_ENTRY_LABELS = new Set([
  "apply",
  "apply now",
  "apply for this job",
  "apply for this position",
]);
const PLATFORM_LABELS = {
  ashby: "Ashby",
  external_ats: "this application site",
  greenhouse: "Greenhouse",
  lever: "Lever",
  linkedin: "LinkedIn",
  smartrecruiters: "SmartRecruiters",
  workable: "Workable",
};
const HUMAN_CHALLENGE_BLOCKERS = new Set(["captcha", "are you a robot", "verify you are human"]);

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
    if (entry?.field === false) continue;
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
      ...(Array.isArray(entry?.options) ? { options: entry.options } : {}),
      ...(entry?.typeahead === true ? { typeahead: true } : {}),
      ...(entry?.stateKnown === true ? { stateKnown: true, value: String(entry.value || "") } : {}),
    });
  }
  return fields;
}

function questionCaptureNeedsRefresh(questionCapture, fields) {
  if (questionCapture?.state !== "captured") return fields.length > 0;
  if (fields.length === 0) return false;

  const hasSavedIds =
    Array.isArray(questionCapture.answerableIds) || Array.isArray(questionCapture.excludedIds);
  if (hasSavedIds) {
    const savedAnswerableIds = new Set(
      (questionCapture.answerableIds || []).map((id) => String(id || "").trim()).filter(Boolean)
    );
    const savedExcludedIds = new Set(
      (questionCapture.excludedIds || []).map((id) => String(id || "").trim()).filter(Boolean)
    );
    const savedIds = new Set([...savedAnswerableIds, ...savedExcludedIds]);
    const renderedIds = new Set(
      fields.map((field) => String(field.id || "").trim()).filter(Boolean)
    );
    if (savedIds.size !== renderedIds.size) return true;
    if ([...renderedIds].some((id) => !savedIds.has(id))) return true;
    return fields.some((field) => {
      const excludedNow = classifySelfIdentificationQuestion(field.label).excluded;
      return excludedNow ? savedAnswerableIds.has(field.id) : savedExcludedIds.has(field.id);
    });
  }

  const hasSavedCounts =
    Object.hasOwn(questionCapture, "answerableCount") ||
    Object.hasOwn(questionCapture, "excludedCount");
  if (!hasSavedCounts) return false;
  const savedCount =
    (Number(questionCapture.answerableCount) || 0) + (Number(questionCapture.excludedCount) || 0);
  return savedCount !== fields.length;
}

function uploadKind(label) {
  const normalized = normalizeLabel(label);
  if (/\b(resume|curriculum vitae|cv)\b/.test(normalized)) return "resume";
  if (/\bcover letter\b/.test(normalized)) return "coverLetter";
  return null;
}

function directUploadKind(label) {
  const normalized = normalizeLabel(label);
  if (/^(?:resume(?: cv)?|curriculum vitae|cv)(?: required)?$/.test(normalized)) return "resume";
  if (/^cover letter(?: required)?$/.test(normalized)) return "coverLetter";
  return null;
}

function parsedSnapshotNodes(snapshotResult) {
  const rawText = snapshotResult?.pageText ?? snapshotResult?.snapshot;
  const nodes = [];
  const parents = [];
  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const match = rawLine.match(/^(\s*)-\s+([\w-]+)(?:\s+"([^"]*)")?(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    while (parents.length && parents.at(-1).indent >= indent) parents.pop();
    const label = String(match[3] || "").trim();
    const tail = match[4] || "";
    const node = {
      indent,
      role: match[2].toLowerCase(),
      label,
      ref: tail.match(/\bref=([\w-]+)/)?.[1] || null,
      required: /\[.*\brequired\b.*\]/.test(tail) || /\*$/.test(label),
      stateKnown: /\]\s*:/.test(tail),
      parent: parents.at(-1) || null,
    };
    nodes.push(node);
    parents.push(node);
  }
  return nodes;
}

export function uploadTargetsFromSnapshot(snapshotResult = {}) {
  const targets = new Map();
  for (const node of parsedSnapshotNodes(snapshotResult)) {
    if (node.role !== "button" || !node.ref) continue;
    const directKind = directUploadKind(node.label);
    if (!directKind && !/^(attach|upload(?: file)?)$/i.test(node.label)) continue;
    let context = node.parent;
    while (context && !uploadKind(context.label)) context = context.parent;
    const kind = directKind || uploadKind(context?.label || node.label);
    if (!kind) continue;
    const target = {
      ref: node.ref,
      kind,
      label: context?.label || node.label,
      required: Boolean(node.required || context?.required),
    };
    const existing = targets.get(kind);
    if (!existing || (node.stateKnown && !existing.stateKnown)) {
      targets.set(kind, { ...target, stateKnown: node.stateKnown });
    }
  }
  return [...targets.values()].map(({ stateKnown: _stateKnown, ...target }) => target);
}

function selectValueFromSnapshot(value, snapshot) {
  const requested = normalizeLabel(value);
  if (!requested) return String(value);
  const options = Object.values(snapshot?.refs || {})
    .filter((entry) => String(entry?.role || "").toLowerCase() === "option")
    .map((entry) => String(entry?.name || "").trim())
    .filter(Boolean);
  const exact = options.find((label) => normalizeLabel(label) === requested);
  if (exact) return exact;
  const prefixed = options.filter((label) => normalizeLabel(label).startsWith(`${requested} `));
  return prefixed.length === 1 ? prefixed[0] : String(value);
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

function ashbyApplicationEntryRef(snapshot) {
  let current;
  try {
    current = new URL(String(snapshot?.origin || ""));
  } catch {
    return null;
  }
  if (current.hostname !== "jobs.ashbyhq.com" || /\/application\/?$/.test(current.pathname)) {
    return null;
  }
  return (
    Object.entries(snapshot?.refs || {}).find(([, entry]) => {
      const role = String(entry?.role || "").toLowerCase();
      return ["tab", "link"].includes(role) && normalizeLabel(entry?.name) === "application";
    })?.[0] || null
  );
}

function applicationEntry(snapshot) {
  const ashbyRef = ashbyApplicationEntryRef(snapshot);
  if (ashbyRef) return { ref: ashbyRef, sameOrigin: true, targetUrl: null };
  if (renderedFieldsFromSnapshot(snapshot).length || uploadTargetsFromSnapshot(snapshot).length) {
    return null;
  }
  const match = Object.entries(snapshot?.refs || {}).find(([, entry]) => {
    const role = String(entry?.role || "").toLowerCase();
    const label = normalizeLabel(entry?.name);
    return role === "link" && APPLICATION_ENTRY_LABELS.has(label) && safePostingUrl(entry?.href);
  });
  if (!match) return null;
  return { ref: match[0], sameOrigin: false, targetUrl: safePostingUrl(match[1].href) };
}

function hasPublicApplicationFormEvidence(snapshot) {
  const hasApplicationField = renderedFieldsFromSnapshot(snapshot).some((field) => {
    const label = normalizeLabel(field.label);
    return (
      /^(?:name|notes|(?:first|given|last|family|full|legal|preferred) name)$/.test(label) ||
      /\b(?:resume|curriculum vitae|cover letter|portfolio|linkedin profile|github profile|work authorization|sponsorship)\b/.test(
        label
      )
    );
  });
  if (hasApplicationField || uploadTargetsFromSnapshot(snapshot).length) {
    return true;
  }
  return Object.values(snapshot?.refs || {}).some((entry) => {
    const role = String(entry?.role || "").toLowerCase();
    const label = normalizeLabel(entry?.name);
    return (
      role === "button" &&
      (/\bsubmit application\b/.test(label) ||
        (label === "submit" && /\breview (?:your )?application\b/i.test(snapshot?.pageText || "")))
    );
  });
}

function applicationPermissionReason(platform) {
  const label = PLATFORM_LABELS[platform] || "this application site";
  return `Application preparation for ${label} is off. Turn it on in Settings before CareerRat opens the form.`;
}

function applicationPlatformForUrl(url) {
  return isEasyApply(url) ? "linkedin" : hostnameToPortal(url) || "external_ats";
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
      if (
        step?.action === "fill" &&
        String(step.source || "").startsWith("form-defaults.voluntary_self_identification.")
      ) {
        return { ...field, ...step };
      }
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

function isHumanChallengeBlocker(blocker) {
  return HUMAN_CHALLENGE_BLOCKERS.has(blocker);
}

function browserInterventionBlockers(snapshot) {
  const blockers = submitGuard({ pageText: snapshot?.pageText }).blockers.filter(
    (blocker) => !isHumanChallengeBlocker(blocker)
  );
  const fields = renderedFieldsFromSnapshot(snapshot);
  if (
    fields.some((field) =>
      /\b(password|create (?:an? )?account|security answer)\b/i.test(field.label)
    )
  ) {
    blockers.push("account creation or password entry");
  }
  // findAdvanceButtonRef already refuses to click social-login/sign-in controls.
  // Treat them as a blocker only when they are the gate, not when an ordinary
  // public application form is usable alongside an optional account shortcut.
  const refs = snapshot?.refs && typeof snapshot.refs === "object" ? snapshot.refs : {};
  const hasSsoControl = Object.values(refs).some(
    (entry) =>
      ["button", "link"].includes(String(entry?.role || "").toLowerCase()) &&
      isSsoOrAccountLabel(entry?.name)
  );
  if (hasSsoControl && !hasPublicApplicationFormEvidence(snapshot)) {
    blockers.push("third-party or account sign-in");
  }
  return [...new Set(blockers)];
}

// The apply driver's own resume-candidate keys (uploadArtifacts below), in
// priority-agnostic form: packet/exports.mjs and the answer-confirmation
// readiness recompute (one-off-answer.mjs) both need "is there ANY
// uploadable resume on this application" as an independent, always-checked
// gap — not derived from whichever other gaps happen to be open — and both
// need it to mean exactly what the apply driver will actually pick from at
// submit time, not a second, drifting definition of "uploadable."
const RESUME_ARTIFACT_KEYS = ["resumePdf", "resumeDocx", "resume"];

export function hasUploadableResumeArtifact({ repoRoot, env, artifacts } = {}) {
  const source = artifacts || {};
  return RESUME_ARTIFACT_KEYS.some((key) => {
    const candidate = safeWorkspaceArtifact(repoRoot, env, source[key]);
    return Boolean(candidate && validUploadArtifact(candidate));
  });
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
        .find((candidate) => candidate && validUploadArtifact(candidate));
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
// type/value combination has no safe action. The caller treats a null action
// the same as a field that changed out from under it: unresolved, nothing clicked.
function browserOp(ops, method, input, signal) {
  return runAbortable(signal, () => ops[method](withAbortSignal(input, signal)));
}

function fieldOpFor(step, snapshot, ops) {
  if (step.type === "text") {
    return (ops, pageId, signal) =>
      browserOp(ops, "fillField", { pageId, ref: step.ref, value: String(step.value) }, signal);
  }
  if (step.type === "select") {
    if (step.declinePolicy === true) {
      if (typeof step.value === "string" && step.value) {
        return (ops, pageId, signal) =>
          browserOp(
            ops,
            "selectOption",
            {
              pageId,
              ref: step.ref,
              label: step.label,
              value: step.value,
              typeahead: step.typeahead === true,
              optionAliases: step.optionAliases,
            },
            signal
          );
      }
      if (typeof ops?.selectDeclineOption !== "function") return null;
      return (ops, pageId, signal) =>
        browserOp(
          ops,
          "selectDeclineOption",
          {
            pageId,
            ref: step.ref,
            label: step.label,
            typeahead: step.typeahead === true,
          },
          signal
        );
    }
    return (ops, pageId, signal) =>
      browserOp(
        ops,
        "selectOption",
        {
          pageId,
          ref: step.ref,
          label: step.label,
          value: selectValueFromSnapshot(step.value, snapshot),
          typeahead: step.typeahead === true,
          optionAliases: step.optionAliases,
        },
        signal
      );
  }
  if (step.type === "checkbox") {
    const value = String(step.value).trim();
    if (/^(yes|true|1)$/i.test(value)) {
      return (ops, pageId, signal) =>
        browserOp(ops, "toggleField", { pageId, ref: step.ref, checked: true }, signal);
    }
    if (/^(no|false|0)$/i.test(value)) {
      return (ops, pageId, signal) =>
        browserOp(ops, "toggleField", { pageId, ref: step.ref, checked: false }, signal);
    }
  }
  if (step.type === "radio") {
    const requested = normalizeLabel(step.value);
    const option = (Array.isArray(step.options) ? step.options : []).find(
      (candidate) => normalizeLabel(candidate?.label) === requested
    );
    if (option?.ref) {
      return (ops, pageId, signal) =>
        typeof ops.chooseButtonOption === "function"
          ? browserOp(ops, "chooseButtonOption", { pageId, ref: option.ref }, signal)
          : browserOp(ops, "clickButton", { pageId, ref: option.ref }, signal);
    }
  }
  return null;
}

function filledChoiceMatches(step, field) {
  const actual = normalizeLabel(field?.value);
  const expected = normalizeLabel(step?.value);
  if (!actual || !expected) return false;
  if (actual === expected || actual.includes(expected) || expected.includes(actual)) return true;
  const city = normalizeLabel(String(step?.value || "").split(",")[0]);
  return Boolean(city && actual.startsWith(`${city} `));
}

function untrustedFormStepResult({ snapshot, filledCount, uploadedCount, unresolved = [] }) {
  const landedOrigin = safeHttpOrigin(snapshot?.origin);
  const reason = landedOrigin
    ? `The application moved to an untrusted site (${landedOrigin}) before CareerRat could continue.`
    : "CareerRat couldn't verify the application site before continuing.";
  return {
    blocked: true,
    reason,
    blockers: [landedOrigin ? "untrusted application site" : "application site not verified"],
    mode: "manual",
    filledCount,
    uploadedCount,
    unresolved,
    finalSnapshot: snapshot,
  };
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
  isTrustedOrigin,
  signal,
}) {
  throwIfAborted(signal);
  const config = candidateConfigGetImpl({ repoRoot, env });
  const answers = await runAbortable(signal, () =>
    loadAnswerMapImpl({ repoRoot, env, application, signal })
  );
  const fields = renderedFieldsFromSnapshot(snapshot);
  const plan = fillPlan({ fields, config, application, answers });

  const initialGuard = submitGuard({
    pageText: snapshot.pageText,
  });
  const preparationBlockers = initialGuard.blockers.filter(
    (blocker) => !isHumanChallengeBlocker(blocker)
  );
  if (preparationBlockers.length) {
    return {
      blocked: true,
      blockers: preparationBlockers,
      mode: initialGuard.mode,
      filledCount: 0,
      uploadedCount: 0,
      unresolved: [],
    };
  }

  const unresolved = [];
  const selectedChoiceValues = new Map();
  let filledCount = 0;
  for (const step of plan) {
    throwIfAborted(signal);
    if (step.action === "exclude") continue;
    if (step.action !== "fill") {
      if (step.required) unresolved.push({ label: step.label, required: true });
      continue;
    }
    const freshSnapshot = await browserOp(ops, "snapshot", { pageId }, signal);
    if (!isTrustedOrigin(freshSnapshot.origin)) {
      return untrustedFormStepResult({
        snapshot: freshSnapshot,
        filledCount,
        uploadedCount: 0,
        unresolved,
      });
    }
    const freshField = currentField(step, freshSnapshot);
    if (
      freshField?.stateKnown === true &&
      ["select", "radio"].includes(step.type) &&
      filledChoiceMatches(step, freshField)
    ) {
      continue;
    }
    const action = freshField
      ? fieldOpFor({ ...step, ...freshField, value: step.value }, freshSnapshot, ops)
      : null;
    if (!action) {
      unresolved.push({
        label: step.label,
        required: step.required,
        reason: "The field changed before it could be filled.",
      });
      continue;
    }
    try {
      const outcome = await action(ops, pageId, signal);
      const selectedValue = String(outcome?.selectedValue || "").trim();
      if (selectedValue && ["select", "radio"].includes(step.type)) {
        selectedChoiceValues.set(step.id, selectedValue);
      }
      filledCount += 1;
    } catch (error) {
      throwIfAborted(signal);
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
    throwIfAborted(signal);
    const file = uploads[target.kind];
    if (!file) {
      if (target.required) unresolved.push({ label: target.label, required: true });
      continue;
    }
    const freshSnapshot = await browserOp(ops, "snapshot", { pageId }, signal);
    if (!isTrustedOrigin(freshSnapshot.origin)) {
      return untrustedFormStepResult({
        snapshot: freshSnapshot,
        filledCount,
        uploadedCount,
        unresolved,
      });
    }
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
      await browserOp(ops, "upload", { pageId, ref: freshTarget.ref, files: file }, signal);
      uploadedCount += 1;
    } catch (error) {
      throwIfAborted(signal);
      unresolved.push({
        label: target.label,
        required: target.required,
        reason: String(error?.message || "This file could not be attached.").slice(0, 240),
      });
    }
  }

  const finalSnapshot = await browserOp(ops, "snapshot", { pageId }, signal);
  if (!isTrustedOrigin(finalSnapshot.origin)) {
    return untrustedFormStepResult({
      snapshot: finalSnapshot,
      filledCount,
      uploadedCount,
      unresolved,
    });
  }
  const finalFields = renderedFieldsFromSnapshot(finalSnapshot);
  for (const step of plan) {
    if (step.action !== "fill" || !["select", "radio"].includes(step.type)) continue;
    const finalField = finalFields.find(
      (field) => field.id === step.id && field.type === step.type && field.label === step.label
    );
    if (finalField?.stateKnown !== true) continue;
    const selectedValue = selectedChoiceValues.get(step.id);
    const selectedValueMatches = selectedValue
      ? filledChoiceMatches({ ...step, value: selectedValue }, finalField)
      : false;
    if (filledChoiceMatches(step, finalField) || selectedValueMatches) {
      for (let index = unresolved.length - 1; index >= 0; index -= 1) {
        if (unresolved[index].label === step.label) unresolved.splice(index, 1);
      }
      continue;
    }
    if (!unresolved.some((item) => item.label === step.label)) {
      unresolved.push({
        label: step.label,
        required: step.required,
        reason: "The selected value did not remain in the live form.",
      });
    }
  }
  for (const field of finalFields) {
    if (!field.required || field.stateKnown !== true || String(field.value || "").trim()) continue;
    if (!unresolved.some((item) => item.label === field.label)) {
      unresolved.push({
        label: field.label,
        required: true,
        reason: "The required field is still blank in the live form.",
      });
    }
  }
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

function advanceIsProvenNonFinal(snapshot, ref) {
  const entry = snapshot?.refs?.[ref];
  return String(entry?.role || "").toLowerCase() === "button" && entry?.advanceSafe === true;
}

function findProvenNonFinalAdvanceButtonRef(snapshot) {
  const refs = snapshot?.refs && typeof snapshot.refs === "object" ? snapshot.refs : {};
  for (const [ref, entry] of Object.entries(refs)) {
    if (String(entry?.role || "").toLowerCase() !== "button") continue;
    if (entry?.advanceSafe === true) return ref;
  }
  return null;
}

function newlyRequiredFields(previousSnapshot, freshSnapshot) {
  const previousCounts = new Map();
  for (const field of renderedFieldsFromSnapshot(previousSnapshot)) {
    const key = `${field.type}\u0000${normalizeLabel(field.label)}`;
    previousCounts.set(key, (previousCounts.get(key) || 0) + 1);
  }
  const introduced = [];
  for (const field of renderedFieldsFromSnapshot(freshSnapshot)) {
    const key = `${field.type}\u0000${normalizeLabel(field.label)}`;
    const remaining = previousCounts.get(key) || 0;
    if (remaining > 0) {
      previousCounts.set(key, remaining - 1);
      if (field.required && field.stateKnown === true && !String(field.value || "").trim()) {
        introduced.push(field);
      }
      continue;
    }
    if (field.required) introduced.push(field);
  }
  return introduced;
}

// Parses a snapshot's full HTTP(S) origin defensively. Scheme and port are
// part of the boundary: an HTTPS downgrade or unexpected port is not the same
// application origin even when the hostname is unchanged. Paths and queries
// are excluded by URL.origin so normal steps on one origin still advance.
function safeHttpOrigin(origin) {
  try {
    const parsed = new URL(String(origin || ""));
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function createRetainedSession(pageId, postingUrl) {
  const postingOrigin = safeHttpOrigin(postingUrl);
  return {
    pageId,
    postingUrl,
    trustedOrigins: new Set(postingOrigin ? [postingOrigin] : []),
  };
}

function trustRetainedOrigin(session, value) {
  const origin = safeHttpOrigin(value);
  if (origin) session.trustedOrigins.add(origin);
}

function retainedOriginIsTrusted(session, value) {
  const origin = safeHttpOrigin(value);
  return Boolean(origin && session?.trustedOrigins?.has(origin));
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
  signal,
}) {
  throwIfAborted(signal);
  const screenshot = await browserOp(ops, "screenshot", { pageId }, signal);
  throwIfAborted(signal);
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
  const inFlight = new Map();

  async function executeOne({
    applicationId,
    application,
    postingUrl,
    questionCapture,
    prepareOnly = false,
    focusSession = false,
    signal,
  } = {}) {
    throwIfAborted(signal);
    const url = safePostingUrl(postingUrl);
    if (!url) {
      return {
        available: false,
        verified: false,
        state: "unavailable",
        reason: "A valid HTTP application link is required.",
      };
    }

    const applicationKey = String(applicationId);
    if (focusSession === true) {
      const retainedSession = sessions.get(applicationKey);
      if (!retainedSession || retainedSession.postingUrl !== url) {
        sessions.delete(applicationKey);
        return {
          available: false,
          verified: false,
          state: "unavailable",
          reason: "There is no prepared browser session to return to. Prepare the form again.",
        };
      }
      try {
        if (typeof ops.focusTab !== "function") {
          throw new Error("This browser provider cannot focus a prepared tab.");
        }
        await browserOp(ops, "focusTab", { pageId: retainedSession.pageId }, signal);
        const retainedSnapshot = await browserOp(
          ops,
          "snapshot",
          { pageId: retainedSession.pageId },
          signal
        );
        if (!retainedOriginIsTrusted(retainedSession, retainedSnapshot.origin)) {
          throw new Error("The prepared tab left the trusted application site.");
        }
        const confirmation = confirmationCheck({
          pageText: retainedSnapshot.pageText,
          currentUrl: retainedSnapshot.origin,
        });
        if (confirmation.submitted) {
          return submittedResult({
            ops,
            pageId: retainedSession.pageId,
            snapshot: retainedSnapshot,
            applicationId,
            repoRoot,
            env,
            saveScreenshotImpl,
            providerLabel,
            confirmation,
            signal,
          });
        }
        return {
          available: true,
          verified: false,
          state: "awaiting-submit",
          reason: "Returned to the prepared application. Review it and press Submit yourself.",
          currentUrl: retainedSnapshot.origin || url,
          session: {
            provider: providerLabel,
            focused: true,
            prepareOnly: true,
            submitMode: "manual",
          },
        };
      } catch (error) {
        throwIfAborted(signal);
        sessions.delete(applicationKey);
        return {
          available: false,
          verified: false,
          state: "unavailable",
          reason: `The prepared browser session is no longer available: ${String(
            error?.message || "browser command failed"
          ).slice(0, 300)}`,
        };
      }
    }

    const easyApply = isEasyApply(url);
    const applicationPlatform = applicationPlatformForUrl(url);
    const permission = mayRunImpl({
      capability: "authenticated_apply_preparation",
      platform: applicationPlatform,
      root: repoRoot,
    });
    if (!permission.allowed) {
      const reason = applicationPermissionReason(applicationPlatform);
      return {
        available: true,
        verified: false,
        state: "blocked",
        code: "APPLICATION_PREPARATION_PERMISSION_REQUIRED",
        reason,
        currentUrl: url,
        session: { provider: providerLabel, blockers: [reason] },
      };
    }

    let retainedSession = sessions.get(applicationKey);
    if (retainedSession?.postingUrl !== url) {
      sessions.delete(applicationKey);
      retainedSession = null;
    }
    const reusedPage = Boolean(retainedSession);
    if (!retainedSession) {
      const opened = await browserOp(ops, "openTab", { url }, signal);
      const pageId = String(opened?.pageId || "").trim();
      if (!pageId) throw new Error("The supervised browser did not return a browser page id.");
      retainedSession = createRetainedSession(pageId, url);
      sessions.set(applicationKey, retainedSession);
    }
    let pageId = retainedSession.pageId;

    let snapshot;
    try {
      snapshot = await browserOp(ops, "snapshot", { pageId }, signal);
    } catch (error) {
      throwIfAborted(signal);
      // A cached page id can point at a tab that has since been closed. That
      // must not poison every later run for this application: drop the stale
      // entry, open a fresh tab, and retry once.
      if (!reusedPage) throw error;
      sessions.delete(applicationKey);
      const reopened = await browserOp(ops, "openTab", { url }, signal);
      pageId = String(reopened?.pageId || "").trim();
      if (!pageId) throw new Error("The supervised browser did not return a browser page id.");
      retainedSession = createRetainedSession(pageId, url);
      sessions.set(applicationKey, retainedSession);
      snapshot = await browserOp(ops, "snapshot", { pageId }, signal);
    }
    if (reusedPage && !retainedOriginIsTrusted(retainedSession, snapshot.origin)) {
      sessions.delete(applicationKey);
      const reopened = await browserOp(ops, "openTab", { url }, signal);
      pageId = String(reopened?.pageId || "").trim();
      if (!pageId) throw new Error("The supervised browser did not return a browser page id.");
      retainedSession = createRetainedSession(pageId, url);
      sessions.set(applicationKey, retainedSession);
      snapshot = await browserOp(ops, "snapshot", { pageId }, signal);
    }
    if (!retainedOriginIsTrusted(retainedSession, snapshot.origin)) {
      sessions.delete(applicationKey);
      const requestedOrigin = safeHttpOrigin(url);
      const landedOrigin = safeHttpOrigin(snapshot.origin);
      const reason =
        requestedOrigin && landedOrigin
          ? `CareerRat opened an unexpected application site (${landedOrigin} instead of ${requestedOrigin}). It stopped before filling the form.`
          : "CareerRat couldn't verify where the application opened. It stopped before filling the form.";
      return {
        available: true,
        verified: false,
        state: "blocked",
        reason,
        currentUrl: snapshot.origin || url,
        session: {
          provider: providerLabel,
          filledCount: 0,
          uploadedCount: 0,
          unresolved: [],
          blockers: [reason],
          submitMode: "manual",
        },
      };
    }
    trustRetainedOrigin(retainedSession, snapshot.origin);
    let confirmation = confirmationCheck({
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
        prepareOnly,
        signal,
      });
    }

    const entry = applicationEntry(snapshot);
    if (entry) {
      const detailSnapshot = snapshot;
      const targetOrigin = safeHttpOrigin(entry.targetUrl);
      const targetPlatform = entry.targetUrl ? applicationPlatformForUrl(entry.targetUrl) : null;
      if (targetPlatform) {
        const targetPermission = mayRunImpl({
          capability: "authenticated_apply_preparation",
          platform: targetPlatform,
          root: repoRoot,
        });
        if (!targetPermission.allowed) {
          const reason = applicationPermissionReason(targetPlatform);
          return {
            available: true,
            verified: false,
            state: "blocked",
            code: "APPLICATION_PREPARATION_PERMISSION_REQUIRED",
            reason,
            currentUrl: detailSnapshot.origin || url,
            session: { provider: providerLabel, blockers: [reason] },
          };
        }
      }
      const clicked = await browserOp(ops, "clickButton", { pageId, ref: entry.ref }, signal);
      const clickedPageId = String(clicked?.pageId || clicked?.browserPageId || "").trim();
      if (clickedPageId && clickedPageId !== pageId) {
        pageId = clickedPageId;
        retainedSession.pageId = pageId;
      }
      snapshot = await browserOp(ops, "snapshot", { pageId }, signal);
      const detailOrigin = safeHttpOrigin(detailSnapshot.origin);
      const applicationOrigin = safeHttpOrigin(snapshot.origin);
      if (!applicationOrigin) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason:
            "CareerRat followed Apply, but couldn't verify where the form opened. Check the browser, then resume preparation.",
          currentUrl: snapshot.origin || detailSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: 0,
            uploadedCount: 0,
            unresolved: [],
            blockers: ["application destination not verified"],
            submitMode: "manual",
          },
        };
      }
      if (
        entry.sameOrigin &&
        detailOrigin &&
        applicationOrigin &&
        detailOrigin !== applicationOrigin
      ) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `Opening the Ashby Application tab left the job board: it moved from ${detailOrigin} to ${applicationOrigin}.`,
          currentUrl: snapshot.origin || detailSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: 0,
            uploadedCount: 0,
            unresolved: [],
            blockers: [],
            submitMode: "manual",
          },
        };
      }
      if (!entry.sameOrigin && applicationOrigin !== targetOrigin) {
        const reason = `CareerRat followed Apply to an unexpected application site (${applicationOrigin} instead of ${targetOrigin}). It stopped before filling the form.`;
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason,
          currentUrl: snapshot.origin || detailSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: 0,
            uploadedCount: 0,
            unresolved: [],
            blockers: [reason],
            submitMode: "manual",
          },
        };
      }
      trustRetainedOrigin(retainedSession, snapshot.origin);
      confirmation = confirmationCheck({
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
          prepareOnly,
          signal,
        });
      }
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
      if (questionCaptureNeedsRefresh(questionCapture, fields)) {
        const captured = await runAbortable(signal, () =>
          captureQuestionsImpl({
            repoRoot,
            env,
            applicationId,
            source: "rendered",
            url: snapshot.origin || url,
            questions: fields,
            signal,
          })
        );
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
        isTrustedOrigin: (value) => retainedOriginIsTrusted(retainedSession, value),
        signal,
      });
      totalFilledCount += result.filledCount;
      totalUploadedCount += result.uploadedCount;
      if (result.blocked) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: result.reason || `Stopped on ${result.blockers.join(", ")}.`,
          currentUrl: result.finalSnapshot?.origin || snapshot.origin || url,
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
        const humanChallengeOnly = guard.blockers.every(isHumanChallengeBlocker);
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: humanChallengeOnly
            ? "CareerRat stopped at the captcha after preparing the live form. Complete the captcha, review it, and submit it yourself."
            : `Stopped on ${guard.blockers.join(", ")}.`,
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
      const preAdvanceSnapshot = await browserOp(ops, "snapshot", { pageId }, signal);
      if (!retainedOriginIsTrusted(retainedSession, preAdvanceSnapshot.origin)) {
        const blocked = untrustedFormStepResult({
          snapshot: preAdvanceSnapshot,
          filledCount: totalFilledCount,
          uploadedCount: totalUploadedCount,
          unresolved,
        });
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: blocked.reason,
          currentUrl: preAdvanceSnapshot.origin || finalSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved,
            blockers: blocked.blockers,
            submitMode: blocked.mode,
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }
      const advanceRef =
        prepareOnly === true
          ? findProvenNonFinalAdvanceButtonRef(preAdvanceSnapshot) ||
            findAdvanceButtonRef(preAdvanceSnapshot)
          : findAdvanceButtonRef(preAdvanceSnapshot);
      if (!advanceRef) {
        if (!easyApply && !hasPublicApplicationFormEvidence(preAdvanceSnapshot)) {
          return {
            available: true,
            verified: false,
            state: "blocked",
            reason:
              "CareerRat opened the job listing but couldn't find the application form. Use the site's Apply button, then resume preparation.",
            currentUrl: preAdvanceSnapshot.origin || finalSnapshot.origin || url,
            session: {
              provider: providerLabel,
              filledCount: totalFilledCount,
              uploadedCount: totalUploadedCount,
              unresolved,
              blockers: ["application form not found"],
              submitMode: "manual",
              ...stepSessionFields(stepIndex, easyApply),
            },
          };
        }
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

      const freshRequiredFields = newlyRequiredFields(snapshot, preAdvanceSnapshot);
      if (freshRequiredFields.length) {
        const unresolvedFreshFields = freshRequiredFields.map((field) => ({
          label: field.label,
          required: true,
          reason: "This required field appeared after the fill pass.",
        }));
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `Stopped on required fields the form added before advancing: ${freshRequiredFields
            .map((field) => field.label)
            .join(", ")}.`,
          currentUrl: preAdvanceSnapshot.origin || finalSnapshot.origin || url,
          session: {
            provider: providerLabel,
            filledCount: totalFilledCount,
            uploadedCount: totalUploadedCount,
            unresolved: unresolvedFreshFields,
            blockers: [],
            submitMode: guard.mode,
            ...(prepareOnly === true ? { prepareOnly: true } : {}),
            ...stepSessionFields(stepIndex, easyApply),
          },
        };
      }

      const advanceLabel = String(preAdvanceSnapshot.refs?.[advanceRef]?.name || "").trim();
      if (prepareOnly === true && !advanceIsProvenNonFinal(preAdvanceSnapshot, advanceRef)) {
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
      await browserOp(ops, "clickButton", { pageId, ref: advanceRef }, signal);
      const nextSnapshot = await browserOp(ops, "snapshot", { pageId }, signal);

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
          prepareOnly,
          signal,
        });
      }

      // Label matching cannot see where a click actually lands. "Continue" is
      // legitimate wizard vocabulary, but it is also what "Continue browsing
      // jobs", a consent wall, an interstitial, or an ATS-hosted redirect
      // says, and none of those advance the application: they leave it. The
      // fingerprint check below only proves the page changed, and a
      // navigation off the application changes the fingerprint too, so it
      // cannot tell a real advance from a wrong destination. This check
      // can: if the click moved the browser to a different HTTP(S) origin,
      // stop before ever filling anything there, naming both origins so the human
      // can see where it went and decide. Ordered after the confirmation
      // check on purpose: a legitimate submit-and-confirm can land on a
      // different origin too (an embedded Greenhouse form completing on
      // boards.greenhouse.io, for one), and confirmationCheck already handles
      // that path with a screenshot and a verified response, so it gets first
      // look. This check is the fallback for every other cross-origin
      // landing, and it deliberately over-blocks: a legitimate same-
      // application handoff to a new origin reads the same as a wrong one from
      // here, so it stops either way and leaves the rest to the human, same
      // bias as browserInterventionBlockers' own SSO handling. A false
      // positive costs one manual step; a false negative is automated
      // form-filling on a page nobody vetted, which is the worse outcome.
      const beforeOrigin = safeHttpOrigin(preAdvanceSnapshot.origin);
      const afterOrigin = safeHttpOrigin(nextSnapshot.origin);
      if (beforeOrigin && afterOrigin && beforeOrigin !== afterOrigin) {
        return {
          available: true,
          verified: false,
          state: "blocked",
          reason: `Clicking "${advanceLabel}" left the application: it moved from ${beforeOrigin} to ${afterOrigin}.`,
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
  }

  return function execute(request = {}) {
    const applicationKey = String(request?.applicationId || "").trim();
    if (!applicationKey) return executeOne(request);
    const running = inFlight.get(applicationKey);
    if (running) return running;

    let shared;
    shared = executeOne(request).finally(() => {
      if (inFlight.get(applicationKey) === shared) inFlight.delete(applicationKey);
    });
    inFlight.set(applicationKey, shared);
    return shared;
  };
}
