import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../src/core/profile/yaml.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsRoot = join(root, ".agents", "skills");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageFiles = packageJson.files || [];
const packageScripts = new Set(Object.keys(packageJson.scripts || {}));
const ALLOWED_FRONTMATTER_KEYS = new Set([
  "allowed-tools",
  "description",
  "license",
  "metadata",
  "name",
]);
const ALLOWED_METADATA_KEYS = new Set(["tier_1_inputs", "tier_2_inputs"]);
const GENERATED_CONFIG_REFERENCES = new Map([
  [
    "config/search-sources.yml",
    ["config/search-sources.example.yml", "config/search-sources.schema.json"],
  ],
  ["config/sourced-scan.json", ["config/sourced-scan.example.json"]],
]);

const careerratLauncher = readFileSync(join(root, "bin", "careerrat.mjs"), "utf8");
const cliMap = careerratLauncher.match(/const CLIS = \{([\s\S]*?)\n\};/)?.[1] || "";
const careerratCommands = new Set([
  "help",
  "init",
  "start",
  "update",
  "version",
  ...[...cliMap.matchAll(/^\s*(?:"([a-z][a-z0-9-]*)"|([a-z][a-z0-9-]*)):/gm)].map(
    (match) => match[1] || match[2]
  ),
]);

function canonicalSkillNames() {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function readSkill(name) {
  const text = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${name} must have one complete YAML frontmatter block`);
  return { frontmatterText: match[1], frontmatter: parseYaml(match[1]), body: match[2] };
}

function pathIsPackaged(path) {
  return packageFiles.some((entry) => {
    if (!entry.includes("*")) return path === entry || path.startsWith(`${entry}/`);
    const pattern = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
    return new RegExp(`^${pattern}$`).test(path);
  });
}

function commandSnippets(text) {
  const snippets = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    snippets.push(...match[1].split("\n"));
  }
  return snippets;
}

test("every canonical skill uses portable frontmatter and preserves supported CareerRat metadata", async (t) => {
  for (const name of canonicalSkillNames()) {
    await t.test(name, () => {
      const { frontmatterText, frontmatter, body } = readSkill(name);
      const topLevelKeys = [...frontmatterText.matchAll(/^([a-z][a-z0-9_-]*):/gm)].map(
        (match) => match[1]
      );
      const unexpected = topLevelKeys.filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key));
      assert.deepEqual(unexpected, [], `${name} has unsupported top-level frontmatter keys`);

      const plainDescription = frontmatterText.match(/^description:\s+([^"'][^\n]*)$/m)?.[1];
      assert.equal(
        plainDescription?.includes(": ") || false,
        false,
        `${name} must quote a description containing a colon followed by whitespace`
      );
      assert.equal(frontmatter.name, name, `${name} frontmatter name must match its directory`);
      assert.equal(typeof frontmatter.description, "string", `${name} needs a description`);
      assert.ok(frontmatter.description.trim(), `${name} description must not be empty`);
      assert.ok(frontmatter.description.length <= 1024, `${name} description exceeds 1024 chars`);
      assert.doesNotMatch(
        frontmatter.description,
        /[<>]/,
        `${name} description must not contain angle brackets`
      );

      if (frontmatter.metadata !== undefined) {
        assert.equal(typeof frontmatter.metadata, "object", `${name} metadata must be a mapping`);
        const metadataKeys = Object.keys(frontmatter.metadata);
        assert.deepEqual(
          metadataKeys.filter((key) => !ALLOWED_METADATA_KEYS.has(key)),
          [],
          `${name} has an unsupported CareerRat metadata extension`
        );
        for (const key of metadataKeys) {
          assert.ok(
            Array.isArray(frontmatter.metadata[key]),
            `${name} metadata.${key} must be a list`
          );
          assert.ok(
            frontmatter.metadata[key].every(
              (value) => typeof value === "string" && value.trim().length > 0
            ),
            `${name} metadata.${key} must contain non-empty strings`
          );
        }
      }

      assert.ok(body.trim(), `${name} must have an instruction body`);
      assert.doesNotMatch(body, /^\s*\[TODO:[^\n]*\]\s*$/m, `${name} has scaffold residue`);
    });
  }
});

test("the agent router documents CareerRat skill extensions inside portable metadata", () => {
  const router = readFileSync(join(root, "AGENTS.md"), "utf8");
  const contextLoading = router.slice(router.indexOf("## Context Loading (Two-Tier)"));
  const example = contextLoading.match(/```yaml\n([\s\S]*?)\n```/)?.[1] || "";

  assert.match(example, /^metadata:/m);
  assert.doesNotMatch(example, /^tier_[12]_inputs:/m);
  assert.match(example, /^ {2}tier_1_inputs:/m);
  assert.match(example, /^ {2}tier_2_inputs:/m);
});

test("every canonical skill resolves its shipped resources and local commands", async (t) => {
  for (const name of canonicalSkillNames()) {
    await t.test(name, () => {
      const skillPath = `.agents/skills/${name}/SKILL.md`;
      const text = readFileSync(join(root, skillPath), "utf8");
      assert.ok(
        packageFiles.includes(skillPath),
        `${skillPath} is missing from package.json#files`
      );

      const references = [
        ...new Set(
          [
            ...text.matchAll(
              /(?<![A-Za-z0-9_-])(?:\.agents|scripts|src|docs|config|templates|bin)\/[A-Za-z0-9_./*-]+(?:\.[A-Za-z0-9]+)?/g
            ),
          ].map((match) => match[0].replace(/[.,;)]+$/, ""))
        ),
      ].sort();
      for (const reference of references) {
        if (existsSync(join(root, reference))) {
          assert.ok(pathIsPackaged(reference), `${name} references unshipped ${reference}`);
          continue;
        }
        const generatedCompanions = GENERATED_CONFIG_REFERENCES.get(reference);
        assert.ok(generatedCompanions, `${name} references missing local resource ${reference}`);
        for (const companion of generatedCompanions) {
          assert.ok(existsSync(join(root, companion)), `${reference} needs ${companion}`);
          assert.ok(pathIsPackaged(companion), `${reference} companion ${companion} must ship`);
        }
      }

      const snippets = commandSnippets(text);
      const referencedCareerratCommands = [
        ...new Set(
          snippets.flatMap((snippet) =>
            [...snippet.matchAll(/(?:^|[;&|]\s*)careerrat\s+([a-z][a-z0-9-]*)/g)].map(
              (match) => match[1]
            )
          )
        ),
      ];
      const missingCareerratCommands = referencedCareerratCommands.filter(
        (command) => !careerratCommands.has(command)
      );
      assert.deepEqual(
        missingCareerratCommands,
        [],
        `${name} references unknown careerrat commands`
      );

      const referencedNpmScripts = [
        ...new Set(
          snippets.flatMap((snippet) =>
            [...snippet.matchAll(/(?:^|[;&|]\s*)npm\s+run\s+([a-z][a-z0-9:-]*)/g)].map(
              (match) => match[1]
            )
          )
        ),
      ];
      const missingNpmScripts = referencedNpmScripts.filter(
        (command) => !packageScripts.has(command)
      );
      assert.deepEqual(missingNpmScripts, [], `${name} references unknown npm scripts`);
    });
  }
});
