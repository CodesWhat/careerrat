// apps/web/src/lib/api.js — thin fetch wrappers over the existing
// src/cli/onboard-route.mjs HTTP surface. No parallel settings store, no
// data-fetching library: M7's data surface is one settings screen with no
// cross-page cache invalidation need (see the M7 design memo §4). Every
// Settings read/write funnels through the named functions below rather than
// a raw fetch() scattered through components. The backend keeps these route
// names stable while writing SQLite in DB mode and YAML only as a legacy
// compatibility export.
import {
  isStaticPreviewApi,
  staticPreviewApiFetch,
  staticPreviewResumeSeed,
} from "../preview/staticPreviewApi.js";

export class ApiError extends Error {
  constructor(status, body) {
    super(`request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path, options = {}) {
  if (isStaticPreviewApi()) return staticPreviewApiFetch(path, options);

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
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

// Exported (not just used internally below) so the ask bar (app-shell/AskBar.jsx)
// can commit whatever typed intent POST /api/workspace/preview classified a
// free-text query into, the same way every typed button action in this file
// already does — see workspace-agent-route.mjs's own contract.
export function runWorkspaceIntent(type, entity, input = {}) {
  return apiFetch("/api/workspace/intent", {
    method: "POST",
    body: JSON.stringify({ intent: { type, entity, input } }),
  });
}

// ---------------------------------------------------------------------------
// W3 — the shell-docked ask bar (app-shell/AskBar.jsx). Same
// src/cli/workspace-agent-route.mjs surface runWorkspaceIntent above already
// wraps, plus the two routes that had no frontend caller before this build:
// the free-text agent turn and the classify-only preview.
// ---------------------------------------------------------------------------

// POST /api/workspace/message — runWorkspaceAgentTurn. Committing the ANSWER
// row: appends `text` to the one durable workspace thread and returns the
// assistant's reply already appended (see workspace-agent.mjs's own
// contract) — no separate poll needed to see the reply, though the ask bar
// still polls getWorkspaceThread while an ACTION intent is in flight.
export function sendWorkspaceMessage(text) {
  return apiFetch("/api/workspace/message", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

// POST /api/workspace/preview — previewWorkspaceIntent. Classify-only: never
// executes anything and never writes to the thread. Returns
// { action: { label, intent } | null, answer: { label }, engineAvailable }.
export function previewWorkspaceQuery(text) {
  return apiFetch("/api/workspace/preview", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

// GET /api/workspace/thread — the same durable thread every workspace route
// above appends to. The ask bar polls this while an ACTION intent runs in
// the background (non-streaming — see workspace-agent-route.mjs's own
// header comment on why this stays a poll rather than SSE).
export function getWorkspaceThread() {
  return apiFetch("/api/workspace/thread");
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

export function getAiSettings() {
  return apiFetch("/api/settings/ai");
}

export function getInstalledAiRuntimes() {
  return apiFetch("/api/settings/ai-runtimes");
}

export function getAutomationSettings() {
  return apiFetch("/api/settings/automation");
}

export function probeInstalledAiRuntime(runtimeId) {
  return apiFetch("/api/settings/ai-runtime/probe", {
    method: "POST",
    body: JSON.stringify({ runtimeId }),
  });
}

export function openInstalledAiRuntimeTerminal(runtimeId) {
  return apiFetch("/api/settings/ai-runtime/open-terminal", {
    method: "POST",
    body: JSON.stringify({ runtimeId }),
  });
}

export function selectInstalledAiRuntime({ runtimeId, providerFallback = false } = {}) {
  return apiFetch("/api/settings/ai-runtime/select", {
    method: "POST",
    body: JSON.stringify({ runtimeId, providerFallback }),
  });
}

// W4 onboarding 3d/3f "Custom command" — any text-in/text-out command works.
// /custom/test never persists anything (the "Test" button); /custom/select
// persists it as the active runtime (runtimeId "custom").
export function testCustomAiRuntime(command) {
  return apiFetch("/api/settings/ai-runtime/custom/test", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

export function selectCustomAiRuntime(command) {
  return apiFetch("/api/settings/ai-runtime/custom/select", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

// POST /api/hosted-interest — the W4 engine picker's hosted "CareerRat AI"
// card. REQUEST ACCESS transforms in place into an inline email capture;
// this call only fires once that email passes the client's own shape check,
// carrying the address the server records alongside requested_at (see
// hosted-interest-route.mjs for its own re-check and for where this
// eventually forwards to EmailOctopus/PostHog once credentials exist). Not
// an engine selection — nothing here touches the installed-runtime
// selection file.
export function requestHostedInterest(email) {
  return apiFetch("/api/hosted-interest", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function getUsageSummary() {
  return apiFetch("/api/settings/usage");
}

export function validateAndSaveAiKey(apiKey, { provider = "anthropic" } = {}) {
  return apiFetch("/api/settings/ai-key/validate", {
    method: "POST",
    body: JSON.stringify({ apiKey, provider }),
  });
}

export function checkAiKey({ provider = "anthropic" } = {}) {
  return apiFetch("/api/settings/ai-key/check", {
    method: "POST",
    body: JSON.stringify({ provider }),
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

// The M1 deterministic path — .txt/.md resumes, or the paste-fallback
// textarea any AI path (resume-ai) degrades to on 422/501/502.
export function parseResumeText(text, { save = true } = {}) {
  return apiFetch("/api/onboard/resume", {
    method: "POST",
    body: JSON.stringify({ text, save }),
  });
}

// POST /api/onboard/resume-ai's frozen contract: the request body IS the
// file's raw bytes (no JSON envelope) — bypasses apiFetch's
// content-type:application/json default entirely. `file` is a browser File
// (from a drop or a picker); its own `.type` becomes the request's
// Content-Type, which the server ignores (it keys off the `name` query
// param's extension, not the header). Same ApiError-on-!ok contract as
// apiFetch, including status codes 501 (no key)/502 (provider/runtime
// failure)/413 (too large)/422 (unparseable after retry)/400 (bad extension).
// On success this unwraps the shared bounded-AI body.data envelope so
// ResumeStep.applySeed() still receives the original seed object shape.
export async function extractResumeAi(file) {
  if (isStaticPreviewApi()) return staticPreviewResumeSeed(file?.name);

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
  if (body?.ok === true && body?.data && typeof body.data === "object") return body.data;
  return body;
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
  if (isStaticPreviewApi()) {
    throw new ApiError(501, { error: "resume-ai-stream is unavailable in static preview" });
  }

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
export async function runAiWebSearchStream({ onEvent, promptIds, signal } = {}) {
  if (isStaticPreviewApi()) {
    throw new ApiError(501, { error: "ai-web-search run is unavailable in static preview" });
  }

  const res = await fetch("/api/search/ai-web-search/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(Array.isArray(promptIds) ? { promptIds } : {}) }),
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
  if (isStaticPreviewApi()) return staticPreviewResumeSeed(file?.name);

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

export function writeConfig() {
  return apiFetch("/api/onboard/write-config", { method: "POST" });
}

export function startQuickSearch() {
  return apiFetch("/api/onboard/quick-start", { method: "POST" });
}

export function getSourcingRun({ purpose } = {}) {
  const params = new URLSearchParams();
  if (purpose) params.set("purpose", purpose);
  const query = params.toString();
  return apiFetch(`/api/sourcing/runs/latest${query ? `?${query}` : ""}`);
}

export function getSearchSources() {
  return apiFetch("/api/search/sources", { method: "GET" });
}

// AI search-assistant prompts (src/cli/search-route.mjs) — generate-first:
// Rolester generates the prompts, the user edits/adds/removes afterward.
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

export function getDiscoveryState() {
  return apiFetch("/api/discovery/state");
}

export function getRuntimeConfig() {
  return apiFetch("/api/runtime/config");
}

export function createCompanyProposals(payload = {}) {
  return apiFetch("/api/discovery/company-proposals", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getCompanyProposals({ status } = {}) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch(`/api/discovery/company-proposals${query}`);
}

export function decideCompanyProposal(payload = {}) {
  return apiFetch("/api/discovery/company-proposal-decisions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function startDiscoveryQuickStart() {
  return apiFetch("/api/discovery/quick-start", { method: "POST" });
}

export function startDiscoveryNext() {
  return apiFetch("/api/discovery/next", { method: "POST" });
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

// GET /api/logos/search?q= — logo.dev Brand Search proxy. Always 200
// (never throws for "no token configured" — see logo-route.mjs's own
// {ok:false, reason:"no-token", results:[]} degrade contract), so this
// deliberately does NOT go through apiFetch's !res.ok throw path for the
// no-token case; a genuine network/parse failure still throws.
export async function searchLogos(query) {
  return apiFetch(`/api/logos/search?q=${encodeURIComponent(query)}`);
}

// Not a fetch wrapper — GET /api/logos/img?domain= is meant to be used
// directly as an <img src>, so the caller gets a URL string to hand to the
// DOM (which does its own onerror-based fallback to an initials chip on a
// 404/miss), not a fetch()+JSON round trip.
export function logoImageUrl(input) {
  const source = input && typeof input === "object" ? input : { domain: input };
  const parts = [];
  const domain = String(source.domain || "").trim();
  const name = String(source.name || "").trim();
  if (domain) parts.push(`domain=${encodeURIComponent(domain)}`);
  if (name) parts.push(`name=${encodeURIComponent(name)}`);
  return `/api/logos/img?${parts.join("&")}`;
}

// POST /api/boards/preview — deterministic, no persistence; both builders
// degrade independently (see boards-route.mjs), so a partial preview (one
// board present, the other's `*Error` set) is a normal 200, not a throw.
export function previewBoards({ keywords, location, remote, minimumBase, windowHours } = {}) {
  return apiFetch("/api/boards/preview", {
    method: "POST",
    body: JSON.stringify({ keywords, location, remote, minimumBase, windowHours }),
  });
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

export function addSearchQuery({ query, label, provider = "HiringCafe" }) {
  return apiFetch("/api/boards/search/add", {
    method: "POST",
    body: JSON.stringify({ query, label, provider }),
  });
}

export function updateSearchSource({ index, label, target, enabled }) {
  return apiFetch("/api/boards/search/update", {
    method: "POST",
    body: JSON.stringify({ index, label, target, enabled }),
  });
}

export function removeSearchSource(index) {
  return apiFetch("/api/boards/search/remove", {
    method: "POST",
    body: JSON.stringify({ index }),
  });
}

export function saveCompanyBoard({ originalName, name, url, enabled = true }) {
  return apiFetch("/api/boards/company/save", {
    method: "POST",
    body: JSON.stringify({ originalName, name, url, enabled }),
  });
}

export function removeCompanyBoard(name) {
  return apiFetch("/api/boards/company/remove", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

// ---------------------------------------------------------------------------
// Chat runtime (src/cli/chat-route.mjs) — the Companies step's "Find
// companies" panel drives discover-companies through this exact
// surface. GET /api/chat/events is intentionally NOT wrapped here: it's a
// plain GET SSE stream, consumed directly via useEventSource
// (../lib/sse.js), same convention as that file's own header comment.
// ---------------------------------------------------------------------------

export function startChat(skill, input) {
  return apiFetch("/api/chat/start", {
    method: "POST",
    body: JSON.stringify({ skill, input }),
  });
}

export function sendChatMessage(chatId, text) {
  return apiFetch("/api/chat/message", {
    method: "POST",
    body: JSON.stringify({ chatId, text }),
  });
}

export function closeChat(chatId) {
  return apiFetch("/api/chat/close", {
    method: "POST",
    body: JSON.stringify({ chatId }),
  });
}

export function findChatBySkill(skill) {
  return apiFetch(`/api/chat/by-skill?skill=${encodeURIComponent(skill)}`);
}

// ---------------------------------------------------------------------------
// M9 — Universal Intake (src/cli/intake-route.mjs). Capture + classify never
// touch domain data (see that route file's own header comment) — only
// POST /api/intake/confirm may dispatch a verb call / skill run / chat
// handoff, and every intake verb's own state machine is fail-closed 409 on a
// legacy (no-DB) workspace, same NO_DATABASE contract as every /api/data/*
// route. `createIntake`'s response already carries the FULL classify result
// (kind, entities, trackerMatch, dispatch) — the create call is awaited
// server-side end to end, not a "submitted, poll for it" shape.
// ---------------------------------------------------------------------------

// `inputKind` is optional — server-side detectInputKind() infers "url" vs
// "text" from the raw string when omitted; the docked capture bar never
// needs to guess this itself.
export function createIntake({ text, inputKind } = {}) {
  return apiFetch("/api/intake", {
    method: "POST",
    body: JSON.stringify({ text, ...(inputKind ? { inputKind } : {}) }),
  });
}

export async function uploadIntakeFile(file) {
  const res = await fetch(`/api/intake/upload?name=${encodeURIComponent(file.name)}`, {
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

export function listIntake({ status, limit } = {}) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return apiFetch(`/api/intake/list${qs ? `?${qs}` : ""}`);
}

export function getIntakeOne(id) {
  return apiFetch(`/api/intake/one?id=${encodeURIComponent(id)}`);
}

// Re-runs classification from scratch on the item's original raw_input —
// allowed by the server from "captured"/"classifying"/"proposed"/"needs_you"/
// "error" (see intake-route.mjs's RECLASSIFIABLE_STATUSES); a 409 means the
// item has already moved past that (confirmed/running/done/dismissed).
export function reclassifyIntake(id) {
  return apiFetch("/api/intake/classify", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

// The ONLY call in this file that can result in a domain write / skill run /
// chat session starting — see intake-route.mjs's own confirm handler. Only
// legal from status "proposed"; a 409 means someone already decided this item.
export function confirmIntake(id) {
  return apiFetch("/api/intake/confirm", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function dismissIntake(id) {
  return apiFetch("/api/intake/dismiss", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

// ---------------------------------------------------------------------------
// M10 — the DB-served dashboard view model (src/cli/dashboard-route.mjs) and
// the six drawer writes the Jobs/Calendar/Home surfaces ship (existing
// src/cli/data-route.mjs verb routes — no new server surface). 409 NO_DATABASE
// is the same fail-closed contract every /api/data/* route already uses; every
// caller here is expected to catch ApiError and show the server's own hint
// (see CaptureBar.jsx's describeCaptureError for the house pattern) rather
// than inventing a second "no database" message.
// ---------------------------------------------------------------------------

// GET /api/data/dashboard — one call, the whole server-derived view model
// (focus, nextSteps, jobs incl. rows/funnel/rail, calendar, activity, …).
// NEVER re-derive CTA/focus/calendar/job-action rules client-side — every
// M10 view renders this payload's fields directly (M10 design doc §2).
export function getDashboard() {
  return apiFetch("/api/data/dashboard");
}

// GET /api/data/applications/one?id= — the RAW application row (not the
// derived jobs.rows[] shape). The drawer's read-modify-write writes
// (follow-up complete, note edit) need this: appSetFields is a shallow
// one-level merge (verbs/app.mjs), so patching a nested sub-object
// (followUp, roleFit) from anything less than the FULL current sub-object
// silently drops sibling keys not named in the patch.
export function getApplication(id) {
  return apiFetch(`/api/data/applications/one?id=${encodeURIComponent(id)}`);
}

// GET /api/data/communications — the raw list, no server-side
// ?applicationId= filter exists (data-route.mjs only filters applications by
// status/company). Callers filter client-side by applicationId — fine at
// this repo's single-user, hundreds-of-rows scale (M10 design doc §2).
export function getCommunications() {
  return apiFetch("/api/data/communications");
}

// Merge helper for the appSetFields shallow-merge trap above: read the
// app's CURRENT sub-object (or {} if absent), overlay `updates`, and hand the
// FULL merged object back to the caller to send as the patch value — never
// send a bare partial for an object-typed field.
export function mergeNestedField(app, field, updates) {
  const current = app?.[field];
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, ...updates };
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
  return runWorkspaceIntent("job.apply", { type: "application", id });
}

// POST /api/data/app/fields — appSetFields verb (shallow one-level merge
// server-side; see mergeNestedField above for the object-field trap).
export function setAppFields({ id, patch } = {}) {
  return apiFetch("/api/data/app/fields", {
    method: "POST",
    body: JSON.stringify({ id, patch }),
  });
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

// POST /api/data/comm/message — commAppendMessage verb ("add a note to the
// thread" affordance; `message.direction` is "note" for a plain drawer note).
export function appendCommMessage({ id, message } = {}) {
  return runWorkspaceIntent(
    "communication.add-note",
    { type: "communication", id },
    {
      summary: message?.summary,
      at: message?.at,
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

// GET /api/data/applications — the raw applications[] rows (not the derived
// dashboard.jobs.rows shape). Used to read back fields dashboard-data.js
// never maps through to the derived row (e.g. packetGate, stamped by
// PacketGateCard's setAppFields call) — see useApplicationGates.js.
export function getApplications() {
  return apiFetch("/api/data/applications");
}

// ---------------------------------------------------------------------------
// Packet engine (src/cli/packet-route.mjs) — the Jobs drawer's Evaluate/
// Documents sections. Every route here already existed and is already
// mounted; this file only adds thin client wrappers, same convention as
// every other section above. NOTE the response-shape split: the POST routes
// (gate/generate/export) wrap their payload as {ok, data}, but GET /api/packet
// returns its object directly (no {ok,data} envelope) — see packet-route.mjs.
// ---------------------------------------------------------------------------

// POST /api/packet/gate — evaluatePacketGate. Body is applicationId-keyed;
// `jobBody`/`jobUrl` are optional overrides (evaluatePacketGate reads the
// already-captured JD off the application's artifacts.jd by default — see
// the JD-body capture invariant in AGENTS.md — so a normal call only needs
// applicationId). The route atomically persists the returned typed evaluation
// and its list/drawer projections before responding.
export function runPacketGate({ applicationId, jobBody, jobUrl } = {}) {
  return apiFetch("/api/packet/gate", {
    method: "POST",
    body: JSON.stringify({ applicationId, jobBody, jobUrl }),
  });
}

// POST /api/packet/generate — generatePacket. Requires packet questions to
// already be captured for this application (POST /api/packet/questions,
// out of this UI's scope) — an application with none throws
// BAD_QUESTION_CAPTURE, surfaced as an ordinary ApiError.
export function generatePacketDocuments({ applicationId, applyIntent, formats } = {}) {
  return apiFetch("/api/packet/generate", {
    method: "POST",
    body: JSON.stringify({ applicationId, applyIntent, formats }),
  });
}

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

// Not a fetch wrapper — GET /api/packet/artifact?id=&kind= is meant to be
// used directly as a binary embed src (PDF/DOCX), same convention as
// logoImageUrl above. Only meaningful when the artifact view's own `.url`
// field (from getPacket) is set (binary artifacts only).
export function packetArtifactUrl(id, kind) {
  return `/api/packet/artifact?id=${encodeURIComponent(id)}&kind=${encodeURIComponent(kind)}`;
}

// ---------------------------------------------------------------------------
// Deep ingest workbench (src/cli/deep-ingest-route.mjs) — the six-endpoint
// surface behind DeepIngestPage.jsx: state, source submit (paste/link JSON)
// and upload (raw file bytes), a proposal build step, proposal decisions
// (confirm/save edits/defer/mark not available/reject/reopen/retry), and lane
// state writes. Every write mutates SQLite source/proposal/lane rows
// directly (core/db/verbs/deep-ingest.mjs) and returns its own partial shape,
// so DeepIngestPage always re-reads getDeepIngestState() after a write rather
// than trying to merge a response into local state — this file stays a thin
// fetch layer with no derived state of its own.
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

export function removeDeepIngestSource(payload = {}) {
  return apiFetch("/api/deep-ingest/sources/remove", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// POST /api/deep-ingest/sources/upload — same raw-bytes-as-body convention
// as extractResumeAi/uploadIntakeFile above: targetShape and the filename
// travel as query params, the File itself IS the request body.
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

// POST /api/deep-ingest/lane-states — direct deepIngestLaneSetState write;
// `reason` is required when `status` is "deferred" or "not_available".
export function updateDeepIngestLaneState(payload = {}) {
  return apiFetch("/api/deep-ingest/lane-states", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// POST /api/deep-ingest/confirmed/update — { lane, id, ...fields } edits one
// already-confirmed row in one of the four per-lane reference tables
// (story_bank/honesty_boundaries/writing_voice/role_signals) — Library
// drawer's Edit/Save affordance for story/voice/honesty/role_signal cards.
// Re-runs the privacy guard only server-side, never grounding/quote-matching.
export function updateDeepIngestConfirmedItem(payload = {}) {
  return apiFetch("/api/deep-ingest/confirmed/update", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// POST /api/deep-ingest/confirmed/remove — { lane, id } deletes exactly one
// row from the matching per-lane reference table — Library drawer's Delete
// affordance for story/voice/honesty/role_signal cards.
export function removeDeepIngestConfirmedItem(payload = {}) {
  return apiFetch("/api/deep-ingest/confirmed/remove", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Jobs drawer follow-ups (ISSUE-030/ISSUE-035/ISSUE-038) — the JD-artifact
// viewer, the interview-prep dossier builder/reader, and the AI-drafted
// communication reply. Every route here already existed and is already
// mounted (job-artifact-route.mjs, interview-prep-route.mjs,
// workspace-agent.mjs's communication.draft intent) — same thin-wrapper
// convention as every other section above.
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

// POST /api/interview-prep/build — buildInterviewDossier. AI-spend surface,
// explicit-click only (never auto-fires on mount). Returns {ok, data:
// {applicationId, dossier: {title, round, path, generatedAt, markdown}, ...}}.
export function buildInterviewDossier({ applicationId, audience, inviteNotes, jobSignals } = {}) {
  return apiFetch("/api/interview-prep/build", {
    method: "POST",
    body: JSON.stringify({ applicationId, audience, inviteNotes, jobSignals }),
  });
}

// GET /api/interview-prep?id= — reads back app.artifacts.interviewDossier.
// 404 with code DOSSIER_NOT_FOUND is the expected "not built yet" state, not
// an error banner — callers render the Build action for it, same convention
// as getJobDescription's JD_NOT_CAPTURED above.
export function getInterviewDossier(id) {
  return apiFetch(`/api/interview-prep?id=${encodeURIComponent(id || "")}`);
}

// POST /api/data/comm/message equivalent for AI drafting — communication.draft
// verb (workspace-agent.mjs). AI-writes a reply and persists it as
// comm.draft; ReadyToSendCard already renders any draft this produces, no
// separate display wiring needed. `instruction` is optional — the agent
// falls back to a sensible default when omitted.
export function draftCommunication({ id, instruction } = {}) {
  return runWorkspaceIntent("communication.draft", { type: "communication", id }, { instruction });
}
