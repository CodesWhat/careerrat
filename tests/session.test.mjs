// tests/session.test.mjs — defaultProfileRoot()'s rename-safe fallback
// (src/core/automation/session.mjs). `~/.careerrat/board-profiles` is the
// default for fresh installs; an existing `~/.rolester/board-profiles` — LIVE
// logged-in browser sessions (cookies/credentials for LinkedIn and the job
// boards) — keeps being read in place, never silently orphaned. Controls
// os.homedir() via the HOME env var, which Node honors on POSIX.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { defaultProfileRoot, profilePath } from "../src/core/automation/session.mjs";

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

test("defaultProfileRoot keeps using a pre-existing ~/.rolester/board-profiles in place when no .careerrat sibling exists", () => {
  const home = tempHome();
  mkdirSync(join(home, ".rolester", "board-profiles"), { recursive: true });
  assert.equal(defaultProfileRoot(), join(home, ".rolester", "board-profiles"));
});

test("defaultProfileRoot prefers .careerrat when both legacy .rolester and .careerrat profile roots exist", () => {
  const home = tempHome();
  mkdirSync(join(home, ".rolester", "board-profiles"), { recursive: true });
  mkdirSync(join(home, ".careerrat", "board-profiles"), { recursive: true });
  assert.equal(defaultProfileRoot(), join(home, ".careerrat", "board-profiles"));
});

test("profilePath joins the platform onto the resolved default root", () => {
  const home = tempHome();
  assert.equal(
    profilePath("linkedin"),
    join(home, ".careerrat", "board-profiles", "linkedin")
  );
});

test("profilePath honors an explicit profileRoot override, ignoring the default entirely", () => {
  tempHome();
  assert.equal(
    profilePath("linkedin", { profileRoot: "/custom/root" }),
    join("/custom/root", "linkedin")
  );
});
