import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PROVIDER_DOCS = [
  "apps/docs/content/docs/index.mdx",
  "apps/docs/content/docs/getting-started/install.mdx",
  "apps/docs/content/docs/getting-started/what-is-careerrat.mdx",
  "apps/docs/content/docs/advanced/agent-contract.mdx",
  "apps/docs/content/docs/advanced/architecture.mdx",
  "apps/docs/content/docs/advanced/privacy.mdx",
  "apps/docs/content/docs/reference/cli.mdx",
  "apps/docs/content/docs/reference/disclaimer.mdx",
  "docs/DISCLAIMER.md",
  "docs/SETUP.md",
];

test("public setup docs expose the neutral direct Claude Code and Codex contract", async () => {
  const combined = (await Promise.all(PROVIDER_DOCS.map((path) => readFile(path, "utf8")))).join(
    "\n"
  );

  assert.match(combined, /CareerRat owns (?:the|its) workflows and threads/i);
  assert.match(combined, /Claude Code/i);
  assert.match(combined, /OpenAI Codex/i);
  assert.match(combined, /two supported product choices/i);
  assert.match(combined, /invokes? the selected installed CLI directly/i);
  assert.match(combined, /never (?:falls back to|silently switches)/i);
  assert.match(
    combined,
    /availability, authentication, and (?:a |the |its )?(?:readiness )?(?:check|probe)/i
  );

  assert.doesNotMatch(combined, /Hermes Agent|Gemini CLI|OpenCode|GitHub Copilot/i);
  assert.doesNotMatch(
    combined,
    /Codex .{0,80}(?:chat and drafting|chat \+ drafting)|task tools tier/i
  );
  assert.doesNotMatch(combined, /requires Claude(?:'s)? verified boundary/i);
  assert.doesNotMatch(combined, /Other detected CLIs stay visible but unverified/i);
  assert.doesNotMatch(combined, /Other detected CLIs remain visible but unverified/i);
  assert.doesNotMatch(combined, /equal engines for the complete CareerRat workflow/i);
  assert.doesNotMatch(
    combined,
    /(?:Claude Code|OpenAI Codex|Hermes Agent)[\s\S]{0,120}first-class|ACP verified/i
  );
});

test("v0.16.6 docs describe candidate behavior without rewriting v0.16.5 history", async () => {
  const [changelog, readme, install] = await Promise.all([
    readFile("CHANGELOG.md", "utf8"),
    readFile("README.md", "utf8"),
    readFile("apps/docs/content/docs/getting-started/install.mdx", "utf8"),
  ]);

  assert.match(changelog, /^## \[0\.16\.2\] - 2026-08-25/m);
  assert.match(changelog, /plain-English Claude setup path/i);
  assert.match(changelog, /Scott's disclosed Claude referral/i);
  assert.match(changelog, /Anthropic's official native installer/i);
  assert.match(changelog, /checks automatically until Claude Code is ready/i);
  assert.match(changelog, /hosted-access email field and send action/i);
  assert.match(changelog, /runtime-marketing sentence/i);
  assert.match(changelog, /calmer vertical spacing/i);
  assert.match(changelog, /completed v0\.16\.0 release state/i);
  assert.match(changelog, /protected PRs #217 and #218 merged/i);
  assert.match(
    changelog,
    /signed v0\.16\.0 tag points to (?:the exact promotion merge on )?`main`/i
  );
  assert.match(changelog, /signed, notarized, and stapled macOS release is public/i);
  assert.match(changelog, /careerrat@latest` is 0\.16\.0/i);
  assert.match(changelog, /careerrat\.com is running the production release/i);
  assert.match(changelog, /Homebrew cask was updated to 0\.16\.0/i);
  assert.match(changelog, /passes Gatekeeper[^.]*launch and visual inspection/i);
  assert.match(
    changelog,
    /Windows x64 installer passes build, install, launch, export, and uninstall QA/i
  );
  assert.match(changelog, /SignPath Foundation signing requires project reputation/i);
  assert.doesNotMatch(changelog, /packaged desktop QA[^.]*still[^.]*pass/i);
  assert.doesNotMatch(changelog, /release is not published or deployed yet/i);
  assert.doesNotMatch(
    changelog,
    /PR review, publication, production deployment[^.]*remain pending/i
  );
  assert.match(changelog, /^## \[0\.16\.6\] - 2026-08-28/m);
  assert.match(changelog, /Promotion requires one clean source revision/i);
  assert.match(
    changelog,
    /exact Claude Code\/Codex hospitality and engineering native-search matrix/i
  );
  assert.match(changelog, /tagged release workflow must then build and verify/i);
  assert.doesNotMatch(changelog, /repository suite passes 4,222 tests/i);
  assert.doesNotMatch(changelog, /web suite passes all 905 tests/i);
  assert.match(changelog, /finite job, recruiter-thread, and company ambiguities/i);
  assert.match(changelog, /First, manual, and AI searches now share one durable worker owner/i);

  for (const publicCopy of [readme, install]) {
    assert.doesNotMatch(publicCopy, /v0\.16\.6 is the current release/i);
    assert.match(publicCopy, /Claude Code and Codex (?:run|the same complete)/i);
    assert.match(publicCopy, /no fallback|never falls back/i);
    assert.match(publicCopy, /(?:durable across|survive)\s+navigation and\s+restart/i);
    assert.match(
      publicCopy,
      /(?:keeps?\s+AI\s+leads|AI\s+leads\s+(?:clearly )?(?:stay|remain))\s+(?:clearly )?unverified/i
    );
    assert.match(publicCopy, /Evaluate reads the posting|full\s+postings/i);
    assert.match(publicCopy, /final Submit control always stay/i);
    assert.match(publicCopy, /Restart and install/i);
    assert.match(publicCopy, /Scott's (?:disclosed )?referral/i);
    assert.match(publicCopy, /Install inside CareerRat/i);
    assert.match(
      publicCopy,
      /Windows x64 installer pass(?:ed|es) build, install, launch, export, and uninstall\s+QA/i
    );
    assert.match(publicCopy, /SignPath Foundation signing[\s\S]{0,80}requires project reputation/i);
    assert.doesNotMatch(publicCopy, /unreleased release candidate/i);
    assert.doesNotMatch(publicCopy, /v0\.16\.5 is the current public release/i);
  }

  assert.match(changelog, /signed `v0\.16\.5` tag points to the exact `main` promotion merge/i);
  assert.match(changelog, /native signed 0\.16\.4-to-0\.16\.5 update/i);
  assert.match(
    changelog,
    /careerrat@latest`, the Homebrew cask, and careerrat\.com are live at 0\.16\.5/i
  );
});

test("published agent setup names the accepted Claude Code and Codex set", async () => {
  const agentContract = await readFile("apps/website/public/AGENTS.md", "utf8");

  assert.match(agentContract, /supported coding-agent CLI/i);
  assert.match(agentContract, /Claude Code or Codex/i);
  assert.match(agentContract, /no CareerRat account\s+or hosted candidate database/i);
  assert.match(agentContract, /selected CLI uses its provider/i);
  assert.match(agentContract, /documented provider and privacy boundary/i);
  for (const skill of [
    "answer-question",
    "coach-gaps",
    "intake-extract",
    "resume-extract",
    "report-issue",
  ]) {
    assert.match(agentContract, new RegExp(`\\b${skill}\\b`));
  }
  assert.doesNotMatch(agentContract, /Hermes Agent|Gemini CLI|OpenCode|GitHub Copilot/i);
  assert.doesNotMatch(agentContract, /No cloud|zero runtime dependencies/i);
  assert.doesNotMatch(agentContract, /data \*\*stays on their machine\*\*/i);
});
