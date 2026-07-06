import { findCompLeak, findCurrentBaseToken } from "../../profile/comp-guard.mjs";

const CONTACT_DETAIL_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/,
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
];

const LOCAL_PATH_PATTERNS = [
  /(?:^|\s)\/Users\/[^\s"'<>]+/i,
  /(?:^|\s)\/home\/[^\s"'<>]+/i,
  /\b[A-Z]:\\[^\s"'<>]+/i,
];

const PROTECTED_TRAIT_PATTERNS = [
  /\b(disability|disabled|medical|accommodation|pregnant|pregnancy|religion|religious|race|ethnicity|gender identity|sexual orientation|veteran status|age)\b/i,
];

const PRIVATE_TOKEN_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?token|private[_-]?token)\b/i,
  /\b(?:sk|pk)_[A-Za-z0-9]{12,}\b/,
];

export function validateDeepIngestPrivacy({ proposal } = {}) {
  const entries = flattenText(proposal?.payload);
  const probe = entries.map((entry) => `${entry.path}\n${entry.value}`).join("\n");
  const blockedFields = new Set();

  if (entries.some((entry) => entry.path.toLowerCase().includes("current_base"))) {
    blockedFields.add("current_base");
  }
  if (findCurrentBaseToken(probe) || findCompLeak(probe)) {
    blockedFields.add("current_base");
  }
  if (CONTACT_DETAIL_PATTERNS.some((pattern) => pattern.test(probe))) {
    blockedFields.add("contact_detail");
  }
  if (LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(probe))) {
    blockedFields.add("local_path");
  }
  if (PROTECTED_TRAIT_PATTERNS.some((pattern) => pattern.test(probe))) {
    blockedFields.add("protected_trait");
  }
  if (PRIVATE_TOKEN_PATTERNS.some((pattern) => pattern.test(probe))) {
    blockedFields.add("private_token");
  }

  const list = [...blockedFields].sort();
  if (list.length) {
    return {
      ok: false,
      code: "PRIVACY_BLOCKED",
      blockedFields: list,
      errors: list.map((field) => ({
        path: field,
        message: "proposal contains private or protected data",
      })),
    };
  }

  return { ok: true, code: null, blockedFields: [], errors: [] };
}

function flattenText(value, path = "payload") {
  if (value == null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [{ path, value: String(value) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => flattenText(entry, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => flattenText(entry, joinPath(path, key)));
  }
  return [];
}

function joinPath(parent, key) {
  return parent ? `${parent}.${key}` : key;
}
