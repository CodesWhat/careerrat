#!/usr/bin/env node
// Packed-tarball install smoke. Packs the package, installs the tarball into an
// empty project with `npm install --omit=dev`, and runs the installed bin. A
// runtime import of a devDependency, or a file missing from the tarball, passes
// every in-repo test and fails here, which is the shape a real
// `npm i -g careerrat` sees. Runs before `npm publish` in publish.yml.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// npm 11 prints `npm pack --json` as an array; npm 12 prints an object keyed by
// package name. Accept either.
export function firstPackedPackage(json) {
  return Array.isArray(json) ? json[0] : Object.values(json)[0];
}

export function packedFilename(output) {
  const filename = firstPackedPackage(JSON.parse(output))?.filename;
  if (!filename) throw new Error("npm pack --json did not report a tarball filename");
  return filename;
}

export function checkInstalledOutput({ version, expectedVersion, help }) {
  const problems = [];
  if (version.trim() !== expectedVersion) {
    problems.push(`--version printed "${version.trim()}", expected "${expectedVersion}"`);
  }
  if (!/Usage:\s*careerrat/.test(help)) problems.push("--help did not print the usage banner");
  return problems;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

export function runPackedInstallSmoke({ log = console.log } = {}) {
  const expectedVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const work = mkdtempSync(join(tmpdir(), "careerrat-packed-smoke-"));
  const env = cleanEnv();
  try {
    const packDir = join(work, "pack");
    const project = join(work, "project");
    mkdirSync(packDir);
    mkdirSync(project);
    const tarball = join(
      packDir,
      packedFilename(
        execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
          cwd: root,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        })
      )
    );
    log(`packed ${tarball}`);
    writeFileSync(
      join(project, "package.json"),
      '{"name":"careerrat-packed-smoke","private":true}\n'
    );
    // --ignore-scripts matches the repo's install posture: dependency lifecycle
    // scripts are reviewed separately (check-install-scripts), not run here.
    execFileSync(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      { cwd: project, env, stdio: ["ignore", "inherit", "inherit"] }
    );
    const bin = join(project, "node_modules", "careerrat", "bin", "careerrat.mjs");
    const run = (arg) =>
      execFileSync(process.execPath, [bin, arg], {
        cwd: project,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
    const problems = checkInstalledOutput({
      version: run("--version"),
      expectedVersion,
      help: run("--help"),
    });
    if (problems.length)
      throw new Error(`packed install smoke failed:\n  - ${problems.join("\n  - ")}`);
    log(`packed install smoke ok: careerrat ${expectedVersion} runs with --omit=dev`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPackedInstallSmoke();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
