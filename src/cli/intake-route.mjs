// intake-route.mjs — M9 Universal Intake's HTTP surface: the drop zone for
// anything a candidate pastes (a JD, a job posting URL, a recruiter email, an
// interview transcript, a status update) plus the confirm-first gate that
// turns a proposed classification into an actual domain write / skill run /
// chat handoff.
//
// Registers:
//   POST /api/intake            capture: { text, inputKind? } -> classify pipeline
//   POST /api/intake/upload     raw bytes, ?name=<filename> -> durable file item
//   GET  /api/intake/list       ?status=&limit=
//   GET  /api/intake/one        ?id=
//   POST /api/intake/classify   { id } — re-run classification
//   POST /api/intake/confirm    { id } — the ONLY place a domain write, skill
//                                run, or workspace intent may start for an item
//   POST /api/intake/dismiss    { id }
//
// Fail-closed 409 no-DB, same as data-route.mjs: intake_items is DB-native
// (migration 002) — a legacy tracker.json-only workspace sees the same
// NoDatabaseError "run careerrat data import/init first" every other
// /api/data/* route already surfaces, not a silent fallback.
//
// ONE-WRITE-PATH + CONFIRM-FIRST: capture/classify never call a domain verb,
// runSkillStream, or workspaceAgentRuntime — see src/core/db/verbs/intake.mjs's own
// header comment and src/core/intake/dispatch.mjs's header comment. Only
// POST /api/intake/confirm executes the {lane, action, params} dispatch
// src/core/intake/dispatch.mjs already resolved at classify time:
//   Lane A — appSetStatus() called directly, then intakeUpdate to done/error
//            (synchronous, same request).
//   Lane B — intakeUpdate to "running", then runSkillStream() fired in the
//            background (NOT awaited by this response — /api/skill/run is
//            normally an SSE stream a live client consumes; this confirm
//            endpoint is a plain JSON responder, so the run's own done/error
//            transition lands via a later intakeUpdate once it settles).
//   Lane W — execute a typed intent on the one durable workspace agent.
//
// `fetchImpl`, `loadSdk`, and `runSkillStream` are all
// dependency-injected (mirroring skill-run-route.mjs/chat-route.mjs/
// resolve.mjs's own conventions) so every path here is testable without a
// real network, SDK devDependency, or subprocess.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { runBoundedAI } from "../core/ai/bounded-ai.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { runSkillStream as defaultRunSkillStream } from "../core/ai/skill-runtime.mjs";
import { requireDb } from "../core/db/connection.mjs";
import {
  appSetStatus,
  InvalidTransitionError,
  intakeCapture,
  intakeDecide,
  intakeList,
  intakeOne,
  intakeUpdate,
} from "../core/db/verbs.mjs";
import { classifyIntakeItem } from "../core/intake/classify.mjs";
import { resolveIntakeDispatch } from "../core/intake/dispatch.mjs";
import { summarizeDispatch } from "../core/intake/dispatch-summary.mjs";
import { matchTrackerRecord } from "../core/intake/match.mjs";
import { normalizeIntakeRequestedAction } from "../core/intake/requested-action.mjs";
import { resolveJobUrl } from "../core/intake/resolve.mjs";
import { extractDocxResumeText, normalizeDocxResumeText } from "../core/onboarding/resume-docx.mjs";
import { userPath } from "../core/paths/workspace.mjs";
import { sanitizeUploadFilename } from "./onboard-route.mjs";
import { readJsonBodyCapped, readRawBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap every other JSON-body route uses.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // binary intake artifacts: PDFs/images/JDs.

// Per-type extraction caps, tighter than MAX_UPLOAD_BYTES above — matches the
// caps the resume routes already settled on (RESUME_AI_MAX_BYTES /
// RESUME_DOCX_MAX_BYTES in onboard-route.mjs): consistency, and because the
// AI-Read-tool path has a real per-call cost/latency floor. .txt/.md/.eml
// decode cheaply, so they stay under the outer 10MB cap only.
const AI_EXTRACT_MAX_BYTES = 5 * 1024 * 1024;
const DOCX_EXTRACT_MAX_BYTES = 5 * 1024 * 1024;
const AI_EXTRACT_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

const INTAKE_EXTRACT_SCHEMA_PATH = "config/intake-extract.schema.json";
const INTAKE_EXTRACT_LABELS = Object.freeze({
  skill: "intake-extract",
  action: "extract",
  operation: "intake.upload-extract",
});
const INTAKE_EXTRACT_MANUAL = Object.freeze({
  available: true,
  reason: "intake-extract-unavailable",
  action: "paste-the-content-as-text",
});

// A re-classify (POST /api/intake/classify) is allowed from any status short
// of "confirmed and past it" — an item already being executed/decided is not
// re-classified out from under that in-flight work.
const RECLASSIFIABLE_STATUSES = new Set([
  "captured",
  "classifying",
  "proposed",
  "needs_you",
  "error",
]);

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (err?.code === "NOT_FOUND") return 404;
  if (err?.code === "INVALID_TRANSITION") return 409;
  return 400; // every other failure here is a caller/body validation problem
}

function respondError(res, err) {
  sendJson(res, statusForError(err), { ok: false, error: err?.message || String(err) });
}

// Single-token http(s) string -> "url"; anything else -> "text". Only used
// when the caller doesn't pass an explicit body.inputKind.
function detectInputKind(raw) {
  const trimmed = raw.trim();
  if (!/\s/.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return "url";
    } catch {
      // not a URL — falls through to "text"
    }
  }
  return "text";
}

// ---------------------------------------------------------------------------
// extractUploadText — turns an uploaded file's raw bytes into plain text so
// it can flow into the SAME classifyAndPropose() path pasted text already
// uses, instead of dead-ending as needs_you for every upload. Dispatches on
// extension:
//   .txt/.md          -> utf8 decode + normalize, always available.
//   .docx              -> mammoth (extractDocxResumeText), always available.
//   .pdf/.png/.jpg/    -> the intake-extract skill (Claude's own Read tool),
//   .jpeg/.webp           gated on an AI route actually being configured.
//   .eml               -> a small hand-rolled header/body + quoted-printable/
//                         base64 splitter — no mail-parsing dependency.
//   anything else      -> unsupported, no attempt.
// Never throws — every failure mode (unsupported type, oversize, no AI
// configured, a provider/parse error) comes back as a normal
// { ok: false, reason } return so the route handler has ONE place to decide
// what happens next, not a scattered try/catch per branch.
// ---------------------------------------------------------------------------

// Loose, intake-scoped "is this real text" gate — deliberately NOT
// looksLikeUsableResumeText (resume-docx.mjs), which false-negatives on
// non-résumé text like a JD or a one-line status update. Just: non-empty
// after trim, and not mostly U+FFFD replacement characters (the tell for a
// lossy decode of binary data as if it were text).
function isUsableExtractedText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  const replacementCount = (trimmed.match(/�/g) || []).length;
  return replacementCount / trimmed.length <= 0.01;
}

// extractionFailureReason — the human copy landed on classification.needsUserReason
// when extraction doesn't succeed. A strict superset of the previous blanket
// "binary file was captured..." message: unsupported/failed types still land
// needs_you exactly like before, just with a more specific reason.
function extractionFailureReason(reason, ext) {
  if (reason === "unsupported-type") {
    return `automatic text extraction isn't available for "${ext}" files. Review it in Inbox and route it manually`;
  }
  if (reason === "ai-not-configured") {
    return "this file needs AI-based extraction (PDF/image), but no AI provider is configured. Configure one, or paste the content as text instead";
  }
  return "automatic text extraction failed for this file. Review it in Inbox and route it manually";
}

// ---------------------------------------------------------------------------
// .eml — best-effort deterministic parse. Split on the first blank line to
// separate headers from body; decode a top-level or (for multipart) a
// text/plain part's Content-Transfer-Encoding (quoted-printable or base64);
// prefer Subject:/From: plus that decoded body as the extracted text.
// Genuinely complex cases (multipart/alternative with only an HTML part,
// S/MIME) degrade to { ok: false } rather than attempting HTML-to-text or
// garbling output. No mailparser dependency — this format is simple enough
// for a hand-rolled decoder.
// ---------------------------------------------------------------------------

function parseHeaderBlock(block) {
  const headers = {};
  let lastKey = null;
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && lastKey) {
      headers[lastKey] += ` ${line.trim()}`;
      continue;
    }
    const m = line.match(/^([\w-]+):\s?(.*)$/);
    if (m) {
      lastKey = m[1].toLowerCase();
      headers[lastKey] = m[2];
    }
  }
  return headers;
}

// RFC 2045 quoted-printable: "=XX" hex-escapes a byte, "=" at end-of-line is
// a soft line break to be removed. Decoded byte-by-byte then re-decoded as
// utf8 so multi-byte characters (encoded as consecutive =XX escapes) survive
// intact.
function decodeQuotedPrintable(text) {
  const joined = String(text || "").replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeEmailBodyPart(bodyText, transferEncoding) {
  const enc = String(transferEncoding || "")
    .toLowerCase()
    .trim();
  if (enc === "quoted-printable") return decodeQuotedPrintable(bodyText);
  if (enc === "base64") {
    try {
      return Buffer.from(String(bodyText || "").replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return bodyText;
}

function parseEmlBytes(bytes) {
  const raw = bytes.toString("utf8").replace(/\r\n/g, "\n");
  const blankIdx = raw.indexOf("\n\n");
  if (blankIdx === -1) return { ok: false, reason: "eml-no-header-body-split" };
  const headers = parseHeaderBlock(raw.slice(0, blankIdx));
  const bodyBlock = raw.slice(blankIdx + 2);

  const contentType = headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  let plainBody = null;

  if (/multipart\//i.test(contentType) && boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = bodyBlock.split(`--${boundary}`).slice(1, -1);
    for (const part of parts) {
      const partBlankIdx = part.indexOf("\n\n");
      if (partBlankIdx === -1) continue;
      const partHeaders = parseHeaderBlock(part.slice(0, partBlankIdx).trim());
      const partBody = part.slice(partBlankIdx + 2);
      const partType = (partHeaders["content-type"] || "text/plain").toLowerCase();
      if (partType.startsWith("text/plain")) {
        plainBody = decodeEmailBodyPart(partBody, partHeaders["content-transfer-encoding"]);
        break;
      }
    }
    if (plainBody === null) return { ok: false, reason: "eml-no-plain-text-part" };
  } else {
    plainBody = decodeEmailBodyPart(bodyBlock, headers["content-transfer-encoding"]);
  }

  const lines = [];
  if (headers.from) lines.push(`From: ${headers.from}`);
  if (headers.subject) lines.push(`Subject: ${headers.subject}`);
  if (lines.length) lines.push("");
  lines.push(String(plainBody || "").trim());
  const text = normalizeDocxResumeText(lines.join("\n"));
  if (!isUsableExtractedText(text)) return { ok: false, reason: "eml-empty-body" };
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// PDF/image -> text via the new backend-only intake-extract skill — modeled
// directly on onboard-route.mjs's runResumeExtractBounded (runSkillStream +
// Read-only tool surface + runBoundedAI's bounded/retry wrapper), minus the
// résumé-specific post-processing: the output schema is just { full_text }.
// ---------------------------------------------------------------------------
async function runIntakeExtractBounded({ savedPath, repoRoot, env, runSkillStream }) {
  const schema = JSON.parse(readFileSync(join(repoRoot, INTAKE_EXTRACT_SCHEMA_PATH), "utf8"));

  async function invoke({ correction }) {
    let rawText = "";
    await runSkillStream({
      skill: "intake-extract",
      action: INTAKE_EXTRACT_LABELS.action,
      operation: INTAKE_EXTRACT_LABELS.operation,
      input: correction
        ? `Read the file at this exact path: ${savedPath}\n\n${correction}`
        : { path: savedPath },
      repoRoot,
      env,
      tools: ["Read"],
      approvedReadPaths: [savedPath],
      outputSchema: schema,
      onEvent: (evt) => {
        if (evt.type !== "assistant") return;
        for (const block of evt.data?.message?.content ?? []) {
          if (block?.type === "text" && typeof block.text === "string") {
            rawText += block.text;
          }
        }
      },
    });
    return rawText;
  }

  return runBoundedAI({
    labels: INTAKE_EXTRACT_LABELS,
    schema,
    manual: INTAKE_EXTRACT_MANUAL,
    structuredMode: "fallback",
    maxRetries: 1,
    invoke: ({ correction }) => invoke({ correction }),
  });
}

async function extractUploadText({
  ext,
  bytes,
  savedPath,
  repoRoot,
  env,
  runSkillStream,
  resolveAIRouteImpl = resolveAIRoute,
}) {
  if (ext === ".txt" || ext === ".md") {
    const text = normalizeDocxResumeText(bytes.toString("utf8"));
    if (!isUsableExtractedText(text)) return { ok: false, reason: "empty-file" };
    return { ok: true, text, extraction: "local" };
  }

  if (ext === ".docx") {
    if (bytes.length > DOCX_EXTRACT_MAX_BYTES) {
      return { ok: false, reason: "too-large-for-extraction" };
    }
    let text;
    try {
      text = await extractDocxResumeText(bytes);
    } catch {
      return { ok: false, reason: "docx-extraction-failed" };
    }
    if (!isUsableExtractedText(text)) return { ok: false, reason: "docx-extraction-failed" };
    return { ok: true, text, extraction: "local" };
  }

  if (ext === ".eml") {
    const parsed = parseEmlBytes(bytes);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return { ok: true, text: parsed.text, extraction: "local" };
  }

  if (AI_EXTRACT_EXTENSIONS.has(ext)) {
    if (bytes.length > AI_EXTRACT_MAX_BYTES) {
      return { ok: false, reason: "too-large-for-ai-extraction" };
    }
    if (resolveAIRouteImpl(env, { repoRoot }).type === "none") {
      return { ok: false, reason: "ai-not-configured" };
    }
    const outcome = await runIntakeExtractBounded({ savedPath, repoRoot, env, runSkillStream });
    if (!outcome.body.ok) return { ok: false, reason: "extraction-failed" };
    const fullText = normalizeDocxResumeText(outcome.body.data?.full_text || "");
    if (!isUsableExtractedText(fullText)) return { ok: false, reason: "extraction-failed" };
    return { ok: true, text: fullText, extraction: "ai" };
  }

  return { ok: false, reason: "unsupported-type" };
}

// ---------------------------------------------------------------------------
// classifyAndPropose — capture -> classify -> match -> dispatch, shared by
// both POST /api/intake (first pass) and POST /api/intake/classify (re-run).
//
// Never lets an unexpected failure here strand the item: the raw capture is
// already durably written (intakeCapture's own DB row + workspace/intake/
// pastes/*.md) before this ever runs, so any error past that point degrades
// the item to status "error" (with the message) rather than 500ing the whole
// request and leaving the caller unsure whether anything was saved at all.
// ---------------------------------------------------------------------------
async function classifyAndPropose({
  repoRoot,
  env,
  id,
  inputKind,
  rawInput,
  requestedAction,
  fetchImpl,
  loadSdk,
}) {
  try {
    intakeUpdate({ repoRoot, env, id, patch: { status: "classifying" } });

    let resolved = null;
    if (inputKind === "url") {
      resolved = await resolveJobUrl(rawInput, { fetchImpl });
    }

    const db = requireDb({ repoRoot, env });

    // Pre-classify trackerMatch: only what's deterministically known before
    // AI runs — a resolved URL's own company/title, or the bare URL itself.
    // Free-text pastes (jd-text, status-update, recruiter-email, …) have no
    // known entities yet at this point, so trackerMatch stays null until the
    // model extracts some.
    let preMatch = null;
    if (resolved?.bodyFetchStatus === "resolved") {
      preMatch = matchTrackerRecord({
        db,
        url: resolved.url,
        company: resolved.company,
        role: resolved.title,
      });
    } else if (inputKind === "url") {
      preMatch = matchTrackerRecord({ db, url: rawInput });
    }

    const classifyResult = await classifyIntakeItem({
      rawInput,
      inputKind,
      resolved,
      trackerMatch: preMatch,
      repoRoot,
      env,
      ...(loadSdk ? { loadSdk } : {}),
    });
    const classification = classifyResult.data;
    const entities = classification.entities || {};

    // Recompute the AUTHORITATIVE trackerMatch off whatever the model
    // extracted — never invented by the model, always this same
    // deterministic query, just re-run with better inputs than pre-classify
    // had. Falls back to preMatch when the model extracted nothing new.
    const finalMatch =
      entities.company || entities.role || entities.url
        ? matchTrackerRecord({
            db,
            url: entities.url || resolved?.url || (inputKind === "url" ? rawInput : null),
            company: entities.company,
            role: entities.role,
          })
        : preMatch;

    let dispatch = null;
    let nextStatus;
    if (classification.needsUser) {
      nextStatus = "needs_you";
    } else {
      dispatch = resolveIntakeDispatch({
        kind: classification.kind,
        entities,
        trackerMatch: finalMatch,
        requestedAction,
      });
      nextStatus = dispatch.action === "needs_you" ? "needs_you" : "proposed";
    }

    return intakeUpdate({
      repoRoot,
      env,
      id,
      patch: {
        status: nextStatus,
        kind: classification.kind,
        classification,
        trackerMatch: finalMatch,
        dispatch,
        // A file upload's rawInput is only known here (the extracted text,
        // threaded straight in as the `rawInput` param above) — it was never
        // set at intakeCapture() time (intake.mjs stores rawInput: null for
        // inputKind:"file"). text/url captures already have rawInput
        // persisted from capture time, so this is a no-op patch for them.
        ...(inputKind === "file" ? { rawInput } : {}),
      },
    }).item;
  } catch (err) {
    return intakeUpdate({ repoRoot, env, id, patch: { status: "error", error: err.message } }).item;
  }
}

// ---------------------------------------------------------------------------
// Confirm-time lane execution — the ONLY code path in this file allowed to
// call a domain verb, runSkillStream, or workspaceAgentRuntime. See dispatch.mjs's own
// header comment for the lane definitions.
// ---------------------------------------------------------------------------

// withDispatchSummary — every response that carries an item with a `dispatch`
// field also carries a `dispatchSummary` string alongside it (M10: killing
// apps/web/src/inbox/dispatch-summary.js's hand-maintained client mirror —
// see dispatch-summary.mjs's own header comment). A cheap pure-function call
// right before sendJson, computed off the SAME dispatch object the item
// already has — never a second derivation.
function withDispatchSummary(item) {
  if (!item) return item;
  return { ...item, dispatchSummary: summarizeDispatch(item.dispatch) };
}

export async function captureIntakeText({
  repoRoot,
  env = process.env,
  text,
  inputKind,
  requestedAction,
  fetchImpl = fetch,
  loadSdk,
} = {}) {
  const rawText = typeof text === "string" ? text : "";
  if (!rawText.trim()) {
    const error = new Error("text is required");
    error.code = "EMPTY_INTAKE";
    throw error;
  }
  if (inputKind !== undefined && inputKind !== "text" && inputKind !== "url") {
    const error = new Error('inputKind must be "text" or "url" when given');
    error.code = "BAD_INTAKE_KIND";
    throw error;
  }
  const normalizedRequestedAction = normalizeIntakeRequestedAction(requestedAction);
  const resolvedKind = inputKind || detectInputKind(rawText);
  const captured = intakeCapture({
    repoRoot,
    env,
    rawInput: rawText,
    inputKind: resolvedKind,
    requestedAction: normalizedRequestedAction,
  });
  const finalItem = await classifyAndPropose({
    repoRoot,
    env,
    id: captured.id,
    inputKind: resolvedKind,
    rawInput: rawText,
    requestedAction: normalizedRequestedAction,
    fetchImpl,
    loadSdk,
  });
  return withDispatchSummary(finalItem);
}

async function executeLaneA({ repoRoot, env, id, dispatch, workspaceAgentRuntime }) {
  const { applicationId, to, note } = dispatch.params;
  if (typeof workspaceAgentRuntime?.executeIntent === "function") {
    const result = await workspaceAgentRuntime.executeIntent({
      intent: {
        type: "outcome.record",
        entity: { type: "application", id: applicationId },
        input: { to, note: note || null, sourceIntakeId: id },
      },
    });
    return intakeUpdate({
      repoRoot,
      env,
      id,
      patch: {
        status: "done",
        result: {
          applicationId,
          to,
          threadId: result.thread?.id || "workspace-main",
        },
        error: null,
      },
    }).item;
  }
  const verbResult = appSetStatus({
    repoRoot,
    env,
    id: applicationId,
    to,
    note: note || undefined,
  });
  return intakeUpdate({
    repoRoot,
    env,
    id,
    patch: { status: "done", result: { applicationId, to, meta: verbResult.meta } },
  }).item;
}

// The evaluate-job input shape a Lane B run needs isn't pinned by name
// elsewhere in this milestone's scope — this is the smallest defensible
// mapping off what classify.mjs already extracted: the URL when one is
// known, the raw pasted JD text otherwise, plus whatever company/role the
// model pulled out as extra grounding.
function buildLaneBInput(item) {
  const entities = item.classification?.entities || {};
  return {
    url: entities.url || (item.inputKind === "url" ? item.rawInput : null),
    text: item.inputKind === "text" ? item.rawInput : null,
    company: entities.company || null,
    role: entities.role || null,
  };
}

// Fires runSkillStream() in the background and returns immediately with the
// item already flipped to "running" — this confirm endpoint is a plain JSON
// responder, not the SSE stream POST /api/skill/run normally is, so nothing
// here awaits the run itself; onEvent is a no-op (a future iteration could
// persist progress events onto the item, or re-expose them over its own SSE
// — out of this milestone's scope).
function executeLaneB({ repoRoot, env, id, item, dispatch, runSkillStream }) {
  const running = intakeUpdate({ repoRoot, env, id, patch: { status: "running" } }).item;
  const skill = dispatch.params.skill;
  const input = buildLaneBInput(item);
  const controller = new AbortController();
  runSkillStream({ skill, input, repoRoot, env, onEvent: () => {}, signal: controller.signal })
    .then((resultData) => {
      const failed = resultData?.ok === false;
      intakeUpdate({
        repoRoot,
        env,
        id,
        patch: {
          status: failed ? "error" : "done",
          result: resultData,
          error: failed ? resultData?.error || "skill run did not complete" : null,
        },
      });
    })
    .catch((err) => {
      intakeUpdate({ repoRoot, env, id, patch: { status: "error", error: err.message } });
    });
  return running;
}

async function executeLaneW({ repoRoot, env, id, dispatch, workspaceAgentRuntime }) {
  if (typeof workspaceAgentRuntime?.executeIntent !== "function") {
    const error = new Error("the workspace agent is unavailable for this confirmed intake item");
    error.code = "WORKSPACE_AGENT_UNAVAILABLE";
    throw error;
  }
  const result = await workspaceAgentRuntime.executeIntent({
    intent: {
      type: dispatch.params.intentType,
      entity: { type: "intake", id },
    },
  });
  const actionResult = [...(result.messages || [])]
    .reverse()
    .find((message) => message.kind === "action_result");
  const evaluationArtifact = actionResult?.artifacts?.find(
    (artifact) => artifact.kind === "job_evaluation"
  );
  const resultArtifacts = Array.isArray(actionResult?.artifacts)
    ? actionResult.artifacts.filter((artifact) =>
        ["job_evaluation", "packet_generation", "application_handoff"].includes(artifact?.kind)
      )
    : [];
  return intakeUpdate({
    repoRoot,
    env,
    id,
    patch: {
      status: "done",
      result: {
        threadId: result.thread?.id || "workspace-main",
        intentType: dispatch.params.intentType,
        summary: actionResult?.text || null,
        communicationId: actionResult?.metadata?.communicationId || null,
        applicationId: actionResult?.metadata?.applicationId || null,
        evaluation: evaluationArtifact?.evaluation || null,
        artifacts: resultArtifacts,
        state: actionResult?.metadata?.state || null,
        nextActions: actionResult?.metadata?.nextActions || [],
      },
      error: null,
    },
  }).item;
}

// ---------------------------------------------------------------------------
// mountIntakeRoutes
// ---------------------------------------------------------------------------

export function mountIntakeRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  loadSdk,
  runSkillStream = defaultRunSkillStream,
  workspaceAgentRuntime,
  captureTextImpl = captureIntakeText,
}) {
  addRoute("POST", "/api/intake", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }

    try {
      const finalItem = await captureTextImpl({
        repoRoot,
        env,
        text: body?.text,
        inputKind: body?.inputKind,
        requestedAction: body?.requestedAction,
        fetchImpl,
        loadSdk,
      });
      sendJson(res, 200, { ok: true, item: finalItem });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/intake/upload", async (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const name = (requestUrl.searchParams.get("name") || "").trim();
    if (!name) {
      sendJson(res, 400, { ok: false, error: "?name=<filename> is required" });
      return;
    }

    try {
      requireDb({ repoRoot, env });
    } catch (err) {
      respondError(res, err);
      return;
    }

    let bytes;
    try {
      bytes = await readRawBodyCapped(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    if (!bytes.length) {
      sendJson(res, 400, { ok: false, error: "request body is empty" });
      return;
    }

    const safeName = sanitizeUploadFilename(name);
    const ext = extname(safeName).toLowerCase();
    let requestedAction;
    try {
      requestedAction = normalizeIntakeRequestedAction(
        requestUrl.searchParams.get("requestedAction")
      );
    } catch (err) {
      respondError(res, err);
      return;
    }
    const relPath = `workspace/intake/uploads/${Date.now()}-${safeName}`;
    const absPath = userPath({ repoRoot, env }, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, bytes);

    let captured;
    try {
      captured = intakeCapture({
        repoRoot,
        env,
        inputKind: "file",
        sourceFilePath: relPath,
        requestedAction,
      });
    } catch (err) {
      respondError(res, err);
      return;
    }

    // Extract text first, THEN classify — the same classifyAndPropose()
    // path pasted text/url captures already use. Every failure mode here
    // (unsupported type, oversize, no AI configured, a provider/parse
    // error) still lands the item at needs_you exactly like the old
    // unconditional behavior did, just with a specific, honest reason
    // instead of one blanket message.
    const extraction = await extractUploadText({
      ext,
      bytes,
      savedPath: absPath,
      repoRoot,
      env,
      runSkillStream,
    });

    if (extraction.ok) {
      await classifyAndPropose({
        repoRoot,
        env,
        id: captured.id,
        inputKind: "file",
        rawInput: extraction.text,
        requestedAction,
        fetchImpl,
        loadSdk,
      });
      const withExtraction = intakeUpdate({
        repoRoot,
        env,
        id: captured.id,
        patch: { extraction: extraction.extraction },
      }).item;
      sendJson(res, 200, { ok: true, item: withDispatchSummary(withExtraction) });
      return;
    }

    const finalItem = intakeUpdate({
      repoRoot,
      env,
      id: captured.id,
      patch: {
        status: "needs_you",
        kind: "other",
        classification: {
          kind: "other",
          entities: {
            company: null,
            role: null,
            url: null,
            statusTo: null,
            statusNote: null,
            contactName: null,
            contactEmail: null,
            interviewDate: null,
          },
          proposedAction: "File captured. Review it in Inbox and route it manually.",
          confidence: 0,
          needsUser: true,
          needsUserReason: extractionFailureReason(extraction.reason, ext),
        },
        trackerMatch: null,
        dispatch: null,
      },
    }).item;

    sendJson(res, 200, { ok: true, item: withDispatchSummary(finalItem) });
  });

  addRoute("GET", "/api/intake/list", (req, res) => {
    try {
      const status = queryParam(req, "status") || undefined;
      const limitParam = queryParam(req, "limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
      const items = intakeList({ repoRoot, env, status, limit });
      sendJson(res, 200, { ok: true, items: items.map(withDispatchSummary) });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("GET", "/api/intake/one", (req, res) => {
    const id = queryParam(req, "id");
    if (!id) {
      sendJson(res, 400, { ok: false, error: "?id= is required" });
      return;
    }
    try {
      const item = intakeOne({ repoRoot, env, id });
      if (!item) {
        sendJson(res, 404, { ok: false, error: `no intake item with id "${id}"` });
        return;
      }
      sendJson(res, 200, { ok: true, item: withDispatchSummary(item) });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/intake/classify", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const id = body?.id;
    if (!id) {
      sendJson(res, 400, { ok: false, error: "body.id is required" });
      return;
    }

    let existing;
    try {
      existing = intakeOne({ repoRoot, env, id });
    } catch (err) {
      respondError(res, err);
      return;
    }
    if (!existing) {
      sendJson(res, 404, { ok: false, error: `no intake item with id "${id}"` });
      return;
    }
    if (!RECLASSIFIABLE_STATUSES.has(existing.status)) {
      respondError(
        res,
        new InvalidTransitionError(
          `intake item "${id}" cannot be re-classified from status "${existing.status}"`
        )
      );
      return;
    }

    const finalItem = await classifyAndPropose({
      repoRoot,
      env,
      id,
      inputKind: existing.inputKind,
      rawInput: existing.rawInput,
      requestedAction: existing.requestedAction,
      fetchImpl,
      loadSdk,
    });
    sendJson(res, 200, { ok: true, item: withDispatchSummary(finalItem) });
  });

  addRoute("POST", "/api/intake/confirm", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const id = body?.id;
    if (!id) {
      sendJson(res, 400, { ok: false, error: "body.id is required" });
      return;
    }

    let existing;
    try {
      existing = intakeOne({ repoRoot, env, id });
    } catch (err) {
      respondError(res, err);
      return;
    }
    if (!existing) {
      sendJson(res, 404, { ok: false, error: `no intake item with id "${id}"` });
      return;
    }
    if (existing.dispatch?.lane === "C") {
      sendJson(res, 409, {
        ok: false,
        error: "This intake item uses a retired dispatch. Reclassify it before confirming.",
      });
      return;
    }

    let decided;
    try {
      decided = intakeDecide({
        repoRoot,
        env,
        id,
        decision: "confirm",
        dispatchSummary: summarizeDispatch(existing.dispatch),
      });
    } catch (err) {
      respondError(res, err);
      return;
    }

    const dispatch = existing.dispatch;
    let finalItem = decided.item;
    try {
      if (dispatch?.lane === "A") {
        finalItem = await executeLaneA({
          repoRoot,
          env,
          id,
          dispatch,
          workspaceAgentRuntime,
        });
      } else if (dispatch?.lane === "B") {
        finalItem = executeLaneB({ repoRoot, env, id, item: existing, dispatch, runSkillStream });
      } else if (dispatch?.lane === "W") {
        finalItem = await executeLaneW({
          repoRoot,
          env,
          id,
          dispatch,
          workspaceAgentRuntime,
        });
      } else {
        // Defensive only: dispatch.mjs never returns a lane-less action
        // except "needs_you", and intakeDecide's CONFIRMABLE_STATUSES
        // already excludes needs_you items from ever reaching here.
        throw new Error(
          `intake item "${id}" has an unrecognized dispatch lane "${dispatch?.lane}"`
        );
      }
    } catch (err) {
      finalItem = intakeUpdate({
        repoRoot,
        env,
        id,
        patch: { status: "error", error: err.message },
      }).item;
    }

    sendJson(res, 200, { ok: true, item: finalItem });
  });

  addRoute("POST", "/api/intake/dismiss", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const id = body?.id;
    if (!id) {
      sendJson(res, 400, { ok: false, error: "body.id is required" });
      return;
    }
    try {
      const decided = intakeDecide({ repoRoot, env, id, decision: "dismiss" });
      sendJson(res, 200, { ok: true, item: decided.item });
    } catch (err) {
      respondError(res, err);
    }
  });
}
