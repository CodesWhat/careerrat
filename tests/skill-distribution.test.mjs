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

const BACKEND_ONLY_SKILLS = new Set(["intake-extract", "resume-extract"]);

function userRoutableSkillNames() {
  return canonicalSkillNames().filter((name) => !BACKEND_ONLY_SKILLS.has(name));
}

function readSkill(name) {
  const text = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${name} must have one complete YAML frontmatter block`);
  return {
    frontmatterText: match[1],
    frontmatter: parseYaml(match[1]),
    body: match[2],
  };
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

test("the published skills catalog lists every shipped skill exactly once", () => {
  const catalog = readFileSync(
    join(root, "apps", "docs", "content", "docs", "reference", "skills.mdx"),
    "utf8"
  );
  const advertisedCount = Number(catalog.match(/description:\s+All (\d+) skills/)?.[1]);
  const introCount = Number(catalog.match(/CareerRat ships (\d+) skills/)?.[1]);
  const listed = [...catalog.matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gm)]
    .map((match) => match[1])
    .sort();
  const expected = canonicalSkillNames();

  assert.equal(advertisedCount, expected.length);
  assert.equal(introCount, expected.length);
  assert.equal(new Set(listed).size, listed.length, "catalog must not duplicate a skill row");
  assert.deepEqual(listed, expected);
});

test("architecture docs distinguish user-routable skills from backend-only helpers", () => {
  const expected = userRoutableSkillNames().length;
  for (const path of [
    join(root, "docs", "ARCHITECTURE.md"),
    join(root, "apps", "docs", "content", "docs", "advanced", "architecture.mdx"),
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(
      source,
      new RegExp(`maps user intent\\s+to (?:all )?${expected} user-facing skills`, "i")
    );
    for (const name of BACKEND_ONLY_SKILLS) {
      assert.match(source, new RegExp(`\\b${name}\\b[\\s\\S]{0,180}backend-only`, "i"));
    }
    assert.doesNotMatch(source, /\b(?:16|21) skills\b/i);
  }
});

test("the canonical agent router maps every user-facing skill and classifies backend helpers", () => {
  const router = readFileSync(join(root, "AGENTS.md"), "utf8");

  for (const name of userRoutableSkillNames()) {
    assert.ok(router.includes(`\`${name}\``), `${name} is not mapped in AGENTS.md`);
  }
  for (const name of BACKEND_ONLY_SKILLS) {
    assert.match(
      router,
      new RegExp(`\`${name}\`[\\s\\S]{0,180}backend-only`, "i"),
      `${name} is not classified as a backend-only helper in AGENTS.md`
    );
  }
});

test("native browser workflow skills describe their CareerRat-owned in-app boundary", async (t) => {
  const contracts = new Map([
    [
      "ingest-mail",
      [
        /\bin-app\b/i,
        /reads Apple Mail[\s\S]*Gmail[\s\S]*Outlook/i,
        /communications[\s\S]*watermark/i,
      ],
    ],
    [
      "ingest-messages",
      [/\bin-app\b/i, /reads LinkedIn[\s\S]*Wellfound/i, /communications[\s\S]*watermark/i],
    ],
    [
      "relationship-sourcing",
      [/\bin-app\b/i, /searches LinkedIn[\s\S]*Wellfound/i, /review-only/i],
    ],
    [
      "optimize-linkedin",
      [
        /\bin-app\b/i,
        /reads (?:the candidate's )?LinkedIn profile/i,
        /approved[\s\S]*live[\s\S]*confirm/i,
      ],
    ],
    [
      "sync-status",
      [
        /\bin-app\b/i,
        /reads Greenhouse[\s\S]*Workday[\s\S]*Ashby[\s\S]*Lever/i,
        /autoApplicable[\s\S]*atomic/i,
        /track-outcomes[\s\S]*(?:candidate-reported|coaching|learning)/i,
      ],
    ],
  ]);

  for (const [name, required] of contracts) {
    await t.test(name, () => {
      const { body } = readSkill(name);
      assert.doesNotMatch(
        body,
        /app never opens|returns a handoff card|intent reads no (?:mail|messages)|handler never refuses/i
      );
      for (const pattern of required) assert.match(body, pattern);
    });
  }
});

test("public docs describe CareerRat-owned browser workflows and native status writes", () => {
  const catalog = readFileSync(
    join(root, "apps", "docs", "content", "docs", "reference", "skills.mdx"),
    "utf8"
  );
  for (const name of [
    "ingest-mail",
    "ingest-messages",
    "relationship-sourcing",
    "optimize-linkedin",
    "sync-status",
  ]) {
    const description = catalog.match(new RegExp(`^\\| \`${name}\` \\| ([^\\n]+)`, "m"))?.[1] || "";
    assert.match(description, /\bin-app\b/i, `${name} catalog copy must describe its in-app path`);
  }
  assert.doesNotMatch(catalog, /track-outcomes[^\n]*only writer/i);
  assert.match(catalog, /sync-status[^\n]*atomic/i);

  for (const path of [
    join(root, "docs", "ARCHITECTURE.md"),
    join(root, "apps", "docs", "content", "docs", "advanced", "architecture.mdx"),
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /CareerRat-owned browser workflows/i);
    assert.match(source, /autoApplicable[\s\S]{0,300}atomic/i);
    assert.match(source, /track-outcomes[\s\S]{0,300}candidate-reported/i);
  }
});

test("public setup docs derive their shipped skill count from the canonical catalog", () => {
  const expected = canonicalSkillNames().length;
  for (const path of [
    join(root, "apps", "docs", "content", "docs", "getting-started", "keeping-current.mdx"),
    join(root, "apps", "docs", "content", "docs", "advanced", "data-model.mdx"),
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, new RegExp(`\\b${expected} skill definitions\\b`, "i"));
    assert.doesNotMatch(source, /\\b(?:16|21) skill definitions\\b/i);
  }
});

test("ingest-profile captures remote geographic eligibility separately from local work modes", () => {
  const { body } = readSkill("ingest-profile");

  assert.match(body, /remote_scope/);
  assert.match(body, /home-country/);
  assert.match(body, /worldwide/);
  assert.match(body, /hybrid.*on-site.*home.*relocation/is);
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
