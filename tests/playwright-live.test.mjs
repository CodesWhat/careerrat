// playwright-live.test.mjs — the ONE test in this suite that launches a REAL
// Chromium instance through playwright-ops.mjs's real default launchImpl
// (chromium.launchPersistentContext), instead of the launchImpl stub every
// other playwright-ops/playwright-executor test injects. Every other test
// asserts against a fake context/page/locator triple and a hand-rolled DOM
// stub for collectControls — none of them have ever proven the real
// collectControls/snapshot/fillField/... path works against an actual page.
//
// Gated behind CAREERRAT_LIVE_BROWSER=1 and SKIPPED otherwise. This is
// mandatory, not a style choice: the lefthook pre-push hook runs the full
// `node --test` suite on every push, and launching a real Chromium instance
// on every push would make every push slow and flaky (browser startup time,
// headless rendering/timing variance). A human or CI job opts in explicitly.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createApplyDriver } from "../src/core/apply/apply-driver.mjs";
import { createPlaywrightOps } from "../src/core/apply/playwright-ops.mjs";
import { startFixtureServer } from "./helpers/fixture-server.mjs";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/apply-form/", import.meta.url));
const RADIO_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/apply-radio-form/", import.meta.url));

const LIVE = process.env.CAREERRAT_LIVE_BROWSER === "1";

// snapshot().refs is keyed by synthetic "e1"/"e2"/... assigned in DOM/selector
// order, not by name — every real assertion below needs to resolve a ref from
// the control's accessible name instead, the same way apply-driver.mjs's real
// callers do it (matching against snapshot text/labels, never a hardcoded
// index).
function refByName(snapshot, name) {
  const entry = Object.entries(snapshot.refs).find(([, meta]) => meta.name === name);
  if (!entry) {
    throw new Error(
      `No control named ${JSON.stringify(name)} in snapshot. Refs: ${JSON.stringify(snapshot.refs, null, 2)}`
    );
  }
  return entry[0];
}

test("real Chromium end-to-end: openTab -> snapshot -> fill/select/toggle/upload -> click across 3 steps, stopping before Submit", {
  skip: !LIVE && "set CAREERRAT_LIVE_BROWSER=1 to run this against a real Chromium instance",
}, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "careerrat-live-profile-"));
  const resumeDir = mkdtempSync(join(tmpdir(), "careerrat-live-resume-"));
  const resumePath = join(resumeDir, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4\nfake resume content for the live harness test\n%%EOF\n");

  const { url: baseUrl, close: closeServer } = await startFixtureServer(FIXTURE_DIR);
  // No launchImpl override — this is the real default launch path
  // (chromium.launchPersistentContext) that every other test in the repo
  // stubs out.
  const ops = createPlaywrightOps({ profileDir, headless: true });

  try {
    // --- Step 1: Basics ---
    const { pageId } = await ops.openTab({ url: `${baseUrl}/step1.html` });

    let snapshot = await ops.snapshot({ pageId });
    assert.match(snapshot.pageText, /Step 1: Basics/, "landed on step 1");
    const fullNameRef = refByName(snapshot, "Full name");
    const emailRef = refByName(snapshot, "Email");
    const phoneRef = refByName(snapshot, "Phone");
    const workAuthRef = refByName(snapshot, "Work authorization");
    let nextRef = refByName(snapshot, "Next");
    assert.equal(snapshot.refs[fullNameRef].role, "textbox");
    assert.equal(snapshot.refs[workAuthRef].role, "combobox");
    assert.equal(snapshot.refs[nextRef].role, "button");
    assert.equal(snapshot.refs[nextRef].advanceSafe, true);

    await ops.fillField({ pageId, ref: fullNameRef, value: "Jordan Rivera" });
    await ops.fillField({ pageId, ref: emailRef, value: "jordan.rivera@example.test" });
    await ops.fillField({ pageId, ref: phoneRef, value: "555-0100" });
    await ops.selectOption({ pageId, ref: workAuthRef, value: "Yes, authorized to work" });

    await ops.clickButton({ pageId, ref: nextRef });

    // The real type=button handler explicitly advances to the next step.
    // Assert it actually happened (the new step's h1) AND that every field
    // genuinely changed in the DOM: the handler carries the live form values
    // in the query string, so it remains a real read-back of
    // exactly what was live in each control's value at submit time — not a
    // stubbed assumption about what fillField/selectOption did.
    snapshot = await ops.snapshot({ pageId });
    assert.match(snapshot.pageText, /Step 2: Documents/, "navigated to step 2");
    assert.match(snapshot.origin, /full_name=Jordan(\+|%20)Rivera/, "fillField changed full_name");
    assert.match(
      snapshot.origin,
      /email=jordan\.rivera%40example\.test/,
      "fillField changed email"
    );
    assert.match(snapshot.origin, /phone=555-0100/, "fillField changed phone");
    assert.match(
      snapshot.origin,
      /work_authorization=yes/,
      "selectOption changed work_authorization"
    );

    // --- Step 2: Documents ---
    const resumeRef = refByName(snapshot, "Resume/CV");
    const coverLetterRef = refByName(snapshot, "Cover letter");
    const agreeRef = refByName(snapshot, "I agree to the terms");
    nextRef = refByName(snapshot, "Next");
    assert.equal(snapshot.refs[nextRef].advanceSafe, true);

    await ops.toggleField({ pageId, ref: agreeRef, checked: true });
    await ops.upload({ pageId, ref: resumeRef, files: resumePath });
    await ops.fillField({
      pageId,
      ref: coverLetterRef,
      value: "I would love to join the team.",
    });

    // Confirm upload() attached the REAL temp file (not a stub) before
    // navigating away. A file input's chosen filename never shows up in a
    // plain GET query string, so the fixture mirrors it into a visible
    // span on "change" specifically so this is observable through
    // snapshot()'s body text — no reach into Playwright internals here.
    snapshot = await ops.snapshot({ pageId });
    assert.match(
      snapshot.pageText,
      /resume\.pdf/,
      "the real uploaded file's name is reflected in the DOM"
    );

    await ops.clickButton({ pageId, ref: nextRef });

    snapshot = await ops.snapshot({ pageId });
    assert.match(snapshot.pageText, /^Review$/m, "navigated to step 3");
    assert.match(snapshot.origin, /agree_terms=on/, "toggleField genuinely checked the box");
    assert.match(
      snapshot.origin,
      /cover_letter=I(\+|%20)would(\+|%20)love/,
      "fillField genuinely changed the textarea value"
    );

    // --- Step 3: Review — the manual Submit boundary ---
    // CareerRat's product guarantee is that submission is always a human
    // action. This harness proves the real ops contract CAN reach and
    // identify the submit control on a real page, then stops — it must
    // NEVER click "Submit application".
    const submitRef = refByName(snapshot, "Submit application");
    assert.equal(snapshot.refs[submitRef].role, "button");

    const shot = await ops.screenshot({ pageId });
    assert.equal(shot.format, "png");
    assert.ok(Buffer.from(shot.data, "base64").length > 0, "screenshot captured real bytes");
  } finally {
    await ops.close();
    await closeServer();
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(resumeDir, { recursive: true, force: true });
  }
});

test("real Chromium prepare-only driver advances structured steps and never clicks final Submit", {
  skip: !LIVE && "set CAREERRAT_LIVE_BROWSER=1 to run this against a real Chromium instance",
}, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "careerrat-live-driver-profile-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-live-driver-root-"));
  const resumePath = join(repoRoot, "workspace", "tailored", "resume.pdf");
  mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
  writeFileSync(resumePath, "%PDF-1.4\nfake resume content for the live driver test\n%%EOF\n");
  const { url: baseUrl, close: closeServer } = await startFixtureServer(FIXTURE_DIR);
  const ops = createPlaywrightOps({ profileDir, headless: true });
  const clicked = [];
  const driverOps = {
    ...ops,
    async clickButton(args) {
      const before = await ops.snapshot({ pageId: args.pageId });
      clicked.push(before.refs[args.ref]?.name || args.ref);
      return ops.clickButton(args);
    },
  };
  const execute = createApplyDriver({
    ops: driverOps,
    providerLabel: "playwright",
    repoRoot,
    candidateConfigGetImpl: () => ({
      profile: {
        candidate: {
          full_name: "Jordan Rivera",
          email: "jordan.rivera@example.test",
          phone: "555-0100",
        },
      },
      honesty: {},
      "form-defaults": { work_authorization: "Yes, authorized to work" },
    }),
    mayRunImpl: () => ({ allowed: true }),
    loadAnswerMapImpl: async () => new Map([["i agree to the terms", "Yes"]]),
  });

  try {
    const result = await execute({
      applicationId: "live-structured-wizard",
      application: {
        id: "live-structured-wizard",
        link: `${baseUrl}/step1.html`,
        artifacts: { resumePdf: "workspace/tailored/resume.pdf" },
      },
      postingUrl: `${baseUrl}/step1.html`,
      questionCapture: { state: "captured" },
      prepareOnly: true,
    });
    assert.equal(result.state, "awaiting-submit");
    assert.notEqual(result.state, "applied");
    assert.equal(result.verified, false);
    assert.equal(result.session.prepareOnly, true);
    assert.equal(result.session.stepIndex, 3);
    assert.equal(result.session.uploadedCount, 1);
    assert.deepEqual(clicked, ["Next", "Next"]);
    assert.match(result.currentUrl, /step3\.html/);
    assert.equal(clicked.includes("Submit application"), false);
  } finally {
    await ops.close();
    await closeServer();
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("real Chromium snapshots and selects a native required radio fieldset without touching Submit", {
  skip: !LIVE && "set CAREERRAT_LIVE_BROWSER=1 to run this against a real Chromium instance",
}, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "careerrat-live-radio-profile-"));
  const { url, close: closeServer } = await startFixtureServer(RADIO_FIXTURE_DIR);
  const ops = createPlaywrightOps({ profileDir, headless: true });

  try {
    const opened = [];
    const clicked = [];
    const driverOps = {
      ...ops,
      async openTab(args) {
        const openedTab = await ops.openTab(args);
        opened.push(openedTab.pageId);
        return openedTab;
      },
      async clickButton(args) {
        clicked.push(args.ref);
        return ops.clickButton(args);
      },
    };
    const execute = createApplyDriver({
      ops: driverOps,
      providerLabel: "playwright",
      repoRoot: "/repo",
      candidateConfigGetImpl: () => ({
        profile: {},
        honesty: {},
        "form-defaults": { requires_sponsorship: "No" },
      }),
      mayRunImpl: () => ({ allowed: true }),
      loadAnswerMapImpl: async () => new Map(),
    });

    const result = await execute({
      applicationId: "live-native-radio",
      application: { id: "live-native-radio", link: url },
      postingUrl: url,
      questionCapture: { state: "captured" },
    });
    const snapshot = await ops.snapshot({ pageId: opened[0] });
    const groupRef = refByName(snapshot, "Will you now or in the future require sponsorship?");
    const group = snapshot.refs[groupRef];

    assert.equal(result.state, "awaiting-submit");
    assert.notEqual(result.state, "applied");
    assert.equal(result.verified, false);
    assert.equal(result.session.filledCount, 1);
    assert.deepEqual(result.session.unresolved, []);
    assert.equal(group.role, "radio-group");
    assert.equal(group.required, true);
    assert.equal(group.stateKnown, true);
    assert.equal(group.value, "No");
    assert.deepEqual(
      group.options.map(({ label }) => label),
      ["Yes", "No"]
    );
    const noRef = group.options.find(({ label }) => label === "No").ref;
    const submitRef = refByName(snapshot, "Submit application");
    assert.deepEqual(clicked, [noRef]);
    assert.notEqual(noRef, submitRef);
    assert.equal(snapshot.origin, `${url}/`);
  } finally {
    await ops.close();
    await closeServer();
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("real Chromium groups unwrapped native radios by form owner and name without touching either Submit", {
  skip: !LIVE && "set CAREERRAT_LIVE_BROWSER=1 to run this against a real Chromium instance",
}, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "careerrat-live-radio-owner-profile-"));
  const { url, close: closeServer } = await startFixtureServer(RADIO_FIXTURE_DIR);
  const ops = createPlaywrightOps({ profileDir, headless: true });

  try {
    const opened = [];
    const clicked = [];
    const driverOps = {
      ...ops,
      async openTab(args) {
        const openedTab = await ops.openTab(args);
        opened.push(openedTab.pageId);
        return openedTab;
      },
      async clickButton(args) {
        clicked.push(args.ref);
        return ops.clickButton(args);
      },
    };
    const execute = createApplyDriver({
      ops: driverOps,
      providerLabel: "playwright",
      repoRoot: "/repo",
      candidateConfigGetImpl: () => ({
        profile: {},
        honesty: {},
        "form-defaults": {
          requires_sponsorship: "No",
          work_authorization: "Yes",
        },
      }),
      mayRunImpl: () => ({ allowed: true }),
      loadAnswerMapImpl: async () => new Map(),
    });

    const postingUrl = `${url}/unwrapped.html`;
    const result = await execute({
      applicationId: "live-native-radio-owner",
      application: { id: "live-native-radio-owner", link: postingUrl },
      postingUrl,
      questionCapture: { state: "captured" },
    });
    const snapshot = await ops.snapshot({ pageId: opened[0] });
    const sponsorshipRef = refByName(
      snapshot,
      "Will you now or in the future require sponsorship?"
    );
    const authorizationRef = refByName(snapshot, "Are you authorized to work?");
    const sponsorship = snapshot.refs[sponsorshipRef];
    const authorization = snapshot.refs[authorizationRef];
    const submitRefs = Object.entries(snapshot.refs)
      .filter(([, entry]) => /^Submit /.test(entry.name))
      .map(([ref]) => ref);

    assert.equal(result.state, "awaiting-submit");
    assert.notEqual(result.state, "applied");
    assert.equal(result.verified, false);
    assert.equal(result.session.filledCount, 2);
    assert.deepEqual(result.session.unresolved, []);
    assert.equal(sponsorship.value, "No");
    assert.equal(authorization.value, "Yes");
    assert.notEqual(sponsorshipRef, authorizationRef);
    assert.deepEqual(clicked, [
      sponsorship.options.find(({ label }) => label === "No").ref,
      authorization.options.find(({ label }) => label === "Yes").ref,
    ]);
    assert.equal(
      clicked.some((ref) => submitRefs.includes(ref)),
      false
    );
  } finally {
    await ops.close();
    await closeServer();
    rmSync(profileDir, { recursive: true, force: true });
  }
});
