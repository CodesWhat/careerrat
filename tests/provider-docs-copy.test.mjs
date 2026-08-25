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

test("v0.16 docs distinguish passed acceptance from unfinished publication", async () => {
  const [changelog, roadmap, readme, install] = await Promise.all([
    readFile("CHANGELOG.md", "utf8"),
    readFile("docs/ROADMAP.md", "utf8"),
    readFile("README.md", "utf8"),
    readFile("apps/docs/content/docs/getting-started/install.mdx", "utf8"),
  ]);

  assert.match(changelog, /signed macOS package passed release-candidate acceptance/i);
  assert.match(changelog, /release is not published or deployed yet/i);
  assert.match(changelog, /PR review, publication, production deployment[^.]*remain pending/i);
  assert.doesNotMatch(changelog, /packaged desktop QA[^.]*still[^.]*pass/i);

  assert.match(roadmap, /Superseding v0\.16 release ledger/i);
  assert.match(roadmap, /duplicate onboarding prompt repair/i);
  assert.match(roadmap, /completed homes/i);
  assert.match(roadmap, /internal résumé-upload/i);
  assert.match(roadmap, /TERM-ignoring child/i);
  assert.match(roadmap, /ACP adapters remain diagnostic-only/i);
  assert.match(roadmap, /branch passed release-candidate QA/i);
  assert.match(roadmap, /release publication is still pending/i);
  assert.match(roadmap, /protected feature-to-dev and\s+dev-to-main PRs/i);
  assert.match(roadmap, /not released or deployed/i);
  assert.doesNotMatch(roadmap, /fresh packaged rebuild and install/i);

  for (const publicCopy of [readme, install]) {
    assert.match(
      publicCopy,
      /v0\.16 provider-parity update passed packaged desktop QA and signing/i
    );
    assert.match(publicCopy, /latest public (?:release|download) remains v0\.15\.0 until/i);
    assert.doesNotMatch(publicCopy, /until packaged desktop QA, signing/i);
  }
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
