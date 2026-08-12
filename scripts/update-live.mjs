#!/usr/bin/env node
// update-live — operator tool: refresh an EXTERNAL live Rolester tree from the
// published npm package, without cd-ing into it. (To self-update the current tree,
// use `careerrat update` instead — both share src/core/update/update-core.mjs.)
//
// Rolester's agent path runs in-tree, so a live install is a full repo tree with the
// user's real candidate/ + workspace/ data co-located. This updates only the CODE by
// extracting the published tarball over the target; the tarball ships code only (the
// package.json `files` whitelist excludes candidate/ and workspace/), so live search
// data is preserved by construction. A privacy guard refuses any tarball that carries
// user-data paths, so running it against your own live install also dogfoods the release.
//
//   node scripts/update-live.mjs --target <dir> [--tag latest|rc|<version>] [--write]
//
// Dry run by default. Add --write to extract over the target. Set ROLESTER_LIVE_DIR
// instead of --target if you prefer.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  extractOver,
  fetchTarball,
  findUserDataLeaks,
  readPkgVersion,
} from "../src/core/update/update-core.mjs";

function parseArgs(argv) {
  const out = { target: process.env.ROLESTER_LIVE_DIR || null, tag: "latest", write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i] || out.target;
    else if (a === "--tag") out.tag = argv[++i] || out.tag;
    else if (a === "--write") out.write = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("-")) {
      /* ignore unknown flag */
    }
  }
  return out;
}

function die(msg) {
  console.error(`update-live: ${msg}`);
  process.exit(1);
}

function looksLikeRolesterTree(dir) {
  return existsSync(join(dir, "bin", "rolester.mjs")) && existsSync(join(dir, "src"));
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(
    "Usage: node scripts/update-live.mjs --target <dir> [--tag latest|rc|<version>] [--write]\n" +
      "  Refreshes CODE in an external live Rolester tree from the published npm package.\n" +
      "  candidate/ and workspace/ are never touched (they aren't in the package).\n" +
      "  Dry run unless --write is passed. To self-update the current tree: careerrat update."
  );
  process.exit(0);
}

if (!opts.target) die("no target — pass --target <dir> or set ROLESTER_LIVE_DIR");
if (!existsSync(opts.target)) die(`target does not exist: ${opts.target}`);
if (!looksLikeRolesterTree(opts.target))
  die(
    `target does not look like a Rolester install tree (no bin/rolester.mjs + src/): ${opts.target}`
  );

const spec = `rolester@${opts.tag}`;
console.log(`• Fetching ${spec} from npm…`);

let pkg;
try {
  pkg = fetchTarball(spec);
} catch (err) {
  die(err?.message || String(err));
}

try {
  const leaks = findUserDataLeaks(pkg.entries);
  if (leaks.length) {
    die(
      `REFUSING — the published package contains user-data paths (a privacy leak):\n` +
        leaks
          .slice(0, 20)
          .map((p) => `    ${p}`)
          .join("\n") +
        `\nThe npm release shipped candidate/ or workspace/ content. Fix the package.json ` +
        `"files" whitelist before installing this version anywhere.`
    );
  }

  const currentVersion = readPkgVersion(opts.target);
  console.log(`• Privacy guard passed — tarball is code-only (${pkg.entries.length} files).`);
  console.log(`• Target:  ${opts.target}  (currently v${currentVersion ?? "?"})`);
  console.log(`• Install: ${spec}${pkg.publishedVersion ? ` → v${pkg.publishedVersion}` : ""}`);

  if (!opts.write) {
    console.log(
      `\nDry run. To apply (code only — candidate/ + workspace/ untouched):\n` +
        `  node scripts/update-live.mjs --target ${opts.target} --tag ${opts.tag} --write`
    );
    process.exit(0);
  }

  console.log(`• Extracting code over target…`);
  extractOver(pkg.tgz, opts.target);

  console.log(`• Done. Now at v${readPkgVersion(opts.target) ?? "?"}.`);
  console.log(`• Running doctor in the live tree…`);
  const doc = spawnSync("node", [join(opts.target, "src/cli/doctor.mjs")], { stdio: "inherit" });
  if (doc.status !== 0) {
    console.log(
      `  (doctor reported issues — review above; per RELEASE.md, re-run \`careerrat ingest\` ` +
        `in update mode if new required config fields were added.)`
    );
  }
} finally {
  pkg.cleanup();
}
