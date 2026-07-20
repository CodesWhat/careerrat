#!/usr/bin/env node
// build:demo — build the intentionally public, fictional React preview into a
// self-contained static bundle for demo.rolester.codeswhat.com.
//
// Pipeline:
//   1. Build the supported React static-preview target at the deployment root.
//   2. Build a backward-compatible copy under /design-v3.
//   3. Copy shared assets/fonts and inject a hash-based CSP into every HTML page.
//
// Output (dist/) is gitignored — rebuild on every deploy so dates stay evergreen.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(REPO, "dist/demo"); // deployable static root
const DESIGN_PREVIEW_OUT = join(OUT, "design-v3");

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

function run(cmd, args, env) {
  execFileSync(cmd, args, { cwd: REPO, stdio: "inherit", env: { ...process.env, ...env } });
}

function copyDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(destination, entry), { recursive: true });
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// This static preview contains fictional data and is intentionally public. A
// private deployment must use hosting-layer access control before files are served.
step("Build public V3 product preview at the deployment root (fictional data only)");
run("npm", ["--workspace", "apps/web", "run", "build"], {
  VITE_BASE_PATH: "/",
  VITE_ROUTER_BASENAME: "/",
  VITE_STATIC_PREVIEW: "true",
});
copyDirectoryContents(join(REPO, "apps/web/dist"), OUT);

cpSync(join(REPO, "assets"), join(OUT, "assets"), { recursive: true });
cpSync(join(REPO, "fonts"), join(OUT, "fonts"), { recursive: true });
cpSync(join(REPO, "assets/favicon.ico"), join(OUT, "favicon.ico")); // bare /favicon.ico auto-request

step("Build backward-compatible /design-v3 preview");
run("npm", ["--workspace", "apps/web", "run", "build"], {
  VITE_BASE_PATH: "/design-v3/",
  VITE_ROUTER_BASENAME: "/design-v3",
  VITE_STATIC_PREVIEW: "true",
});
cpSync(join(REPO, "apps/web/dist"), DESIGN_PREVIEW_OUT, { recursive: true });

step("Apply per-page hash-based Content Security Policy");
run("node", ["scripts/harden-static-html.mjs", OUT]);

step(`Done → ${OUT}`);
console.log(`  /: public V3 product preview (fictional data)`);
console.log(`  design-v3/: backward-compatible preview route`);
console.log(`  assets/logos: ${readdirSync(join(OUT, "assets/logos")).length} logos`);
console.log(`  fonts/: ${readdirSync(join(OUT, "fonts")).join(", ")}`);
console.log(`\nServe locally to verify:  npx serve ${OUT}   (or any static root server)`);
