import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { loadAutomation, mayRun } from "../automation/consent.mjs";
import { resolveSession } from "../automation/session.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import {
  capturePacketQuestions,
  classifySelfIdentificationQuestion,
} from "../packet/questions.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import {
  buildFillPlan,
  confirmationCheck,
  hostnameToPortal,
  isEasyApply,
  submitGuard,
} from "./form-fill.mjs";

const FIELD_ROLES = new Map([
  ["textbox", "text"],
  ["combobox", "select"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
]);

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

function requiredRef(snapshot, ref) {
  const marker = `ref=${ref}`;
  return String(snapshot || "")
    .split(/\r?\n/)
    .some((line) => line.includes(marker) && /\[.*\brequired\b.*\]/.test(line));
}

export function renderedFieldsFromSnapshot(snapshotResult = {}) {
  const refs =
    snapshotResult.refs && typeof snapshotResult.refs === "object" ? snapshotResult.refs : {};
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
      required: requiredRef(snapshotResult.snapshot, ref),
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

function parsedSnapshotNodes(snapshot) {
  const nodes = [];
  const parents = [];
  for (const rawLine of String(snapshot || "").split(/\r?\n/)) {
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
  for (const node of parsedSnapshotNodes(snapshotResult.snapshot)) {
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

function loadAnswerMap({ repoRoot, env, application }) {
  const stored = application?.artifacts?.answersSource || application?.artifacts?.answers;
  const path = safeWorkspaceArtifact(repoRoot, env, stored);
  if (!path || !/\.md$/i.test(path)) return new Map();
  try {
    return answerSections(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

function orcaExecutable(env) {
  const configured = String(env?.ORCA_CLI_COMMAND || "").trim();
  if (configured && !/\s/.test(configured)) return configured;
  return process.platform === "linux" && !env?.ORCA_WORKTREE_ID ? "orca-ide" : "orca";
}

function runOrcaCommand(args, { env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      orcaExecutable(env),
      args,
      {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 12 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        let payload = null;
        try {
          payload = JSON.parse(String(stdout || ""));
        } catch {
          payload = null;
        }
        if (error || !payload?.ok) {
          const failure = new Error(
            payload?.error?.message || error?.message || "The Orca browser command failed."
          );
          failure.code = payload?.error?.code || error?.code || "ORCA_BROWSER_FAILED";
          reject(failure);
          return;
        }
        resolve(payload.result || {});
      }
    );
  });
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
  return renderedFieldsFromSnapshot(snapshot).find(
    (field) => field.id === step.id && field.type === step.type
  );
}

function currentUploadTarget(step, snapshot) {
  return uploadTargetsFromSnapshot(snapshot).find((target) => target.kind === step.kind);
}

function browserInterventionBlockers(snapshot) {
  const blockers = [...submitGuard({ pageText: snapshot?.snapshot }).blockers];
  const fields = renderedFieldsFromSnapshot(snapshot);
  if (
    fields.some((field) =>
      /\b(password|create (?:an? )?account|security answer)\b/i.test(field.label)
    )
  ) {
    blockers.push("account creation or password entry");
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

function screenshotPath({ repoRoot, env, applicationId, data, format }) {
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

function commandForStep(step, pageId) {
  if (step.type === "text") {
    return [
      "fill",
      "--page",
      pageId,
      "--element",
      `@${step.ref}`,
      "--value",
      String(step.value),
      "--json",
    ];
  }
  if (step.type === "select") {
    return [
      "select",
      "--page",
      pageId,
      "--element",
      `@${step.ref}`,
      "--value",
      String(step.value),
      "--json",
    ];
  }
  if (step.type === "checkbox" && /^(yes|true|1)$/i.test(String(step.value))) {
    return ["check", "--page", pageId, "--element", `@${step.ref}`, "--json"];
  }
  return null;
}

export function createOrcaApplyExecutor({
  repoRoot,
  env = process.env,
  runOrcaImpl = (args) => runOrcaCommand(args, { env, cwd: repoRoot }),
  captureQuestionsImpl = capturePacketQuestions,
  candidateConfigGetImpl = candidateConfigGet,
  loadAnswerMapImpl = loadAnswerMap,
  mayRunImpl = mayRun,
  saveScreenshotImpl = screenshotPath,
} = {}) {
  const sessions = new Map();

  return async function execute({ applicationId, application, postingUrl, questionCapture } = {}) {
    const url = safePostingUrl(postingUrl);
    if (!url) {
      return {
        available: false,
        verified: false,
        state: "unavailable",
        reason: "A valid HTTP application link is required.",
      };
    }

    if (isEasyApply(url)) {
      const permission = mayRunImpl({
        capability: "one_click_apply",
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
          session: { provider: "orca", blockers },
        };
      }
    }

    let pageId = sessions.get(String(applicationId));
    if (!pageId) {
      const opened = await runOrcaImpl(["tab", "create", "--url", url, "--json"]);
      pageId = String(opened?.browserPageId || "").trim();
      if (!pageId) throw new Error("Orca did not return a browser page id.");
      sessions.set(String(applicationId), pageId);
    }

    const snapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
    const confirmation = confirmationCheck({
      pageText: snapshot.snapshot,
      currentUrl: snapshot.origin,
    });
    if (confirmation.submitted) {
      const screenshot = await runOrcaImpl(["screenshot", "--page", pageId, "--json"]);
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
        session: { provider: "orca" },
        artifacts: [
          {
            kind: "submission_confirmation",
            title: "Verified submission confirmation",
            path,
          },
        ],
      };
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
          provider: "orca",
          filledCount: 0,
          uploadedCount: 0,
          unresolved: [],
          blockers: interventionBlockers,
          submitMode: "manual",
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
          provider: "orca",
          answerableCount: captured.questions?.length || 0,
          excludedCount: captured.excluded?.length || 0,
          demographicSectionPresent: captured.demographicSectionPresent === true,
        },
      };
    }

    const config = candidateConfigGetImpl({ repoRoot, env });
    const answers = await loadAnswerMapImpl({ repoRoot, env, application });
    const plan = fillPlan({ fields, config, application, answers });
    const initialGuard = submitGuard({
      pageText: snapshot.snapshot,
      formDefaults: config?.["form-defaults"] || {},
    });
    if (initialGuard.blockers.length) {
      return {
        available: true,
        verified: false,
        state: "blocked",
        reason: `Stopped on ${initialGuard.blockers.join(", ")}.`,
        currentUrl: snapshot.origin || url,
        session: {
          provider: "orca",
          filledCount: 0,
          uploadedCount: 0,
          unresolved: [],
          blockers: initialGuard.blockers,
          submitMode: initialGuard.mode,
        },
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
      const freshSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
      const freshField = currentField(step, freshSnapshot);
      const command = freshField ? commandForStep({ ...step, ref: freshField.ref }, pageId) : null;
      if (!command) {
        unresolved.push({
          label: step.label,
          required: step.required,
          reason: "The field changed before it could be filled.",
        });
        continue;
      }
      try {
        await runOrcaImpl(command);
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
      const freshSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
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
        await runOrcaImpl([
          "upload",
          "--page",
          pageId,
          "--element",
          `@${freshTarget.ref}`,
          "--files",
          file,
          "--json",
        ]);
        uploadedCount += 1;
      } catch (error) {
        unresolved.push({
          label: target.label,
          required: target.required,
          reason: String(error?.message || "This file could not be attached.").slice(0, 240),
        });
      }
    }

    const finalSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
    const guard = submitGuard({
      pageText: finalSnapshot.snapshot,
      formDefaults: config?.["form-defaults"] || {},
    });
    return {
      available: true,
      verified: false,
      state: guard.blockers.length ? "blocked" : "awaiting-submit",
      reason: guard.blockers.length
        ? `Stopped on ${guard.blockers.join(", ")}.`
        : "Review the live form and submit it in the supervised browser, then ask CareerRat to verify it.",
      currentUrl: finalSnapshot.origin || snapshot.origin || url,
      session: {
        provider: "orca",
        filledCount,
        uploadedCount,
        unresolved,
        blockers: guard.blockers,
        submitMode: guard.mode,
      },
    };
  };
}

export function createConfiguredApplyExecutor({
  repoRoot,
  env = process.env,
  loadAutomationImpl = loadAutomation,
  ...options
} = {}) {
  let provider = "extension";
  try {
    const data = loadAutomationImpl({ root: repoRoot }).data;
    provider = resolveSession({ data, env }).provider;
  } catch {
    return null;
  }
  if (provider !== "orca") return null;

  const execute = createOrcaApplyExecutor({ repoRoot, env, ...options });
  return async (input) => {
    try {
      return await execute(input);
    } catch (error) {
      return {
        available: false,
        verified: false,
        state: "unavailable",
        reason: `The Orca supervised browser is unavailable: ${String(
          error?.message || "browser command failed"
        ).slice(0, 300)}`,
      };
    }
  };
}
