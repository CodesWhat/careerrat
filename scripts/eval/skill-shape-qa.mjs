#!/usr/bin/env node

// scripts/eval/skill-shape-qa.mjs — machine-checks that every AI-shaped skill
// reply "comes back the right shape" without a human dogfooder.
//
// Four lanes, one AI-shaped output each:
//   1. evaluate-job's packet-gate verdict → packetGateAiVerdictSchema
//   2. coach-gaps' coaching plan          → coachingPlanSchema
//   3. search-jobs' coarse triage         → SINGLE_ROLE_SCHEMA (shared with phase2)
//   4. company-health's rating            → validateCompanyHealth() (throws w/ .code)
//
// Every lane replays that skill's own verbatim SKILL.md rules (extractSection,
// scripts/eval/lib/skill-sections.mjs — same mechanism scripts/eval/
// phase2-ai-lane.mjs already proved out), spawns the real installed AI CLI
// (detectInstalledRuntimes() + buildInstalledRuntimeInvocation(),
// src/core/ai/installed-runtimes.mjs, via the shared spawn/parse helper in
// scripts/eval/lib/installed-cli-call.mjs), and validates the reply's
// structured_output against that lane's schema — lanes 1-3 through
// src/core/profile/schema-validator.mjs's validate()/formatErrors() (THE
// validator; no second one is introduced here), lane 4 by calling
// validateCompanyHealth() directly and reporting its thrown `.code`.
//
// COST: this makes exactly one real AI call per lane (four total for a full
// run) against whatever installed CLI detectInstalledRuntimes() finds. Never
// fabricates or simulates a reply — with no installed runtime, this script
// stops with a clear message and a non-zero exit. Run manually or by
// dispatch; this is never wired into per-PR CI (see tests/skill-shape-qa.
// test.mjs for the deterministic, AI-free lane that DOES run in CI).
//
// Usage:
//   node scripts/eval/skill-shape-qa.mjs --list        # enumerate lanes, no AI calls
//   node scripts/eval/skill-shape-qa.mjs --lane <name>  # run one lane
//   node scripts/eval/skill-shape-qa.mjs --runtime codex # run one supported runtime
//   node scripts/eval/skill-shape-qa.mjs                # run every lane and runtime (default)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectInstalledRuntimes,
  probeInstalledRuntime,
} from "../../src/core/ai/installed-runtimes.mjs";
import { coachingPlanSchema } from "../../src/core/coaching/schemas.mjs";
import { validateCompanyHealth } from "../../src/core/db/verbs/company-health.mjs";
import { packetPromptFromContext } from "../../src/core/packet/context.mjs";
import { packetGateAiVerdictSchema } from "../../src/core/packet/schemas/packet-schemas.mjs";
import { formatErrors, validate } from "../../src/core/profile/schema-validator.mjs";
import { parseYaml } from "../../src/core/profile/yaml.mjs";
import { buildSearchPromptContext } from "../../src/core/search/search-prompts.mjs";
import { callInstalledRuntimeForJson } from "./lib/installed-cli-call.mjs";
import { SINGLE_ROLE_SCHEMA } from "./lib/single-role-schema.mjs";
import { extractSection, loadSkillMd } from "./lib/skill-sections.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const DEMO_DIR = join(REPO_ROOT, "examples/demo-workspace");
const RUNTIME_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// demo-workspace inputs
// ---------------------------------------------------------------------------

function loadDemoYaml(relPath) {
  return parseYaml(readFileSync(join(DEMO_DIR, relPath), "utf8"));
}

function loadDemoText(relPath) {
  return readFileSync(join(DEMO_DIR, relPath), "utf8");
}

function loadCandidateContext() {
  return {
    profile: loadDemoYaml("candidate/profile.yml"),
    targeting: loadDemoYaml("candidate/targeting.yml"),
    evidence: loadDemoYaml("candidate/evidence.yml"),
    honesty: loadDemoYaml("candidate/honesty.yml"),
  };
}

// AGENTS.md's Privacy Invariant: current_base never reaches an AI call. The
// demo profile ships it blank, but a shape-QA harness that sends candidate
// context to a real model should honor the same rail every production prompt
// builder does (context.mjs's own unexported withoutCurrentComp).
function withoutCurrentBase(profile) {
  if (!profile?.compensation) return profile;
  const { current_base, ...compensation } = profile.compensation;
  return { ...profile, compensation };
}

// ---------------------------------------------------------------------------
// company-health's reply shape — no schemas.mjs exists for this skill (unlike
// packet-gate/coach-gaps): validateCompanyHealth() enforces the contract by
// hand-written business rules, not a JSON Schema. This object is used ONLY as
// the --json-schema hint handed to the installed CLI so its reply is well-
// formed JSON in the documented shape (SKILL.md STEP 5) — it is never run
// through schema-validator.mjs itself; validateCompanyHealth() is the one and
// only pass/fail check for this lane, per the spec.
const dimensionReplySchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["level", "note"],
  properties: {
    level: { type: "string" },
    note: { type: "string" },
    functionHit: { type: ["boolean", "null"] },
    trend: { type: ["string", "null"] },
  },
});

const companyHealthSignalReplySchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["source", "date", "summary", "url"],
  properties: {
    source: { type: "string" },
    date: { type: "string" },
    summary: { type: "string" },
    url: { type: "string" },
  },
});

const companyHealthReplySchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["rating", "forFunction", "asOf", "provenance", "dimensions", "rationale"],
  properties: {
    rating: { type: "string", enum: ["healthy", "watch", "risky"] },
    forFunction: { type: "string" },
    asOf: { type: "string" },
    provenance: { type: "string", enum: ["built-from-data", "needs-more-info", "stale"] },
    crossCut: { type: "array", items: { type: "string" } },
    fitDelta: { type: "number" },
    dimensions: {
      type: "object",
      additionalProperties: false,
      properties: {
        layoffRisk: dimensionReplySchema,
        hiringMomentum: dimensionReplySchema,
        financial: dimensionReplySchema,
        sentiment: dimensionReplySchema,
        leadership: dimensionReplySchema,
      },
    },
    rationale: { type: "string" },
    signals: { type: "array", items: companyHealthSignalReplySchema },
  },
});

// ---------------------------------------------------------------------------
// Lane 1 — evaluate-job's packet-gate AI verdict (packetGateAiVerdictSchema)
//
// The production AI call for THIS json contract (evaluatePacketGate,
// src/core/packet/gate.mjs) never feeds SKILL.md prose to the model — its
// instructions live entirely in packetPromptFromContext()'s own trailing
// paragraph plus the schema, reused here UNMODIFIED (the real prompt, not a
// hand-copied rebuild) rather than duplicated. evaluate-job/SKILL.md's own
// STEP 6/STEP 8 prose (which targets the terminal agent's separate GATE/FIT/
// COMP/ACTION text format, not this JSON shape) is still replayed verbatim
// alongside it, for the same judgment grounding a body-read agent gets.
// ---------------------------------------------------------------------------

function buildEvaluateJobPrompt({ skillMd, candidate }) {
  const fitRating = extractSection(skillMd, "STEP 6 — FIT RATING");
  const action = extractSection(skillMd, "STEP 8 — ACTION");
  const jobBody = loadDemoText("workspace/jobs/demo/e-corp-staff-software-engineer.md");
  const context = {
    app: { company: "E Corp", role: "Staff Software Engineer" },
    job: { body: jobBody },
    profile: withoutCurrentBase(candidate.profile),
    targeting: candidate.targeting,
    evidence: { claims: candidate.evidence?.claims || [] },
    honesty: candidate.honesty,
  };
  return [
    "You are the evaluate-job skill's packet-gate AI verdict call. Ground your fit judgment " +
      "in the skill's own written rules below, replayed verbatim from " +
      ".agents/skills/evaluate-job/SKILL.md, then return the typed JSON verdict the prompt " +
      "after them asks for.",
    "## STEP 6 — FIT RATING (verbatim from evaluate-job/SKILL.md)",
    fitRating,
    "## STEP 8 — ACTION (verbatim from the same file)",
    action,
    packetPromptFromContext(context),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Lane 2 — coach-gaps' coaching plan (coachingPlanSchema)
// ---------------------------------------------------------------------------

// A real, evidence-grounded gap for the Tyrell Corporation JD below: its
// "Nice to Have" section names SOC 2 / HIPAA-compliant deployment practices
// in a biotech/pharma domain, and nothing in examples/demo-workspace's
// candidate/evidence.yml claims that. Picked over a fabricated one so a
// no-close-path suggestion is a legitimate, expected possible reply, not a
// harness artifact.
const COACH_GAPS_FIT_RISKS = [
  "No demonstrated experience with HIPAA-compliant or regulated biotech/pharma deployments",
];

function buildCoachGapsPrompt({ skillMd, candidate }) {
  const buildStep = extractSection(skillMd, "STEP 1 — Build the plan");
  const persistStep = extractSection(skillMd, "STEP 2 — Persist the plan");
  const jobBody = loadDemoText("workspace/jobs/demo/tyrell-senior-platform-engineer.md");
  const candidateContext = {
    evidence: { claims: candidate.evidence?.claims || [] },
    honesty: candidate.honesty || {},
  };
  const numbered = COACH_GAPS_FIT_RISKS.map((risk, i) => `${i + 1}. ${risk}`).join("\n");
  return [
    "You are the coach-gaps skill's plan-building AI call, replaying its own written rules " +
      "below, verbatim from .agents/skills/coach-gaps/SKILL.md, before returning the typed " +
      "coaching plan the given schema requires.",
    "## STEP 1 — Build the plan (verbatim from coach-gaps/SKILL.md)",
    buildStep,
    "## STEP 2 — Persist the plan (verbatim from the same file — the object shape you are producing)",
    persistStep,
    "Company: Tyrell Corporation",
    "Role: Senior Platform Engineer",
    "",
    "Job Description:",
    jobBody,
    "",
    "Fit gaps a prior evaluate-job verdict named (address every one, in this exact order):",
    numbered,
    "",
    "Candidate context (private, local — confirmed evidence claims and honesty boundaries only):",
    JSON.stringify(candidateContext, null, 2),
    "",
    "Return one typed coaching plan matching the given schema — one gap entry per numbered " +
      "gap above, in the same order, with gapText echoing the numbered gap verbatim.",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Lane 3 — search-jobs' coarse triage (SINGLE_ROLE_SCHEMA), same offline
// framing scripts/eval/phase2-ai-lane.mjs already proved out: WebSearch/
// WebFetch are skipped, one already-found posting is handed to the model
// directly, and only the STEP 3 scoring half runs.
// ---------------------------------------------------------------------------

const SEARCH_JOBS_POSTING = Object.freeze({
  company: "Black Mesa",
  title: "Applied AI Engineer",
  location: "Unspecified",
  url: "https://blackmesasource.com/network/applied-ai-engineer",
});

function buildSearchJobsPrompt({ skillMd, candidate }) {
  const aiWebSearchMode = extractSection(skillMd, "AI Web Search mode");
  const step3 = extractSection(skillMd, "STEP 3 — Coarse triage on every new sourced entry");
  const candidateContext = buildSearchPromptContext({ config: candidate });
  return [
    "You are the search-jobs skill's AI Web Search mode, running ONLY the coarse-triage half " +
      "of that mode offline for a shape-QA harness. WebSearch/WebFetch have already been run " +
      "for you and this ONE posting was already found and fetched — do not call any tool, " +
      "none are available. Score it using the AI Web Search mode instructions and STEP 3 " +
      "rules below, verbatim, exactly as you would mid-run.",
    "## AI Web Search mode (verbatim from .agents/skills/search-jobs/SKILL.md)",
    aiWebSearchMode,
    "## STEP 3 — Coarse triage on every new sourced entry (verbatim from the same file)",
    step3,
    "## candidate context (the same object buildSearchPromptContext() hands you mid-run)",
    JSON.stringify({ candidate: candidateContext }, null, 2),
    "## The one posting to triage (already found — no search/fetch needed)",
    JSON.stringify(SEARCH_JOBS_POSTING, null, 2),
    "Reply with exactly one JSON object (matching the required output schema) and nothing " +
      'else — fit_score, fit_bucket, fit_basis ("triage"), rule_flags (only flags STEP 3 ' +
      "defines that you can actually confirm from the posting + candidate context given — " +
      "omit anything you'd have to guess), source_evidence (one line).",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Lane 4 — company-health's rating (validateCompanyHealth())
// ---------------------------------------------------------------------------

// examples/demo-workspace/candidate/targeting.yml declares no `priorities`/
// `must_haves` — per SKILL.md STEP 0, that means no candidate_needs, so the
// rating must come back standalone (fitDelta 0, crossCut []). Cyberdyne
// Systems/demo-app-5 is at the "onsite" stage, the real interview-band
// trigger STEP 1's cost gate describes.
const COMPANY_HEALTH_COMPANY = "Cyberdyne Systems";
const COMPANY_HEALTH_FUNCTION = "Staff ML Engineering";

function buildCompanyHealthPrompt({ skillMd }) {
  const scoreStep = extractSection(
    skillMd,
    "STEP 4 — Score (standalone rating + selective cross-cut)"
  );
  const persistStep = extractSection(
    skillMd,
    "STEP 5 — Persist to the tracker (Tracker Write Contract)"
  );
  return [
    "You are the company-health skill's role-scoped rating call, replaying its own written " +
      "scoring and persistence rules below, verbatim from .agents/skills/company-health/" +
      "SKILL.md. Web research has already been done for you in this offline shape-QA harness " +
      "— do not call any tool, none are available. Compose your best-effort rating from " +
      "general knowledge instead, exactly as if STEP 3's research had already surfaced it, " +
      "and reply with ONLY the companyHealth object STEP 5 documents (not the outer " +
      "`careerrat:discovery` envelope) matching the given schema.",
    "## STEP 4 — Score (verbatim from company-health/SKILL.md)",
    scoreStep,
    "## STEP 5 — Persist to the tracker (verbatim from the same file — the object shape you are producing)",
    persistStep,
    `Company: ${COMPANY_HEALTH_COMPANY}`,
    `Target function: ${COMPANY_HEALTH_FUNCTION}`,
    "Candidate needs (targeting.priorities/must_haves — empty here means standalone: " +
      "fitDelta must be 0, crossCut must be []): []",
    `As of: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n\n");
}

function checkCompanyHealth(structured) {
  try {
    validateCompanyHealth(structured);
    return { valid: true, errors: [] };
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: "", message: `${error.code || "ERROR"}: ${error.message}` }],
    };
  }
}

// ---------------------------------------------------------------------------
// Lane table
// ---------------------------------------------------------------------------

export const LANES = Object.freeze([
  {
    name: "evaluate-job",
    description: "evaluate-job / packet-gate AI verdict → packetGateAiVerdictSchema",
    schema: packetGateAiVerdictSchema,
    buildPrompt: buildEvaluateJobPrompt,
    check: (structured) => validate(structured, packetGateAiVerdictSchema),
  },
  {
    name: "coach-gaps",
    description: "coach-gaps coaching plan → coachingPlanSchema",
    schema: coachingPlanSchema,
    buildPrompt: buildCoachGapsPrompt,
    check: (structured) => validate(structured, coachingPlanSchema),
  },
  {
    name: "search-jobs",
    description: "search-jobs coarse triage → SINGLE_ROLE_SCHEMA (shared with phase2-ai-lane)",
    schema: SINGLE_ROLE_SCHEMA,
    buildPrompt: buildSearchJobsPrompt,
    check: (structured) => validate(structured, SINGLE_ROLE_SCHEMA),
  },
  {
    name: "company-health",
    description: "company-health rating → validateCompanyHealth()",
    schema: companyHealthReplySchema,
    buildPrompt: buildCompanyHealthPrompt,
    check: (structured) => checkCompanyHealth(structured),
  },
]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SUPPORTED_RUNTIME_IDS = new Set(["claude", "codex"]);

export function parseSkillShapeQaArgs(argv) {
  const out = { list: false, lane: null, runtime: "all" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--list") out.list = true;
    if (argv[i] === "--lane" && argv[i + 1]) out.lane = argv[++i];
    if (argv[i] === "--runtime" && argv[i + 1]) out.runtime = argv[++i];
  }
  if (out.runtime !== "all" && !SUPPORTED_RUNTIME_IDS.has(out.runtime)) {
    throw new Error("--runtime must be claude, codex, or all.");
  }
  return out;
}

export function selectSkillShapeRuntimes(runtimes, requested = "all") {
  const supported = (Array.isArray(runtimes) ? runtimes : []).filter(
    (runtime) => SUPPORTED_RUNTIME_IDS.has(runtime?.id) && runtime.available
  );
  return requested === "all" ? supported : supported.filter((runtime) => runtime.id === requested);
}

export async function probeSkillShapeRuntimes(runtimes, { probe = probeInstalledRuntime } = {}) {
  const verified = [];
  for (const runtime of runtimes) {
    const result = await probe(runtime);
    if (!result?.ready) continue;
    verified.push({ ...runtime, capabilities: result.capabilities });
  }
  return verified;
}

async function runLane(lane, { runtime, candidate }) {
  const skillMd = loadSkillMd(REPO_ROOT, lane.name);
  const prompt = lane.buildPrompt({ skillMd, candidate });
  let result;
  try {
    result = await callInstalledRuntimeForJson({
      runtime,
      prompt,
      schema: lane.schema,
      timeoutMs: RUNTIME_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      lane: lane.name,
      runtime: runtime.id,
      pass: false,
      message: `AI call failed: ${error.message}`,
    };
  }
  const outcome = lane.check(result.structured);
  return {
    lane: lane.name,
    runtime: runtime.id,
    pass: outcome.valid,
    message: outcome.valid ? null : formatErrors(outcome.errors),
    costUsd: result.costUsd,
  };
}

async function main() {
  let args;
  try {
    args = parseSkillShapeQaArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (args.list) {
    console.log("skill-shape-qa lanes (one real AI call each — none made by --list):\n");
    for (const lane of LANES) console.log(`  ${lane.name} — ${lane.description}`);
    return;
  }

  const lanesToRun = args.lane ? LANES.filter((lane) => lane.name === args.lane) : LANES;
  if (args.lane && lanesToRun.length === 0) {
    console.error(
      `Unknown lane "${args.lane}". Run with --list to see available lanes: ` +
        LANES.map((lane) => lane.name).join(", ")
    );
    process.exit(1);
  }

  const detectedRuntimes = selectSkillShapeRuntimes(detectInstalledRuntimes(), args.runtime);
  const runtimes = await probeSkillShapeRuntimes(detectedRuntimes);
  if (runtimes.length === 0) {
    console.error(
      `STOP: no installed ${args.runtime === "all" ? "Claude Code or OpenAI Codex" : args.runtime} runtime is available. ` +
        "skill-shape-qa requires a live supported AI route and refuses to simulate results."
    );
    process.exit(1);
  }

  const candidate = loadCandidateContext();

  console.log(
    `skill-shape-qa — ${lanesToRun.length} lane(s) across ${runtimes.length} runtime(s).`
  );

  const results = [];
  for (const runtime of runtimes) {
    console.log(`\n${runtime.id} — ${runtime.commandShape}`);
    for (const lane of lanesToRun) {
      process.stdout.write(`[${lane.name}] `);
      const result = await runLane(lane, { runtime, candidate });
      results.push(result);
      console.log(
        `${result.pass ? "PASS" : "FAIL"}${result.costUsd != null ? ` (cost=$${result.costUsd.toFixed(4)})` : ""}`
      );
      if (!result.pass) {
        console.log(
          result.message
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n")
        );
      }
    }
  }

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} lane(s) passed.`);
  if (failed.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
