import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("real Chromium application preparation and rendered UI geometry are an explicit required CI context", async () => {
  const [workflow, protection, liveApply, liveVisual] = await Promise.all([
    source(".github/workflows/ci-verify.yml"),
    source("scripts/protect-main.sh"),
    source("tests/playwright-live.test.mjs"),
    source("tests/playwright-app-visual.test.mjs"),
  ]);
  const job = workflow.slice(
    workflow.indexOf("  browser-application-prep:"),
    workflow.indexOf("  qlty:")
  );

  assert.match(job, /name:\s*browser-application-prep/);
  assert.match(job, /CAREERRAT_LIVE_BROWSER:\s*["']?1/);
  assert.match(job, /playwright install --with-deps chromium/);
  assert.match(job, /npm run build --workspace apps\/web/);
  assert.match(job, /tests\/playwright-live\.test\.mjs/);
  assert.match(job, /tests\/playwright-live-dropdowns\.test\.mjs/);
  assert.match(job, /tests\/playwright-app-visual\.test\.mjs/);
  assert.match(job, /output\/playwright/);
  assert.doesNotMatch(job, /ANTHROPIC|OPENAI|CLAUDE|CODEX/);
  assert.match(protection, /"context": "browser-application-prep"/);
  assert.match(liveApply, /assert\.notEqual\(result\.state, "applied"\)/);
  assert.match(liveApply, /clicked\.includes\("Submit application"\), false/);
  assert.match(liveVisual, /getComputedStyle/);
  assert.match(liveVisual, /boundingBox/);
  assert.match(liveVisual, /page\.screenshot/);
});

test("all deterministic product builds are declared as protected contexts", async () => {
  const [workflow, protection] = await Promise.all([
    source(".github/workflows/ci-verify.yml"),
    source("scripts/protect-main.sh"),
  ]);
  for (const context of [
    "web-build",
    "website-build",
    "windows-package-smoke",
    "browser-application-prep",
  ]) {
    assert.match(workflow, new RegExp(`name:\\s*${context}`));
    assert.match(protection, new RegExp(`"context": "${context}"`));
  }
  assert.doesNotMatch(workflow, /web-build, website-build, and windows-package-smoke[^\n]*don't/i);
  assert.doesNotMatch(workflow, /Non-gating for now/i);
});

test("every npm ci job activates the pinned npm, installs with scripts disabled, checks allowScripts, then reinstalls strictly", async () => {
  // Codex review /tmp/codex-305-r3.md (finding 1): the workflow ran plain
  // `npm ci` before the checker, so a newly-added dependency with no
  // allowScripts entry got to run its install script before anything
  // validated it.
  //
  // Codex review /tmp/codex-305-r4.md (findings 2 and 3): setup-node's
  // bundled npm is not the pinned npm@12.0.2, so `--strict-allow-scripts`
  // could be silently ignored and an older Pacote's Git fetcher could run a
  // nested install during the ignored-script phase; and `npm rebuild` skips
  // the root lifecycle phases (prepublish/preprepare/prepare/postprepare)
  // and a regular Git dependency's own prepare hook, so it isn't a faithful
  // replay of what `npm ci` would have run.
  //
  // Every job that installs from the lockfile must therefore: (1) activate
  // the pinned npm via Corepack and assert its version, (2)
  // `npm ci --ignore-scripts` so nothing runs yet, (3) run this repo's
  // checker, (4) `npm ci --strict-allow-scripts`, a second full install on
  // the now-pinned npm that replays every lifecycle phase a normal
  // `npm ci` runs and fails closed on anything npm's own matcher still
  // finds unreviewed. This must hold for every job, including the ones that
  // only build an app (web-build, website-build) and the Windows smoke job,
  // not just the `tests` job.
  const workflow = await source(".github/workflows/ci-verify.yml");
  const jobNames = [
    "tests",
    "web-build",
    "website-build",
    "windows-package-smoke",
    "browser-application-prep",
    "knip",
  ];
  const jobStarts = jobNames.map((name) => ({
    name,
    index: workflow.indexOf(`\n  ${name}:\n`),
  }));
  for (const { name, index } of jobStarts) {
    assert.notEqual(index, -1, `expected a top-level "${name}:" job in ci-verify.yml`);
  }
  const sortedStarts = [...jobStarts].sort((a, b) => a.index - b.index).map((j) => j.index);

  for (const { name, index } of jobStarts) {
    const nextIndex = sortedStarts.find((i) => i > index) ?? workflow.length;
    const job = workflow.slice(index, nextIndex);
    // Codex review /tmp/codex-305-r5.md (finding 1): Corepack excludes npm
    // unless the shim is explicitly named, so a bare `corepack enable`
    // leaves Node 24's bundled npm active and the version assertion below
    // fails before any install runs. Require the explicit `npm` argument
    // and reject the ineffective bare form.
    assert.match(
      job,
      /corepack enable npm\b/,
      `${name}: expected \`corepack enable npm\`, not a bare Corepack activation`
    );
    assert.doesNotMatch(
      job,
      /corepack enable(?!\s+npm\b)/,
      `${name}: \`corepack enable\` without the explicit \`npm\` argument does not activate the pinned npm`
    );
    assert.match(
      job,
      /require\(['"]\.\/package\.json['"]\)\.packageManager/,
      `${name}: expected the activation step to read the pinned version from package.json`
    );
    assert.match(
      job,
      /actual_npm="npm@\$\(npm --version\)"/,
      `${name}: expected the activation step to assert the activated npm version`
    );
    assert.match(
      job,
      /Corepack activated \$actual_npm instead of \$EXPECTED_NPM/,
      `${name}: expected the activation step to fail the job on a version mismatch`
    );
    assert.match(
      job,
      /run:\s*npm ci --ignore-scripts/,
      `${name}: expected \`npm ci --ignore-scripts\`, not a plain \`npm ci\` that can run an unreviewed script`
    );
    assert.match(
      job,
      /run:\s*npm run check:install-scripts/,
      `${name}: expected a check:install-scripts step`
    );
    // Codex review /tmp/codex-305-r5.md (finding 4): `--strict-allow-scripts`
    // alone does not neutralize `dangerously-allow-all-scripts` or
    // `ignore-scripts`; either override, set by a future project config or
    // an inherited environment, defeats the gate without changing this
    // command. Require both explicit negations on the post-check install.
    assert.match(
      job,
      /run:\s*npm ci --strict-allow-scripts --no-dangerously-allow-all-scripts --no-ignore-scripts/,
      `${name}: expected \`npm ci --strict-allow-scripts --no-dangerously-allow-all-scripts --no-ignore-scripts\` to fully reinstall on the pinned npm, fail closed on the rest, and refuse an inherited override`
    );
    assert.doesNotMatch(
      job,
      /run:\s*npm rebuild --strict-allow-scripts/,
      `${name}: \`npm rebuild\` does not replay root or Git-dependency lifecycle hooks; must use \`npm ci --strict-allow-scripts\` instead`
    );
    const corepackAt = job.indexOf("corepack enable npm");
    const ciAt = job.indexOf("npm ci --ignore-scripts");
    const checkAt = job.indexOf("npm run check:install-scripts");
    const strictCiAt = job.indexOf(
      "npm ci --strict-allow-scripts --no-dangerously-allow-all-scripts --no-ignore-scripts"
    );
    assert.ok(
      corepackAt < ciAt && ciAt < checkAt && checkAt < strictCiAt,
      `${name}: expected corepack activation, then ignored-script install, then check, then strict install, in that order`
    );
  }
});

test("the Windows activation step declares shell: bash so its multiline set -euo pipefail body runs under Bash, not PowerShell", async () => {
  // Codex review /tmp/codex-305-r5.md (finding 2): windows-latest defaults
  // to PowerShell, where `set -euo pipefail` is a syntax error, so the
  // Corepack activation step (and every step relying on it) never ran.
  // Any multiline step whose body starts with `set -euo pipefail` inside a
  // job running on a Windows runner must declare `shell: bash`.
  const workflow = await source(".github/workflows/ci-verify.yml");
  const jobBlockPattern = /\n {2}([a-z][\w-]*):\n((?:(?!\n {2}[a-z][\w-]*:\n)[\s\S])*)/g;
  const jobBlocks = [...workflow.matchAll(jobBlockPattern)];
  const windowsJobs = jobBlocks.filter(([, , jobBody]) =>
    /runs-on:\s*windows-latest/.test(jobBody)
  );
  assert.ok(windowsJobs.length > 0, "expected at least one windows-latest job in ci-verify.yml");

  const stepPattern = /- name:[^\n]*\n((?:(?!\n\s*- name:)[\s\S])*)/g;
  for (const [, jobName, jobBody] of windowsJobs) {
    const pipefailSteps = [...jobBody.matchAll(stepPattern)]
      .map(([, step]) => step)
      .filter((step) => /run:\s*\|\s*\n\s*set -euo pipefail/.test(step));
    for (const step of pipefailSteps) {
      assert.match(
        step,
        /shell:\s*bash/,
        `${jobName}: a multiline \`set -euo pipefail\` step on windows-latest must declare \`shell: bash\` or it runs under PowerShell and fails`
      );
    }
  }
});

test("paid native AI certification is separate from deterministic release gates", async () => {
  const [rootPackage, rootVerify, desktopVerify, desktopWorkflow] = await Promise.all([
    source("package.json"),
    source("scripts/verify-live-search-receipts.mjs"),
    source("apps/desktop/scripts/verify-release.mjs"),
    source(".github/workflows/desktop-release.yml"),
  ]);
  const pkg = JSON.parse(rootPackage);
  const macReleaseJob = desktopWorkflow.slice(
    desktopWorkflow.indexOf("  build-notarize-upload:"),
    desktopWorkflow.indexOf("  build-windows-upload:")
  );
  assert.equal(
    pkg.scripts?.["release:pretag"],
    "node --test tests/release-consistency.test.mjs tests/release-gating-ci.test.mjs tests/release-workflow-chain.test.mjs"
  );
  assert.equal(
    pkg.scripts?.["qa:native-search:evidence"],
    "node scripts/verify-live-search-receipts.mjs"
  );
  assert.doesNotMatch(rootVerify, /releaseVersion|EXCEPTION/);
  assert.match(rootVerify, /PASS native AI search certification evidence/);
  assert.doesNotMatch(desktopVerify, /live-search|Live-search|verifyLiveSearchReceiptDirectory/);
  assert.doesNotMatch(desktopWorkflow, /Verify current native AI search receipts/);
  assert.match(desktopWorkflow, /Verify deterministic release metadata/);
  assert.match(desktopWorkflow, /npm run release:pretag/);
  assert.doesNotMatch(
    desktopWorkflow,
    /LIVE_SEARCH_(?:SKIP|BYPASS|EXCEPTION)|skip-live-search|bypass-live-search/i
  );
  assert.doesNotMatch(macReleaseJob, /ANTHROPIC|OPENAI|CLAUDE|CODEX/);
  assert.match(macReleaseJob, /fetch-depth:\s*0/);
});
