#!/usr/bin/env node
// deploy:demo — (re)build the evergreen static demo bundle and ship it to the live demo
// at demo.rolester.codeswhat.com. Deploys via Vercel's Build Output API (prebuilt — no
// remote build), so ONLY the static files in dist/demo are uploaded; the project link
// and OIDC token under dist/.vercel never enter the served bundle.
//
//   Project: codeswhat/careerrat-demo   (link lives at dist/.vercel, gitignored)
//   Scope:   codeswhat   (ALWAYS pass --scope explicitly; the CLI's default account is
//                         a different, non-public org and must never receive this deploy)
//
// One-time setup already done: `cd dist && vercel link --project careerrat-demo --scope codeswhat`
// and the demo.rolester.codeswhat.com domain + Cloudflare CNAME. Re-run this anytime to
// refresh the demo (dates rebase to today on every build).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATIC_EDGE_CONTENT_SECURITY_POLICY,
  securityHeaders,
} from "../src/core/security/browser-policy.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(REPO, "dist");
const BUNDLE = join(DIST, "demo");
const OUTPUT = join(DIST, ".vercel/output"); // Build Output API; sibling of the project link
const STATIC_RESPONSE_HEADERS = securityHeaders({ csp: STATIC_EDGE_CONTENT_SECURITY_POLICY });

function run(cmd, args, cwd = REPO) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

// 1. fresh evergreen build → dist/demo
run("node", ["scripts/build-demo.mjs"]);

// 2. lay out the Build Output API tree (static = the bundle, config v3)
console.log("\n▸ Prepare prebuilt output");
rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(join(OUTPUT, "static"), { recursive: true });
cpSync(BUNDLE, join(OUTPUT, "static"), { recursive: true });
writeFileSync(
  join(OUTPUT, "config.json"),
  `${JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/.*", headers: STATIC_RESPONSE_HEADERS, continue: true },
        { handle: "filesystem" },
        { src: "/design-v3(?:/.*)?", dest: "/design-v3/index.html" },
        { src: "/.*", dest: "/index.html" },
      ],
    },
    null,
    2
  )}\n`
);

// 3. deploy prebuilt to production under the codeswhat scope
console.log("\n▸ Deploy to Vercel (codeswhat/careerrat-demo, prod)");
run("vercel", ["deploy", "--prebuilt", "--prod", "--yes", "--scope", "codeswhat"], DIST);
