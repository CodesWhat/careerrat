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
// form/index.html reproduces the three dropdown shapes that matter instead: a
// genuine native <select> (the still-must-work Lever-shaped path), a
// react-select-shaped click-to-open custom [role=combobox] (the Greenhouse-
// shaped path selectOption() previously couldn't drive at all), and an
// Ashby-shaped type-to-populate combobox (a plain text input that renders no
// options until something is typed into it).
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

// This is the regression pin for a real, measured false positive: the
// fixture's Citizenship control renders its option list asynchronously, in
// a portal, in two waves (an interim list a click can't commit through,
// replaced shortly after by the real one). Against the PREVIOUSLY committed
// selectOption() — no verification, an unpaced pressSequentially, and a
// stale nth(index) click — this test FAILS: selectOption() resolves without
// throwing (it clicks the interim, inert option) while the field is left
// genuinely blank, so the status text this test asserts on never appears.
// It only passes once selectOption() actually confirms the control's own
// display value before reporting success.
test("selectOption drives a real Ashby-shaped type-to-populate combobox that renders no options until typed into", {
  skip: !LIVE,
}, async () => {
  await withLiveOps(async (ops) => {
    const { pageId } = await ops.openTab({ url: FIXTURE_URL });
    const ref = await refFor(ops, pageId, "Citizenship");

    // "Tanzania" is present in the fixture's list regardless of what was
    // typed (mirroring a real Ashby query for "Uni" surfacing "Tanzania")
    // and has no other option text it could be confused with.
    await ops.selectOption({ pageId, ref, value: "Tanzania" });

    const after = await ops.snapshot({ pageId });
    assert.match(after.pageText, /Citizenship selected: Tanzania/);
  });
});

test("selectOption on the Ashby-shaped combobox prefers the exact match over a substring match, and tolerates a duplicate label", {
  skip: !LIVE,
}, async () => {
  await withLiveOps(async (ops) => {
    const { pageId } = await ops.openTab({ url: FIXTURE_URL });
    const ref = await refFor(ops, pageId, "Citizenship");

    // "Canadian Overseas Territory" contains "canada" and is ordered first
    // in the fixture's option list, and "Canada" itself renders TWICE (a
    // duplicate label) — a naive first-hit search would land on the
    // substring match, and a naive click-by-index could throw on/mismatch
    // the duplicate, instead of landing on the exact "Canada" match either
    // way.
    await ops.selectOption({ pageId, ref, value: "Canada" });

    const after = await ops.snapshot({ pageId });
    assert.match(after.pageText, /Citizenship selected: Canada$/m);
  });
});

test("selectOption on the Ashby-shaped combobox fails fast with the human-handoff error when nothing matches", {
  skip: !LIVE,
}, async () => {
  await withLiveOps(async (ops) => {
    const { pageId } = await ops.openTab({ url: FIXTURE_URL });
    const ref = await refFor(ops, pageId, "Citizenship");

    const startedAt = Date.now();
    await assert.rejects(
      () => ops.selectOption({ pageId, ref, value: "Atlantis" }),
      (error) => {
        assert.match(error.message, /"Citizenship" dropdown/);
        assert.match(error.message, /couldn't be set automatically/);
        assert.match(error.message, /switch to the open browser window/);
        return true;
      }
    );
    const elapsedMs = Date.now() - startedAt;

    // Same 15s ceiling the Country-shaped fails-fast test above holds to —
    // this shape pays for two bounded waits in sequence (the click-to-open
    // attempt that never opens anything, then the type-to-populate attempt
    // that also renders nothing for a non-matching value), so it's the
    // tightest real check against that ceiling.
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
