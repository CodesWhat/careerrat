// Every command, flag, path and helper a skill names must exist. This reads the
// real SKILL.md files and checks them against the real CLI entry points, so a
// renamed verb, a dropped flag or an unshipped script fails here instead of
// failing quietly in front of a user.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { USAGE_OPERATIONS } from "../src/core/profile/modes.mjs";

const root = join(import.meta.dirname, "..");
const skillsDir = join(root, ".agents/skills");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const binSource = readFileSync(join(root, "bin/careerrat.mjs"), "utf8");

const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
  .map((entry) => ({
    name: entry.name,
    text: readFileSync(join(skillsDir, entry.name, "SKILL.md"), "utf8"),
  }));

// The text inside fenced blocks and inline `code spans`, one entry per line.
function codeLines(text) {
  const lines = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) lines.push(line);
    else for (const match of line.matchAll(/`([^`\n]+)`/g)) lines.push(match[1]);
  }
  return lines;
}

// bin/careerrat.mjs's dispatch table: command -> script.
const cliTable = Object.fromEntries(
  [
    ...binSource.match(/const CLIS = \{([\s\S]*?)\n\};/)[1].matchAll(/"?([\w-]+)"?: "([^"]+)"/g),
  ].map((m) => [m[1], m[2]])
);
// Handled inside the launcher itself rather than by a script.
const LAUNCHER_COMMANDS = new Set(["start", "init", "help", "version", "people", "restore"]);

const helpCache = new Map();
// A CLI's own listing of what it accepts: --help, plus --list where --help
// points at it (gate keeps its verb names there).
function helpText(script) {
  if (!helpCache.has(script)) {
    const run = (flag) =>
      spawnSync(process.execPath, [join(root, script), flag], {
        cwd: root,
        env: { ...process.env, CAREERRAT_NO_UPDATE_CHECK: "1", CAREERRAT_HOME: root },
        encoding: "utf8",
        timeout: 20000,
      });
    const help = run("--help");
    let text = `${help.stdout}\n${help.stderr}`;
    if (/--list\b/.test(text)) {
      const list = run("--list");
      text += `\n${list.stdout}\n${list.stderr}`;
    }
    helpCache.set(script, text);
  }
  return helpCache.get(script);
}

function commandsFromSkills() {
  const found = [];
  for (const skill of skills) {
    for (const line of codeLines(skill.text)) {
      const m = line.match(
        /(?:^|[\s$(])careerrat\s+(?:--for\s+\S+\s+)?([a-z][a-z-]*)((?:\s+[a-z][a-z-]*(?![\w/-]))?)(.*)$/
      );
      if (!m) continue;
      const [, top, sub, rest] = m;
      found.push({
        skill: skill.name,
        top,
        sub: sub.trim(),
        flags: [...rest.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)].map((f) => f[1]),
        line: line.trim(),
      });
    }
  }
  return found;
}

test("every `careerrat <command>` a skill names is a real command", () => {
  const all = commandsFromSkills();
  assert.ok(all.length > 150, `expected to find the skills' commands, found ${all.length}`);
  const unknown = all.filter(({ top }) => !cliTable[top] && !LAUNCHER_COMMANDS.has(top));
  // Prose such as "careerrat under your account" is not a command; a command
  // line carries a flag, a placeholder or a path.
  assert.deepEqual(
    unknown
      .filter(({ line }) => /--|<|\//.test(line))
      .map(({ skill, line }) => `${skill}: ${line}`),
    []
  );
});

test("every subcommand a skill names appears in that command's own help", () => {
  const missing = [];
  for (const { skill, top, sub, line } of commandsFromSkills()) {
    const script = cliTable[top];
    if (!script || !sub) continue;
    const help = helpText(script);
    if (!help.trim()) continue; // a CLI with no --help text has no verb list to check
    if (!new RegExp(`(^|[^\\w-])${sub}([^\\w-]|$)`).test(help)) {
      missing.push(`${skill}: ${line} (no "${sub}" in ${script} --help)`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test("every flag a skill passes to a careerrat command exists in that command's source", () => {
  const missing = [];
  for (const { skill, top, flags, line } of commandsFromSkills()) {
    const script = cliTable[top];
    if (!script) continue;
    const source = `${readFileSync(join(root, script), "utf8")}\n${binSource}`;
    for (const flag of flags) {
      if (!source.includes(flag)) missing.push(`${skill}: ${flag} in "${line}"`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every script, `node src/...` file and `npm run` alias a skill names exists", () => {
  const missing = [];
  for (const skill of skills) {
    for (const line of codeLines(skill.text)) {
      for (const m of line.matchAll(/\b(?:node\s+)?((?:src|scripts)\/[A-Za-z0-9_./-]+\.mjs)/g)) {
        if (!existsSync(join(root, m[1]))) missing.push(`${skill.name}: ${m[1]}`);
      }
      for (const m of line.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
        if (!pkg.scripts?.[m[1]]) missing.push(`${skill.name}: npm run ${m[1]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("skills name the installed `careerrat` command, not a checkout path", () => {
  // `node src/cli/x.mjs` only resolves inside a source checkout, so an npm
  // install running the skill would fail on it.
  const checkoutOnly = [];
  for (const skill of skills) {
    for (const line of codeLines(skill.text)) {
      if (/\bnode\s+src\//.test(line)) checkoutOnly.push(`${skill.name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(checkoutOnly, []);
});

test("every `modes allows <operation>` a skill names is a known usage operation", () => {
  const unknown = [];
  for (const skill of skills) {
    for (const line of codeLines(skill.text)) {
      for (const m of line.matchAll(/modes allows ([a-z][a-z:-]*)/g)) {
        if (!Object.hasOwn(USAGE_OPERATIONS, m[1])) unknown.push(`${skill.name}: ${m[1]}`);
      }
    }
  }
  assert.deepEqual(unknown, []);
});

test("every script the source spawns ships in the npm package", () => {
  const spawned = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".mjs")) {
        // join(root, "scripts/x.mjs") is how the source locates a script to run.
        for (const m of readFileSync(path, "utf8").matchAll(
          /join\(\s*[\w.]+,\s*["'](scripts\/[A-Za-z0-9_-]+\.mjs)["']/g
        )) {
          spawned.add(m[1]);
        }
      }
    }
  };
  walk(join(root, "src"));
  assert.ok(spawned.has("scripts/update-check.mjs"), "the scan must see the update checker");
  const missing = [...spawned].filter((script) => !pkg.files.includes(script));
  assert.deepEqual(missing, []);
});
