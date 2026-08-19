// tests/playwright-live-dropdowns.test.mjs
// Real-Chromium coverage for playwright-ops.mjs's selectOption() combobox
// fallback (src/core/apply/playwright-ops.mjs). Every other playwright-ops
// suite (tests/playwright-apply-executor.test.mjs) runs against a fake
// browser/page/locator — right for pinning the ops CONTRACT cheaply, but it
// can't catch anything that depends on how a real browser actually resolves
// selectors, actionability, or DOM timing, which is exactly where the P0
// this file guards against was found: pointing createPlaywrightOps() at
// three real ATS forms showed native selectOption() either fails immediately
// against a non-<select> element (Greenhouse, Ashby) or hangs the full 30s
// default timeout against one (Lever) — a real ATS combobox never even gets
// this far in a fake-browser suite.
//
// No real ATS URL appears anywhere in this file. tests/fixtures/apply-
// form/index.html reproduces the two dropdown shapes that matter instead: a
// genuine native <select> (the still-must-work Lever-shaped path) and a
// react-select-shaped custom [role=combobox] (the Greenhouse/Ashby-shaped
// path selectOption() previously couldn't drive at all).
//
// Gated on CAREERRAT_LIVE_BROWSER=1, the same opt-in the multi-step harness in
// tests/playwright-live.test.mjs uses (and the same idea as
// tests/resume-extract.test.mjs's `skip: !process.env.ANTHROPIC_API_KEY` for a
// suite that needs a real, possibly-slow external dependency — here a real
// installed Chromium instead of a real model call). Run directly with:
//   CAREERRAT_LIVE_BROWSER=1 node --test tests/playwright-live-dropdowns.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createPlaywrightOps } from "../src/core/apply/playwright-ops.mjs";

const LIVE = process.env.CAREERRAT_LIVE_BROWSER === "1";

const FIXTURE_URL = new URL("./fixtures/apply-form/index.html", import.meta.url).href;

// createPlaywrightOps({ profileDir, headless }) with no launchImpl override
// reaches the module's real defaultLaunch — a genuine
// chromium.launchPersistentContext, not a stub — so every selectOption()
// call below runs against real DOM/actionability/timing semantics.
async function withLiveOps(fn) {
  const profileDir = mktempProfileDir();
  const ops = createPlaywrightOps({ profileDir, headless: true });
  try {
    await fn(ops);
  } finally {
    await ops.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

function mktempProfileDir() {
  return mkdtempSync(join(tmpdir(), "careerrat-playwright-live-"));
}

async function refFor(ops, pageId, name) {
  const snapshot = await ops.snapshot({ pageId });
  const [ref] = Object.entries(snapshot.refs).find(([, meta]) => meta.name === name) || [];
  assert.ok(ref, `no ref found for a control named "${name}" in: ${JSON.stringify(snapshot.refs)}`);
  return ref;
}

test("selectOption still drives a genuine native <select> over a real browser (Lever-shape, no regression)", {
  skip: !LIVE,
}, async () => {
  await withLiveOps(async (ops) => {
    const { pageId } = await ops.openTab({ url: FIXTURE_URL });
    const ref = await refFor(ops, pageId, "Work authorization");

    await ops.selectOption({ pageId, ref, value: "Yes" });

    const after = await ops.snapshot({ pageId });
    assert.match(after.pageText, /Work authorization selected: Yes/);
  });
});

test("selectOption drives a real react-select-shaped combobox and prefers the exact match (Greenhouse/Ashby-shape)", {
  skip: !LIVE,
}, async () => {
  await withLiveOps(async (ops) => {
    const { pageId } = await ops.openTab({ url: FIXTURE_URL });
    const ref = await refFor(ops, pageId, "Country");

    // "United States" has both an exact option and a substring-containing
    // option ("United States Minor Outlying Islands") that renders first
    // in the real DOM — proves the fallback doesn't just click whatever
    // happens to be first.
    await ops.selectOption({ pageId, ref, value: "United States" });

    const after = await ops.snapshot({ pageId });
    assert.match(after.pageText, /Country selected: United States(?! Minor)/);
  });
});

test("selectOption fails fast with a plain-language human-handoff error when no real option matches", {
  skip: !LIVE,
}, async () => {
  await withLiveOps(async (ops) => {
    const { pageId } = await ops.openTab({ url: FIXTURE_URL });
    const ref = await refFor(ops, pageId, "Country");

    const startedAt = Date.now();
    await assert.rejects(
      () => ops.selectOption({ pageId, ref, value: "Atlantis" }),
      (error) => {
        assert.match(error.message, /"Country" dropdown/);
        assert.match(error.message, /couldn't be set automatically/);
        assert.match(error.message, /switch to the open browser window/);
        return true;
      }
    );
    const elapsedMs = Date.now() - startedAt;

    // The original bug against a real Lever combobox was a full 30s hang.
    // A generous ceiling well under that proves this is a bounded, fast
    // failure and not a rebranded version of the same hang.
    assert.ok(
      elapsedMs < 15_000,
      `selectOption should fail fast, not hang — took ${elapsedMs}ms against a local fixture`
    );
  });
});

// Import-time sanity: fileURLToPath just proves FIXTURE_URL resolves to a
// real file on disk under this repo, catching a typo'd fixture path with a
// clear assertion instead of an opaque net::ERR_FILE_NOT_FOUND deep inside a
// skipped-by-default live suite.
test("the fixture URL used by the live suite above resolves to a real file", () => {
  const path = fileURLToPath(FIXTURE_URL);
  assert.ok(path.endsWith(join("fixtures", "apply-form", "index.html")));
  assert.ok(existsSync(path), `fixture file missing on disk: ${path}`);
});
