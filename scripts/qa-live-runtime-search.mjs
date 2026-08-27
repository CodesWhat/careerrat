#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectInstalledRuntimes,
  hasCompleteCareerRatCapabilities,
  probeInstalledRuntime,
} from "../src/core/ai/installed-runtimes.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { readDbScannerRows } from "../src/core/db/scan-context.mjs";
import { candidateConfigPatch, candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import { runAiWebSearch } from "../src/core/search/ai-web-search.mjs";
import { saveSearchPrompts } from "../src/core/search/search-prompts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeId = String(process.argv[2] || "").trim();
const fixtureId = String(process.argv[3] || "hospitality").trim();
if (
  !new Set(["claude", "codex"]).has(runtimeId) ||
  !new Set(["hospitality", "engineering"]).has(fixtureId)
) {
  console.error(
    "Usage: node scripts/qa-live-runtime-search.mjs <claude|codex> [hospitality|engineering]"
  );
  process.exit(2);
}

const qaHome = mkdtempSync(join(tmpdir(), `careerrat-live-${runtimeId}-${fixtureId}-`));
const env = {
  ...process.env,
  CAREERRAT_HOME: qaHome,
  CAREERRAT_DESKTOP_CLI_ONLY: "1",
};

function safeResult(result) {
  return {
    runtimeId,
    fixtureId,
    searched: result.searched,
    found: result.found,
    new: result.new,
    duplicates: result.duplicates,
    disqualified: result.disqualified,
    reasonCounts: result.reasonCounts,
    partial: result.partial,
    unreadable: result.unreadable,
    errors: result.errors,
    failedPromptIds: result.failedPromptIds,
    queryResults: result.queryResults,
    sources: result.sources,
  };
}

const FIXTURES = {
  hospitality: {
    profile: {
      candidate: {
        full_name: "Morgan Hale",
        domain: "hospitality and beverage operations",
      },
      location: {
        home: "New York, NY",
        remote: false,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
      compensation: { minimum_base: null, target_base: null },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
    targeting: {
      role_buckets: [
        {
          name: "Bar leadership",
          priority: "primary",
          titles: ["Bartender", "Lead Bartender", "Bar Manager", "Beverage Manager"],
        },
        {
          name: "Hospitality operations",
          priority: "adjacent",
          titles: ["Food and Beverage Manager", "Event Operations Manager"],
        },
      ],
      keep_signals: [
        "New York City",
        "beverage program ownership",
        "training and advancement",
        "high-volume polished service",
      ],
      cut_signals: ["outside the New York City area"],
      excluded_companies: [],
    },
    prompts: [
      {
        id: "nyc-hospitality",
        text: "Find currently active bartender, lead bartender, bar manager, beverage manager, and food and beverage manager openings in New York City. Search the open web broadly, including specialist hospitality boards, employer career pages, and useful aggregators. Keep specific employer-and-role leads even when the full posting needs a browser session, but do not include roles outside New York City.",
      },
    ],
  },
  engineering: {
    profile: {
      candidate: {
        full_name: "Morgan Hale",
        domain: "developer infrastructure and B2B SaaS",
      },
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: false,
        max_commute_days_per_week: 2,
        relocation: [],
      },
      compensation: { minimum_base: 150000, target_base: 180000 },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
    targeting: {
      role_buckets: [
        {
          name: "Platform and backend",
          priority: "primary",
          titles: ["Staff Platform Engineer", "Staff Backend Engineer"],
        },
        {
          name: "Developer infrastructure",
          priority: "secondary",
          titles: ["Developer Infrastructure Engineer", "Developer Experience Engineer"],
        },
      ],
      keep_signals: [
        "distributed systems",
        "developer infrastructure",
        "B2B SaaS",
        "US remote or New York City hybrid",
      ],
      cut_signals: ["more than two office days", "local role outside New York City"],
      excluded_companies: [],
    },
    prompts: [
      {
        id: "us-remote-engineering",
        text: "Find currently active Staff Platform Engineer and Staff Backend Engineer roles that are remote anywhere in the United States. Search employer career pages, specialist boards, and the open web. Keep specific employer-and-role leads when the full posting needs a browser session, and exclude foreign-only or state-restricted roles that do not include New York.",
      },
      {
        id: "nyc-hybrid-engineering",
        text: "Find currently active Staff Platform Engineer, Staff Backend Engineer, and Infrastructure Engineer roles in New York City that are hybrid with no more than two required office days per week. Search employer career pages, specialist boards, and the open web. Exclude local roles outside New York City and roles requiring three or more office days.",
      },
      {
        id: "developer-infrastructure",
        text: "Find currently active Developer Infrastructure, Developer Experience, Internal Developer Platform, and Staff Infrastructure Software Engineer roles that are either US-remote or hybrid in New York City with at most two office days. Search broadly and keep specific employer-and-role leads even when the full posting needs a browser session.",
      },
    ],
  },
};

try {
  const fixture = FIXTURES[fixtureId];
  candidateSetupInitialize({ repoRoot, env });
  candidateConfigPatch({
    repoRoot,
    env,
    name: "profile",
    patch: fixture.profile,
  });
  candidateConfigPatch({
    repoRoot,
    env,
    name: "targeting",
    patch: fixture.targeting,
  });
  candidateConfigPatch({
    repoRoot,
    env,
    name: "modes",
    patch: { usage_mode: "standard", application_mode: "balanced" },
  });
  saveSearchPrompts({
    repoRoot,
    env,
    prompts: fixture.prompts,
  });

  const runtime = detectInstalledRuntimes({ env }).find((entry) => entry.id === runtimeId);
  if (!runtime?.available) throw new Error(`${runtimeId} is not installed.`);
  const probe = await probeInstalledRuntime(runtime, { env, cwd: repoRoot });
  if (!probe?.ready) throw new Error(`${runtimeId} is not ready: ${probe?.status || "unknown"}`);
  if (!hasCompleteCareerRatCapabilities(probe.capabilities, runtimeId)) {
    throw new Error(`${runtimeId} did not pass the complete CareerRat capability probe.`);
  }
  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId,
    providerFallback: false,
    verification: {
      path: runtime.path,
      capabilities: probe.capabilities,
      checkedAt: new Date().toISOString(),
    },
  });

  const result = await runAiWebSearch({
    repoRoot,
    env,
    onProgress(event) {
      if (event?.message) console.error(`[${runtimeId}/${fixtureId}] ${event.message}`);
    },
  });
  const rows = readDbScannerRows({ repoRoot, env })
    .filter((row) => row.source === "ai-web-search")
    .map((row) => ({
      company: row.company,
      role: row.role,
      location: row.loc,
      fitScore: row.fitScore,
      partial: row.scanner?.bodyPartial === true,
      source: row.link,
    }));
  console.log(JSON.stringify({ summary: safeResult(result), rows }, null, 2));
  if (result.errors?.length || result.failedPromptIds?.length || rows.length === 0)
    process.exitCode = 1;
} catch (error) {
  console.error(`[${runtimeId}/${fixtureId}] ${error?.message || String(error)}`);
  process.exitCode = 1;
} finally {
  closeAll();
  rmSync(qaHome, { recursive: true, force: true });
}
