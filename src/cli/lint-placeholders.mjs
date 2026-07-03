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
];

const files = targets.flatMap((target) => collect(resolveTarget(target)));
const findings = [];

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
  if (stat.isFile()) return textExtensions.has(extname(path).toLowerCase()) ? [path] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => collect(join(path, name)));
}

function resolveTarget(target) {
  return isAbsolute(target) ? target : userPath(pathCtx, target);
}
