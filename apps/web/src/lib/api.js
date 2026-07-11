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

export function getUsageSummary() {
  return apiFetch("/api/settings/usage");
}

export function saveAiKey(apiKey) {
  return apiFetch("/api/settings/ai-key", {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });
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

// POST /api/assist/suggest — "Roland-suggest" chips. `kind` is "titles" or
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

// ---------------------------------------------------------------------------
// Chat runtime (src/cli/chat-route.mjs) — the Companies step's "Roland,
// find companies" panel drives discover-companies through this exact
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

// POST /api/data/app/status — appSetStatus verb.
export function setAppStatus({ id, to, note, followUpDueAt, clearInterview } = {}) {
  return apiFetch("/api/data/app/status", {
    method: "POST",
    body: JSON.stringify({ id, to, note, followUpDueAt, clearInterview }),
  });
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
  return apiFetch("/api/data/app/interview", {
    method: "POST",
    body: JSON.stringify({ id, at, round, note }),
  });
}

// POST /api/data/comm/message — commAppendMessage verb ("add a note to the
// thread" affordance; `message.direction` is "note" for a plain drawer note).
export function appendCommMessage({ id, message } = {}) {
  return apiFetch("/api/data/comm/message", {
    method: "POST",
    body: JSON.stringify({ id, message }),
  });
}

// POST /api/data/comm/send — commMarkSent verb. The literal mechanism behind
// the self-clearing "Ready to send" CTA: nulls comm.draft (and, if linked,
// app.followUp.draft) server-side in one write.
export function markCommSent({ id, at, summary } = {}) {
  return apiFetch("/api/data/comm/send", {
    method: "POST",
    body: JSON.stringify({ id, at, summary }),
  });
}

// POST /api/data/sourced/promote — sourcedPromote verb (the folded-in
// sourced-triage tab's "Gate this role" action: moves a sourced[] row into
// applications[] as status "reviewed-hold").
export function promoteSourced({ id, appRow } = {}) {
  return apiFetch("/api/data/sourced/promote", {
    method: "POST",
    body: JSON.stringify({ id, appRow }),
  });
}
