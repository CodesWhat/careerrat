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
if (!new Set(["claude", "codex"]).has(runtimeId)) {
  console.error("Usage: node scripts/qa-live-runtime-search.mjs <claude|codex>");
  process.exit(2);
}

const qaHome = mkdtempSync(join(tmpdir(), `careerrat-live-${runtimeId}-`));
const env = {
  ...process.env,
  CAREERRAT_HOME: qaHome,
  CAREERRAT_DESKTOP_CLI_ONLY: "1",
};

function safeResult(result) {
  return {
    runtimeId,
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
  };
}

try {
  candidateSetupInitialize({ repoRoot, env });
  candidateConfigPatch({
    repoRoot,
    env,
    name: "profile",
    patch: {
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
  });
  candidateConfigPatch({
    repoRoot,
    env,
    name: "targeting",
    patch: {
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
    prompts: [
      {
        id: "nyc-hospitality",
        text: "Find currently active bartender, lead bartender, bar manager, beverage manager, and food and beverage manager openings in New York City. Search the open web broadly, including specialist hospitality boards, employer career pages, and useful aggregators. Keep specific employer-and-role leads even when the full posting needs a browser session, but do not include roles outside New York City.",
      },
    ],
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
      if (event?.message) console.error(`[${runtimeId}] ${event.message}`);
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
  console.error(`[${runtimeId}] ${error?.message || String(error)}`);
  process.exitCode = 1;
} finally {
  closeAll();
  rmSync(qaHome, { recursive: true, force: true });
}
