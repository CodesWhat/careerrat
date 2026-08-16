import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at src/core/version.mjs — two levels up from its own
// directory (src/core -> src -> repo root) is the repo root regardless of
// which CLI entrypoint or route module imports it.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function readVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}
