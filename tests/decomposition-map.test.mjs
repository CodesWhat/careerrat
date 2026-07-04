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

function requiredSection(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  assert.notEqual(start, -1, `expected section ${startHeading}`);
  if (!endHeading) return text.slice(start);
  const end = endHeading ? text.indexOf(endHeading, start + startHeading.length) : -1;
  assert.notEqual(end, -1, `expected section ${endHeading} after ${startHeading}`);
  return text.slice(start, end);
}

function assertOrdered(text, phrases, label) {
  let previous = -1;
  for (const phrase of phrases) {
    const next = text.indexOf(phrase);
    assert.ok(next > previous, `${label} must contain ${phrase} in order`);
    previous = next;
  }
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value.trim(), "", `${label} must not be empty`);
}

function assertRepoOwnerPath(ownerRef, label = "owner") {
  assertNonEmptyString(ownerRef, label);
  assert.ok(!ownerRef.includes("\0"), `${label} must not contain null bytes: ${ownerRef}`);

  if (ownerRef.startsWith("planned:")) {
    assert.notEqual(
      ownerRef.slice("planned:".length).trim(),
      "",
      `${label} planned target is required`
    );
    return;
  }

  assert.ok(!path.isAbsolute(ownerRef), `${label} must be repo-relative: ${ownerRef}`);
  assert.ok(
    !ownerRef.split(/[\\/]/).includes(".."),
    `${label} must not traverse directories: ${ownerRef}`
  );
  assert.ok(
    !/^(candidate|workspace|\.internal|\.rolester|tmp-skill-conversion)(\/|$)/.test(ownerRef),
    `${label} must not point at private/generated workspace data: ${ownerRef}`
  );

  const resolved = path.resolve(repoRoot, ownerRef);
  assert.ok(
    resolved.startsWith(`${repoRoot}${path.sep}`),
    `${label} must stay inside the repo: ${ownerRef}`
  );
  assert.ok(existsSync(resolved), `${label} reference must exist: ${ownerRef}`);
}

function assertDecisionRefs(decisions, allowedDecisions, label) {
  assert.ok(Array.isArray(decisions), `${label}.decisions must be an array`);
  assert.ok(decisions.length > 0, `${label}.decisions must not be empty`);
  for (const decision of decisions) {
    assert.ok(allowedDecisions.has(decision), `${label}.decisions contains unknown ${decision}`);
  }
}

test("skill-decomposition.yml parses and lists high-priority skills", () => {
  assert.equal(decomposition.phase, "01-decomposition-map");
  assert.ok(decomposition.skills && typeof decomposition.skills === "object");

  for (const skill of requiredSkills) {
    assert.ok(decomposition.skills[skill], `missing ${skill} decomposition entry`);
  }
});

test("each high-priority skill has required metadata and classification buckets", () => {
  const allowedOwnerTypes = new Set(Object.keys(decomposition.owner_types ?? {}));
  const allowedDecisions = new Set(Object.keys(decomposition.source_decisions ?? {}));

  assert.deepEqual(
    Object.keys(decomposition.classification_buckets ?? {}).sort(),
    requiredBuckets.toSorted(),
    "classification_buckets should declare the required bucket names"
  );
  assert.ok(allowedOwnerTypes.size > 0, "owner_types should be declared");
  assert.equal(allowedDecisions.size, 14, "source_decisions should declare D-01 through D-14");

  for (const skill of requiredSkills) {
    const entry = decomposition.skills[skill];
    assertRepoOwnerPath(entry.source, `${skill}.source`);
    assert.ok(Array.isArray(entry.requirements), `${skill}.requirements must be an array`);
    assert.ok(entry.requirements.length > 0, `${skill}.requirements must not be empty`);
    assert.ok(Array.isArray(entry.notes), `${skill}.notes must be an array`);

    for (const bucket of requiredBuckets) {
      assert.ok(Array.isArray(entry[bucket]), `${skill}.${bucket} must be present as an array`);
      for (const [index, row] of entry[bucket].entries()) {
        const label = `${skill}.${bucket}[${index}]`;
        assertNonEmptyString(row.step, `${label}.step`);
        assertRepoOwnerPath(row.owner, `${label}.owner`);
        assert.ok(allowedOwnerTypes.has(row.owner_type), `${label}.owner_type is invalid`);
        assertDecisionRefs(row.decisions, allowedDecisions, label);
      }
    }
  }
});

test("discover-companies contract keeps seed, cache, cascade, and confirmation boundaries", () => {
  assertOrdered(
    discoverCompaniesText,
    [
      "## Phase Boundary",
      "## Inputs",
      "## AI Seed Schema",
      "## Resolver Cache Contract",
      "## Cheapest-First Sourcing Cascade",
      "## Scanner And Extractor Cascade",
      "## Proposal Gate",
      "## Confirmation Contract",
      "## Write Path",
      "## Bakeoff Metrics",
      "## Existing Code Owners",
      "## Non-Goals",
    ],
    artifactPaths.discoverCompanies
  );

  const cascade = requiredSection(
    discoverCompaniesText,
    "## Cheapest-First Sourcing Cascade",
    "## Scanner And Extractor Cascade"
  );
  assertOrdered(
    cascade,
    [
      "existing DB/source config",
      "cached company board resolution",
      "direct ATS scanner/local scraper",
      "free or cheap job API",
      "targeted crawler/extractor",
      "AI web search/extract",
      "full skill runtime",
    ],
    "D-02 cheapest-first cascade"
  );

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
      "next_refresh_reason",
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

  for (let i = 1; i <= 14; i++) {
    assertContains(
      discoverCompaniesText,
      `D-${String(i).padStart(2, "0")}`,
      artifactPaths.discoverCompanies
    );
  }
});

test("routing policy distinguishes local APIs, DB/CLI owners, bounded AI, chat, and full skill runtime", () => {
  assertOrdered(
    routingPolicyText,
    [
      "## Phase Boundary",
      "## Principles",
      "## Decision Matrix",
      "## Caller Rules",
      "### UI",
      "### CLI",
      "### Agents",
      "## Existing Route Owners",
      "## No-AI Degradation",
      "## Examples",
      "## Drift Checks",
    ],
    artifactPaths.routingPolicy
  );

  const principles = requiredSection(routingPolicyText, "## Principles", "## Decision Matrix");
  assertOrdered(
    principles,
    [
      "Cheapest correct route first",
      "DB/source config",
      "cached resolution",
      "deterministic scanners or local",
      "cheap API lanes",
      "targeted extractors",
      "bounded AI",
      "full skill runtime",
    ],
    "D-02 routing order"
  );
  assertContains(principles, "cost tier", artifactPaths.routingPolicy);

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

  const ui = requiredSection(routingPolicyText, "### UI", "### CLI");
  assert.match(ui, /local API routes/i);
  assert.match(ui, /\/api\/data\/\*/);
  assert.match(ui, /bounded AI/i);
  assert.match(ui, /POST \/api\/skill\/run/);

  const cli = requiredSection(routingPolicyText, "### CLI", "### Agents");
  assert.match(cli, /DB verbs and existing CLI helpers/i);
  assert.match(cli, /deterministic commands/i);
  assert.match(cli, /bounded AI/i);
  assert.match(cli, /skill or chat runtimes/i);

  const agents = requiredSection(routingPolicyText, "### Agents", "## Existing Route Owners");
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
    assert.ok(
      decomposition.source_decisions?.[decisionId],
      `source_decisions missing ${decisionId}`
    );
    assertContains(allArchitectureText, decisionId, "Phase 1 architecture artifacts");
  }
});
