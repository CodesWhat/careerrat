// public-intel-scrub.mjs — fail-closed privacy boundary for publishable metadata.

export const PUBLIC_INTEL_PRIVATE_FIELD = "PUBLIC_INTEL_PRIVATE_FIELD";

const FORBIDDEN_KEYS = new Set([
  "ai",
  "application",
  "applicationid",
  "applications",
  "artifactpath",
  "artifacts",
  "body",
  "bodytext",
  "candidate",
  "capturedoffers",
  "comp",
  "compensation",
  "currentbase",
  "currentcomp",
  "currentcompshareable",
  "current_base",
  "current_comp_shareable",
  "evidence",
  "fit",
  "fitscore",
  "gate",
  "jd",
  "jdpath",
  "jobposting",
  "jobpostings",
  "jobs",
  "localpath",
  "minimumbase",
  "minimum_base",
  "modeltext",
  "note",
  "notes",
  "pagebody",
  "pagetext",
  "private",
  "privatenote",
  "profile",
  "prompt",
  "raw",
  "rawmodeltext",
  "rawtext",
  "reqid",
  "resume",
  "rolefit",
  "sourcedid",
  "targetbase",
  "target_base",
  "tracker",
  "trackerid",
]);

const LOCAL_PATH_RE =
  /(^|[\s"'])(\/Users\/|\/home\/|\/var\/folders\/|workspace\/|candidate\/|\.rolester\/|\.internal\/)/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeKey(key) {
  return String(key || "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toLowerCase();
}

function errorFor(path) {
  const err = new Error(`public intel payload contains private field at ${path || "<root>"}`);
  err.code = PUBLIC_INTEL_PRIVATE_FIELD;
  err.path = path || "";
  return err;
}

function pathJoin(path, key) {
  return path ? `${path}.${key}` : String(key);
}

function assertSafeString(value, path) {
  const text = String(value || "");
  if (/^https?:\/\//i.test(text)) return;
  if (LOCAL_PATH_RE.test(text)) throw errorFor(path);
}

export function assertPublicIntelPayload(value, { context = "public-intel" } = {}) {
  const stack = [{ value, path: "" }];
  while (stack.length) {
    const current = stack.pop();
    const item = current.value;
    if (item === null || item === undefined) continue;
    if (typeof item === "string") {
      assertSafeString(item, current.path || context);
      continue;
    }
    if (typeof item !== "object") continue;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i += 1) {
        stack.push({ value: item[i], path: pathJoin(current.path, i) });
      }
      continue;
    }
    for (const [key, nested] of Object.entries(item)) {
      const nextPath = pathJoin(current.path, key);
      if (FORBIDDEN_KEYS.has(normalizeKey(key))) throw errorFor(nextPath);
      stack.push({ value: nested, path: nextPath });
    }
  }
  return true;
}

export function scrubPublicIntelPayload(value, options = {}) {
  assertPublicIntelPayload(value, options);
  return clone(value);
}

export function validatePublicIntelPayload(value, options = {}) {
  try {
    assertPublicIntelPayload(value, options);
    return { ok: true, value: clone(value) };
  } catch (err) {
    return {
      ok: false,
      code: err.code || PUBLIC_INTEL_PRIVATE_FIELD,
      error: { message: err.message, path: err.path || "" },
    };
  }
}
