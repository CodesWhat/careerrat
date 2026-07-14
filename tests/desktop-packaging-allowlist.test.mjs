import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESKTOP_ROOT = join(REPO_ROOT, "apps/desktop");
const MAIN_PATH = join(DESKTOP_ROOT, "main.mjs");
const BUILDER_CONFIG = join(DESKTOP_ROOT, "electron-builder.yml");
const LOCAL_MJS_IMPORT_FROM = /\b(?:import|export)\s+[^;"']*?\bfrom\s+["'](\.\/[^"']+\.mjs)["']/g;
const LOCAL_MJS_SIDE_EFFECT_IMPORT = /\bimport\s*["'](\.\/[^"']+\.mjs)["']/g;

function parseFilesAllowlist(source) {
  const entries = new Set();
  let inFiles = false;

  for (const line of source.split(/\r?\n/)) {
    if (!inFiles) {
      if (/^files:\s*$/.test(line)) inFiles = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+-\s+([^#]+?)\s*$/);
    if (match) entries.add(match[1].replace(/^['"]|['"]$/g, ""));
  }

  return entries;
}

function localImports(modulePath) {
  const source = readFileSync(modulePath, "utf8");
  return [
    ...source.matchAll(LOCAL_MJS_IMPORT_FROM),
    ...source.matchAll(LOCAL_MJS_SIDE_EFFECT_IMPORT),
  ].map((match) => resolve(dirname(modulePath), match[1]));
}

test("desktop packaging includes local modules reachable from main.mjs", () => {
  const allowlist = parseFilesAllowlist(readFileSync(BUILDER_CONFIG, "utf8"));
  const directImports = localImports(MAIN_PATH);
  const reachableImports = new Set(directImports);

  for (const modulePath of directImports) {
    for (const importedPath of localImports(modulePath)) reachableImports.add(importedPath);
  }

  const missing = [...reachableImports]
    .map((modulePath) => relative(DESKTOP_ROOT, modulePath))
    .filter((modulePath) => !allowlist.has(modulePath))
    .sort();

  assert.deepEqual(
    missing,
    [],
    `electron-builder.yml files allowlist is missing imported desktop module(s): ${missing.join(", ")}`
  );
  assert.ok(reachableImports.size > 0, `${basename(MAIN_PATH)} must have local imports to guard`);
});
