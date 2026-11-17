import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = fileURLToPath(
  new URL("../../.internal/personal-sentinels.json", import.meta.url)
);

export function loadPersonalSentinels({ env = process.env, defaultPath = DEFAULT_PATH } = {}) {
  let raw = env.CAREERRAT_PERSONAL_SENTINELS;
  if (!raw?.trim()) {
    try {
      raw = readFileSync(env.CAREERRAT_PERSONAL_SENTINELS_FILE || defaultPath, "utf8");
    } catch (error) {
      if (
        error.code === "ENOENT" &&
        !env.CAREERRAT_PERSONAL_SENTINELS_FILE &&
        env.CAREERRAT_PERSONAL_SENTINELS_REQUIRED !== "1"
      )
        return [];
      throw new Error("Private sentinel configuration is missing or unreadable.");
    }
  }
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new Error("Private sentinel configuration must be a JSON array of nonempty strings.");
  }
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error("Private sentinel configuration must be a JSON array of nonempty strings.");
  }
  return [...new Set(values)];
}

export const PERSONAL_SENTINELS = Object.freeze(loadPersonalSentinels());

export function containsPersonalSentinel(value) {
  const haystack = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return PERSONAL_SENTINELS.some((sentinel) => haystack.includes(sentinel));
}
