#!/usr/bin/env node
// build:demo — render the demo fixture (examples/demo-workspace/) into a self-contained
// static bundle for the live demo at demo.rolester.codeswhat.com. Everything the page
// fetches is a root-absolute path (/dashboard-data.js, /workspace/*.json, /fonts/, /assets/),
// so the bundle only works served at a domain ROOT — which the subdomain gives for free.
//
// Pipeline:
//   1. Stage a throwaway render home (dist/demo-home/) from the fixture — tracker.json
//      lands under workspace/ (the fixture keeps it at root), candidate/*.yml copied in.
//   2. Date-rebase the staged tracker.json to real-today (the committed fixture stays
//      anchored). See scripts/rebase-demo-dates.mjs.
//   3. Render via src/cli/tracker.mjs → emits tracker.html + dashboard-data.js + the
//      modes/settings/library JSON snapshots into the staged workspace/.
//   4. Assemble dist/demo/ as the deployable static root: index.html, dashboard-data.js,
//      workspace/*.json, plus copies of repo assets/ and fonts/.
//
// Output (dist/) is gitignored — rebuild on every deploy so dates stay evergreen.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO, "examples/demo-workspace");
const HOME = join(REPO, "dist/demo-home"); // throwaway render home
const OUT = join(REPO, "dist/demo"); // deployable static root
const DESIGN_PREVIEW_OUT = join(OUT, "design-v3");

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

function run(cmd, args, env) {
  execFileSync(cmd, args, { cwd: REPO, stdio: "inherit", env: { ...process.env, ...env } });
}

// 1. stage the render home from the fixture
step("Stage render home from fixture");
rmSync(HOME, { recursive: true, force: true });
mkdirSync(join(HOME, "workspace"), { recursive: true });
cpSync(join(FIXTURE, "tracker.json"), join(HOME, "workspace/tracker.json"));
cpSync(join(FIXTURE, "candidate"), join(HOME, "candidate"), { recursive: true });

// 2. evergreen date-rebase the staged copy (fixture stays anchored)
step("Date-rebase staged tracker.json to today");
run("node", ["scripts/rebase-demo-dates.mjs", join(HOME, "workspace/tracker.json")]);

// 3. render the static dashboard set into the staged workspace/
step("Render dashboard");
run("node", ["src/cli/tracker.mjs"], { ROLESTER_HOME: HOME });

// 4. assemble the deployable static root
step("Assemble static bundle");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "workspace"), { recursive: true });

const ws = join(HOME, "workspace");
cpSync(join(ws, "tracker.html"), join(OUT, "index.html")); // served at /
cpSync(join(ws, "dashboard-data.js"), join(OUT, "dashboard-data.js"));
for (const f of ["tracker.json", "modes.json", "settings.json", "library.json"]) {
  if (existsSync(join(ws, f))) cpSync(join(ws, f), join(OUT, "workspace", f));
}
cpSync(join(REPO, "assets"), join(OUT, "assets"), { recursive: true });
cpSync(join(REPO, "fonts"), join(OUT, "fonts"), { recursive: true });
cpSync(join(REPO, "assets/favicon.ico"), join(OUT, "favicon.ico")); // bare /favicon.ico auto-request

step("Build gated V3 design preview");
run("npm", ["--workspace", "apps/web", "run", "build"], {
  VITE_BASE_PATH: "/design-v3/",
  VITE_ROUTER_BASENAME: "/design-v3",
  VITE_REQUIRE_PREVIEW_PASSWORD: "true",
  VITE_STATIC_PREVIEW: "true",
  VITE_PREVIEW_PASSWORD:
    process.env.ROLESTER_PREVIEW_PASSWORD || process.env.VITE_PREVIEW_PASSWORD || "rolester",
});
cpSync(join(REPO, "apps/web/dist"), DESIGN_PREVIEW_OUT, { recursive: true });

step(`Done → ${OUT}`);
console.log(`  index.html + dashboard-data.js`);
console.log(`  design-v3/: gated V3 product preview`);
console.log(`  workspace/: ${readdirSync(join(OUT, "workspace")).join(", ")}`);
console.log(`  assets/logos: ${readdirSync(join(OUT, "assets/logos")).length} logos`);
console.log(`  fonts/: ${readdirSync(join(OUT, "fonts")).join(", ")}`);
console.log(`\nServe locally to verify:  npx serve ${OUT}   (or any static root server)`);
