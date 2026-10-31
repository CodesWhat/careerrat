import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptSource = join(repoRoot, "apps", "website", "scripts", "vercel-ignore-build.sh");

let dir;
let baseSha;
let docsOnlySha;
let websiteSha;
let docsAppSha;

// Run inside a git hook (lefthook pre-push), GIT_DIR and GIT_WORK_TREE point at
// the real checkout. Inheriting them sends every command below into it, so the
// scratch repo gets an environment with no GIT_* variables and no user config.
const isolatedEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  HOME: dir,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(dir, ".gitconfig-isolated"),
});

const git = (...args) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: isolatedEnv() }).trim();

const write = (rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

const commit = (message) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

const run = (env, sha) => {
  git("checkout", "-q", "--detach", sha);
  const result = spawnSync("sh", ["scripts/vercel-ignore-build.sh"], {
    cwd: join(dir, "apps", "website"),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return result.status;
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vercel-ignore-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "apps", "website", "scripts"), { recursive: true });
  copyFileSync(scriptSource, join(dir, "apps", "website", "scripts", "vercel-ignore-build.sh"));
  write("apps/website/src/page.tsx", "a");
  write("apps/docs/page.mdx", "a");
  write("src/app.mjs", "a");
  write("package.json", "{}");
  baseSha = commit("base");
  write("src/app.mjs", "b");
  docsOnlySha = commit("app source only");
  write("apps/website/src/page.tsx", "b");
  websiteSha = commit("website change");
  write("apps/docs/page.mdx", "b");
  docsAppSha = commit("docs app change");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("vercel-ignore-build.sh", () => {
  it("always builds production", () => {
    assert.equal(
      run({ VERCEL_ENV: "production", VERCEL_GIT_PREVIOUS_SHA: baseSha }, docsOnlySha),
      1
    );
    assert.equal(
      run({ VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_PREVIOUS_SHA: baseSha }, docsOnlySha),
      1
    );
  });

  it("skips a preview when only non-site files changed", () => {
    assert.equal(run({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: baseSha }, docsOnlySha), 0);
  });

  it("builds a preview when apps/website changed", () => {
    assert.equal(run({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: baseSha }, websiteSha), 1);
  });

  it("builds a preview when apps/docs changed", () => {
    assert.equal(
      run({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: websiteSha }, docsAppSha),
      1
    );
  });

  it("builds a preview when there is no previous SHA and no origin", () => {
    assert.equal(run({ VERCEL_ENV: "preview" }, docsOnlySha), 1);
  });

  it("builds a preview when the previous SHA is not in the clone and no origin", () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(run({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: missing }, docsOnlySha), 1);
  });
});

describe("apps/website/vercel.json", () => {
  const config = JSON.parse(readFileSync(join(repoRoot, "apps", "website", "vercel.json"), "utf8"));

  it("disables deployments for branches that never need a preview", () => {
    const enabled = config.git.deploymentEnabled;
    for (const pattern of [
      "feat/**",
      "fix/**",
      "docs/**",
      "chore/**",
      "ci/**",
      "dev/**",
      "release/**",
      "renovate/**",
      "dependabot/**",
    ]) {
      assert.equal(enabled[pattern], false, pattern);
    }
  });

  it("keeps main deploying and leaves site/** free for a wanted preview", () => {
    const patterns = Object.keys(config.git.deploymentEnabled);
    assert.notEqual(config.git.deploymentEnabled.main, false);
    // Every disabled pattern carries a prefix, so it can never match "main".
    for (const pattern of patterns) assert.match(pattern, /^[a-z]+\/\*\*$/, pattern);
    assert.equal(patterns.includes("site/**"), false);
  });

  it("runs the ignore script from the project root", () => {
    assert.match(config.ignoreCommand, /scripts\/vercel-ignore-build\.sh$/);
  });
});
