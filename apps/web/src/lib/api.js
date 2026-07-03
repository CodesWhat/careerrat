// apps/web/src/lib/api.js — thin fetch wrappers over the existing
// src/cli/onboard-route.mjs HTTP surface. No parallel settings store, no
// data-fetching library: M7's data surface is one settings screen with no
// cross-page cache invalidation need (see the M7 design memo §4). Every
// Settings read/write funnels through the named functions below rather than
// a raw fetch() scattered through components — when a real DB-backed
// settings route eventually lands (see ROADMAP.md's "App-first rework"),
// only this file changes.

export class ApiError extends Error {
  constructor(status, body) {
    super(`request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path, options = {}) {
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

export function getAiSettings() {
  return apiFetch("/api/settings/ai");
}

export function saveAiKey(apiKey) {
  return apiFetch("/api/settings/ai-key", {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });
}

// `patch` is deep-merged server-side onto the file's current contents:
// object keys merge recursively, but any ARRAY in `patch` REPLACES the
// corresponding array wholesale (see onboard-route.mjs#deepMerge's own doc
// comment). Every array-typed field this is ever called with must be resent
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
// textarea any AI path (resume-ai) degrades to on 422/501.
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
// apiFetch, including status codes 501 (no key)/413 (too large)/422
// (unparseable after retry)/400 (bad extension).
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

// POST /api/assist/suggest — "Roland-suggest" chips. `kind` is "titles" or
// "keywords"; 501 when no AI route is configured, 422 when the model never
// produces valid structured output after one retry — both are ordinary
// ApiError throws the caller catches and degrades on (hide/disable the
// assist affordance), never a hard block.
export function suggestAssist(kind, input) {
  return apiFetch("/api/assist/suggest", {
    method: "POST",
    body: JSON.stringify({ kind, input }),
  });
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
export function logoImageUrl(domain) {
  return `/api/logos/img?domain=${encodeURIComponent(domain)}`;
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
