#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectInstalledRuntimes,
  hasCompleteCareerRatCapabilities,
  installedRuntimeExecutionIdentity,
  probeInstalledRuntime,
} from "../src/core/ai/installed-runtimes.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { readDbScannerRows } from "../src/core/db/scan-context.mjs";
import { candidateConfigPatch, candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import { healSearchSourceConfig } from "../src/core/onboarding/first-search-run.mjs";
import { runAiWebSearch } from "../src/core/search/ai-web-search.mjs";
import { saveSearchPrompts } from "../src/core/search/search-prompts.mjs";
import { titleMatchesBucket } from "../src/core/search/title-match.mjs";
import { runUnifiedJobSearch } from "../src/core/search/unified-job-search.mjs";
import {
  annotateCanonicalReadableRows,
  buildLiveSearchReceipt,
  canonicalSourcesFromUnifiedSearch,
  LIVE_SEARCH_RECEIPT_DIRECTORY,
  liveSearchReceiptFilename,
  verifyLiveSearchReceiptForReview,
} from "./lib/live-search-receipts.mjs";
import { runSourcedScan } from "./scan-sourced.mjs";

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

const qaHome = mkdtempSync(join(tmpdir(), `careerrat-native-ai-${runtimeId}-${fixtureId}-`));
const env = {
  ...process.env,
  CAREERRAT_HOME: qaHome,
  CAREERRAT_DESKTOP_CLI_ONLY: "1",
};
const receiptDirectory = resolve(join(repoRoot, LIVE_SEARCH_RECEIPT_DIRECTORY));
const MAX_DIAGNOSTIC_CAPTURE_FAILURES = 10;

function currentSourceRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function assertCleanSourceRevision(expectedRevision) {
  const currentRevision = currentSourceRevision();
  if (currentRevision !== expectedRevision) {
    throw new Error("The source revision changed while the native AI search was running.");
  }
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const receiptPrefix = `${LIVE_SEARCH_RECEIPT_DIRECTORY}/`;
  const changedSourcePath = status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1))
    .find((path) => !String(path).startsWith(receiptPrefix));
  if (changedSourcePath) {
    throw new Error(
      `Native AI search evidence requires a clean source revision (${changedSourcePath}).`
    );
  }
}

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
    canonicalOverlaps: Array.isArray(result.canonicalOverlaps)
      ? result.canonicalOverlaps.map((overlap) => ({
          promptId: String(overlap?.promptId || ""),
          url: String(overlap?.url || ""),
        }))
      : [],
    disqualified: result.disqualified,
    reasonCounts: result.reasonCounts,
    partial: result.partial,
    unreadable: result.unreadable,
    errors: result.errors,
    failedPromptIds: result.failedPromptIds,
    queryResults: result.queryResults,
    sources: result.sources,
    captureFailures: Array.isArray(result.captureFailures)
      ? result.captureFailures.slice(0, MAX_DIAGNOSTIC_CAPTURE_FAILURES)
      : [],
    canonicalDisqualifications: Array.isArray(result.canonicalDisqualifications)
      ? result.canonicalDisqualifications.slice(0, MAX_DIAGNOSTIC_CAPTURE_FAILURES)
      : [],
    fetchedPostingDecisions: Array.isArray(result.fetchedPostingDecisions)
      ? result.fetchedPostingDecisions.slice(0, MAX_DIAGNOSTIC_CAPTURE_FAILURES)
      : [],
    validationFailures: Array.isArray(result.validationFailures)
      ? result.validationFailures.slice(0, MAX_DIAGNOSTIC_CAPTURE_FAILURES)
      : [],
  };
}

function safeDeterministicResult(result) {
  return {
    scanned: result.scanned,
    new: result.new,
    presented: result.presented,
    errors: result.errors,
    loginRequests: result.loginRequests,
    sourceCoverage: result.sourceCoverage,
  };
}

function presentedSetReceipt({ fixture, result, rows }) {
  const presentedRows = rows.filter(
    (row) =>
      row.canonicalReadable === true &&
      row.partial !== true &&
      Number.isFinite(Number(row.fitScore)) &&
      Number(row.fitScore) >= result.fitFloor
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
    .filter((bucket) => presentedRows.some((row) => titleMatchesBucket(row.role, bucket)))
    .map((bucket) => bucket.name);
  return {
    presentedRowCount: presentedRows.length,
    presentedRoleCount,
    presentedBucketCount: presentedBuckets.length,
    presentedBuckets,
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
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
      compensation: { minimum_annual_earnings: 85000 },
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
        "$85,000 minimum expected annual cash earnings, including tips",
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
        text: "Find currently active Bar Manager, Assistant Bar Manager, Bar Operations Lead, Lead Bartender, and Head Bartender openings in New York City. Search the open web broadly, including specialist hospitality boards, employer career pages, and useful aggregators. Morgan needs to earn at least $85,000 a year in cash from the job. For tipped roles, count wages plus expected tips. You may also count recurring commissions or cash bonuses, but not equity or benefits. Keep jobs when earnings are not posted so they can be checked later. Skip a job only when its posted range cannot reach $85,000; keep a range that crosses $85,000 for review. Exclude local roles outside New York City.",
      },
      {
        id: "nyc-hospitality-operations",
        text: "Find currently active Food and Beverage Operations Manager, Assistant General Manager, and General Manager openings in New York City hospitality businesses. Search specialist hospitality boards, employer career pages, and the open web. Morgan needs to earn at least $85,000 a year in cash from the job. For tipped roles, count wages plus expected tips. You may also count recurring commissions or cash bonuses, but not equity or benefits. Keep jobs when earnings are not posted so they can be checked later. Skip a job only when its posted range cannot reach $85,000; keep a range that crosses $85,000 for review. Exclude local roles outside New York City.",
      },
      {
        id: "event-and-venue-operations",
        text: "Find currently active Event Operations Manager, Event Coordinator, and Venue Operations Manager roles that are either local to New York City or remote anywhere in the United States and available to a New York resident. Search employer career pages, specialist boards, and the open web. Morgan needs to earn at least $85,000 a year in cash from the job. For tipped roles, count wages plus expected tips. You may also count recurring commissions or cash bonuses, but not equity or benefits. Keep jobs when earnings are not posted so they can be checked later. Skip a job only when its posted range cannot reach $85,000; keep a range that crosses $85,000 for review.",
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
        "$150,000 minimum annual base salary",
      ],
      cut_signals: ["more than two office days", "local role outside New York City"],
      excluded_companies: [],
      fit_bands: { high_min: 85, med_min: 65, fit_floor: 65 },
    },
    prompts: [
      {
        id: "us-remote-engineering",
        text: "Find currently active Staff Platform Engineer and Staff Backend Engineer roles that are remote anywhere in the United States. Search employer career pages, specialist boards, and the open web. When an annual base salary is posted, require its lower bound to be at least $150,000; do not count bonuses, commissions, equity, OTE, or total compensation toward that floor. Keep specific employer-and-role leads when base salary or the full posting needs verification, and exclude foreign-only or state-restricted roles that do not include New York.",
      },
      {
        id: "nyc-hybrid-engineering",
        text: "Find currently active Staff Platform Engineer, Staff Backend Engineer, and Infrastructure Engineer roles in New York City that are hybrid with no more than two required office days per week. Search employer career pages, specialist boards, and the open web. When an annual base salary is posted, require its lower bound to be at least $150,000; do not count bonuses, commissions, equity, OTE, or total compensation toward that floor. Keep specific leads with unverified base salary. Exclude local roles outside New York City and roles requiring three or more office days.",
      },
      {
        id: "developer-infrastructure",
        text: "Find currently active Developer Infrastructure, Developer Experience, Internal Developer Platform, and Staff Infrastructure Software Engineer roles that are either US-remote or hybrid in New York City with at most two office days. Search broadly. When an annual base salary is posted, require its lower bound to be at least $150,000; do not count bonuses, commissions, equity, OTE, or total compensation toward that floor. Keep specific employer-and-role leads even when base salary or the full posting needs a browser session.",
      },
    ],
  },
};

try {
  const sourceRevision = currentSourceRevision();
  assertCleanSourceRevision(sourceRevision);
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
  healSearchSourceConfig({ repoRoot, env });

  const runtime = detectInstalledRuntimes({ env }).find((entry) => entry.id === runtimeId);
  if (!runtime?.available) throw new Error(`${runtimeId} is not installed.`);
  const probe = await probeInstalledRuntime(runtime, { env, cwd: repoRoot });
  if (!probe?.ready) throw new Error(`${runtimeId} is not ready: ${probe?.status || "unknown"}`);
  if (!hasCompleteCareerRatCapabilities(probe.capabilities, runtimeId)) {
    throw new Error(`${runtimeId} did not pass the complete CareerRat capability probe.`);
  }
  const identity = installedRuntimeExecutionIdentity(
    { ...runtime, version: probe.version },
    { env }
  );
  if (!identity) throw new Error(`${runtimeId} executable identity could not be verified.`);
  const runtimeVerification = {
    ...identity,
    capabilities: probe.capabilities,
    checkedAt: new Date().toISOString(),
  };
  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId,
    providerFallback: false,
    verification: runtimeVerification,
  });

  const unified = await runUnifiedJobSearch({
    searchExecutionId: `release-${runtimeId}-${fixtureId}`,
    runDeterministic: async ({ signal }) =>
      runSourcedScan({
        repoRoot,
        env,
        signal,
        write: true,
        verify: true,
        onProgress(progress) {
          console.error(
            `[${runtimeId}/${fixtureId}] Deterministic sources ${progress.completedSources}/${progress.totalSources}`
          );
        },
      }),
    runAiWeb: async ({ deterministic, signal }) =>
      runAiWebSearch({
        repoRoot,
        env,
        deterministic,
        signal,
        onProgress(event) {
          if (event?.message) console.error(`[${runtimeId}/${fixtureId}] ${event.message}`);
        },
      }),
    aiAvailable: true,
  });
  if (unified.lanes.deterministic.status !== "succeeded") {
    throw new Error("The deterministic search lane did not succeed.");
  }
  if (unified.lanes.aiWeb.status !== "succeeded") {
    throw new Error("The selected native runtime AI lane did not succeed.");
  }
  const deterministicResult = unified.lanes.deterministic.result;
  const aiResult = unified.lanes.aiWeb.result;
  const canonicalSources = canonicalSourcesFromUnifiedSearch({
    deterministicResult,
    aiResult,
  });
  const rows = annotateCanonicalReadableRows({
    rows: readDbScannerRows({ repoRoot, env }).map((row) => ({
      company: row.company,
      role: row.role,
      location: row.loc,
      fitScore: row.fitScore,
      partial: row.scanner?.bodyPartial === true,
      qualificationUnknowns: row.scanner?.qualificationUnknowns || [],
      discoveryLane: row.source === "ai-web-search" ? "ai-web" : "deterministic",
      unverified: row.scanner?.unverified === true,
      source: row.link,
    })),
    sources: canonicalSources,
  });
  const usefulSet = presentedSetReceipt({ fixture, result: aiResult, rows });
  const aiSummary = safeResult(aiResult);
  const summary = {
    presented: usefulSet.presentedRowCount,
    fitFloor: aiResult.fitFloor,
    errors: aiSummary.errors,
    failedPromptIds: aiSummary.failedPromptIds,
    deterministic: safeDeterministicResult(deterministicResult),
    ai: aiSummary,
  };
  const completedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      kind: "native-ai-search-diagnostic",
      sourceRevision,
      runtimeId,
      fixtureId,
      completedAt,
      searchExecutionId: unified.searchExecutionId,
      summary,
      usefulSet,
      rows,
    })
  );
  const receipt = buildLiveSearchReceipt({
    sourceRevision,
    runtimeId,
    fixtureId,
    providerFallback: false,
    completedAt,
    runtimeVerification,
    laneStatuses: {
      deterministic: unified.lanes.deterministic.status,
      aiWeb: unified.lanes.aiWeb.status,
    },
    summary,
    expectedPromptIds: fixture.prompts.map((prompt) => prompt.id),
    aiSummary,
    usefulSet,
    rows,
  });
  verifyLiveSearchReceiptForReview(receipt);
  assertCleanSourceRevision(sourceRevision);
  mkdirSync(receiptDirectory, { recursive: true });
  const receiptPath = join(receiptDirectory, liveSearchReceiptFilename(runtimeId, fixtureId));
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ kind: "native-ai-search-receipt", receiptPath }));
} catch (error) {
  console.error(`[${runtimeId}/${fixtureId}] ${error?.message || String(error)}`);
  process.exitCode = 1;
} finally {
  closeAll();
  rmSync(qaHome, { recursive: true, force: true });
}
