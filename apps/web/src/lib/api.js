// apps/web/src/lib/api.js — thin fetch wrappers over the existing
// src/cli/onboard-route.mjs HTTP surface. No parallel settings store, no
// data-fetching library: M7's data surface is one settings screen with no
// cross-page cache invalidation need (see the M7 design memo §4). Every
// Settings read/write funnels through the named functions below rather than
// a raw fetch() scattered through components. The backend keeps these route
// names stable while writing the canonical local database.
export class ApiError extends Error {
  constructor(status, body) {
    super(`request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// The exact refusal string request-security.mjs sends when the per-launch
// HttpOnly capability cookie is missing or doesn't match. The dev server
// mints a fresh capability on every process start, and the file watcher
// restarts that process on a concurrent CLI write to a watched workspace
// file — an open tab's cookie goes stale mid-session with no user action
// (issue #86). Matched by exact string, not just status 401, so a real
// auth failure (wrong-origin request, expired session elsewhere, etc.)
// never gets silently retried and masked.
const CAPABILITY_INVALID_ERROR = "local browser capability is missing or invalid";

function isCapabilityCredentialError(status, body) {
  return status === 401 && body?.error === CAPABILITY_INVALID_ERROR;
}

// Refreshing the cookie is just an ordinary bootstrap GET (request-security.mjs's
// isHtmlBootstrap sets a fresh Set-Cookie on any GET to /app, unauthenticated) —
// no dedicated refresh endpoint needed. Multiple requests failing at once
// (e.g. a burst of calls right after the restart) share one in-flight
// refresh instead of each firing its own bootstrap GET.
let capabilityRefresh = null;
function refreshCapabilityCookie() {
  if (!capabilityRefresh) {
    capabilityRefresh = fetch("/app", { method: "GET" })
      .catch(() => null)
      .finally(() => {
        capabilityRefresh = null;
      });
  }
  return capabilityRefresh;
}

async function apiFetch(path, options = {}, { retried = false } = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    // One silent retry with a freshly minted cookie — the common case (a
    // restart that happened while this tab sat idle) never surfaces an
    // error at all. Never retried twice: if the fresh cookie still 401s,
    // something else is wrong and that's a real error to surface.
    if (!retried && isCapabilityCredentialError(res.status, body)) {
      await refreshCapabilityCookie();
      return apiFetch(path, options, { retried: true });
    }
    throw new ApiError(res.status, body);
  }
  return body;
}

async function apiBinaryFetch(path, options = {}, { retried = false } = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    if (!retried && isCapabilityCredentialError(res.status, body)) {
      await refreshCapabilityCookie();
      return apiBinaryFetch(path, options, { retried: true });
    }
    throw new ApiError(res.status, body);
  }
  const blob = await res.blob();
  const signature = new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer());
  if (signature !== "%PDF-") {
    throw new ApiError(502, { error: "dossier export returned invalid PDF bytes" });
  }
  const disposition = res.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || "interview-dossier.pdf";
  const encodedPath = res.headers.get("x-careerrat-artifact-path") || "";
  let artifactPath = "";
  try {
    artifactPath = decodeURIComponent(encodedPath);
  } catch {
    artifactPath = "";
  }
  return { blob, filename, path: artifactPath };
}

let workspaceRequestSequence = 0;

function durableWorkspaceRequestId(value) {
  const supplied = String(value || "").trim();
  if (supplied) return supplied;
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `workspace-${random}`;
  workspaceRequestSequence += 1;
  return `workspace-${Date.now().toString(36)}-${workspaceRequestSequence.toString(36)}`;
}

// Commits a typed workspace intent classified from a free-text query.
export function runWorkspaceIntent(type, entity, input = {}, { requestId } = {}) {
  return apiFetch("/api/workspace/intent", {
    method: "POST",
    body: JSON.stringify({
      requestId: durableWorkspaceRequestId(requestId),
      intent: { type, entity, input },
    }),
  });
}

// ---------------------------------------------------------------------------
// Free-text workspace turns and classify-only previews.
// ---------------------------------------------------------------------------

// POST /api/workspace/message — runWorkspaceAgentTurn. Committing the ANSWER
// row: starts a durable workspace operation. The caller follows the returned
// operation id while the server appends the eventual reply to the one thread.
export function sendWorkspaceMessage(text, context, choice, { requestId } = {}) {
  return apiFetch("/api/workspace/message", {
    method: "POST",
    body: JSON.stringify({
      requestId: durableWorkspaceRequestId(requestId),
      text,
      ...(context ? { context } : {}),
      ...(choice ? { choice } : {}),
    }),
  });
}

// POST /api/workspace/preview — previewWorkspaceIntent. Classify-only: never
// executes anything and never writes to the thread. Returns
// { action: { label, intent } | null, answer: { label }, engineAvailable }.
export function previewWorkspaceQuery(text, context) {
  return apiFetch("/api/workspace/preview", {
    method: "POST",
    body: JSON.stringify({ text, ...(context ? { context } : {}) }),
  });
}

export function getOnboardState() {
  return apiFetch("/api/onboard/state");
}

export function getOnboardingDraft() {
  return apiFetch("/api/onboard/draft");
}

export function saveOnboardingDraft(draft) {
  return apiFetch("/api/onboard/draft", {
    method: "POST",
    body: JSON.stringify(draft || {}),
  });
}

export function finishOnboarding() {
  return apiFetch("/api/onboard/finish", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function setPublicSyncPreference(enabled) {
  return apiFetch("/api/onboard/public-sync-preference", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function getInstalledAiRuntimes() {
  return apiFetch("/api/settings/ai-runtimes");
}

export function getAiPreferences() {
  return apiFetch("/api/settings/ai-preferences");
}

export function saveAiPreferences({ quality, reasoning } = {}) {
  return apiFetch("/api/settings/ai-preferences", {
    method: "POST",
    body: JSON.stringify({ quality, reasoning }),
  });
}

export function getRuntimeConfig() {
  return apiFetch("/api/runtime/config");
}

export function requestHostedInterest(email) {
  return apiFetch("/api/hosted-interest", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function getAutomationSettings() {
  return apiFetch("/api/settings/automation");
}

export function setAutomationSessionProvider(provider) {
  return apiFetch("/api/settings/automation/session", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export function probeInstalledAiRuntime(runtimeId) {
  return apiFetch("/api/settings/ai-runtime/probe", {
    method: "POST",
    body: JSON.stringify({ runtimeId }),
  });
}

export function startInstalledAiRuntimeSignIn(runtimeId) {
  return apiFetch("/api/settings/ai-runtime/sign-in", {
    method: "POST",
    body: JSON.stringify({ runtimeId }),
  });
}

export async function startInstalledAiRuntimeGuidedSetup(runtimeId, { onEvent, signal } = {}) {
  const res = await fetch("/api/settings/ai-runtime/guided-setup", {
    method: "POST",
    body: JSON.stringify({ runtimeId }),
    headers: { "content-type": "application/json" },
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    throw new ApiError(res.status, body);
  }

  let result = null;
  let streamError = null;
  await parseSseStream(res.body, {
    onEvent(event) {
      onEvent?.(event);
      if (event?.type === "done") result = { runtimeId: event.runtimeId };
      if (event?.type === "error") streamError = event;
    },
  });
  if (streamError) {
    const error = new Error(streamError.message || "Claude Code did not finish installing.");
    error.code = streamError.code;
    throw error;
  }
  if (!result) throw new Error("The Claude Code installer stopped before it finished.");
  return result;
}

export function selectInstalledAiRuntime({ runtimeId, providerFallback = false } = {}) {
  return apiFetch("/api/settings/ai-runtime/select", {
    method: "POST",
    body: JSON.stringify({ runtimeId, providerFallback }),
  });
}

// `patch` is deep-merged server-side onto the current candidate setup doc:
// object keys merge recursively, but any ARRAY in `patch` REPLACES the
// corresponding array wholesale. Every array-typed field this is ever called with must be resent
// in full — never a subset — or the rest silently truncates on write. None
// of M7's Settings fields are arrays; a future section that edits one
// (e.g. targeting.role_families) must respect this.
export function saveCandidateFile(name, patch) {
  return apiFetch(`/api/onboard/candidate/${name}`, {
    method: "POST",
    body: JSON.stringify({ data: patch }),
  });
}

// ---------------------------------------------------------------------------
// M8 — the /app/onboarding wizard's surface. Every function below is a thin
// wrapper over an M8 backend route (src/cli/onboard-route.mjs,
// assist-route.mjs, logo-route.mjs, boards-route.mjs, chat-route.mjs) —
// same "no parallel store" discipline as the M7 functions above.
// ---------------------------------------------------------------------------

export function initOnboard() {
  return apiFetch("/api/onboard/init", { method: "POST" });
}

// The M1 deterministic path for pasted/manual text when the structured AI
// extractor is unavailable.
export function parseResumeText(text, { save = true } = {}) {
  return apiFetch("/api/onboard/resume", {
    method: "POST",
    body: JSON.stringify({ text, save }),
  });
}

// POST /api/onboard/resume-ai's frozen contract: PDF, image, or text résumé
// uploads send the file's raw bytes (no JSON envelope), bypassing apiFetch's
// content-type:application/json default entirely. `file` is a browser File
// (from a drop or a picker); its own `.type` becomes the request's
// Content-Type, which the server ignores (it keys off the `name` query
// param's extension, not the header). Same ApiError-on-!ok contract as
// apiFetch, including status codes 501 (no key)/502 (provider/runtime
// failure)/413 (too large)/422 (unparseable after retry)/400 (bad extension).
// On success this unwraps the shared bounded-AI body.data envelope so
// ResumeStep.applySeed() still receives the original seed object shape.
export async function extractResumeAi(file) {
  const res = await fetch(`/api/onboard/resume-ai?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  if (body?.ok === true && body?.data && typeof body.data === "object") {
    return {
      ...body.data,
      ...(body.operation ? { operation: body.operation } : {}),
      seedSaved: body.operation?.status === "completed",
    };
  }
  return body;
}

export async function getResumeExtraction({ id, digest } = {}) {
  const query = new URLSearchParams();
  if (id) query.set("id", id);
  if (digest) query.set("digest", digest);
  const body = await apiFetch(
    `/api/onboard/resume-ai/operation${query.size ? `?${query.toString()}` : ""}`
  );
  return body.operation || null;
}

// Shared SSE-over-fetch frame parser: frames are `data: <json>\n\n`, plus
// bare `: ping` heartbeat comment lines the sender uses to keep the
// connection alive (skipped, never handed to onEvent). Unlike sse.js's
// postSSE (event:<name>/data:<json> pairs), there is no separate `event:`
// line here — each frame's parsed JSON payload carries its own "type" field,
// so onEvent gets the parsed payload object directly rather than a (type,
// data) pair. Tolerates a frame (or even a single "data:" line) split across
// two chunk reads by buffering any trailing partial frame between
// reader.read() calls. `body` is a ReadableStream (a Response's `.body`) —
// callers own checking `res.ok`/`res.body` before handing it in here.
async function parseSseStream(body, { onEvent } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function emitFrame(frame) {
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw) continue;
      try {
        onEvent?.(JSON.parse(raw));
      } catch {
        /* malformed frame — skip it rather than aborting the whole stream */
      }
    }
  }

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (frame.trim()) emitFrame(frame);
    }
  }
  // A stream that ends without one final trailing blank line still leaves
  // its last frame sitting in `buffer` — flush it rather than dropping it.
  if (buffer.trim()) emitFrame(buffer);
}

// POST /api/onboard/resume-ai-stream's frozen contract: same raw-bytes-as-
// body / filename-as-query convention as extractResumeAi above, but the
// response is text/event-stream instead of buffered JSON, parsed by
// parseSseStream above (frame payloads carry their own "type" field:
// saved/activity/json/restart/done/error). Throws (with .status, once known)
// on a non-200 response or a body-less response so callers can fall back to
// the buffered extractResumeAi — same as a static-preview build, which has
// no streaming route at all and throws immediately below rather than faking
// an SSE sequence.
export async function streamResumeAi(file, { onEvent, signal } = {}) {
  const res = await fetch(`/api/onboard/resume-ai-stream?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    throw new ApiError(res.status, body);
  }

  await parseSseStream(res.body, { onEvent });
}

// POST /api/search/ai-web-search/run — the Jobs > Search tab's AI web-search
// lane. Same `data: <json>\n\n` frame / `: ping` heartbeat contract as
// resume-ai-stream above (parsed by the same parseSseStream), but this
// route's own payload shapes: {type:"activity", message} progress lines,
// {type:"done", data:{searched, found, new, duplicates, errors}}, and
// {type:"error", message}. No request body — the server reads the saved
// search prompts itself (see getSearchPrompts/saveSearchPrompts above).
// Pre-stream failures are ordinary ApiError throws: 409 while a run is
// already in flight, other 4xx/5xx for no-AI/no-prompts/lean-downshift with
// the API's standard error shape. Static preview has no run route at all —
// same immediate-throw contract as streamResumeAi above.
export async function runAiWebSearchStream({ onEvent, promptIds, searchExecutionId, signal } = {}) {
  const res = await fetch("/api/search/ai-web-search/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(Array.isArray(promptIds) ? { promptIds } : {}),
      ...(searchExecutionId ? { searchExecutionId } : {}),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    throw new ApiError(res.status, body);
  }

  await parseSseStream(res.body, { onEvent });
}

export async function extractResumeDocx(file) {
  const res = await fetch(`/api/onboard/resume-docx?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export function saveEvidenceSeed(claims) {
  return apiFetch("/api/onboard/evidence-seed", {
    method: "POST",
    body: JSON.stringify({ claims }),
  });
}

export function replaceEvidenceClaims(claims) {
  return apiFetch("/api/onboard/candidate/evidence/replace", {
    method: "POST",
    body: JSON.stringify({ claims }),
  });
}

// POST /api/onboard/candidate/evidence/remove — delete exactly one evidence
// claim by id (Library drawer's Delete affordance for evidence-kind cards).
// Editing an existing claim reuses saveCandidateFile("evidence", {claims}) —
// candidateEvidenceMerge's id-match path updates in place rather than
// duplicating, so no separate "edit" wrapper is needed.
export function removeEvidenceClaim(id) {
  return apiFetch("/api/onboard/candidate/evidence/remove", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function getSourcingRun({ purpose, id, signal } = {}) {
  const params = new URLSearchParams();
  if (purpose) params.set("purpose", purpose);
  if (id) params.set("id", id);
  const query = params.toString();
  return apiFetch(`/api/sourcing/runs/latest${query ? `?${query}` : ""}`, {
    ...(signal ? { signal } : {}),
  });
}

export function getSearchSourceStatus() {
  return apiFetch("/api/search/sources");
}

// AI search-assistant prompts (src/cli/search-route.mjs) — generate-first:
// CareerRat generates the prompts, the user edits/adds/removes afterward.
// GET/PUT both unwrap to the stored { id, text, source, updatedAt } list;
// generate additionally persists server-side before returning it.
export function getSearchPrompts() {
  return apiFetch("/api/search/prompts", { method: "GET" });
}

export function generateSearchPrompts() {
  return apiFetch("/api/search/prompts/generate", { method: "POST" });
}

export function saveSearchPrompts(prompts) {
  return apiFetch("/api/search/prompts", {
    method: "PUT",
    body: JSON.stringify({ prompts }),
  });
}

export function startFirstSearchRun(payload = {}) {
  return apiFetch("/api/sourcing/first-run/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function startSearchRun(payload = {}) {
  return apiFetch("/api/sourcing/search/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createCompanyProposals(payload = {}) {
  return apiFetch("/api/discovery/company-proposals", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getAppOperation(id) {
  const body = await apiFetch(
    `/api/app-operations/operation?id=${encodeURIComponent(String(id || ""))}`
  );
  return body.operation || null;
}

export function retryAppOperation(id) {
  return apiFetch("/api/app-operations/retry", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function getCompanyProposalBatch(batchId) {
  const body = await apiFetch(
    `/api/discovery/company-proposals?id=${encodeURIComponent(String(batchId || ""))}`
  );
  return body?.data?.batch || null;
}

export function decideCompanyProposal(payload = {}) {
  return apiFetch("/api/discovery/company-proposal-decisions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// POST /api/assist/suggest — AI-suggest chips. `kind` is "titles" or
// "keywords"; 501 when no AI route is configured, 422 when the model never
// produces valid structured output after one retry — both are ordinary
// ApiError throws the caller catches and degrades on (hide/disable the
// assist affordance), never a hard block.
export async function suggestAssist(kind, input) {
  const body = await apiFetch("/api/assist/suggest", {
    method: "POST",
    body: JSON.stringify({ kind, input }),
  });
  const data = body?.data && typeof body.data === "object" ? body.data : {};
  return {
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    ...(data.rationale ? { rationale: data.rationale } : {}),
    ...(body?.ai ? { ai: body.ai } : {}),
    ...(body?.manual ? { manual: body.manual } : {}),
  };
}

export function addBoard({ url, label }) {
  return apiFetch("/api/boards/add", {
    method: "POST",
    body: JSON.stringify({ url, label }),
  });
}

export function getSourceMaintenance() {
  return apiFetch("/api/boards/sources");
}

// ---------------------------------------------------------------------------
// First-run chat runtime (src/cli/chat-route.mjs). GET /api/chat/events is a
// plain GET SSE stream consumed directly via useEventSource (../lib/sse.js).
// ---------------------------------------------------------------------------

export function startChat(skill, input) {
  return apiFetch("/api/chat/start", {
    method: "POST",
    body: JSON.stringify({ skill, input }),
  });
}

export function sendChatMessage(chatId, text, choice) {
  return apiFetch("/api/chat/message", {
    method: "POST",
    body: JSON.stringify({ chatId, text, ...(choice ? { choice } : {}) }),
  });
}

export function recordSkillChatDecision(decision) {
  return apiFetch("/api/chat/decision", {
    method: "POST",
    body: JSON.stringify(decision || {}),
  });
}

export function completeDiscovery(step) {
  return apiFetch("/api/discovery/complete", {
    method: "POST",
    body: JSON.stringify({ step }),
  });
}

export function findChatBySkill(skill) {
  return apiFetch(`/api/chat/by-skill?skill=${encodeURIComponent(skill)}`);
}

// ---------------------------------------------------------------------------
// Chat-first dashboard aggregate and retained typed workspace actions.
// ---------------------------------------------------------------------------

// GET /api/data/dashboard — one call, the whole server-derived view model
// (focus, nextSteps, jobs incl. rows/funnel/rail, calendar, activity, …).
// NEVER re-derive CTA/focus/calendar/job-action rules client-side — every
// M10 view renders this payload's fields directly (M10 design doc §2).
export function getDashboard() {
  return apiFetch("/api/data/dashboard");
}

// Visible status changes belong to the one durable workspace agent. The
// deterministic outcome writer still owns the canonical DB transition behind
// this typed intent.
export function setAppStatus({ id, to, note, followUpDueAt, clearInterview } = {}) {
  return runWorkspaceIntent(
    "outcome.record",
    { type: "application", id },
    {
      to,
      note,
      followUpDueAt,
      clearInterview,
    }
  );
}

export function recordExternalApplication({ id, appliedAt } = {}) {
  return runWorkspaceIntent(
    "application.record-external",
    { type: "application", id },
    {
      appliedAt,
    }
  );
}

export function applyOnSite({ id } = {}) {
  return runWorkspaceIntent("job.prepare-submit", { type: "application", id });
}

// POST /api/data/app/interview — appScheduleInterview verb. A second call
// while an interview is already future-set books the NEXT round into
// nextInterviewAt instead of interviewAt (see verbs/app.mjs's own comment) —
// the caller never has to decide which field to write.
export function scheduleInterview({ id, at, round, note } = {}) {
  return runWorkspaceIntent(
    "interview.schedule",
    { type: "application", id },
    {
      at,
      round,
      note,
    }
  );
}

// POST /api/data/comm/send — commMarkSent verb. The literal mechanism behind
// the self-clearing "Ready to send" CTA: nulls comm.draft (and, if linked,
// app.followUp.draft) server-side in one write.
export function markCommSent({ id, at, summary } = {}) {
  return runWorkspaceIntent(
    "communication.record-external",
    { type: "communication", id },
    {
      sentAt: at,
      summary,
    }
  );
}

// POST /api/data/sourced/promote — sourcedPromote verb (the folded-in
// sourced-triage tab's "Gate this role" action: moves a sourced[] row into
// applications[] as status "reviewed-hold").
export function promoteSourced({ id, appRow } = {}) {
  return runWorkspaceIntent(
    "sourced.promote",
    { type: "sourced", id },
    {
      ...(appRow ? { appRow } : {}),
    }
  );
}

// POST /api/data/sourced/status — sourcedSetStatus verb. The Jobs Search
// tab's Skip action calls this with to:"cut" (the taxonomy's archived,
// recoverable sourced[] state — track-outcomes SKILL.md's canonical status
// vocabulary); there's no "park"/"hold" sourced[] state in that vocabulary.
export function setSourcedStatus({ id, to, note } = {}) {
  return runWorkspaceIntent(
    "sourced.skip",
    { type: "sourced", id },
    {
      ...(to && to !== "cut" ? { requestedStatus: to } : {}),
      ...(note ? { note } : {}),
    }
  );
}

// ---------------------------------------------------------------------------
// Chat-first packet reads and exports. POST /api/packet/export wraps its
// payload as {ok, data}; GET /api/packet returns the packet object directly.
// ---------------------------------------------------------------------------

// POST /api/packet/export — exportPacketArtifacts. Renders the generated
// markdown sources to real PDF/DOCX files under workspace/tailored/ and
// registers them on the application row; `userFacing` in the response is
// {resume:[{format,path,name}], coverLetter:[...], answers:[...]}.
export function exportPacketDocuments({ applicationId, formats } = {}) {
  return apiFetch("/api/packet/export", {
    method: "POST",
    body: JSON.stringify({ applicationId, formats }),
  });
}

// GET /api/packet?id= — NOT wrapped in {ok,data} (see this section's header
// comment) — returns {id, company, role, resumeNote, artifacts:{resume,
// coverLetter, answers}} directly, each artifact either null or
// {path, markdown, html, binary, kind, url, needsYou?}.
export function getPacket(id) {
  return apiFetch(`/api/packet?id=${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Chat-first deep ingest: state, source submit/upload, proposal build, and
// proposal decisions. Each write is followed by a canonical state read.
// ---------------------------------------------------------------------------

// GET /api/deep-ingest/state — buildDeepIngestViewModel()'s full view model
// (lanes, readiness, sources, proposals, review queue, confirmed rows).
// Unwraps the {ok, data} envelope so callers get the view model directly.
export async function getDeepIngestState() {
  const body = await apiFetch("/api/deep-ingest/state");
  return body?.data ?? body;
}

// POST /api/deep-ingest/sources — `payload` IS normalizeDeepIngestSource()'s
// input shape verbatim: targetShape, sourceKind, plus `text` (paste/note
// kinds) or `url` (url/linkedin/portfolio/project_link kinds) — see
// core/deep-ingest/source-normalize.mjs for the full per-kind field
// contract.
export function submitDeepIngestSource(payload = {}) {
  return apiFetch("/api/deep-ingest/sources", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function removeDeepIngestSource({ sourceId } = {}) {
  return apiFetch("/api/deep-ingest/sources/remove", {
    method: "POST",
    body: JSON.stringify({ sourceId }),
  });
}

export function retryDeepIngestSource({ sourceId } = {}) {
  return apiFetch("/api/deep-ingest/sources/retry", {
    method: "POST",
    body: JSON.stringify({ sourceId }),
  });
}

// POST /api/deep-ingest/sources/upload uses raw bytes as the body; targetShape
// and the filename travel as query params.
export async function uploadDeepIngestFile(file, { targetShape } = {}) {
  const params = new URLSearchParams();
  if (targetShape) params.set("targetShape", targetShape);
  params.set("name", file.name);
  const res = await fetch(`/api/deep-ingest/sources/upload?${params.toString()}`, {
    method: "POST",
    body: file,
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body?.data ?? body;
}

// POST /api/deep-ingest/proposals — runs the target lane's AI proposal
// builder against an already-scanned source's chunks and persists the
// resulting review rows (evidence/story/honesty/writing_voice/role_signal/
// gap; `targetShape` defaults server-side to the source's own targetShape
// when omitted). Explicit, button-click-only call — deep-ingest never fires
// this itself after a scan (intent-gated AI spend, same rule as every other
// AI-spend surface in this app).
export function buildDeepIngestProposals(payload = {}) {
  return apiFetch("/api/deep-ingest/proposals", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// POST /api/deep-ingest/proposal-decisions — `decision` is "confirm" (routes
// to deepIngestConfirmProposal) or one of deepIngestProposalDecision's verbs
// ("save_edits" | "defer" | "mark_not_available" | "reject" | "reopen" |
// "retry"); `reason` is required for defer/mark_not_available/reject (see
// verbs/deep-ingest.mjs's PROPOSAL_DECISION_TO_STATUS map).
export function decideDeepIngestProposal(payload = {}) {
  return apiFetch("/api/deep-ingest/proposal-decisions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function upsertDeepIngestConfirmedItem(payload = {}) {
  return apiFetch("/api/deep-ingest/confirmed/upsert", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Chat-first job artifacts and interview dossier reads.
// ---------------------------------------------------------------------------

// GET /api/jobs/job-description?source=application|sourced&id= —
// readJobDescriptionArtifact. Returns {id, recordType, company, role,
// artifact: {kind, completeness, capturedAt, sourceName, sourceUrl, markdown,
// html, bodyChars, technical:{path}}} — already shaped for
// ArtifactViewerModal's `artifact.html` branch. Throws ApiError with codes
// JD_NOT_CAPTURED/JD_FILE_MISSING (expected "nothing captured yet" states)
// or JD_TOO_LARGE/UNSAFE_ARTIFACT_PATH (defensive, unexpected) — callers
// distinguish on err.body.code, not just err.status.
export function getJobDescription({ source, id } = {}) {
  return apiFetch(
    `/api/jobs/job-description?source=${encodeURIComponent(source || "")}&id=${encodeURIComponent(id || "")}`
  );
}

// GET /api/interview-prep?id= — reads back app.artifacts.interviewDossier.
// A dossier that has not been built yet is a console-clean 200 with
// data.state:"missing" and dossier:null; callers render the Build action.
export function getInterviewDossier(id) {
  return apiFetch(`/api/interview-prep?id=${encodeURIComponent(id || "")}`);
}

// ---------------------------------------------------------------------------
// Chat-first workspace. The aggregate read is included in
// GET /api/data/dashboard as data.chatFirst so the page, decision queue, and
// activity pill stay on one snapshot. These writes own only durable
// conversation, mission, and mock-session state. Application submission is
// intentionally absent: the final submit always belongs to the user.
// ---------------------------------------------------------------------------

export function pinJobThread({ applicationId, pinned = true } = {}) {
  return apiFetch("/api/chat-first/job-thread/pin", {
    method: "POST",
    body: JSON.stringify({ applicationId, pinned }),
  });
}

export function archiveJobThread({ applicationId, archived = true } = {}) {
  return apiFetch("/api/chat-first/job-thread/archive", {
    method: "POST",
    body: JSON.stringify({ applicationId, archived }),
  });
}

export function dismissTouchDue({ id, source } = {}) {
  return apiFetch("/api/chat-first/touch-due/dismiss", {
    method: "POST",
    body: JSON.stringify({ id, source }),
  });
}

export function dismissDeepIngestPrompt() {
  return apiFetch("/api/chat-first/deep-ingest-prompt/dismiss", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function openDeepIngestThread() {
  return apiFetch("/api/chat-first/deep-ingest/open", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function decideChatFirstSourced(payload = {}) {
  return apiFetch("/api/chat-first/sourced/decision", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function appendJobThreadMessage({
  applicationId,
  role,
  kind,
  text,
  metadata,
  artifacts,
} = {}) {
  return apiFetch("/api/chat-first/job-thread/message", {
    method: "POST",
    body: JSON.stringify({ applicationId, role, kind, text, metadata, artifacts }),
  });
}

export function sendJobThreadTurn({ applicationId, text, choice } = {}) {
  return apiFetch("/api/chat-first/job-thread/turn", {
    method: "POST",
    body: JSON.stringify({ applicationId, text, ...(choice ? { choice } : {}) }),
  });
}

export function exportInterviewDossierPdf({ applicationId, artifactPath } = {}) {
  return apiBinaryFetch("/api/chat-first/dossier/pdf", {
    method: "POST",
    body: JSON.stringify({ applicationId, artifactPath }),
  });
}

export function createChatFirstMission(payload = {}) {
  return apiFetch("/api/chat-first/missions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function runChatFirstMission(id) {
  return apiFetch("/api/chat-first/missions/run", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function resumeChatFirstMission(id, { focusApplicationId } = {}) {
  return apiFetch("/api/chat-first/missions/resume", {
    method: "POST",
    body: JSON.stringify({ id, ...(focusApplicationId ? { focusApplicationId } : {}) }),
  });
}

export function setChatFirstMissionStatus({ id, status } = {}) {
  return apiFetch("/api/chat-first/missions/status", {
    method: "POST",
    body: JSON.stringify({ id, status }),
  });
}

export function setChatFirstMissionStepStatus({ missionId, stepId, status, result, error } = {}) {
  return apiFetch("/api/chat-first/missions/step", {
    method: "POST",
    body: JSON.stringify({ missionId, stepId, status, result, error }),
  });
}

export function startMockInterview({ applicationId, questionTotal, title, context } = {}) {
  return apiFetch("/api/chat-first/mock/start", {
    method: "POST",
    body: JSON.stringify({ applicationId, questionTotal, title, context }),
  });
}

export function sendMockInterviewMessage({
  sessionId,
  role,
  kind,
  questionNumber,
  text,
  metadata,
} = {}) {
  return apiFetch("/api/chat-first/mock/message", {
    method: "POST",
    body: JSON.stringify({ sessionId, role, kind, questionNumber, text, metadata }),
  });
}

export function sendMockInterviewTurn({ sessionId, text } = {}) {
  return apiFetch("/api/chat-first/mock/turn", {
    method: "POST",
    body: JSON.stringify({ sessionId, text }),
  });
}

export function recordMockFeedback({ sessionId, messageId, questionNumber, worked, tighten } = {}) {
  return apiFetch("/api/chat-first/mock/feedback", {
    method: "POST",
    body: JSON.stringify({ sessionId, messageId, questionNumber, worked, tighten }),
  });
}

export function endMockInterview({ sessionId, summary } = {}) {
  return apiFetch("/api/chat-first/mock/end", {
    method: "POST",
    body: JSON.stringify({ sessionId, summary }),
  });
}
