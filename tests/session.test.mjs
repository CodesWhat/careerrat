// tests/session.test.mjs — browser session identity and readiness.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  defaultProfileRoot,
  describeProviders,
  detectSession,
  PROVIDER_PREFERENCE,
  profilePath,
  resolveSession,
} from "../src/core/automation/session.mjs";

const cleanupRoots = [];
const originalHome = process.env.HOME;

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "careerrat-session-home-"));
  cleanupRoots.push(home);
  process.env.HOME = home;
  return home;
}

beforeEach(() => {
  process.env.HOME = originalHome;
});

after(() => {
  process.env.HOME = originalHome;
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("defaultProfileRoot isolates browser identity by active CareerRat home", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-session-repo-"));
  cleanupRoots.push(repoRoot);
  const firstHome = join(repoRoot, "candidate-a");
  const secondHome = join(repoRoot, "candidate-b");

  const first = defaultProfileRoot({ repoRoot, env: { CAREERRAT_HOME: firstHome } });
  const retry = defaultProfileRoot({ repoRoot, env: { CAREERRAT_HOME: firstHome } });
  const second = defaultProfileRoot({ repoRoot, env: { CAREERRAT_HOME: secondHome } });

  assert.equal(first, join(firstHome, "board-profiles"));
  assert.equal(retry, first, "one workspace must reuse its persistent browser identity");
  assert.equal(second, join(secondHome, "board-profiles"));
  assert.notEqual(first, second, "different CareerRat homes must not share authenticated state");
});

test("profilePath joins the platform under the active private data root", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-session-repo-"));
  cleanupRoots.push(repoRoot);
  const dataRoot = join(repoRoot, "candidate-a");
  assert.equal(
    profilePath("linkedin", { repoRoot, env: { CAREERRAT_HOME: dataRoot } }),
    join(dataRoot, "board-profiles", "linkedin")
  );
});

test("profilePath honors an explicit profileRoot override, ignoring the default entirely", () => {
  assert.equal(
    profilePath("linkedin", {
      profileRoot: "/custom/root",
      repoRoot: "/repo",
      env: { CAREERRAT_HOME: "/private/candidate" },
    }),
    join("/custom/root", "linkedin")
  );
});

test("Orca is a supported supervised session-browser provider without a credential profile", () => {
  assert.ok(PROVIDER_PREFERENCE.includes("orca"));
  const session = resolveSession({ data: { session: { provider: "orca" } } });
  assert.equal(session.provider, "orca");
  assert.equal(session.descriptor.storesCreds, false);
  assert.equal(session.profileRoot, null);
});

test("automatic session setup uses Orca when CareerRat is running inside Orca", () => {
  assert.equal(PROVIDER_PREFERENCE[0], "auto");
  const session = resolveSession({
    data: { session: { provider: "auto" } },
    env: { ORCA_WORKTREE_ID: "worktree-123" },
  });
  assert.equal(session.configuredProvider, "auto");
  assert.equal(session.provider, "orca");
  assert.equal(session.descriptor.storesCreds, false);
});

test("automatic session setup falls back to the browser extension outside Orca", () => {
  const session = resolveSession({ data: { session: { provider: "auto" } }, env: {} });
  assert.equal(session.configuredProvider, "auto");
  assert.equal(session.provider, "extension");
});

test("automatic session setup uses bundled Playwright in a packaged desktop workspace", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-session-repo-"));
  cleanupRoots.push(repoRoot);
  const dataRoot = join(repoRoot, "desktop-home");
  const session = resolveSession({
    repoRoot,
    data: { session: { provider: "auto" } },
    env: { CAREERRAT_PACKAGED_DESKTOP: "1", CAREERRAT_HOME: dataRoot },
  });
  assert.equal(session.configuredProvider, "auto");
  assert.equal(session.provider, "playwright");
  assert.equal(session.descriptor.automatedApply, true);
  assert.equal(session.profileRoot, join(dataRoot, "board-profiles"));
});

test("Playwright is ready before any persistent profile exists when Chromium can launch", () => {
  const home = tempHome();
  const profileRoot = join(home, ".careerrat", "board-profiles");
  assert.equal(existsSync(profileRoot), false);

  const session = detectSession({
    data: { session: { provider: "playwright", profile_root: profileRoot } },
    env: {},
    playwrightToolingDependencies: {
      resolvePackage: () => "/modules/playwright/index.js",
      loadPackage: () => ({
        chromium: { executablePath: () => "/browsers/chromium/chrome" },
      }),
      pathExists: (path) => path === "/browsers/chromium/chrome",
    },
  });

  assert.equal(session.presence.status, "ready");
  assert.match(session.presence.detail, /can open a browser when a job needs one/i);
  assert.doesNotMatch(session.presence.detail, /sign in|per platform|\.careerrat|board-profiles/i);
  assert.equal(existsSync(profileRoot), false, "readiness detection must not create a profile");
});

test("Playwright is not ready when its Chromium executable is missing", () => {
  const session = detectSession({
    data: { session: { provider: "playwright" } },
    env: {},
    playwrightToolingDependencies: {
      resolvePackage: () => "/modules/playwright/index.js",
      loadPackage: () => ({
        chromium: { executablePath: () => "/browsers/chromium/chrome" },
      }),
      pathExists: () => false,
    },
  });

  assert.equal(session.presence.status, "missing");
  assert.equal(session.presence.detail, "CareerRat's browser isn't ready yet.");
  assert.equal(session.presence.nextStep, undefined);
});

test("browser readiness gives a plain in-app next step without implementation jargon", () => {
  const session = detectSession({ data: { session: { provider: "extension" } }, env: {} });

  assert.ok(["missing", "unverified"].includes(session.presence.status));
  assert.equal(
    session.presence.detail,
    session.presence.status === "missing"
      ? "CareerRat needs a browser connection before it can help with job forms."
      : "CareerRat needs one more setup step before it can help with job forms."
  );
  assert.deepEqual(session.presence.nextStep, {
    kind: "choose",
    provider: "playwright",
    label: "Use CareerRat browser",
  });
  assert.doesNotMatch(
    `${session.presence.detail} ${session.presence.nextStep.label}`,
    /CLI|provider|extension|Playwright|Chromium|careerrat automation|`/i
  );
});

test("Orca remains the automatic packaged-desktop provider inside an Orca workspace", () => {
  const session = resolveSession({
    data: { session: { provider: "auto" } },
    env: {
      CAREERRAT_PACKAGED_DESKTOP: "1",
      ORCA_WORKTREE_ID: "worktree-123",
    },
  });
  assert.equal(session.provider, "orca");
});

// Regression: describeProviders() used to report the "auto" descriptor's own
// literal automatedApply (always true), not what "auto" actually resolves to.
// Outside Orca, "auto" resolves to the extension provider, which cannot drive
// apply-job's scripted apply path — the option list (and the JSON
// `careerrat automation status --json` / Settings both read) must say so.
test("describeProviders reports automatedApply:false for the auto option outside an Orca workspace", () => {
  const providers = describeProviders({ env: {} });
  const auto = providers.find((p) => p.id === "auto");
  assert.equal(auto.automatedApply, false);
});

test("describeProviders reports automatedApply:true for the auto option inside an Orca workspace", () => {
  const providers = describeProviders({ env: { ORCA_WORKTREE_ID: "worktree-123" } });
  const auto = providers.find((p) => p.id === "auto");
  assert.equal(auto.automatedApply, true);
});

test("describeProviders leaves the concrete providers' automatedApply untouched by env", () => {
  const providers = describeProviders({ env: {} });
  const byId = Object.fromEntries(providers.map((p) => [p.id, p.automatedApply]));
  assert.equal(byId.extension, false);
  assert.equal(byId.orca, true);
  assert.equal(byId.playwright, true);
});

test("the Playwright provider describes on-demand browser use instead of blanket sign-in setup", () => {
  const playwright = describeProviders({ env: {} }).find(
    (provider) => provider.id === "playwright"
  );

  assert.match(playwright.needs, /when a workflow needs it/i);
  assert.doesNotMatch(playwright.needs, /sign in|per platform|persistent profile/i);
});
