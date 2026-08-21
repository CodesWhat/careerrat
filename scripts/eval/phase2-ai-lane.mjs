#!/usr/bin/env node

// scripts/eval/phase2-ai-lane.mjs — SEARCH-SHAPE-EVAL.md Phase 2.
//
// Feeds the SAME labeled corpus (tests/fixtures/eval/search-shape-corpus.json)
// through the AI web-search lane's own scoring/triage logic — the search-jobs
// skill's "AI Web Search mode" section plus its "STEP 3 — Coarse triage" rules,
// read VERBATIM out of .agents/skills/search-jobs/SKILL.md at run time (see
// lib/skill-sections.mjs) so this always replays the current rules, never a
// hand-copied snapshot — scored against the SAME candidate context
// buildSearchPromptContext({config}) would actually build for
// examples/demo-workspace (reused unmodified from src/core/search/
// search-prompts.mjs).
//
// ai-web-search.mjs itself has no deterministic scoring function to call: in
// production, runAiWebSearch() drives the search-jobs skill through
// runSkillStream(), which does its own WebSearch/WebFetch fan-out AND the
// STEP 3 triage in one natural-language pass, at whatever AI route the
// operator has configured (BYOK key, proxy, or an installed CLI). There is no
// way to "call the AI lane's scoring" without an actual model invocation.
//
// This script skips the live-search half (no WebSearch/WebFetch — the
// posting is handed to the model already "found", exactly like the labeled
// corpus's Phase 1 entries) and runs ONLY the triage half, offline, via the
// same installed-CLI runtime production code already supports
// (src/core/ai/installed-runtimes.mjs — detectInstalledRuntimes() +
// buildInstalledRuntimeInvocation(), reused unmodified here; this script adds
// its own spawn/parse only to retain total_cost_usd/duration_ms, which the
// production parseClaudeResult() helper deliberately drops).
//
// If no installed CLI runtime is available, this script STOPS with a clear
// message and a non-zero exit code — it never fabricates or simulates
// Phase 2 results.
//
// Usage: node scripts/eval/phase2-ai-lane.mjs [--limit N] [--out <path>]

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInstalledRuntimeInvocation,
  detectInstalledRuntimes,
} from "../../src/core/ai/installed-runtimes.mjs";
import { parseYaml } from "../../src/core/profile/yaml.mjs";
import { scoreSourcedOffer } from "../../src/core/scoring/sourced-scanner.mjs";
import { buildSearchPromptContext } from "../../src/core/search/search-prompts.mjs";
import { SINGLE_ROLE_SCHEMA } from "./lib/single-role-schema.mjs";
import { extractSection, loadSearchJobsSkill } from "./lib/skill-sections.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const CORPUS_PATH = join(REPO_ROOT, "tests/fixtures/eval/search-shape-corpus.json");
const TARGETING_PATH = join(REPO_ROOT, "examples/demo-workspace/candidate/targeting.yml");
const PROFILE_PATH = join(REPO_ROOT, "examples/demo-workspace/candidate/profile.yml");
const DEFAULT_OUT = join(__dirname, "phase2-results.json");
const RUNTIME_TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) out.out = argv[++i];
    if (argv[i] === "--limit" && argv[i + 1]) out.limit = Number(argv[++i]);
  }
  return out;
}

function loadCorpus() {
  return JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
}

function loadConfig() {
  const targeting = parseYaml(readFileSync(TARGETING_PATH, "utf8"));
  const profile = parseYaml(readFileSync(PROFILE_PATH, "utf8"));
  return { targeting, profile };
}

function buildPromptTemplate() {
  const skillMd = loadSearchJobsSkill(REPO_ROOT);
  const aiWebSearchMode = extractSection(skillMd, "AI Web Search mode");
  const step3 = extractSection(skillMd, "STEP 3 — Coarse triage on every new sourced entry");
  return { aiWebSearchMode, step3 };
}

function buildPrompt({ aiWebSearchMode, step3, candidateContext, posting }) {
  return [
    "You are the search-jobs skill's AI Web Search mode, running ONLY the coarse-triage half " +
      "of that mode offline for an evaluation harness. WebSearch/WebFetch have already been " +
      "run for you and this ONE posting was already found and fetched — do not call any tool, " +
      "none are available. Score it using the AI Web Search mode instructions and STEP 3 rules " +
      "below, verbatim, exactly as you would mid-run.",
    "## AI Web Search mode (verbatim from .agents/skills/search-jobs/SKILL.md)",
    aiWebSearchMode,
    "## STEP 3 — Coarse triage on every new sourced entry (verbatim from the same file)",
    step3,
    "## candidate context (this is the SAME object buildSearchPromptContext() would hand you in " +
      "the real kickoff input — score against this, not any targeting.yml file, per the AI Web " +
      "Search mode instructions above)",
    JSON.stringify({ candidate: candidateContext }, null, 2),
    "## The one posting to triage (already found — no search/fetch needed)",
    JSON.stringify(
      {
        company: posting.company,
        title: posting.title,
        location: posting.location === "Unspecified" ? null : posting.location,
        url: posting.url,
      },
      null,
      2
    ),
    "Reply with exactly one JSON object (matching the required output schema) and nothing else — " +
      'fit_score, fit_bucket, fit_basis ("triage"), rule_flags (only flags STEP 3 defines that you ' +
      "can actually confirm from the posting + candidate context given — omit anything you'd have " +
      "to guess), source_evidence (one line).",
  ].join("\n\n");
}

function parseClaudeEnvelope(stdout) {
  const envelope = JSON.parse(stdout);
  if (envelope?.is_error === true || envelope?.subtype === "error") {
    throw new Error(`Claude CLI reported an error: ${envelope?.result || "unknown"}`);
  }
  return envelope;
}

function runInstalledClaude({ command, args, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Installed CLI call timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        reject(new Error(`Installed CLI exited with status ${status}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(parseClaudeEnvelope(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

async function scoreOnePosting({ runtime, promptTemplate, candidateContext, posting }) {
  const prompt = buildPrompt({ ...promptTemplate, candidateContext, posting });
  const invocation = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: runtime.path,
    schema: SINGLE_ROLE_SCHEMA,
    tools: [],
  });
  const startedAt = Date.now();
  const envelope = await runInstalledClaude({
    command: invocation.command,
    args: invocation.args,
    prompt,
    timeoutMs: RUNTIME_TIMEOUT_MS,
  });
  const wallClockMs = Date.now() - startedAt;
  const structured = envelope.structured_output;
  if (!structured || typeof structured.fit_bucket !== "string") {
    throw new Error(`No structured_output in envelope: ${JSON.stringify(envelope).slice(0, 300)}`);
  }
  return {
    fitBucket: structured.fit_bucket,
    fitScore: structured.fit_score,
    fitBasis: structured.fit_basis,
    ruleFlags: structured.rule_flags || [],
    sourceEvidence: structured.source_evidence || "",
    costUsd: envelope.total_cost_usd ?? null,
    durationApiMs: envelope.duration_api_ms ?? null,
    wallClockMs,
    usage: envelope.usage || null,
    model: envelope.modelUsage ? Object.keys(envelope.modelUsage) : null,
  };
}

function deterministicFit(posting, config) {
  const offer = {
    title: posting.title || "",
    company: posting.company || "",
    location: posting.location === "Unspecified" ? "" : posting.location || "",
    comp: posting.comp || "",
    bodyText: posting.bodyText || "",
  };
  return scoreSourcedOffer(offer, config).fit;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimes = detectInstalledRuntimes();
  const claude = runtimes.find((r) => r.id === "claude" && r.available);
  if (!claude) {
    console.error(
      "STOP: no installed 'claude' CLI runtime is available on this machine " +
        "(src/core/ai/installed-runtimes.mjs detectInstalledRuntimes() found no usable 'claude' " +
        "binary). Phase 2 cannot run without a live AI route, and this harness refuses to " +
        "simulate results. Install/authenticate the Claude Code CLI and re-run."
    );
    process.exit(1);
  }

  const corpus = loadCorpus();
  const config = loadConfig();
  const candidateContext = buildSearchPromptContext({ config });
  const promptTemplate = buildPromptTemplate();

  let postings = corpus.postings;
  if (Number.isFinite(args.limit) && args.limit > 0) postings = postings.slice(0, args.limit);

  console.log(
    `Phase 2 — AI web-search lane triage vs. agent-judged labels + Phase 1 deterministic`
  );
  // Log only id/commandShape, never the resolved absolute path — if stdout is
  // ever redirected into a file under scripts/, that file would trip the same
  // release-safety scan the output object above is written to avoid.
  console.log(`Runtime: claude CLI (${claude.commandShape})`);
  console.log(
    `Candidate context handed to the model:\n${JSON.stringify(candidateContext, null, 2)}`
  );
  console.log(`Scoring ${postings.length} posting(s) sequentially...\n`);

  const rows = [];
  for (const posting of postings) {
    const detFit = deterministicFit(posting, config);
    let attempt;
    let lastError = null;
    for (let tryNum = 0; tryNum < 2 && !attempt; tryNum++) {
      try {
        attempt = await scoreOnePosting({
          runtime: claude,
          promptTemplate,
          candidateContext,
          posting,
        });
      } catch (error) {
        lastError = error;
        console.warn(`  [${posting.id}] attempt ${tryNum + 1} failed: ${error.message}`);
      }
    }
    if (!attempt) {
      rows.push({
        id: posting.id,
        provider: posting.provider,
        title: posting.title,
        company: posting.company,
        myLabel: posting.myLabel,
        deterministicFit: detFit,
        error: lastError?.message || "unknown error",
      });
      console.log(`  [${posting.id}] FAILED — ${lastError?.message}`);
      continue;
    }
    const row = {
      id: posting.id,
      provider: posting.provider,
      title: posting.title,
      company: posting.company,
      myLabel: posting.myLabel,
      deterministicFit: detFit,
      aiFitBucket: attempt.fitBucket,
      aiFitScore: attempt.fitScore,
      aiRuleFlags: attempt.ruleFlags,
      aiSourceEvidence: attempt.sourceEvidence,
      costUsd: attempt.costUsd,
      durationApiMs: attempt.durationApiMs,
      wallClockMs: attempt.wallClockMs,
      usage: attempt.usage,
      agreeWithMine: attempt.fitBucket === posting.myLabel,
      agreeWithDeterministic: attempt.fitBucket === detFit,
    };
    rows.push(row);
    console.log(
      `  [${posting.id}] "${posting.title}" — mine=${posting.myLabel} det=${detFit} ai=${attempt.fitBucket} ` +
        `(cost=$${(attempt.costUsd ?? 0).toFixed(4)}, ${attempt.wallClockMs}ms)`
    );
  }

  const scored = rows.filter((r) => !r.error);
  const failed = rows.filter((r) => r.error);
  const agreeMine = scored.filter((r) => r.agreeWithMine).length;
  const agreeDet = scored.filter((r) => r.agreeWithDeterministic).length;
  const totalCost = scored.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  const totalWallClock = scored.reduce((sum, r) => sum + (r.wallClockMs || 0), 0);

  const stats = {
    totalPostings: rows.length,
    scored: scored.length,
    failed: failed.length,
    aiVsMineAgreement: scored.length
      ? Number(((agreeMine / scored.length) * 100).toFixed(1))
      : null,
    aiVsDeterministicAgreement: scored.length
      ? Number(((agreeDet / scored.length) * 100).toFixed(1))
      : null,
    aiVsDeterministicDisagreementPct: scored.length
      ? Number((100 - (agreeDet / scored.length) * 100).toFixed(1))
      : null,
    totalCostUsd: Number(totalCost.toFixed(4)),
    avgCostUsdPerPosting: scored.length ? Number((totalCost / scored.length).toFixed(4)) : null,
    totalWallClockMs: totalWallClock,
    avgWallClockMsPerPosting: scored.length ? Math.round(totalWallClock / scored.length) : null,
  };

  const output = {
    generatedAt: new Date().toISOString(),
    // Never write the resolved absolute binary path into a committable
    // artifact — see tests/release-safety.test.mjs's "operational scripts do
    // not hardcode an absolute personal-home path" check, which scans every
    // file under scripts/ (including generated output) for /Users/<name> or
    // /home/<name>. id + commandShape are enough to identify the runtime.
    runtime: {
      id: claude.id,
      commandShape: claude.commandShape,
      mode: "installed CLI, --safe-mode, no tools",
    },
    candidateContext,
    corpusPath: "tests/fixtures/eval/search-shape-corpus.json",
    stats,
    rows,
  };

  writeFileSync(args.out, JSON.stringify(output, null, 2) + "\n");

  console.log(`\n--- Summary ---`);
  console.log(`Scored: ${stats.scored}/${stats.totalPostings} (failed: ${stats.failed})`);
  console.log(`AI vs my labels: ${agreeMine}/${scored.length} (${stats.aiVsMineAgreement}%)`);
  console.log(
    `AI vs deterministic (Phase 1): ${agreeDet}/${scored.length} (${stats.aiVsDeterministicAgreement}% agree, ${stats.aiVsDeterministicDisagreementPct}% disagree)`
  );
  console.log(`Total cost: $${stats.totalCostUsd} (avg $${stats.avgCostUsdPerPosting}/posting)`);
  console.log(
    `Total wall-clock: ${stats.totalWallClockMs}ms (avg ${stats.avgWallClockMsPerPosting}ms/posting)`
  );
  console.log(`\nWrote ${args.out}`);
}

main();
