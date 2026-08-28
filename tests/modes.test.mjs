import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateGate } from "../src/core/evaluate/gate.mjs";
import {
  computeAllows,
  DEFAULT_MODES,
  normalizeModes,
  USAGE_OPERATIONS,
} from "../src/core/profile/modes.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";
import { scoreSourcedOffer } from "../src/core/scoring/sourced-scanner.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("normalizeModes defaults to standard usage and balanced application when absent", () => {
  const result = normalizeModes(null);
  assert.equal(result.valid, true);
  assert.deepEqual(result.data, DEFAULT_MODES);
});

test("normalizeModes validates allowed usage_mode and application_mode values", () => {
  const result = normalizeModes({ usage_mode: "lean", application_mode: "high-volume" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.data, { usage_mode: "lean", application_mode: "high-volume" });

  const invalid = normalizeModes({ usage_mode: "cheap", application_mode: "chaotic" });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((e) => e.path === "usage_mode"));
  assert.ok(invalid.errors.some((e) => e.path === "application_mode"));
});

test("modes template validates against the real schema", () => {
  const text = readFileSync(join(ROOT, "templates/modes.example.yml"), "utf8");
  const result = normalizeModes(parseYaml(text));
  assert.equal(result.valid, true);
});

test("computeAllows keeps core work full quality in lean mode", () => {
  assert.equal(computeAllows("core:evaluate", { usage_mode: "lean" }).decision, "run");
  assert.equal(computeAllows("core:tailor", { usage_mode: "lean" }).decision, "run");
  assert.equal(computeAllows("core:comms", { usage_mode: "lean" }).decision, "run");
});

test("computeAllows downshifts or skips discretionary work in lean mode", () => {
  assert.equal(computeAllows("research:company", { usage_mode: "lean" }).decision, "skip");
  assert.equal(computeAllows("research:comp", { usage_mode: "lean" }).decision, "downshift");
  assert.equal(computeAllows("research:boards", { usage_mode: "lean" }).decision, "skip");
  assert.equal(
    computeAllows("interview:packet:deep", { usage_mode: "lean" }).decision,
    "downshift"
  );
  assert.ok(Object.keys(USAGE_OPERATIONS).includes("search:sweep:broad"));
});

test("computeAllows treats an explicit one-off request as authorization without changing lean breadth", () => {
  const companyResearch = computeAllows(
    "research:company",
    { usage_mode: "lean" },
    { explicit: true }
  );
  assert.equal(companyResearch.decision, "run");
  assert.equal(companyResearch.allowed, true);
  assert.equal(companyResearch.explicit, true);
  assert.match(companyResearch.reason, /explicit request authorizes this run/i);

  const broadSearch = computeAllows(
    "search:sweep:broad",
    { usage_mode: "lean" },
    { explicit: true }
  );
  assert.equal(broadSearch.decision, "downshift");
  assert.equal(broadSearch.allowed, true);
  assert.equal(broadSearch.explicit, true);
});

test("modes allows accepts an explicit one-off request without changing saved mode", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-modes-explicit-"));
  try {
    mkdirSync(join(repoRoot, "candidate"), { recursive: true });
    mkdirSync(join(repoRoot, "config"), { recursive: true });
    writeFileSync(
      join(repoRoot, "candidate", "modes.yml"),
      "usage_mode: lean\napplication_mode: balanced\n"
    );
    writeFileSync(
      join(repoRoot, "config", "modes.schema.json"),
      readFileSync(join(ROOT, "config", "modes.schema.json"))
    );

    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, "src", "cli", "modes.mjs"),
        "allows",
        "research:company",
        "--explicit",
        "--json",
        "--root",
        repoRoot,
      ],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.decision, "run");
    assert.equal(verdict.explicit, true);
    assert.match(readFileSync(join(repoRoot, "candidate", "modes.yml"), "utf8"), /lean/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("search and research skills consume explicit authorization instead of asking again", () => {
  const skills = [
    ["research-company", "research:company"],
    ["research-comp", "research:comp"],
    ["research-boards", "research:boards"],
    ["discover-companies", "research:companies"],
    ["search-jobs", "search:sweep:broad"],
  ];

  for (const [skill, operation] of skills) {
    const text = readFileSync(join(ROOT, ".agents", "skills", skill, "SKILL.md"), "utf8");
    assert.match(
      text,
      new RegExp(`careerrat modes allows ${operation.replace(":", "\\:")} --explicit`),
      `${skill} must pass one-off authorization to the mode verdict`
    );
    assert.doesNotMatch(
      text,
      /(?:offer to proceed only if|stop unless|proceed only on) (?:the user )?(?:explicitly )?overrides?/i,
      `${skill} must not ask for a second override after an explicit request`
    );
  }

  const searchJobs = readFileSync(
    join(ROOT, ".agents", "skills", "search-jobs", "SKILL.md"),
    "utf8"
  );
  assert.doesNotMatch(
    searchJobs,
    /unless the user explicitly\s+overrides and asks for a partial sweep/i,
    "an explicit search request must not be blocked by a second discovery-pipeline override"
  );
});

test("high-volume application mode promotes medium scanner matches without changing discovery", () => {
  const offer = {
    title: "Operations Manager",
    company: "Acme",
    location: "Remote US",
    baseComp: "$200k - $230k",
    bodyText:
      "Own cross-functional rollout, customer onboarding, and operational process design. ".repeat(
        8
      ),
  };
  const config = {
    modes: { application_mode: "high-volume" },
    targeting: { keep_signals: [], cut_signals: [], excluded_companies: [] },
    profile: { compensation: { minimum_base: 150000 }, location: { remote: true } },
  };

  const balanced = scoreSourcedOffer(offer, {
    ...config,
    modes: { application_mode: "balanced" },
  });
  const highVolume = scoreSourcedOffer(offer, config);

  assert.equal(balanced.fit, "med");
  assert.equal(balanced.gate, "review");
  assert.equal(highVolume.fit, "med");
  assert.equal(highVolume.gate, "likely-keep");
});

test("selective application mode holds medium body-read fits for review", () => {
  const job = {
    frontmatter: {
      company: "Acme",
      role: "Solutions Engineer",
      location: "Remote US",
      comp: "$200k - $230k",
    },
    body: "Work with customers on implementation, onboarding, and workflow rollout.",
  };
  const targeting = {
    role_buckets: [{ name: "Solutions", priority: "secondary", titles: ["Solutions Engineer"] }],
    keep_signals: [],
    cut_signals: [],
    excluded_companies: [],
  };
  const profile = {
    compensation: { minimum_base: 150000, target_base: 160000 },
    location: { remote: true },
    authorization: { work_authorized: true },
  };

  const result = evaluateGate({
    job,
    targeting,
    profile,
    modes: { application_mode: "selective" },
  });

  assert.equal(result.fit.tier, "med");
  assert.equal(result.gate, "REVIEW");
  assert.equal(result.action, "manual");
  assert.ok(result.reasons.some((r) => r.includes("application mode selective")));
});
