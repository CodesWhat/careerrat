import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

const LEGACY_BRAND = ["role", "ster"].join("");
const STALE_PUBLIC_CLI_PATTERN = new RegExp(
  `node bin\\/careerrat\\.mjs|npm run (?:doctor|next|ingest|searches|companies|modes|automation|research|gate|learnings|stories|activity|analytics|evidence|strategy-review|status:map|export|install-skills|evaluate|tracker|tracker:dev)(?:\\s|\u0060|$)|(?:${LEGACY_BRAND}|careerrat) [a-z:-]+ -- --|tracker:dev`
);

async function listFiles(dir, suffix) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path, suffix)));
    else if (entry.isFile() && path.endsWith(suffix)) out.push(path);
  }
  return out;
}

test("website hero leads with the CareerRat pitch", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");
  const styles = await readFile("apps/website/src/app/globals.css", "utf8");

  assert.match(page, /Your job hunt, run by a rat\./);
  assert.match(page, /Mac app that turns the AI CLI you already have into a personal recruiter/);
  assert.doesNotMatch(page, /npm install -g careerrat|careerrat start|careerrat update/);
  assert.doesNotMatch(page, new RegExp(LEGACY_BRAND, "i"));
  assert.doesNotMatch(
    styles,
    /\.hero-visual\s*\{[^}]*order:\s*-1/s,
    "mobile visitors should see the product value proposition before the preview"
  );
});

test("website leads with the signed Mac app and keeps installation focused on the download", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");

  // Hero: the Mac app is the primary framing and the primary CTA. Free and
  // local are supporting facts, not the headline.
  assert.match(page, /Mac app that turns the AI CLI you already have into a personal recruiter/);
  assert.match(page, /Download for Mac/);
  assert.match(page, /https:\/\/github\.com\/CodesWhat\/careerrat\/releases\/latest/);
  assert.match(page, /Signed and notarized, for Apple Silicon Macs on macOS 12 or newer\./);
  assert.match(page, /CareerRat itself costs nothing/);
  assert.doesNotMatch(page, /Runs on your own AI CLI/);
  assert.doesNotMatch(page, /Get started, free &amp; open source/);
  assert.doesNotMatch(page, /bring your AI CLI/);
  assert.doesNotMatch(page, /Agent runtime/);
  assert.doesNotMatch(page, /Self-host it/);

  assert.doesNotMatch(page, /Anywhere with npm|brew install|npm install|Node\.js 24/);
});

test("website presents Claude Code and Codex as neutral direct runtime choices", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");

  assert.doesNotMatch(
    page,
    /CareerRat owns the workflows and threads\. Claude Code and OpenAI Codex are its two supported product choices\./
  );
  for (const runtime of ["Claude Code", "OpenAI Codex"]) {
    assert.match(page, new RegExp(runtime));
  }
  assert.match(page, /runs the same CareerRat-owned workflows and skills/i);
  assert.match(page, /invokes it directly/i);
  assert.match(page, /available, signed in, and passes its readiness check/i);
  assert.match(page, /never falls back to another provider/i);
  assert.doesNotMatch(
    page,
    /Gemini CLI|GitHub Copilot|Hermes Agent|OpenCode|Claude Code · full tasks|Codex · chat \+ drafting|first-class|ACP verified|verified per capability|equal, complete/i
  );
});

test("public copy explains provider-neutral AI controls without ranking providers", async () => {
  const paths = {
    readme: "README.md",
    website: "apps/website/src/app/page.tsx",
    docsIndex: "apps/docs/content/docs/index.mdx",
    configuration: "apps/docs/content/docs/advanced/configuration.mdx",
  };
  const copy = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")])
    )
  );

  for (const name of Object.keys(paths)) {
    assert.match(copy[name], /Automatic/i, `${paths[name]} should explain Automatic routing`);
    assert.match(copy[name], /Faster/i, `${paths[name]} should name the Faster choice`);
    assert.match(copy[name], /Balanced/i, `${paths[name]} should name the Balanced choice`);
    assert.match(copy[name], /Best/i, `${paths[name]} should name the Best choice`);
    assert.match(copy[name], /thinking depth/i, `${paths[name]} should explain thinking depth`);
    assert.match(
      copy[name],
      /Claude Code[\s\S]{0,500}OpenAI\s+Codex|OpenAI\s+Codex[\s\S]{0,500}Claude Code/i,
      `${paths[name]} should keep both runtime choices in the same product contract`
    );
    assert.doesNotMatch(
      copy[name],
      /Claude(?: Code)?[^\n.]{0,100}(?:better|best|stronger|preferred|recommended)[^\n.]{0,100}Codex|Codex[^\n.]{0,100}(?:better|best|stronger|preferred|recommended)[^\n.]{0,100}Claude/i
    );
  }
});

test("public copy keeps AI discovery broad and evaluation honest", async () => {
  const paths = {
    readme: "README.md",
    website: "apps/website/src/app/page.tsx",
    docsIndex: "apps/docs/content/docs/index.mdx",
    firstJob: "apps/docs/content/docs/getting-started/first-job.mdx",
    sources: "docs/SOURCES.md",
  };
  const copy = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")])
    )
  );

  for (const name of Object.keys(paths)) {
    assert.match(copy[name], /open[- ]web/i, `${paths[name]} should name open-web discovery`);
    assert.match(copy[name], /unverified/i, `${paths[name]} should label discovery honestly`);
    assert.match(copy[name], /Evaluate/i, `${paths[name]} should hand verification to Evaluate`);
    assert.match(copy[name], /hospitality/i, `${paths[name]} should name hospitality coverage`);
    assert.match(copy[name], /engineering/i, `${paths[name]} should name engineering coverage`);
  }
});

test("public docs explain durable background work without claiming interrupted work completed", async () => {
  const paths = {
    readme: "README.md",
    website: "apps/website/src/app/page.tsx",
    dashboard: "apps/docs/content/docs/getting-started/dashboard.mdx",
    runtime: "docs/CHAT_FIRST_RUNTIME.md",
  };
  const copy = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")])
    )
  );

  for (const name of Object.keys(paths)) {
    assert.match(
      copy[name],
      /navigate|move between|leave (?:the )?(?:view|page|thread)/i,
      `${paths[name]} should explain navigation continuity`
    );
    assert.match(copy[name], /background/i, `${paths[name]} should name background work`);
    assert.match(copy[name], /retry/i, `${paths[name]} should explain interrupted-work recovery`);
  }
});

test("website explains the first-run handoff and supervised apply boundary plainly", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");

  assert.match(page, /questions in plain English/i);
  assert.match(page, /what would make one job worth applying to before another/i);
  assert.match(page, /Search opens when setup is ready/i);
  assert.match(page, /fills safe application fields/i);
  assert.match(page, /Voluntary questions stay blank by default/i);
  assert.match(page, /local Application defaults can choose a decline option when available/i);
  assert.match(page, /CAPTCHAs and Submit stay with you/i);
});

test("public copy keeps local Application defaults and plain-English onboarding aligned", async () => {
  const paths = {
    readme: "README.md",
    docsIndex: "apps/docs/content/docs/index.mdx",
    applying: "apps/docs/content/docs/guides/applying.mdx",
    agentContract: "apps/docs/content/docs/advanced/agent-contract.mdx",
    browserAutomation: "apps/docs/content/docs/advanced/browser-automation.mdx",
    architecture: "docs/ARCHITECTURE.md",
    changelog: "CHANGELOG.md",
    roadmap: "docs/ROADMAP.md",
    acceptance: ".planning/QA-ACCEPTANCE.md",
  };
  const copy = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")])
    )
  );

  for (const name of ["readme", "docsIndex", "changelog", "roadmap"]) {
    assert.match(
      copy[name],
      /what would make one job worth applying to before another/i,
      `${paths[name]} should carry the concrete priority question`
    );
  }

  for (const name of ["readme", "applying", "agentContract", "browserAutomation"]) {
    assert.match(
      copy[name],
      /Profile\s*>\s*Application defaults/i,
      `${paths[name]} should name the UI`
    );
    assert.match(copy[name], /local/i, `${paths[name]} should make the setting local-only`);
    assert.match(
      copy[name],
      /(?:leave|keep)\s+(?:them\s+|these\s+)?blank|stay\s+blank\s+by\s+default/i,
      `${paths[name]} should name the default`
    );
    assert.match(
      copy[name],
      /decline\s+option[\s\S]{0,80}when\s+(?:one\s+is\s+)?available|decline\s+when\s+available/i,
      `${paths[name]} should name the only opt-in policy`
    );
    assert.match(copy[name], /never infer/i, `${paths[name]} should keep the inference boundary`);
  }

  assert.match(
    copy.agentContract,
    /may use ordinary Next or Continue controls[\s\S]{0,160}never activates a control that submits the application\s+or\s+confirms a submission/i
  );

  assert.match(copy.architecture, /excluded from AI drafting/i);
  assert.match(copy.architecture, /explicit saved local policy or exact answer/i);
  for (const name of ["roadmap", "acceptance"]) {
    assert.match(
      copy[name],
      /(?:PASS:[^\n]*Application defaults|Application defaults[\s\S]{0,500}(?:implemented|now offers)|implemented[\s\S]{0,500}Application defaults)/i
    );
    assert.match(
      copy[name],
      /Application defaults[\s\S]{0,1200}(?:follow-up )?live (?:Greenhouse )?run[\s\S]{0,220}filled 22 fields[\s\S]{0,180}zero\s+unresolved fields/i
    );
    assert.doesNotMatch(
      copy[name],
      /Application defaults[\s\S]{0,500}(?:needs implementation plus fresh live acceptance|live (?:application )?retest[\s\S]{0,120}(?:is |remains )?pending)/i
    );
  }
});

test("website sections keep a calm vertical rhythm", async () => {
  const styles = await readFile("apps/website/src/app/globals.css", "utf8");

  assert.match(styles, /\.section\s*\{[^}]*padding-top:\s*120px/s);
  assert.match(
    styles,
    /@media \(max-width:\s*760px\)[\s\S]*?\.section\s*\{[^}]*padding-top:\s*88px/s
  );
});

test("public surfaces keep the provider-neutral installed-runtime contract aligned", async () => {
  const paths = {
    readme: "README.md",
    website: "apps/website/src/app/page.tsx",
    runtime: "docs/CHAT_FIRST_RUNTIME.md",
    windows: "docs/WINDOWS.md",
    architecture: "docs/ARCHITECTURE.md",
    roadmap: "docs/ROADMAP.md",
  };
  const copy = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")])
    )
  );
  const combined = Object.values(copy).join("\n");

  for (const name of ["readme", "runtime", "windows", "architecture"]) {
    assert.match(
      copy[name],
      /CareerRat[\s\S]{0,180}(?:owns|keeps)[\s\S]{0,120}(?:workflows?|threads?)[\s\S]{0,120}provider-neutral/i,
      `${paths[name]} should make CareerRat-owned state provider-neutral`
    );
    assert.match(copy[name], /Claude Code/, `${paths[name]} should name Claude Code`);
    assert.match(copy[name], /OpenAI Codex/, `${paths[name]} should name OpenAI Codex`);
    assert.match(
      copy[name],
      /(?:availability|installed)[\s\S]{0,100}(?:authentication|signed in)[\s\S]{0,140}(?:complete )?(?:readiness )?(?:check|probe)/i,
      `${paths[name]} should gate selection on complete local readiness`
    );
    assert.doesNotMatch(copy[name], /Gemini CLI|OpenCode|GitHub Copilot|Hermes Agent/);
  }

  assert.match(copy.roadmap, /Claude Code and Codex are the only supported runtime choices/);
  assert.match(copy.roadmap, /packaged app invokes the selected\s+installed CLI directly/i);

  assert.doesNotMatch(
    combined,
    /Codex (?:remains unavailable|task-tool and research work fails closed)|only (?:Claude|Claude Code)|needs Claude|Claude Code · full tasks|Codex · chat \+ drafting|(?:Claude Code|OpenAI Codex)[\s\S]{0,120}first-class|ACP verified|equal, complete CareerRat engines/i
  );
});

test("website provides a keyboard skip link and preserves approved button variants", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");
  const styles = await readFile("apps/website/src/app/globals.css", "utf8");

  assert.match(page, /className="skip-link" href="#main-content"/);
  assert.match(page, /<main id="main-content">/);
  assert.match(styles, /\.skip-link:focus-visible\s*\{[^}]*transform:\s*translate\(-50%,\s*0\)/s);
  assert.match(styles, /\.site-nav__cta\s*\{[^}]*font-weight:\s*700/s);
  assert.match(
    styles,
    /\.button--white\.button--large,\s*\.button--outline\.button--large\s*\{[^}]*font-weight:\s*700/s
  );
  assert.match(
    styles,
    /\.button--lime\.button--large,\s*\.button--ink\.button--large\s*\{[^}]*padding-inline:\s*24px/s
  );
});

test("website uses the approved text mark, natural chat colors, and house footer", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");
  const styles = await readFile("apps/website/src/app/globals.css", "utf8");
  const iconBuild = await readFile("apps/website/scripts/generate-brand-icons.mjs", "utf8");
  // The footer is the shared CodesWhat house pattern (brand-peer band, product
  // left / CodesWhat pill right) and lives in its own component, not inline
  // in page.tsx.
  const footer = await readFile("apps/website/src/components/Footer.tsx", "utf8");

  assert.match(page, /className="brand-mark"[\s\S]*Career[\s\S]*Rat\./);
  assert.doesNotMatch(page, /🐀|chat-activity(?:-pending)?\.(?:png|gif)/);
  assert.match(styles, /\.brand-mark\s*\{[^}]*background:\s*var\(--sky\)/s);
  assert.match(
    styles,
    /\.chat-demo__user\s*\{[^}]*color:\s*var\(--ink\)[^}]*background:\s*var\(--tint-cool-2\)/s
  );
  assert.doesNotMatch(styles, /\.chat-demo__user\s*\{[^}]*background:\s*var\(--ink\)/s);
  assert.match(page, /<Footer \/>/);
  assert.match(footer, /className="codeswhat-badge"/);
  assert.match(footer, /CODE_SIGNING_POLICY\.md/);
  assert.match(footer, /label:\s*"Code signing policy"/);
  assert.match(styles, /\.codeswhat-badge\s*\{[^}]*background:\s*var\(--cream\)/s);
  assert.doesNotMatch(
    styles,
    /\.js\s+\.reveal\s*\{[^}]*opacity:\s*0/s,
    "marketing content must not depend on scroll animation JavaScript to become visible"
  );
  assert.match(iconBuild, />CR<\/text>/);
  assert.match(iconBuild, /<circle[^>]+fill="\$\{INK\}"/);
  assert.match(iconBuild, /MONOGRAM FAVICON/);
  assert.match(iconBuild, /fontSize = Math\.round\(size \* 0\.64\)/);
  assert.match(iconBuild, /textLength="\$\{Math\.round\(size \* 0\.8\)\}"/);
  assert.match(iconBuild, /lengthAdjust="spacingAndGlyphs"/);
  assert.match(iconBuild, /sharp\(faviconSvg\(512\)\).*icon\.png/s);
  assert.match(iconBuild, /sharp\(faviconSvg\(180\)\).*apple-icon\.png/s);
  assert.doesNotMatch(iconBuild, /appMarkSvg|TIGHT LOWER-LEFT STACK/);
  assert.match(iconBuild, /favicon\.ico/);
  assert.doesNotMatch(iconBuild, /🐀/);
  await access("apps/website/src/app/favicon.ico");
  await assert.rejects(access("apps/website/public/chat-activity.gif"));
  await assert.rejects(access("apps/website/public/chat-activity-pending.png"));
});

test("root layout has no legacy scroll-reveal bootstrap", async () => {
  const layout = await readFile("apps/website/src/app/layout.tsx", "utf8");

  assert.doesNotMatch(layout, /REVEAL_BOOTSTRAP|classList\.add\('js'\)/);
  assert.doesNotMatch(layout, /suppressHydrationWarning/);
});

// House PostHog standard (mirrors CodesWhat/codeswhat.com's own
// frontend/test/posthog-source.test.mjs template): the site runs the shared
// cookieless PostHog proxy instead of Vercel Analytics, wired through
// instrumentation-client.ts rather than a layout-mounted component.
test("website analytics uses the cookieless house PostHog posture, not Vercel Analytics", async () => {
  const layout = await readFile("apps/website/src/app/layout.tsx", "utf8");
  const packageJson = JSON.parse(await readFile("apps/website/package.json", "utf8"));
  const instrumentation = await readFile("apps/website/instrumentation-client.ts", "utf8");

  assert.doesNotMatch(layout, /@vercel\/(analytics|speed-insights)/);
  assert.doesNotMatch(layout, /<Analytics\s*\/>/);
  assert.equal(packageJson.dependencies["@vercel/analytics"], undefined);
  assert.equal(packageJson.dependencies["@vercel/speed-insights"], undefined);
  // Pinned to an exact version, not a range: the analytics client is
  // third-party code running on every page, so it moves when Renovate opens a
  // reviewed PR and never silently on install. Asserting the pin's shape
  // rather than one literal version keeps that guarantee without turning
  // every routine bump into a test failure, which is how this drifted to a
  // stale 1.417.0 while package.json had already moved to 1.417.1.
  assert.match(packageJson.dependencies["posthog-js"], /^\d+\.\d+\.\d+$/);

  assert.match(instrumentation, /posthog\.init\(/);
  assert.doesNotMatch(layout, /posthog\.init\(/);
  for (const option of [
    "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
    "NEXT_PUBLIC_POSTHOG_HOST",
    "NEXT_PUBLIC_POSTHOG_UI_HOST",
    "capture_pageview: false",
    "capture_pageleave: true",
    "autocapture: false",
    "disable_session_recording: true",
    'persistence: "memory"',
    'cookieless_mode: "always"',
    "disable_persistence: true",
    "capture_performance:",
  ]) {
    assert.match(instrumentation, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(instrumentation, /before_send:/);

  const privacy = await readFile("apps/website/src/lib/posthog-privacy.ts", "utf8");
  assert.match(privacy, /POSTHOG_API_HOST = "https:\/\/e\.codeswhat\.com"/);
  assert.match(privacy, /ALLOWED_PLACEMENTS = new Set\(\["header", "hero", "get", "final"\]\)/);
  assert.match(privacy, /schema_version: 1/);
  assert.match(privacy, /site: SITE/);
  assert.match(privacy, /surface: surfaceForPath\(path\)/);
});

test("website metadata is CareerRat-branded", async () => {
  const layout = await readFile("apps/website/src/app/layout.tsx", "utf8");

  assert.match(layout, /CareerRat: Rate\. Apply\. Track\./);
  assert.doesNotMatch(layout, new RegExp(LEGACY_BRAND, "i"));
  // Product copy carries no em dashes, and page/OG/Twitter titles and
  // descriptions are product copy: they are the first thing anyone sees in a
  // shared link preview. Scoped to the metadata strings so an em dash in a
  // code comment (which no user reads) does not fail the suite.
  const metadataCopy = [
    ...layout.matchAll(/^\s*(?:title|description):\s*"([^"]*)"/gm),
    ...layout.matchAll(/^\s*"(CareerRat is [^"]*)"/gm),
  ].map((match) => match[1]);
  // Three titles (page, OG, Twitter) plus the shared siteDescription.
  assert.equal(metadataCopy.length, 4);
  for (const copy of metadataCopy) {
    assert.doesNotMatch(copy, /—/);
  }
});

test("website publishes canonical social metadata with a large CareerRat sharing card", async () => {
  const layout = await readFile("apps/website/src/app/layout.tsx", "utf8");

  assert.match(layout, /metadataBase:\s*new URL\("https:\/\/careerrat\.com"\)/);
  assert.match(layout, /alternates:\s*\{\s*canonical:\s*"\/"\s*\}/s);
  assert.match(
    layout,
    /openGraph:\s*\{[\s\S]*?url:\s*"\/"[\s\S]*?images:\s*\[\s*\{[\s\S]*?url:\s*"\/opengraph-image\.png"[\s\S]*?width:\s*1200[\s\S]*?height:\s*630/s
  );
  assert.match(
    layout,
    /twitter:\s*\{[\s\S]*?card:\s*"summary_large_image"[\s\S]*?images:\s*\[\s*\{[\s\S]*?url:\s*"\/opengraph-image\.png"[\s\S]*?width:\s*1200[\s\S]*?height:\s*630/s
  );

  const icon = await sharp("apps/website/src/app/icon.png").metadata();
  const appleIcon = await sharp("apps/website/src/app/apple-icon.png").metadata();
  const socialCard = await sharp("apps/website/src/app/opengraph-image.png").metadata();
  assert.deepEqual(
    { width: icon.width, height: icon.height, format: icon.format },
    { width: 512, height: 512, format: "png" }
  );
  assert.deepEqual(
    { width: appleIcon.width, height: appleIcon.height, format: appleIcon.format },
    { width: 180, height: 180, format: "png" }
  );
  assert.deepEqual(
    { width: socialCard.width, height: socialCard.height, format: socialCard.format },
    { width: 1200, height: 630, format: "png" }
  );

  const favicon = await readFile("apps/website/src/app/favicon.ico");
  assert.equal(favicon.readUInt16LE(0), 0);
  assert.equal(favicon.readUInt16LE(2), 1);
  const faviconCount = favicon.readUInt16LE(4);
  assert.equal(faviconCount, 4);
  assert.deepEqual(
    Array.from({ length: faviconCount }, (_, index) => favicon[6 + index * 16] || 256),
    [16, 32, 48, 64]
  );
});

test("deployed sites bundle fonts without Google build-time fetches", async () => {
  const websiteLayout = await readFile("apps/website/src/app/layout.tsx", "utf8");
  const docsLayout = await readFile("apps/docs/src/app/layout.tsx", "utf8");
  const combined = `${websiteLayout}\n${docsLayout}`;

  assert.doesNotMatch(combined, /next\/font\/google|fonts\.(?:googleapis|gstatic)\.com/);
  assert.match(websiteLayout, /next\/font\/local/);
  assert.match(websiteLayout, /@fontsource\/figtree/);
  assert.doesNotMatch(websiteLayout, /GeistVF|GeistMonoVF|@fontsource\/archivo/);
  assert.match(docsLayout, /next\/font\/local/);
});

test("website stays download-only while docs keep the public careerrat CLI convention", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");
  const publicAgents = await readFile("apps/website/public/AGENTS.md", "utf8");
  const installDocs = await readFile("apps/docs/content/docs/getting-started/install.mdx", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const combined = publicAgents;

  assert.doesNotMatch(
    page,
    /npm install -g careerrat|careerrat start|careerrat update|Node\.js 24/
  );
  assert.match(publicAgents, /careerrat start claude/);
  assert.match(publicAgents, /careerrat ingest/);
  assert.match(publicAgents, /careerrat update/);
  assert.equal(packageJson.engines.node, ">=24");
  assert.match(installDocs, /Node\.js >= 24/);

  assert.doesNotMatch(combined, STALE_PUBLIC_CLI_PATTERN);
});

test("docs website source uses the public careerrat CLI convention", async () => {
  const files = await listFiles("apps/docs/content", ".mdx");
  const docs = await Promise.all(files.map(async (file) => readFile(file, "utf8")));
  const combined = docs.join("\n");

  assert.match(combined, /npm install -g careerrat/);
  assert.match(combined, /careerrat start claude/);
  assert.match(combined, /careerrat tracker-dev/);
  assert.match(combined, /careerrat automation status/);
  assert.match(combined, /careerrat update/);
  assert.match(combined, /site:dev/);
  assert.match(combined, /site:build/);
  assert.match(combined, /docs:dev/);
  assert.match(combined, /docs:build/);
  assert.doesNotMatch(combined, /\bweb:(?:dev|build)\b/);

  // Internal contracts use the current product name too.
  assert.match(combined, /~\/Downloads\/careerrat\//);

  assert.doesNotMatch(combined, STALE_PUBLIC_CLI_PATTERN);
});

test("public docs describe local storage and AI-provider boundaries accurately", async () => {
  const paths = [
    "apps/docs/content/docs/index.mdx",
    "apps/docs/content/docs/getting-started/what-is-careerrat.mdx",
    "apps/docs/content/docs/advanced/privacy.mdx",
  ];
  const combined = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");

  assert.doesNotMatch(combined, /your data never leaves your machine/i);
  assert.doesNotMatch(combined, /evidence, comp floor, and\s+excluded companies never leave/i);
  assert.match(combined, /provider(?:'s)? privacy and retention terms/i);
  assert.match(combined, /SQLite/i);
});

test("docs website is CareerRat-branded (product name and repo links)", async () => {
  const layout = await readFile("apps/docs/src/app/layout.tsx", "utf8");
  const indexPage = await readFile("apps/docs/content/docs/index.mdx", "utf8");

  assert.match(layout, /CareerRat Docs/);
  assert.match(layout, /github\.com\/CodesWhat\/careerrat/);
  assert.match(indexPage, /CareerRat is a local, skill-driven job-search workspace/);

  assert.doesNotMatch(layout, new RegExp(`\\b${LEGACY_BRAND}\\b`, "i"));
});
