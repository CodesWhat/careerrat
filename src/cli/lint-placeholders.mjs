#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { userPath } from "../core/paths/workspace.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };
const args = process.argv.slice(2);
const targets = args.length > 0 ? args : ["workspace/tailored", "workspace/comms"];
const textExtensions = new Set([".md", ".txt", ".rtf", ".html", ".json", ".yml", ".yaml"]);

const patterns = [
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bFIXME\b/i,
  /\blorem ipsum\b/i,
  /\bplaceholder\b/i,
  /\[company\]/i,
  /\[role\]/i,
  /\[candidate\]/i,
  /\[insert[^\]]*\]/i,
  /\{company\}/i,
  /\{role\}/i,
  /\{candidate\}/i,
  /<insert[^>]*>/i,
  /<company>/i,
  /<role>/i,
  /<candidate>/i,
  /\bJane Candidate\b/,
  /\bjane@example\.com\b/i,
  // Unanswerable form-question marker (tailor-application STEP 6). Case-sensitive:
  // ALL-CAPS is the marker form; lowercase "needs you" is legitimate prose.
  /\bNEEDS YOU\b/,
  // Any other bracketed fill-in token ("[Hiring Manager]", "[Your Name]"). A
  // markdown link "[text](url)", reference "[text][id]" / "[id]: url", and a
  // task box "[x]" are not placeholders, so the lookahead leaves them alone.
  /\[[A-Z][^\]\n]{1,40}\](?![([:])/,
];

// Named paths must exist: "No unresolved placeholders found" for a typo'd path
// told the agent a draft was clean when nothing had been read. The default
// directories may legitimately be absent (nothing drafted yet).
const explicit = args.length > 0;
const skipped = [];
const missing = [];
const files = targets.flatMap((target) => {
  const resolved = resolveTarget(target);
  if (explicit && !existsSync(resolved)) missing.push(target);
  return collect(resolved);
});
const findings = [];

if (missing.length > 0) {
  for (const target of missing) console.error(`lint-placeholders: path not found: ${target}`);
  process.exit(2);
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        findings.push({ file, line: index + 1, text: line.trim() });
        break;
      }
    }
  });
}

for (const file of skipped) {
  console.error(`lint-placeholders: not checked (unsupported file type): ${file}`);
}

if (findings.length === 0 && explicit && files.length === 0) {
  console.error("lint-placeholders: no checkable files at the given path.");
  process.exit(2);
}

if (findings.length === 0) {
  console.log("No unresolved placeholders found.");
  process.exit(0);
}

console.log("Unresolved placeholders found:");
for (const hit of findings) {
  console.log(`- ${hit.file}:${hit.line}: ${hit.text}`);
}
process.exit(1);

function collect(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) {
    if (textExtensions.has(extname(path).toLowerCase())) return [path];
    skipped.push(path);
    return [];
  }
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => collect(join(path, name)));
}

function resolveTarget(target) {
  return isAbsolute(target) ? target : userPath(pathCtx, target);
}
