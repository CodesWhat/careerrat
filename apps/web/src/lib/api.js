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
