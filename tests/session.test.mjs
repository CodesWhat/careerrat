// tests/session.test.mjs — defaultProfileRoot() (src/core/automation/session.mjs).
// `~/.careerrat/board-profiles` is the default for fresh installs. Controls
// os.homedir() via the HOME env var, which Node honors on POSIX.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  defaultProfileRoot,
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

test("defaultProfileRoot resolves under ~/.careerrat/board-profiles for a fresh home", () => {
  const home = tempHome();
  assert.equal(defaultProfileRoot(), join(home, ".careerrat", "board-profiles"));
});

test("profilePath joins the platform onto the resolved default root", () => {
  const home = tempHome();
  assert.equal(profilePath("linkedin"), join(home, ".careerrat", "board-profiles", "linkedin"));
});

test("profilePath honors an explicit profileRoot override, ignoring the default entirely", () => {
  tempHome();
  assert.equal(
    profilePath("linkedin", { profileRoot: "/custom/root" }),
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
