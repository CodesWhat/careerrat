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

test("v0.16.2 docs record guided setup and preserve v0.16.0 release evidence", async () => {
  const [changelog, roadmap, readme, install] = await Promise.all([
    readFile("CHANGELOG.md", "utf8"),
    readFile("docs/ROADMAP.md", "utf8"),
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

  assert.match(roadmap, /Superseding v0\.16 release ledger/i);
  assert.match(roadmap, /v0\.16\.1 hotfix checkpoint/i);
  assert.match(roadmap, /v0\.16\.2 guided setup checkpoint/i);
  assert.match(roadmap, /never used an agentic CLI/i);
  assert.match(roadmap, /packaged-app-only, macOS-only, and Claude-only/i);
  assert.match(roadmap, /I already use another AI tool/i);
  assert.match(roadmap, /hosted-access email and send controls/i);
  assert.match(roadmap, /website runtime-marketing sentence/i);
  assert.match(roadmap, /calmer section spacing/i);
  assert.match(roadmap, /duplicate onboarding prompt repair/i);
  assert.match(roadmap, /completed homes/i);
  assert.match(roadmap, /internal résumé-upload/i);
  assert.match(roadmap, /TERM-ignoring child/i);
  assert.match(roadmap, /ACP adapters remain diagnostic-only/i);
  assert.match(roadmap, /v0\.16\.0 is released and deployed/i);
  assert.match(roadmap, /Packaging and release \| Released and verified/i);
  assert.match(roadmap, /protected PRs #217 and #218 merged/i);
  assert.match(roadmap, /signed v0\.16\.0 tag points to the exact promotion merge on `main`/i);
  assert.match(roadmap, /Homebrew cask is 0\.16\.0/i);
  assert.match(roadmap, /Windows build, install, launch, export, and uninstall QA are green/i);
  assert.match(roadmap, /SignPath requires project reputation/i);
  assert.doesNotMatch(roadmap, /fresh packaged rebuild and install/i);
  assert.doesNotMatch(roadmap, /release publication is still pending/i);
  assert.doesNotMatch(roadmap, /not released or deployed/i);
  assert.doesNotMatch(roadmap, /Publication pending/i);

  for (const publicCopy of [readme, install]) {
    assert.match(publicCopy, /v0\.16\.2 is the current public release/i);
    assert.match(publicCopy, /v0\.16\.0 provider-parity\s+release/i);
    assert.match(publicCopy, /protected PRs #217 and #218 merged/i);
    assert.match(
      publicCopy,
      /signed\s+v0\.16\.0 tag points to the exact promotion merge on `main`/i
    );
    assert.match(publicCopy, /signed, notarized, and stapled Mac DMG/i);
    assert.match(publicCopy, /careerrat@latest` is 0\.16\.2/i);
    assert.match(publicCopy, /Homebrew cask is 0\.16\.2/i);
    assert.match(publicCopy, /reports version 0\.16\.2/i);
    assert.match(publicCopy, /Scott's (?:disclosed )?referral/i);
    assert.match(publicCopy, /Install inside CareerRat/i);
    assert.match(publicCopy, /passes Gatekeeper[^.]*launch and visual inspection/i);
    assert.match(
      publicCopy,
      /Windows x64 installer pass(?:ed|es) build, install, launch, export, and uninstall\s+QA/i
    );
    assert.match(publicCopy, /SignPath Foundation signing[\s\S]{0,80}requires project reputation/i);
    assert.doesNotMatch(publicCopy, /latest public (?:release|download) remains v0\.15\.0 until/i);
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
