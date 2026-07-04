import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseYaml } from "../src/core/profile/yaml.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const artifactPaths = {
  decomposition: ".planning/architecture/skill-decomposition.yml",
  discoverCompanies: ".planning/architecture/discover-companies-target-contract.md",
  routingPolicy: ".planning/architecture/runtime-routing-policy.md",
};

function readRepoFile(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

const decompositionText = readRepoFile(artifactPaths.decomposition);
const discoverCompaniesText = readRepoFile(artifactPaths.discoverCompanies);
const routingPolicyText = readRepoFile(artifactPaths.routingPolicy);
const decomposition = parseYaml(decompositionText);

const requiredSkills = [
  "setup-searches",
  "research-boards",
  "discover-companies",
  "search-jobs",
  "evaluate-job",
  "apply-job",
  "email-comms",
  "interview-prep",
  "track-outcomes",
];

const requiredBuckets = [
  "deterministic",
  "bounded_ai",
  "full_skill_runtime",
  "prompt_spec",
  "deferred",
];

function assertContains(text, needle, label) {
  const normalizedText = text.replace(/\s+/g, " ");
  const normalizedNeedle = needle.replace(/\s+/g, " ");
  assert.ok(normalizedText.includes(normalizedNeedle), `${label} should contain ${needle}`);
}

function assertContainsAll(text, needles, label) {
  for (const needle of needles) {
    assertContains(text, needle, label);
  }
}

function collectOwnerRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectOwnerRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "owner" && typeof nested === "string" && nested.trim() !== "") {
      refs.push(nested);
    } else {
      collectOwnerRefs(nested, refs);
    }
  }
  return refs;
}

function sectionBetween(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  assert.notEqual(start, -1, `expected section ${startHeading}`);
  const end = endHeading ? text.indexOf(endHeading, start + startHeading.length) : -1;
  return text.slice(start, end === -1 ? undefined : end);
}

test("skill-decomposition.yml parses and lists high-priority skills", () => {
  assert.equal(decomposition.phase, "01-decomposition-map");
  assert.ok(decomposition.skills && typeof decomposition.skills === "object");

  for (const skill of requiredSkills) {
    assert.ok(decomposition.skills[skill], `missing ${skill} decomposition entry`);
  }
});

test("each high-priority skill has the required classification buckets", () => {
  for (const skill of requiredSkills) {
    const entry = decomposition.skills[skill];
    for (const bucket of requiredBuckets) {
      assert.ok(Array.isArray(entry[bucket]), `${skill}.${bucket} must be present as an array`);
    }
  }
});

test("inventory owner references are existing repo paths or planned owners", () => {
  const ownerRefs = collectOwnerRefs(decomposition.skills);
  assert.ok(ownerRefs.length > 0, "expected owner references in decomposition inventory");

  for (const ownerRef of ownerRefs) {
    if (ownerRef.startsWith("planned:")) continue;
    assert.ok(
      existsSync(path.join(repoRoot, ownerRef)),
      `owner reference must exist or use planned: prefix: ${ownerRef}`
    );
  }
});

test("discover-companies contract keeps seed, cache, cascade, and confirmation boundaries", () => {
  assertContainsAll(
    discoverCompaniesText,
    [
      "companySeedSchema",
      "companyBoardResolutionCache",
      "company_name",
      "company_domain",
      "careers_url",
      "job_board_url",
      "ats_provider",
      "api_url",
      "confidence",
      "source_provenance",
      "first_resolved_at",
      "last_verified_at",
      "last_scan_result",
      "failure_count",
      "existing DB/source config",
      "cached company board resolution",
      "direct ATS scanner/local scraper",
      "free or cheap job API",
      "targeted crawler/extractor",
      "AI web search/extract",
      "full skill runtime",
      "Techmap",
      "JobDataFeeds",
      "Firecrawl",
      "Tavily",
      "Adzuna",
      "Coresignal",
      "confirm-first",
      "Supported ATS promotion",
      "unsupported public-page cache",
      "does not require or authorize runtime source changes",
      "Phase 1 does not create new DB tables, migrations, route handlers, or runtime source changes",
    ],
    artifactPaths.discoverCompanies
  );
});

test("routing policy distinguishes local APIs, DB/CLI owners, bounded AI, chat, and full skill runtime", () => {
  assertContainsAll(
    routingPolicyText,
    [
      "/api/search/scan",
      "/api/data/*",
      "DB verb or CLI helper",
      "bounded structured AI",
      "/api/chat/*",
      "POST /api/skill/run",
    ],
    artifactPaths.routingPolicy
  );

  const ui = sectionBetween(routingPolicyText, "### UI", "### CLI");
  assert.match(ui, /local API routes/i);
  assert.match(ui, /\/api\/data\/\*/);
  assert.match(ui, /bounded AI/i);
  assert.match(ui, /POST \/api\/skill\/run/);

  const cli = sectionBetween(routingPolicyText, "### CLI", "### Agents");
  assert.match(cli, /DB verbs and existing CLI helpers/i);
  assert.match(cli, /deterministic commands/i);
  assert.match(cli, /bounded AI/i);
  assert.match(cli, /skill or chat runtimes/i);

  const agents = sectionBetween(routingPolicyText, "### Agents", "## Existing Route Owners");
  assert.match(agents, /deterministic route, DB verb, CLI helper, or\s+bounded AI owner/i);
  assert.match(agents, /\/api\/chat\/\*/);
  assert.match(agents, /POST \/api\/skill\/run/);
});

test("all Phase 1 artifacts keep the non-runtime boundary and D-01 through D-14 coverage", () => {
  assert.match(decompositionText, /Phase 1 creates planning artifacts only/);
  assert.match(discoverCompaniesText, /Phase 1 planning artifact only/);
  assert.match(routingPolicyText, /Phase 1 is documentation and validation only/);

  const allArchitectureText = [decompositionText, discoverCompaniesText, routingPolicyText].join(
    "\n"
  );

  for (let i = 1; i <= 14; i++) {
    const decisionId = `D-${String(i).padStart(2, "0")}`;
    assertContains(allArchitectureText, decisionId, "Phase 1 architecture artifacts");
  }
});
