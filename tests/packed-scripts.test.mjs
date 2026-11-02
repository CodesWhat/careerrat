import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

// Files a script pulls in with a relative import, so a shipped script cannot
// depend on a file that was left out of the tarball.
function relativeImports(file) {
  const text = readFileSync(join(root, file), "utf8");
  const found = [];
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = relative(root, resolve(root, dirname(file), match[1]));
    if (existsSync(join(root, target))) found.push(target);
  }
  return found;
}

test("every script the shipped code spawns or imports is in the packed tarball", () => {
  const packed = new Set(
    JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    )[0].files.map((file) => file.path.split("/").join(sep))
  );

  const referenced = new Set();
  for (const file of [...sourceFiles("src"), ...sourceFiles("bin")]) {
    const text = readFileSync(join(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const match of text.matchAll(/scripts\/[A-Za-z0-9_./-]+\.(?:mjs|js|sh)/g)) {
      const script = match[0].split("/").join(sep);
      if (existsSync(join(root, script))) referenced.add(script);
    }
  }
  // Scripts the code is known to start. If the scan above stops finding these,
  // it has stopped working and the check below would pass for the wrong reason.
  for (const known of ["update-check.mjs", "install-skills.mjs", "scan-sourced.mjs"])
    assert.ok(referenced.has(join("scripts", known)), `scan no longer sees scripts/${known}`);

  const missing = new Set();
  const queue = [...referenced];
  const visited = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!packed.has(file)) missing.add(file);
    if (file.startsWith("scripts")) queue.push(...relativeImports(file));
  }
  assert.deepEqual(
    [...missing],
    [],
    "these files are used by shipped code but would not be in the npm package"
  );
});
