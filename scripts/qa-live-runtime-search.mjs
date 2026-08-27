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
    presented: result.presented,
    fitFloor: result.fitFloor,
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

function normalizedTitleWords(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}

function roleMatchesBucket(role, bucket) {
  const actual = normalizedTitleWords(role);
  return (bucket.titles || []).some((title) => {
    const target = normalizedTitleWords(title);
    return target.size > 0 && [...target].every((word) => actual.has(word));
  });
}

function presentedSetReceipt({ fixture, result, rows }) {
  const presentedRows = rows.filter(
    (row) => Number.isFinite(Number(row.fitScore)) && Number(row.fitScore) >= result.fitFloor
  );
  const presentedRoleCount = new Set(
    presentedRows
      .map((row) =>
        String(row.role || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  ).size;
  const presentedBuckets = (fixture.targeting.role_buckets || [])
    .filter((bucket) => presentedRows.some((row) => roleMatchesBucket(row.role, bucket)))
    .map((bucket) => bucket.name);
  return { presentedRoleCount, presentedBucketCount: presentedBuckets.length, presentedBuckets };
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
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
      compensation: { minimum_base: 85000, target_base: 100000 },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
    targeting: {
      role_buckets: [
        {
          name: "Bar leadership",
          priority: "primary",
          titles: [
            "Bar Manager",
            "Assistant Bar Manager",
            "Bar Operations Lead",
            "Lead Bartender",
            "Head Bartender",
          ],
        },
        {
          name: "Hospitality operations",
          priority: "secondary",
          titles: [
            "Operations Manager, Food & Beverage",
            "Assistant General Manager",
            "General Manager",
          ],
        },
        {
          name: "Event and venue operations",
          priority: "adjacent",
          titles: ["Event Operations Manager", "Event Coordinator", "Venue Operations Manager"],
        },
      ],
      keep_signals: [
        "New York City local or remote anywhere in the United States",
        "beverage program ownership",
        "training and advancement",
        "high-volume polished service",
        "$85,000 or more in salary or credible total compensation",
      ],
      cut_signals: ["local role outside New York City", "remote role unavailable in New York"],
      excluded_companies: [],
      fit_bands: { high_min: 85, med_min: 65, fit_floor: 65 },
    },
    formDefaults: {
      voluntary_self_identification: {
        enabled: true,
        default_action: "decline_when_available",
        confirmed_at: "2026-08-27T00:00:00.000Z",
      },
    },
    prompts: [
      {
        id: "nyc-bar-leadership",
        text: "Find currently active Bar Manager, Assistant Bar Manager, Bar Operations Lead, Lead Bartender, and Head Bartender openings in New York City. Search the open web broadly, including specialist hospitality boards, employer career pages, and useful aggregators. Prefer roles that can credibly reach $85,000 in salary or total compensation. Keep specific employer-and-role leads when compensation or the full posting still needs verification, but exclude local roles outside New York City.",
      },
      {
        id: "nyc-hospitality-operations",
        text: "Find currently active Food and Beverage Operations Manager, Assistant General Manager, and General Manager openings in New York City hospitality businesses. Search specialist hospitality boards, employer career pages, and the open web. Prefer roles paying at least $85,000 with a path toward $100,000. Keep specific sourced leads when compensation still needs verification, but exclude local roles outside New York City.",
      },
      {
        id: "event-and-venue-operations",
        text: "Find currently active Event Operations Manager, Event Coordinator, and Venue Operations Manager roles that are either local to New York City or remote anywhere in the United States and available to a New York resident. Search employer career pages, specialist boards, and the open web. Prefer hospitality-transferable roles paying at least $85,000, while keeping specific sourced leads with unverified compensation for later evaluation.",
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
  if (fixture.formDefaults) {
    candidateConfigPatch({
      repoRoot,
      env,
      name: "form-defaults",
      patch: fixture.formDefaults,
    });
  }
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
      qualificationUnknowns: row.scanner?.qualificationUnknowns || [],
      unverified: row.scanner?.unverified === true,
      source: row.link,
    }));
  const usefulSet = presentedSetReceipt({ fixture, result, rows });
  console.log(JSON.stringify({ summary: safeResult(result), usefulSet, rows }, null, 2));
  if (
    result.errors?.length ||
    result.failedPromptIds?.length ||
    rows.length === 0 ||
    Number(result.presented || 0) < 1 ||
    rows.some((row) => row.unverified !== true) ||
    (fixtureId === "hospitality" &&
      (usefulSet.presentedRoleCount < 3 || usefulSet.presentedBucketCount < 2))
  )
    process.exitCode = 1;
} catch (error) {
  console.error(`[${runtimeId}/${fixtureId}] ${error?.message || String(error)}`);
  process.exitCode = 1;
} finally {
  closeAll();
  rmSync(qaHome, { recursive: true, force: true });
}
