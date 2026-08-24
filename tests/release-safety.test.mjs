import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const LEGACY_BRAND_TERMS = [["role", "ster"].join(""), ["roll", "ster"].join("")];

test("tracked paths and text use CareerRat branding only", () => {
  const pattern = LEGACY_BRAND_TERMS.join("|");
  const trackedPaths = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((file) => file && existsSync(join(root, file)));
  const pathOffenders = trackedPaths.filter((file) =>
    LEGACY_BRAND_TERMS.some((term) => file.toLowerCase().includes(term))
  );

  let textOffenders = "";
  try {
    textOffenders = execFileSync("git", ["grep", "-n", "-I", "-i", "-E", pattern], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (err.status !== 1) throw err;
  }

  assert.deepEqual(
    pathOffenders,
    [],
    `Legacy-branded tracked paths found:\n${pathOffenders.join("\n")}`
  );
  assert.equal(textOffenders, "", `Legacy brand text found:\n${textOffenders}`);
});

test("the tracked repository root contains only entry-point documentation", () => {
  const allowed = new Set(["AGENTS.md", "CHANGELOG.md", "CLAUDE.md", "README.md"]);
  const rootMarkdown = execFileSync("git", ["ls-files", "*.md"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((file) => file && !file.includes("/"));

  assert.deepEqual(
    rootMarkdown.filter((file) => !allowed.has(file)),
    [],
    "Long-form project documentation belongs under docs/"
  );
});

test("every explicit workflow test path exists", async () => {
  const workflowsDir = join(root, ".github/workflows");
  const missing = [];

  for (const entry of await readdir(workflowsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const source = await readFile(join(workflowsDir, entry.name), "utf8");
    const paths = source.match(
      /\b(?:tests|apps\/[A-Za-z0-9._/-]+)\/[A-Za-z0-9._/-]+\.test\.(?:mjs|cjs|js|jsx|ts|tsx)\b/g
    );
    for (const path of new Set(paths || [])) {
      if (!existsSync(join(root, path))) missing.push(`${entry.name}: ${path}`);
    }
  }

  assert.deepEqual(missing, [], `Workflow test paths must exist:\n${missing.join("\n")}`);
});

test("document export fonts stay packaged while the app bundles its own fonts", async () => {
  assert.equal(existsSync(join(root, "fonts")), false, "root fonts/ should not exist");
  for (const file of ["Geist-OFL.txt", "GeistMonoVF.woff2", "GeistVF.woff2"]) {
    assert.equal(existsSync(join(root, "assets", "fonts", file)), true, `${file} should ship`);
  }

  const trackerDev = await readText("src/cli/tracker-dev.mjs");
  const documentExport = await readText("src/core/documents/export.mjs");
  const webFoundation = await readText("apps/web/src/chat-first/app-foundation.css");
  const pkg = JSON.parse(await readText("package.json"));
  const webPkg = JSON.parse(await readText("apps/web/package.json"));
  assert.doesNotMatch(trackerDev, /FONTS_DIR|serveFont|"\/fonts\//);
  assert.match(documentExport, /join\(repoRoot, "assets", "fonts", file\)/);
  assert.match(webFoundation, /@fontsource\/figtree\/400\.css/);
  assert.equal(webPkg.dependencies["@fontsource/figtree"], "^5.3.0");
  assert.doesNotMatch(webFoundation, /url\("\/fonts\//);
  assert.ok(!pkg.files.includes("fonts"));
});

test("product apps and archived prototypes are consolidated out of the repository root", async () => {
  for (const staleRoot of ["website", "docs-site", "mockups"]) {
    assert.equal(
      existsSync(join(root, staleRoot)),
      false,
      `${staleRoot}/ should not remain at the repository root`
    );
  }
  for (const expected of [
    "apps/website/package.json",
    "apps/docs/package.json",
    ".planning/archive/mockups/index.html",
  ]) {
    assert.equal(existsSync(join(root, expected)), true, `${expected} should exist`);
  }
  assert.equal(
    existsSync(join(root, "apps/docs/package-lock.json")),
    false,
    "the monorepo should use one root package lock"
  );
  const trackedPaths = new Set(
    execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n")
  );
  assert.equal(
    trackedPaths.has("apps/docs/next-env.d.ts"),
    false,
    "Next may generate app-local type wiring, but Git should not track it"
  );
  assert.equal(
    trackedPaths.has("apps/docs/package-lock.json"),
    false,
    "the monorepo should not track an app-local package lock"
  );

  const pkg = JSON.parse(await readText("package.json"));
  const websitePkg = JSON.parse(await readText("apps/website/package.json"));
  const docsPkg = JSON.parse(await readText("apps/docs/package.json"));
  const gitignore = await readText(".gitignore");
  const vercelignore = await readText(".vercelignore");
  const turbo = JSON.parse(await readText("turbo.json"));

  assert.deepEqual(pkg.workspaces, ["apps/*"]);
  assert.equal(websitePkg.name, "@careerrat/website");
  assert.equal(docsPkg.name, "@careerrat/docs");
  assert.match(websitePkg.scripts["build:docs-content"], /build-docs-content\.mjs/);
  assert.match(websitePkg.scripts.build, /\.\.\/\.\.\/scripts\/harden-static-html\.mjs/);
  assert.match(docsPkg.scripts.build, /\.\.\/\.\.\/scripts\/harden-static-html\.mjs/);
  assert.match(pkg.scripts["site:build"], /@careerrat\/website/);
  assert.match(pkg.scripts["docs:build"], /@careerrat\/docs/);
  assert.ok(turbo.tasks.build.outputs.includes("dist/**"));
  assert.ok(!turbo.tasks.build.outputs.includes("apps/web/dist/**"));
  assert.doesNotMatch(gitignore, /^(?:website|docs-site|mockups)\//m);
  assert.match(vercelignore, /^\/\.planning$/m);
});

test("onboarding does not ask candidates to choose implementation modes", async () => {
  const router = await readText("AGENTS.md");
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");
  const roadmap = await readText("docs/ROADMAP.md");
  const setup = await readText("docs/SETUP.md");
  const installGuide = await readText("apps/docs/content/docs/getting-started/install.mdx");
  for (const text of [router, skill, roadmap, setup, installGuide]) {
    assert.doesNotMatch(text, /Basic vs Advanced/i);
    assert.doesNotMatch(text, /\b(?:Basic|Advanced) mode\b/i);
    assert.doesNotMatch(text, /Do you want \*\*(?:Basic|Deep|Simple)/i);
  }
  assert.doesNotMatch(setup, /## Setup Modes|Deep vs Shallow/i);
  assert.match(skill, /capability-on-demand/i);
  assert.match(skill, /defaults to the full conversational setup/i);
});

test("public docs describe the app as an active client over canonical data", async () => {
  for (const path of [
    "README.md",
    "AGENTS.md",
    "apps/docs/content/docs/getting-started/dashboard.mdx",
    "apps/docs/content/docs/getting-started/first-job.mdx",
  ]) {
    const text = await readText(path);
    assert.doesNotMatch(text, /dashboard is (?:\*\*)?read-only|dashboard never .*writes/i, path);
  }
});

test("the published package runs no consumer lifecycle setup and start installs skills itself", async () => {
  const pkg = JSON.parse(await readText("package.json"));
  const launcher = await readText("bin/careerrat.mjs");
  assert.equal(pkg.scripts?.prepare, undefined);
  assert.equal(pkg.scripts?.postinstall, undefined);
  assert.match(pkg.scripts?.["hooks:install"] || "", /lefthook install/);
  assert.match(launcher, /run\(join\(root, "scripts\/install-skills\.mjs"\), \["--soft"\]\)/);
});

test("start and update reconcile stale local app runtimes without killing foreign listeners", async () => {
  const launcher = await readText("bin/careerrat.mjs");
  const healthRoute = await readText("src/cli/tracker-dev.mjs");

  assert.match(launcher, /classifyLocalAppRuntime/);
  assert.match(launcher, /findAvailableLoopbackPort/);
  assert.match(launcher, /runtime\.state === "stale-owned"/);
  assert.match(launcher, /runtime\.state === "foreign"/);
  assert.match(launcher, /activeRecordedDashboard/);
  assert.match(launcher, /restartDashboardAfterUpdate/);
  assert.match(healthRoute, /product:\s*"careerrat"/);
  assert.match(healthRoute, /pid:\s*process\.pid/);
});

test("the trusted-publishing workflow installs dependencies before npm publish", async () => {
  const workflow = await readText(".github/workflows/publish.yml");
  const installAt = workflow.indexOf("run: corepack npm ci");
  const publishAt = workflow.indexOf("corepack npm publish --provenance");

  assert.notEqual(installAt, -1, "trusted publishing must install the locked dependency graph");
  assert.ok(installAt < publishAt, "npm ci must run before npm publish triggers prepack");
});

test("onboarding previews every explicit candidate fact without waiting for a field bundle", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /confirm-block each explicit fact immediately/i);
  assert.match(skill, /do not wait for related identity or contact fields/i);
  assert.doesNotMatch(skill, /name \+ email \+ phone, once all three are confirmed/i);
});

test("onboarding never re-asks a fact already present in canonical or pending state", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /never ask for a fact already present in canonical or pending state/i);
  assert.match(skill, /inspect both saved candidate data and unresolved confirm blocks/i);
});

test("web onboarding does not collect job-board preferences it cannot save", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /in conversational chat, do not ask for job-board preferences/i);
  assert.match(skill, /setup-searches owns that question and its durable write/i);
  assert.doesNotMatch(skill, /hold the answer in conversation/i);
});

test("onboarding does not reclassify an already-saved compensation value", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /never ask whether a repeated value is current_base or expected_base/i);
  assert.match(skill, /preserve the stored compensation field/i);
});

test("onboarding skips arrangement floors for work the candidate ruled out", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /collect floors only for arrangements the candidate would accept/i);
  assert.match(skill, /do not ask for an onsite or relocation floor/i);
});

test("web onboarding confirms expected base once while preserving both canonical mirrors", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /emit one form-defaults confirmation block/i);
  assert.match(skill, /the web surface mirrors that confirmed value into profile compensation/i);
});

test("onboarding does not solicit optional lifestyle details by default", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(
    skill,
    /ask about family or lifestyle constraints only when optional_areas includes lifestyle/i
  );
  assert.match(skill, /or the candidate raises one naturally/i);
});

test("onboarding does not solicit over-employment by default", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /ask about over-employment only when the candidate naturally raises/i);
  assert.match(skill, /otherwise skip (?:this|the) question/i);
  assert.doesNotMatch(skill, /explicitly ask about over-employment/i);
});

test("conversational onboarding stops once the canonical checklist is complete", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /when .*setupProgress\.complete.*true/i);
  assert.match(skill, /answers a question Paul asked before completion/i);
  assert.match(skill, /emit its confirmation block before ending/i);
  assert.match(skill, /never say a new fact is noted or saved/i);
  assert.match(skill, /ask no new initial-setup questions/i);
});

test("onboarding starts baseline sourcing before the deeper discovery handoff", async () => {
  const router = await readText("AGENTS.md");
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");
  const launcher = await readText("bin/careerrat.mjs");

  for (const text of [router, skill, launcher]) {
    assert.match(text, /search_ready|search-ready/i);
    assert.match(text, /baseline search/i);
  }
  assert.match(skill, /while Paul continues/i);
  assert.match(skill, /Pause setup/i);
  assert.doesNotMatch(launcher, /before the first job sweep/i);
});

test("onboarding saves notice period at the supported profile path and does not invent an earliest-start field", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /profile\.authorization\.notice_period/i);
  assert.match(skill, /never save it under `form-defaults\.notice_period`/i);
  assert.match(skill, /do not ask for an earliest possible start date during initial setup/i);
});

test("onboarding does not solicit optional company-size preferences by default", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(
    skill,
    /ask about headcount or funding-stage limits only when optional_areas includes work-preferences/i
  );
  assert.match(skill, /otherwise skip this question/i);
});

test("web onboarding confirms profile links once while preserving form mirrors", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /emit one profile confirmation block for linkedin, github, and portfolio/i);
  assert.match(skill, /the web surface mirrors those confirmed links into form-defaults/i);
  assert.match(
    skill,
    /profile link fields are strings; use an empty string when the candidate has no link/i
  );
});

test("web onboarding writes ATS authorization defaults with schema-safe strings", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");

  assert.match(skill, /form-defaults work_authorization and requires_sponsorship are strings/i);
  assert.match(skill, /use yes or no, never booleans/i);
});

test("web onboarding persists stated writing preferences without requiring sample files", async () => {
  const skill = await readText(".agents/skills/ingest-profile/SKILL.md");
  const schema = JSON.parse(await readText("config/honesty.schema.json"));

  assert.match(skill, /when the candidate states writing preferences/i);
  assert.match(skill, /emit one honesty confirmation block immediately/i);
  assert.match(skill, /style\.prefer/i);
  assert.deepEqual(schema.properties.style.properties.prefer, {
    type: "array",
    items: { type: "string" },
  });
});

test("conversational board research never asks users to recite internal source config", async () => {
  const skill = await readText(".agents/skills/research-boards/SKILL.md");

  assert.match(skill, /outbound-safe candidate context.*configured_sources/is);
  assert.match(skill, /never ask the\s+candidate for configured source labels or urls/i);
});

test("web discovery emits typed proposals that the app can actually persist", async () => {
  const boards = await readText(".agents/skills/research-boards/SKILL.md");
  const companies = await readText(".agents/skills/discover-companies/SKILL.md");

  assert.match(boards, /careerrat:discovery/);
  assert.match(boards, /"kind":"source_proposal"/);
  assert.match(boards, /"kind":"discovery_complete","step":"research-boards"/);
  assert.match(companies, /careerrat:discovery/);
  assert.match(companies, /"kind":"company_proposal"/);
  assert.match(companies, /"kind":"discovery_complete","step":"discover-companies"/);
});

test("the app ships one fixed light visual mode", async () => {
  const index = await readText("apps/web/index.html");
  const foundation = await readText("apps/web/src/chat-first/app-foundation.css");
  const workspace = await readText("apps/web/src/chat-first/chat-first.css");
  assert.doesNotMatch(index, /theme-init\.js/);
  assert.equal(existsSync(join(root, "apps/web/public/theme-init.js")), false);
  assert.doesNotMatch(`${foundation}\n${workspace}`, /\[data-theme=["']?dark/);
  assert.match(foundation, /--canvas:\s*#edf5fb/);
  assert.match(foundation, /body\s*\{[^}]*background:\s*var\(--canvas\)/s);
});

test("local user data roots are excluded from git, docker, and Vercel surfaces", async () => {
  const gitignore = await readText(".gitignore");
  const dockerignore = await readText(".dockerignore");
  const vercelignore = await readText(".vercelignore");

  assert.match(gitignore, /^\.careerrat\/$/m);
  assert.match(gitignore, /^\/candidate\/$/m);
  assert.match(gitignore, /^workspace\/tracker\.\*$/m);
  assert.match(gitignore, /^config\/search-sources\.yml$/m);
  assert.match(gitignore, /^config\/sourced-scan\.json$/m);

  for (const pattern of [
    ".careerrat",
    ".internal",
    "candidate",
    "workspace/jobs",
    "workspace/research",
    "workspace/network-leads",
  ]) {
    assert.match(dockerignore, new RegExp(`^${escapeRegExp(pattern)}$`, "m"));
  }
  assert.doesNotMatch(dockerignore, /^\*\.png$/m);
  assert.match(dockerignore, /^tracker-\*\.png$/m);

  for (const pattern of [
    ".careerrat",
    ".internal",
    "candidate",
    "workspace",
    ".agents",
    "config",
  ]) {
    assert.match(vercelignore, new RegExp(`^/${escapeRegExp(pattern)}$`, "m"));
  }

  // .vercelignore uses .gitignore semantics: an unanchored pattern matches at
  // every depth. A bare `src` also matched both Next apps' source trees, so
  // the git build deleted them and production served a 404.
  for (const pattern of [
    "src",
    "bin",
    "scripts",
    "tests",
    "examples",
    "templates",
    "config",
    "mockups",
  ]) {
    assert.doesNotMatch(
      vercelignore,
      new RegExp(`^${escapeRegExp(pattern)}$`, "m"),
      `.vercelignore must anchor "${pattern}" as "/${pattern}" so it cannot delete nested app files from the Vercel upload`
    );
  }
  assert.match(vercelignore, /^!\/scripts\/harden-static-html\.mjs$/m);
  assert.match(vercelignore, /^!\/scripts\/build-docs-content\.mjs$/m);
});

test("npm package allowlist names app files, not broad private-data roots", async () => {
  const pkg = JSON.parse(await readText("package.json"));
  const files = pkg.files || [];

  assert.ok(files.includes("bin"));
  assert.ok(files.includes("src"));
  assert.ok(files.includes("config/*.schema.json"));
  assert.ok(files.includes("config/*.example.*"));
  assert.ok(
    files.includes("config/paste-intake-routes.json"),
    "the installed intake classifier needs its canonical routing table"
  );
  assert.ok(files.includes(".agents/skills/apply-job/SKILL.md"));
  assert.ok(files.includes(".agents/skills/calendar-sync/SKILL.md"));
  assert.ok(files.includes(".agents/skills/relationship-sourcing/SKILL.md"));
  const packagedSkills = files.filter((item) => item.startsWith(".agents/skills/")).sort();
  const sourceSkills = (await readdir(join(root, ".agents/skills"), { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, ".agents/skills", entry.name, "SKILL.md"))
    )
    .map((entry) => `.agents/skills/${entry.name}/SKILL.md`)
    .sort();
  assert.deepEqual(
    packagedSkills,
    sourceSkills,
    "every runtime-neutral source skill must ship in the npm package"
  );
  for (const entry of packagedSkills) {
    await assert.doesNotReject(readText(entry), `${entry} should exist before packaging`);
  }

  assert.ok(!files.includes("config"));
  assert.ok(!files.includes(".agents"));
  assert.ok(!files.includes(".agents/skills/*/SKILL.md"));
  assert.ok(!files.includes("docs"));
  assert.ok(!files.includes("candidate"));
  assert.ok(!files.includes("workspace"));
  assert.ok(!files.some((entry) => entry.includes("search-sources.yml")));
});

// Shared with the built-dist scan below (apps/web/dist) — one banned list,
// two surfaces: `git grep` over tracked source, and a plain filesystem walk
// over generated build output that `git grep` (tracked-files-only) can't see.
const PERSONAL_SENTINELS = [
  ["Scott", "Benson"].join(" "),
  "Bloomfield",
  "$" + "145K",
  "145" + "000",
  "sctt" + "bnsn",
  ["Work", "OS"].join(""),
  ["work", "os"].join(""),
  "Pw" + "C",
  "pwc",
  "workos" + ".com",
  "pwc" + ".com",
  "shopify" + ".com",
  ["Anna", "Meyer"].join(" "),
  ["Robert", "Choe"].join(" "),
  ["Alex", "Aberg"].join(" "),
  ["Juniper", "Square"].join(" "),
  "Sabri" + "na",
  "225" + "000",
  "220" + "000",
  "225" + "K",
];

test("tracked app files do not contain known production personal sentinels", () => {
  const pattern = PERSONAL_SENTINELS.map(escapeEgrep).join("|");

  try {
    const output = execFileSync(
      "git",
      [
        "grep",
        "-n",
        "-I",
        "-E",
        pattern,
        "--",
        ".",
        ":!.planning/**",
        ":!candidate/**",
        ":!workspace/**",
        ":!tests/release-safety.test.mjs",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    assert.fail(`Tracked personal sentinel(s) found:\n${output}`);
  } catch (err) {
    if (err.status === 1) return;
    throw err;
  }
});

// M7 — apps/web/dist is gitignored (built fresh, shipped via package.json
// #files), so the `git grep` check above (tracked files only) can never see
// it. Vite bundles anything imported at build time into plain static text;
// this is the guard that no candidate/workspace value ever gets inlined into
// the shipped SPA bundle. Skips cleanly when dist hasn't been built in this
// run (root `npm test` stays build-free — see package.json's own `test`
// script scoping) rather than failing on a missing optional artifact.
test("built apps/web/dist (when present) contains no known production personal sentinels", async () => {
  const {
    existsSync,
    readdirSync,
    readFileSync: readFileSyncFs,
    statSync,
  } = await import("node:fs");
  const distDir = join(root, "apps/web/dist");
  if (!existsSync(distDir)) return;

  const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".map", ".json", ".svg", ".txt"]);
  const pattern = new RegExp(PERSONAL_SENTINELS.map(escapeRegExp).join("|"));

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(distDir);

  const offenders = [];
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf("."));
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const text = readFileSyncFs(file, "utf8");
    if (pattern.test(text)) offenders.push(file.slice(root.length));
  }

  assert.deepEqual(
    offenders,
    [],
    `Personal sentinel(s) found in built apps/web/dist — a candidate/workspace value leaked ` +
      `into the SPA bundle:\n${offenders.join("\n")}`
  );
});

test("shipped docs/SOURCES.md carries no candidate-discovered (vetted) boards", async () => {
  // research-boards must persist discovered boards to the user's gitignored
  // config/search-sources.yml + workspace/research log — NEVER to this shipped, published
  // doc. Discovered boards are recorded with Status `vetted`; a `vetted` row here means one
  // user's targeting (their domain/role-specific niche boards) leaked into the package.
  // This is the guard for the research-boards → docs/SOURCES.md write-back leak.
  const sources = await readText("docs/SOURCES.md");
  assert.doesNotMatch(
    sources,
    /\|\s*vetted\s*\|/,
    "docs/SOURCES.md has a `vetted` registry row — a candidate-discovered board leaked into the shipped doc. research-boards must write discovered boards to the gitignored config/search-sources.yml only, never here."
  );
});

test("operational scripts do not hardcode an absolute personal-home path", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const scriptsDir = join(root, "scripts");

  // Walk scripts/ recursively (catches untracked one-off repair/ingest scripts
  // too — those are the ones most likely to grow a hardcoded /Users/<name> path).
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  try {
    walk(scriptsDir);
  } catch (err) {
    if (err.code === "ENOENT") return; // no scripts/ dir → nothing to scan
    throw err;
  }

  // A literal home root like /Users/example/ or /home/scott/. The portable forms
  // ($HOME, ${HOME}, ~, and import.meta.url-relative paths) never match.
  const homePath = /\/(?:Users|home)\/[A-Za-z0-9._-]+/;
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    text.split("\n").forEach((line, i) => {
      if (homePath.test(line))
        offenders.push(`${file.slice(root.length)}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Hardcoded personal-home path(s) in scripts/ — use $HOME, ~, or an import.meta.url-relative root:\n${offenders.join("\n")}`
  );
});

test("scripts reachable from a skill or published npm-run alias are shipped", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const pkg = JSON.parse(await readText("package.json"));
  const files = pkg.files || [];
  const npmScripts = pkg.scripts || {};

  // Map each `npm run <alias>` to the scripts/X.mjs it executes (if any).
  const aliasToScript = {};
  for (const [alias, cmd] of Object.entries(npmScripts)) {
    const m = cmd.match(/scripts\/[A-Za-z0-9_-]+\.mjs/);
    if (m) aliasToScript[alias] = m[0];
  }

  // Everything an agent can reach at runtime MUST ship. npm pack ships exactly
  // the "files" allowlist, so an unshipped-but-referenced script breaks every
  // installed/live copy (the missing-verify-tracker.mjs class of bug).
  const DEV_ONLY = new Set();

  const referenced = new Set();
  // Every script a published npm-run alias points at.
  for (const s of Object.values(aliasToScript)) referenced.add(s);
  // Every script a skill tells the agent to run — directly (`scripts/X.mjs`) or
  // via an `npm run <alias>` that resolves to one.
  const skillsDir = join(root, ".agents/skills");
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let text;
    try {
      text = readFileSync(join(skillsDir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/scripts\/[A-Za-z0-9_-]+\.mjs/g)) referenced.add(m[0]);
    for (const m of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      const script = aliasToScript[m[1]];
      if (script) referenced.add(script);
    }
  }

  const missing = [...referenced].filter((s) => !DEV_ONLY.has(s) && !files.includes(s)).sort();

  assert.deepEqual(
    missing,
    [],
    `Reachable script(s) missing from the package.json "files" allowlist — they break ` +
      `in every installed/live copy:\n${missing.map((s) => `    ${s}`).join("\n")}`
  );
});

function readText(relPath) {
  return readFile(join(root, relPath), "utf8");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeEgrep(value) {
  return String(value).replace(/[.[\]{}()*+?^$\\|]/g, "\\$&");
}
