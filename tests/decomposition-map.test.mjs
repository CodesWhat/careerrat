import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const privateOwnerRoots = new Set([
  "candidate",
  "workspace",
  ".internal",
  ".rolester",
  "tmp-skill-conversion",
]);
const plannedCapableOwnerTypes = new Set(["planned_ts_module", "planned_policy", "api_route"]);

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

function normalizeOwnerTarget(ownerRef) {
  return path.posix.normalize(ownerRef.replaceAll("\\", "/")).replace(/^(\.\/)+/, "");
}

function gitCheck(args) {
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isGitIgnored(relPath) {
  return gitCheck(["check-ignore", "-q", "--no-index", "--", relPath]);
}

function isTrackedPath(relPath) {
  return gitCheck(["ls-files", "--error-unmatch", "--", relPath]);
}

function assertSafeOwnerTarget(ownerRef, label) {
  assertNonEmptyString(ownerRef, label);
  assert.ok(!ownerRef.includes("\0"), `${label} must not contain null bytes: ${ownerRef}`);
  const slashTarget = ownerRef.replaceAll("\\", "/");
  assert.ok(
    !path.posix.isAbsolute(slashTarget) && !path.win32.isAbsolute(ownerRef),
    `${label} must be repo-relative: ${ownerRef}`
  );
  assert.ok(
    !slashTarget.split("/").includes(".."),
    `${label} must not traverse directories: ${ownerRef}`
  );
  const normalized = normalizeOwnerTarget(ownerRef);
  assert.ok(normalized !== "" && normalized !== ".", `${label} target is required`);
  assert.ok(
    !normalized.split("/").includes(".."),
    `${label} must not traverse directories after normalization: ${ownerRef}`
  );
  assert.ok(
    !privateOwnerRoots.has(normalized.split("/")[0]),
    `${label} must not point at private/generated workspace data: ${ownerRef}`
  );
  assert.ok(!isGitIgnored(normalized), `${label} must not be gitignored/private: ${ownerRef}`);
  return normalized;
}

function assertRepoOwnerPath(ownerRef, label = "owner", ownerType = undefined) {
  assertNonEmptyString(ownerRef, label);

  if (ownerRef.startsWith("planned:")) {
    assert.ok(
      plannedCapableOwnerTypes.has(ownerType),
      `${label} planned owners must use a planned-capable owner_type: ${ownerRef}`
    );
    const normalized = assertSafeOwnerTarget(
      ownerRef.slice("planned:".length),
      `${label} planned target`
    );
    if (ownerType === "planned_ts_module" || ownerType === "api_route") {
      assert.match(
        normalized,
        /^(src|scripts)\/.+\.mjs$/,
        `${label} planned module owner must target a future JS module path: ${ownerRef}`
      );
    }
    if (ownerType === "planned_policy") {
      assert.match(
        normalized,
        /^[a-z0-9][a-z0-9-]*$/,
        `${label} planned_policy must be a policy or epic label, not a file path: ${ownerRef}`
      );
    }
    return;
  }

  assert.notEqual(
    ownerType,
    "planned_ts_module",
    `${label} planned_ts_module owners must use planned:: ${ownerRef}`
  );
  assert.notEqual(
    ownerType,
    "planned_policy",
    `${label} planned_policy owners must use planned:: ${ownerRef}`
  );

  const normalized = assertSafeOwnerTarget(ownerRef, label);
  assert.ok(isTrackedPath(normalized), `${label} must be a checked-in source path: ${ownerRef}`);
  const resolved = path.resolve(repoRoot, normalized);
  assert.ok(
    resolved.startsWith(`${repoRoot}${path.sep}`),
    `${label} must stay inside the repo: ${ownerRef}`
  );
  assert.ok(existsSync(resolved), `${label} reference must exist: ${ownerRef}`);
}

test("owner validation enforces planned owner type semantics", () => {
  assert.throws(
    () => assertRepoOwnerPath("planned:src/core/future.mjs", "bad owner", "existing_ts_module"),
    /planned-capable owner_type/
  );
  assert.throws(
    () => assertRepoOwnerPath("planned:src/core/future.mjs", "bad policy", "planned_policy"),
    /not a file path/
  );
  assert.doesNotThrow(() =>
    assertRepoOwnerPath("planned:src/core/future.mjs", "future module", "planned_ts_module")
  );
  assert.doesNotThrow(() =>
    assertRepoOwnerPath("planned:src/cli/future-route.mjs", "future route", "api_route")
  );
  assert.doesNotThrow(() =>
    assertRepoOwnerPath("planned:v2-browser-surface", "future policy", "planned_policy")
  );
});

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
        assert.ok(allowedOwnerTypes.has(row.owner_type), `${label}.owner_type is invalid`);
        assertRepoOwnerPath(row.owner, `${label}.owner`, row.owner_type);
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
