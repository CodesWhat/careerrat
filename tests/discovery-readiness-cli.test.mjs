import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize, sourceConfigPut } from "../src/core/db/verbs.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

function tempHome() {
  return mkdtempSync(join(tmpdir(), "careerrat-readiness-"));
}

function runCli(script, args, home) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, CAREERRAT_HOME: home },
    encoding: "utf8",
  });
}

function runCareerRat(args, home, extraEnv = {}) {
  return spawnSync(process.execPath, ["bin/careerrat.mjs", ...args], {
    cwd: ROOT,
    // CAREERRAT_NO_UPDATE_CHECK: bin/careerrat.mjs otherwise fires a detached
    // background npm-registry check on every invocation. That child writes into
    // CAREERRAT_HOME on its own schedule, well after this spawnSync returns, and
    // races the test's own `rmSync(home, { recursive: true, force: true })`
    // cleanup — an ENOTEMPTY on a tempdir that has nothing to do with the
    // assertion under test. See src/core/update/update-core.mjs.
    env: {
      ...process.env,
      CAREERRAT_HOME: home,
      CAREERRAT_NO_UPDATE_CHECK: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function seedCandidateFiles(home) {
  mkdirSync(join(home, "candidate"), { recursive: true });
  writeFileSync(join(home, "candidate", "profile.yml"), "{}\n", "utf8");
  writeFileSync(join(home, "candidate", "targeting.yml"), "role_buckets: []\n", "utf8");
  writeFileSync(join(home, "candidate", "evidence.yml"), "claims: []\n", "utf8");
  writeFileSync(join(home, "candidate", "honesty.yml"), "{}\n", "utf8");
  writeFileSync(join(home, "candidate", "form-defaults.yml"), "{}\n", "utf8");
}

test("companies --list explains that empty tracked companies means ATS scans are not wired", () => {
  const home = tempHome();
  try {
    const result = runCli("src/cli/companies.mjs", ["--list"], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /No tracked companies yet\./);
    assert.match(result.stdout, /Ask your agent to run discover-companies next/);
    assert.match(result.stdout, /77 public Career Ops adapters/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor surfaces missing company ATS discovery separately from broad search sources", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "search-sources.yml"),
      `searches:
  - provider: HiringCafe
    label: Director of IT
    query: Director of IT
    enabled: true
`,
      "utf8"
    );

    const result = runCli("src/cli/doctor.mjs", [], home);

    assert.match(result.stdout, /Search readiness:/);
    assert.match(result.stdout, /Broad sources: 1 enabled search/);
    assert.match(result.stdout, /Company ATS scans: not configured/);
    assert.match(result.stdout, /discover-companies/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor prints the ordered post-onboarding discovery pipeline", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "search-sources.yml"),
      `searches:
  - provider: HiringCafe
    label: Director of IT
    query: Director of IT
    enabled: true
`,
      "utf8"
    );

    const result = runCli("src/cli/doctor.mjs", [], home);

    assert.match(result.stdout, /Discovery pipeline:/);
    assert.match(
      result.stdout,
      /setup-searches -> research-boards -> discover-companies -> search-jobs/
    );
    assert.match(result.stdout, /Next discovery step: research-boards/);
    assert.match(result.stdout, /then discover-companies before the first sweep/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor gives an agent-led next action for incomplete discovery", () => {
  const home = tempHome();
  try {
    seedCandidateFiles(home);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "search-sources.yml"),
      `searches:
  - provider: HiringCafe
    label: Director of IT
    query: Director of IT
    enabled: true
`,
      "utf8"
    );

    const result = runCli("src/cli/doctor.mjs", [], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Agent guidance:/);
    assert.match(result.stdout, /CareerRat is agent-led/);
    assert.match(result.stdout, /Ask your agent to run research-boards next/);
    assert.match(result.stdout, /then discover-companies before search-jobs/);
    // GitHub Actions runs from tracked files only, so the ignored Claude shim is
    // absent there. It remains actionable diagnostics without replacing the
    // runtime-neutral next-skill handoff or making doctor fail.
    if (!existsSync(join(ROOT, ".claude/skills"))) {
      assert.match(result.stdout, /Claude Code skill shim missing/);
      assert.match(result.stdout, /careerrat install-skills/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("searches --list calls out configured searches that have never run", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "search-sources.yml"),
      `searches:
  - provider: HiringCafe
    label: Director of IT
    query: Director of IT
    enabled: true
`,
      "utf8"
    );

    const result = runCli("src/cli/searches.mjs", ["--list"], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /1 enabled search configured/);
    assert.match(result.stdout, /0\/1 have run watermarks/);
    assert.match(result.stdout, /Ask your agent to run search-jobs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a saved login-backed source stays actionable without a setup or permission gate", () => {
  const home = tempHome();
  try {
    seedCandidateFiles(home);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "search-sources.yml"),
      `searches:
  - provider: LinkedIn
    platform: linkedin
    source_type: browser
    auth: true
    label: LinkedIn operations
    url: https://www.linkedin.com/jobs/search/?keywords=operations
    enabled: false
`,
      "utf8"
    );

    const list = runCli("src/cli/searches.mjs", ["--list"], home);
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /Ask your agent to run search-jobs/i);
    assert.match(list.stdout, /ask whether you want to log in/i);
    assert.doesNotMatch(list.stdout, /run setup-searches or enable sources/i);

    const doctor = runCli("src/cli/doctor.mjs", ["--json"], home);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const data = JSON.parse(doctor.stdout);
    assert.equal(data.discovery.broadSources.pendingLogin, 1);
    assert.equal(data.agentGuidance.nextSkill, "search-jobs");
    assert.doesNotMatch(data.agentGuidance.reason, /nothing useful to sweep/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor --json exposes the next agent skill after onboarding search setup", () => {
  const home = tempHome();
  try {
    seedCandidateFiles(home);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "search-sources.yml"),
      `searches:
  - provider: HiringCafe
    label: Director of IT
    query: Director of IT
    enabled: true
`,
      "utf8"
    );

    const result = runCli("src/cli/doctor.mjs", ["--json"], home);
    const data = JSON.parse(result.stdout);

    assert.equal(data.agentGuidance.nextSkill, "research-boards");
    assert.match(data.agentGuidance.message, /Ask your agent to run research-boards next/);
    assert.match(data.agentGuidance.reason, /board discovery and company discovery/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("careerrat next prints the next agent skill without the full doctor report", () => {
  const home = tempHome();
  try {
    seedCandidateFiles(home);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "search-sources.yml"),
      `searches:
  - provider: HiringCafe
    label: Director of IT
    query: Director of IT
    enabled: true
`,
      "utf8"
    );

    const result = runCareerRat(["next"], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Next: ask your agent to run research-boards/);
    assert.match(result.stdout, /then discover-companies before search-jobs/);
    assert.doesNotMatch(result.stdout, /Search readiness:/);
    assert.doesNotMatch(result.stdout, /Discovery pipeline:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("careerrat next can record skipped discovery steps and advance the handoff", () => {
  const home = tempHome();
  try {
    seedCandidateFiles(home);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "search-sources.yml"),
      `searches:
  - provider: HiringCafe
    label: Director of IT
    query: Director of IT
    enabled: true
`,
      "utf8"
    );

    const skipBoards = runCareerRat(["next", "--skip", "research-boards", "--write"], home);
    assert.equal(skipBoards.status, 0);
    assert.match(skipBoards.stdout, /Skipped research-boards/);
    assert.match(skipBoards.stdout, /Next: ask your agent to run discover-companies/);

    const setupState = JSON.parse(readFileSync(join(home, "workspace/setup-state.json"), "utf8"));
    assert.deepEqual(setupState.skippedDiscoverySteps, ["research-boards"]);

    const next = runCareerRat(["next"], home);
    assert.equal(next.status, 0);
    assert.match(next.stdout, /Next: ask your agent to run discover-companies/);
    assert.doesNotMatch(next.stdout, /research-boards next/);

    const skipCompanies = runCareerRat(["next", "--skip", "discover-companies", "--write"], home);
    assert.equal(skipCompanies.status, 0);
    assert.match(skipCompanies.stdout, /Skipped discover-companies/);
    assert.match(skipCompanies.stdout, /Next: ask your agent to run search-jobs/);
    assert.match(skipCompanies.stdout, /Discovery skip recorded/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("empty DB candidate setup routes doctor and next back to ingest-profile", () => {
  const home = tempHome();
  try {
    const init = runCareerRat(["data", "candidate", "init"], home);
    assert.equal(init.status, 0);

    const doctor = runCli("src/cli/doctor.mjs", ["--json"], home);
    const data = JSON.parse(doctor.stdout);
    assert.equal(doctor.status, 1);
    assert.equal(data.agentGuidance.nextSkill, "ingest-profile");
    assert.match(data.agentGuidance.reason, /source resume/i);

    const next = runCareerRat(["next"], home);
    assert.equal(next.status, 0);
    assert.match(next.stdout, /Next: ask your agent to run ingest-profile/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reads company ATS readiness from DB source config when legacy config is absent", () => {
  const home = tempHome();
  try {
    const init = runCareerRat(["data", "candidate", "init"], home);
    assert.equal(init.status, 0);

    const add = runCareerRat(
      ["companies", "--add", "Acme", "--url", "https://jobs.lever.co/acme", "--write", "--json"],
      home
    );
    assert.equal(add.status, 0);
    assert.equal(JSON.parse(add.stdout).total, 1);
    assert.equal(existsSync(join(home, "config/sourced-scan.json")), false);

    const doctor = runCli("src/cli/doctor.mjs", ["--json"], home);
    const data = JSON.parse(doctor.stdout);

    assert.equal(data.discovery.companyAts.configured, true);
    assert.equal(data.discovery.companyAts.total, 1);
    assert.deepEqual(data.discovery.companyAts.providers, ["lever"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reads broad search readiness from DB source config when legacy config is absent", () => {
  const home = tempHome();
  const env = { ...process.env, CAREERRAT_HOME: home };
  try {
    candidateSetupInitialize({ repoRoot: ROOT, env });
    sourceConfigPut({
      repoRoot: ROOT,
      env,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "HiringCafe",
            label: "Director of IT",
            query: "Director of IT",
            enabled: true,
            recency: { lastRunAt: "2026-07-03T12:00:00.000Z" },
          },
        ],
      },
    });

    assert.equal(existsSync(join(home, "config/search-sources.yml")), false);

    const doctor = runCli("src/cli/doctor.mjs", ["--json"], home);
    const data = JSON.parse(doctor.stdout);

    assert.equal(data.discovery.broadSources.exists, true);
    assert.equal(data.discovery.broadSources.valid, true);
    assert.equal(data.discovery.broadSources.total, 1);
    assert.equal(data.discovery.broadSources.enabled, 1);
    assert.equal(data.discovery.broadSources.withLastRun, 1);
    assert.deepEqual(data.discovery.broadSources.providers, ["HiringCafe"]);
  } finally {
    closeAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test("searches --from-targeting refuses to persist an empty DB targeting baseline", () => {
  const home = tempHome();
  try {
    const init = runCareerRat(["data", "candidate", "init"], home);
    assert.equal(init.status, 0);

    const result = runCli("src/cli/searches.mjs", ["--from-targeting", "--json"], home);
    assert.equal(result.status, 1);
    assert.match(result.stderr || result.stdout, /role titles/i);
    assert.equal(existsSync(join(home, "config/search-sources.yml")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skill handoffs keep post-onboarding discovery in the required order", () => {
  const files = [
    "AGENTS.md",
    ".agents/skills/ingest-profile/SKILL.md",
    ".agents/skills/setup-searches/SKILL.md",
    ".agents/skills/research-boards/SKILL.md",
  ];

  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.match(
      text,
      /setup-searches -> research-boards -> discover-companies -> search-jobs/,
      file
    );
  }
});

test("discovery skills end with explicit next-skill handoffs", () => {
  const expected = [
    ["setup-searches", /Final handoff[\s\S]*research-boards/i],
    ["research-boards", /Final handoff[\s\S]*discover-companies/i],
    ["discover-companies", /Final handoff[\s\S]*search-jobs/i],
    [
      "search-jobs",
      /Final handoff[\s\S]*(evaluate-job|apply-job|research-boards|discover-companies)/i,
    ],
  ];

  for (const [skill, pattern] of expected) {
    const text = readFileSync(join(ROOT, ".agents/skills", skill, "SKILL.md"), "utf8");
    assert.match(text, pattern, skill);
  }
});

test("router tells agents to follow doctor Agent guidance instead of raw list commands", () => {
  const text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

  assert.match(text, /Agent guidance/);
  assert.match(text, /canonical next handoff/);
  assert.match(text, /do not treat `careerrat searches` or `careerrat companies` as the workflow/);
});

test("router makes proactive next-skill recommendations beyond cold start", () => {
  const text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

  assert.match(text, /Always steer toward the next useful skill/);
  assert.match(text, /If sourcing is empty or stale[\s\S]*search-jobs/);
  assert.match(text, /If an interview is scheduled[\s\S]*interview-prep/);
  assert.match(text, /If a recruiter thread needs a reply[\s\S]*email-comms/);
  assert.match(text, /If a status changed[\s\S]*track-outcomes/);
});

test("user-facing docs use default list commands instead of npm -- --list noise", () => {
  const files = [
    "src/cli/searches.mjs",
    "src/cli/companies.mjs",
    "src/cli/doctor.mjs",
    ".agents/skills/search-jobs/SKILL.md",
    ".agents/skills/setup-searches/SKILL.md",
    ".agents/skills/research-boards/SKILL.md",
    ".agents/skills/discover-companies/SKILL.md",
    "docs/foundations-spec.md",
  ];

  const offenders = files.filter((file) =>
    /npm run (?:searches|companies) -- --list/.test(readFileSync(join(ROOT, file), "utf8"))
  );

  assert.deepEqual(offenders, []);
});

test("careerrat exposes discovery helper commands directly", () => {
  const home = tempHome();
  try {
    const companies = runCareerRat(["companies", "--json"], home);
    assert.equal(companies.status, 0);
    assert.equal(JSON.parse(companies.stdout).total, 0);

    const searchesHelp = runCareerRat(["searches", "--help"], home);
    assert.equal(searchesHelp.status, 0);
    assert.match(searchesHelp.stdout, /Usage:\s+careerrat searches/);

    const companiesHelp = runCareerRat(["companies", "--help"], home);
    assert.equal(companiesHelp.status, 0);
    assert.match(companiesHelp.stdout, /Usage:\s+careerrat companies/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("product-facing search and company guidance leads with careerrat commands", () => {
  const files = [
    "bin/careerrat.mjs",
    "src/core/agent-guidance.mjs",
    "src/cli/searches.mjs",
    "src/cli/companies.mjs",
    "src/cli/doctor.mjs",
    ".agents/skills/search-jobs/SKILL.md",
    ".agents/skills/setup-searches/SKILL.md",
    ".agents/skills/research-boards/SKILL.md",
    ".agents/skills/discover-companies/SKILL.md",
    "docs/foundations-spec.md",
  ];

  const offenders = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/npm run (?:searches|companies)(?:\s|`|$)/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line}: ${match[0].trim()}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("public setup docs teach the careerrat binary instead of source-file invocations", () => {
  const files = ["README.md", "docs/SETUP.md"];
  const offenders = [];

  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/node bin\/careerrat\.mjs/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("careerrat start prompt anchors the agent to doctor and the discovery order", () => {
  const text = readFileSync(join(ROOT, "bin/careerrat.mjs"), "utf8");

  assert.match(text, /run careerrat doctor/);
  assert.match(text, /next unfinished CareerRat skill/);
  assert.match(text, /setup-searches -> research-boards -> discover-companies -> search-jobs/);
});

test("careerrat start --no-agent prints the manual agent handoff", () => {
  const home = tempHome();
  try {
    const result = runCareerRat(["start", "--no-agent", "--no-dashboard"], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Open your agent in this folder and say:/);
    assert.match(result.stdout, /run careerrat doctor/);
    assert.match(result.stdout, /next unfinished CareerRat skill/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("careerrat start refuses an unaccepted detected agent command", () => {
  const home = tempHome();
  const binDir = join(home, "bin");
  try {
    mkdirSync(binDir, { recursive: true });
    const hermes = join(binDir, "hermes");
    writeFileSync(hermes, "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    const result = runCareerRat(["start", "hermes", "--no-dashboard"], home, {
      PATH: binDir,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Couldn't find "hermes"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI output lines that mention flags use ASCII hyphen separators", () => {
  const home = tempHome();
  try {
    const commands = [
      ["src/cli/doctor.mjs", []],
      ["src/cli/analytics.mjs", ["--help"]],
      ["src/cli/activity.mjs", ["--help"]],
      ["src/cli/status-map.mjs", ["--help"]],
      ["src/cli/next.mjs", ["--help"]],
    ];
    const offenders = [];

    for (const [script, args] of commands) {
      const result = runCli(script, args, home);
      for (const [index, line] of `${result.stdout}\n${result.stderr}`.split("\n").entries()) {
        if (line.includes("--") && line.includes("—")) {
          offenders.push(`${script}:${index + 1}: ${line}`);
        }
      }
    }

    assert.deepEqual(offenders, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
