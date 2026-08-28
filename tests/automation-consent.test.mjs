import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  automationModePatch,
  automationStatus,
  CAPABILITIES,
  defaultAutomation,
  mayRun,
  PLATFORMS,
  planAutomationEdit,
  planModeEdit,
  resolveEditPath,
} from "../src/core/automation/consent.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";

const root = join(new URL("..", import.meta.url).pathname);

// The repo root is the right `root` for the tests that read shipped templates and
// schemas out of the tree. It is the WRONG root for anything asserting on which
// session provider resolves, because loadAutomation() reads `candidate/automation.yml`
// under it, and on a machine where CareerRat has actually been set up that file is a
// real (gitignored) workspace pinning an explicit `session.provider`. An explicit
// provider short-circuits resolveSession()'s "auto" branch entirely, so the
// resolution logic under test never runs and the assertion reads the developer's
// config instead. That passed in CI and in fresh worktrees, where no candidate/
// exists, and failed only on a set-up machine. An empty directory has no candidate
// workspace, so these tests get the shipped defaults and exercise the real branch.
const emptyRoot = mkdtempSync(join(tmpdir(), "careerrat-automation-status-"));

function loadJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

const automationTextWithoutSetupMode = `version: 1
consent:
  linkedin: true
capabilities:
  authenticated_apply_preparation:
    enabled: true
    platforms:
      linkedin: true
session:
  provider: extension
  profile_root: null
`;

test("automation consent: mail_access supports Gmail, Outlook, and generic webmail", () => {
  assert.deepEqual(CAPABILITIES.mail_access.platforms, ["gmail", "outlook", "webmail"]);
  assert.equal(CAPABILITIES.mail_access.label, "Session webmail access");
  assert.ok(PLATFORMS.includes("gmail"));
  assert.ok(PLATFORMS.includes("outlook"));
  assert.ok(PLATFORMS.includes("webmail"));
});

test("automation consent: relationship_sourcing supports LinkedIn and Wellfound", () => {
  assert.deepEqual(CAPABILITIES.relationship_sourcing.platforms, ["linkedin", "wellfound"]);
  assert.equal(CAPABILITIES.relationship_sourcing.label, "Relationship sourcing");
  assert.ok(PLATFORMS.includes("linkedin"));
  assert.ok(PLATFORMS.includes("wellfound"));
});

test("job-source login is not part of the global automation permission matrix", () => {
  const template = parseYaml(readFileSync(join(root, "templates/automation.example.yml"), "utf8"));
  const schema = loadJson("config/automation.schema.json");

  assert.equal(Object.hasOwn(CAPABILITIES, "authenticated_search"), false);
  assert.equal(Object.hasOwn(defaultAutomation().capabilities, "authenticated_search"), false);
  assert.equal(Object.hasOwn(template.capabilities, "authenticated_search"), false);
  assert.equal(
    Object.hasOwn(schema.properties.capabilities.properties, "authenticated_search"),
    false
  );
});

test("automation consent: supervised apply preparation replaces the removed one-click capability", () => {
  assert.deepEqual(CAPABILITIES.authenticated_apply_preparation.platforms, [
    "greenhouse",
    "lever",
    "ashby",
    "workable",
    "smartrecruiters",
    "linkedin",
    "external_ats",
  ]);
  assert.equal(
    CAPABILITIES.authenticated_apply_preparation.label,
    "Authenticated apply preparation"
  );
  assert.equal(Object.hasOwn(CAPABILITIES, "one_click_apply"), false);

  const cfg = defaultAutomation();
  cfg.setup_mode = "advanced";
  cfg.capabilities.authenticated_apply_preparation.enabled = true;
  cfg.capabilities.authenticated_apply_preparation.platforms.linkedin = true;
  cfg.consent.linkedin = true;
  assert.equal(
    mayRun({
      capability: "authenticated_apply_preparation",
      platform: "linkedin",
      data: cfg,
    }).allowed,
    true
  );
  cfg.capabilities.authenticated_apply_preparation.platforms.greenhouse = true;
  cfg.consent.greenhouse = true;
  assert.equal(
    mayRun({
      capability: "authenticated_apply_preparation",
      platform: "greenhouse",
      data: cfg,
    }).allowed,
    true
  );
  const removed = mayRun({ capability: "one_click_apply", platform: "linkedin", data: cfg });
  assert.equal(removed.allowed, false);
  assert.match(removed.reasons.join(" "), /unknown capability/i);
});

test("automation schema rejects the removed one-click capability id", () => {
  const schema = loadJson("config/automation.schema.json");
  const result = validate(
    {
      capabilities: {
        one_click_apply: { enabled: false, platforms: { linkedin: false } },
      },
    },
    schema
  );
  assert.equal(result.valid, false);
  assert.match(JSON.stringify(result.errors), /one_click_apply.*unexpected property/i);
});

test("automation consent: calendar_sync supports calendar providers and automation tools", () => {
  assert.deepEqual(CAPABILITIES.calendar_sync.platforms, [
    "apple_calendar",
    "google_calendar",
    "outlook_calendar",
    "automation_tools",
  ]);
  assert.equal(CAPABILITIES.calendar_sync.label, "Calendar provider sync");
  assert.ok(PLATFORMS.includes("apple_calendar"));
  assert.ok(PLATFORMS.includes("google_calendar"));
  assert.ok(PLATFORMS.includes("outlook_calendar"));
  assert.ok(PLATFORMS.includes("automation_tools"));
});

test("automation consent: mail_access defaults fully off", () => {
  const cfg = defaultAutomation();
  assert.equal(cfg.setup_mode, "basic");
  assert.equal(cfg.session.provider, "auto");
  assert.equal(cfg.consent.gmail, false);
  assert.equal(cfg.consent.outlook, false);
  assert.equal(cfg.consent.webmail, false);
  assert.equal(cfg.capabilities.mail_access.enabled, false);
  assert.deepEqual(cfg.capabilities.mail_access.platforms, {
    gmail: false,
    outlook: false,
    webmail: false,
  });
});

test("automation consent: relationship_sourcing defaults fully off and uses the same predicate", () => {
  const cfg = defaultAutomation();
  assert.equal(cfg.capabilities.relationship_sourcing.enabled, false);
  assert.deepEqual(cfg.capabilities.relationship_sourcing.platforms, {
    linkedin: false,
    wellfound: false,
  });

  let verdict = mayRun({ capability: "relationship_sourcing", platform: "linkedin", data: cfg });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.checks, { global: false, platform: false, consent: false });

  cfg.capabilities.relationship_sourcing.enabled = true;
  cfg.capabilities.relationship_sourcing.platforms.linkedin = true;
  cfg.consent.linkedin = true;
  cfg.setup_mode = "advanced";

  verdict = mayRun({ capability: "relationship_sourcing", platform: "linkedin", data: cfg });
  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.reasons, []);
});

test("automation consent: calendar_sync defaults fully off and uses the same predicate", () => {
  const cfg = defaultAutomation();
  assert.equal(cfg.capabilities.calendar_sync.enabled, false);
  assert.deepEqual(cfg.capabilities.calendar_sync.platforms, {
    apple_calendar: false,
    google_calendar: false,
    outlook_calendar: false,
    automation_tools: false,
  });

  let verdict = mayRun({ capability: "calendar_sync", platform: "google_calendar", data: cfg });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.checks, { global: false, platform: false, consent: false });

  cfg.capabilities.calendar_sync.enabled = true;
  cfg.capabilities.calendar_sync.platforms.google_calendar = true;
  cfg.consent.google_calendar = true;
  cfg.setup_mode = "advanced";

  verdict = mayRun({ capability: "calendar_sync", platform: "google_calendar", data: cfg });
  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.reasons, []);
});

test("automation consent: mail_access uses the same three-switch predicate", () => {
  const cfg = defaultAutomation();

  let verdict = mayRun({ capability: "mail_access", platform: "gmail", data: cfg });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.checks, { global: false, platform: false, consent: false });

  cfg.capabilities.mail_access.enabled = true;
  cfg.capabilities.mail_access.platforms.gmail = true;
  cfg.consent.gmail = true;
  cfg.setup_mode = "advanced";

  verdict = mayRun({ capability: "mail_access", platform: "gmail", data: cfg });
  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.reasons, []);
});

test("Basic mode is a hard off switch and its patch revokes every capability, platform, and consent", () => {
  const configured = defaultAutomation();
  configured.setup_mode = "advanced";
  configured.capabilities.messaging.enabled = true;
  configured.capabilities.messaging.platforms.linkedin = true;
  configured.consent.linkedin = true;
  assert.equal(
    mayRun({ capability: "messaging", platform: "linkedin", data: configured }).allowed,
    true
  );

  const patch = automationModePatch("basic");
  assert.equal(patch.setup_mode, "basic");
  assert.equal(patch.capabilities.messaging.enabled, false);
  assert.equal(patch.capabilities.messaging.platforms.linkedin, false);
  assert.equal(patch.consent.linkedin, false);
  assert.equal(
    mayRun({ capability: "messaging", platform: "linkedin", data: patch }).allowed,
    false
  );
  assert.deepEqual(automationModePatch("advanced"), { setup_mode: "advanced" });
});

test("Basic mode blocks a malformed stale live matrix even before it is cleared", () => {
  const cfg = defaultAutomation();
  cfg.capabilities.authenticated_apply_preparation.enabled = true;
  cfg.capabilities.authenticated_apply_preparation.platforms.linkedin = true;
  cfg.consent.linkedin = true;
  const verdict = mayRun({
    capability: "authenticated_apply_preparation",
    platform: "linkedin",
    data: cfg,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons.join(" "), /Basic mode/);
});

test("automation consent: status output includes mail_access platforms", () => {
  const status = automationStatus();
  const cap = status.capabilities.find((c) => c.capability === "mail_access");
  assert.ok(cap, "mail_access should appear in automation status");
  assert.deepEqual(
    cap.platforms.map((p) => p.platform),
    ["gmail", "outlook", "webmail"]
  );
});

test("automation consent: status exposes automatic browser setup and the effective provider", () => {
  const status = automationStatus({ root });
  assert.ok(status.session);
  assert.ok(Array.isArray(status.session.options));
  assert.equal(status.session.options[0].id, "auto");
  assert.equal(typeof status.session.effectiveProvider, "string");
  assert.ok(status.session.presence?.status);
});

test("automation consent: status reports Playwright package and Chromium readiness independently of provider selection", () => {
  const status = automationStatus({
    root: emptyRoot,
    env: {},
    playwrightToolingDependencies: {
      resolvePackage: () => "/modules/playwright/index.js",
      loadPackage: () => ({
        chromium: { executablePath: () => "/browsers/chromium/chrome" },
      }),
      pathExists: (path) => path === "/browsers/chromium/chrome",
    },
  });

  assert.equal(status.session.provider, "auto");
  assert.equal(status.session.effectiveProvider, "extension");
  assert.equal(status.session.options.find((option) => option.id === "auto").automatedApply, false);
  assert.deepEqual(status.session.tooling.playwright, {
    packageInstalled: true,
    browserInstalled: true,
    ready: true,
    detail: "Playwright and Chromium are installed.",
  });
});

test("automation consent: status distinguishes a missing Playwright package from a missing Chromium executable", () => {
  const missingPackage = automationStatus({
    root: emptyRoot,
    playwrightToolingDependencies: {
      resolvePackage: () => {
        throw new Error("MODULE_NOT_FOUND");
      },
      loadPackage: () => {
        throw new Error("must not load an unresolved package");
      },
      pathExists: () => true,
    },
  });
  assert.deepEqual(missingPackage.session.tooling.playwright, {
    packageInstalled: false,
    browserInstalled: false,
    ready: false,
    detail: "Playwright is not installed.",
  });

  const missingBrowser = automationStatus({
    root: emptyRoot,
    playwrightToolingDependencies: {
      resolvePackage: () => "/modules/playwright/index.js",
      loadPackage: () => ({
        chromium: { executablePath: () => "/browsers/chromium/chrome" },
      }),
      pathExists: () => false,
    },
  });
  assert.deepEqual(missingBrowser.session.tooling.playwright, {
    packageInstalled: true,
    browserInstalled: false,
    ready: false,
    detail: "Playwright is installed, but its Chromium executable is missing.",
  });
});

test("automation consent: Playwright tooling probe never throws when package inspection fails", () => {
  const status = automationStatus({
    root: emptyRoot,
    playwrightToolingDependencies: {
      resolvePackage: () => "/modules/playwright/index.js",
      loadPackage: () => {
        throw new Error("broken package entrypoint");
      },
      pathExists: () => {
        throw new Error("must not inspect an unavailable executable");
      },
    },
  });

  assert.deepEqual(status.session.tooling.playwright, {
    packageInstalled: true,
    browserInstalled: false,
    ready: false,
    detail: "Playwright is installed, but Chromium readiness could not be verified.",
  });
});

// Regression for the "auto" option lying about automatic-apply support outside an
// Orca workspace: it used to read the optimistic literal on the raw `auto`
// descriptor (always true) instead of what resolveSession() actually resolves
// "auto" to. Outside Orca that's the extension provider, which genuinely can't
// drive apply-job's scripted apply path — so the UI (and the JSON `careerrat
// automation status --json` exposes) must say automatedApply:false there, not
// true. This is the path that was wrong; a test that only covered the Orca case
// would have kept passing under the bug.
test("automation consent: status auto option reports automatedApply:false outside an Orca workspace (resolved to extension, not the optimistic descriptor)", () => {
  const status = automationStatus({ root: emptyRoot, env: {} });
  const autoOption = status.session.options.find((o) => o.id === "auto");
  assert.equal(status.session.provider, "auto", "the default config must leave provider on auto");
  assert.equal(status.session.effectiveProvider, "extension");
  assert.equal(autoOption.automatedApply, false);
});

test("automation consent: status auto option reports automatedApply:true inside an Orca workspace", () => {
  const status = automationStatus({ root: emptyRoot, env: { ORCA_WORKTREE_ID: "worktree-123" } });
  const autoOption = status.session.options.find((o) => o.id === "auto");
  assert.equal(status.session.provider, "auto", "the default config must leave provider on auto");
  assert.equal(status.session.effectiveProvider, "orca");
  assert.equal(autoOption.automatedApply, true);
});

test("automation consent: status options list concrete providers with their fixed automatedApply, unaffected by env", () => {
  const status = automationStatus({ root: emptyRoot, env: {} });
  const byId = Object.fromEntries(status.session.options.map((o) => [o.id, o.automatedApply]));
  assert.equal(byId.extension, false);
  assert.equal(byId.orca, true);
  assert.equal(byId.playwright, true);
});

test("automation consent: status output includes relationship_sourcing platforms", () => {
  const status = automationStatus();
  const cap = status.capabilities.find((c) => c.capability === "relationship_sourcing");
  assert.ok(cap, "relationship_sourcing should appear in automation status");
  assert.deepEqual(
    cap.platforms.map((p) => p.platform),
    ["linkedin", "wellfound"]
  );
});

test("automation consent: status output includes calendar_sync platforms", () => {
  const status = automationStatus();
  const cap = status.capabilities.find((c) => c.capability === "calendar_sync");
  assert.ok(cap, "calendar_sync should appear in automation status");
  assert.deepEqual(
    cap.platforms.map((p) => p.platform),
    ["apple_calendar", "google_calendar", "outlook_calendar", "automation_tools"]
  );
});

test("automation consent: CLI edit paths support mail_access and webmail consent", () => {
  const platformEdit = resolveEditPath({
    kind: "platform",
    capability: "mail_access",
    platform: "gmail",
  });
  assert.deepEqual(platformEdit.parts, ["capabilities", "mail_access", "platforms", "gmail"]);

  const consentEdit = resolveEditPath({ kind: "consent", platform: "outlook" });
  assert.deepEqual(consentEdit.parts, ["consent", "outlook"]);

  const webmailEdit = resolveEditPath({
    kind: "platform",
    capability: "mail_access",
    platform: "webmail",
  });
  assert.deepEqual(webmailEdit.parts, ["capabilities", "mail_access", "platforms", "webmail"]);
});

test("automation consent: CLI edit paths support calendar_sync and provider consent", () => {
  const platformEdit = resolveEditPath({
    kind: "platform",
    capability: "calendar_sync",
    platform: "apple_calendar",
  });
  assert.deepEqual(platformEdit.parts, [
    "capabilities",
    "calendar_sync",
    "platforms",
    "apple_calendar",
  ]);

  const consentEdit = resolveEditPath({ kind: "consent", platform: "automation_tools" });
  assert.deepEqual(consentEdit.parts, ["consent", "automation_tools"]);
});

test("automation template: mail_access ships OFF and validates against schema", () => {
  const template = parseYaml(readFileSync(join(root, "templates/automation.example.yml"), "utf8"));
  assert.equal(template.consent.gmail, false);
  assert.equal(template.consent.outlook, false);
  assert.equal(template.consent.webmail, false);
  assert.equal(template.capabilities.mail_access.enabled, false);
  assert.deepEqual(template.capabilities.mail_access.platforms, {
    gmail: false,
    outlook: false,
    webmail: false,
  });

  const result = validate(template, loadJson("config/automation.schema.json"));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("automation template: relationship_sourcing ships OFF and validates against schema", () => {
  const template = parseYaml(readFileSync(join(root, "templates/automation.example.yml"), "utf8"));
  assert.equal(template.capabilities.relationship_sourcing.enabled, false);
  assert.deepEqual(template.capabilities.relationship_sourcing.platforms, {
    linkedin: false,
    wellfound: false,
  });

  const result = validate(template, loadJson("config/automation.schema.json"));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("automation template: calendar_sync ships OFF and validates against schema", () => {
  const template = parseYaml(readFileSync(join(root, "templates/automation.example.yml"), "utf8"));
  assert.equal(template.consent.apple_calendar, false);
  assert.equal(template.consent.google_calendar, false);
  assert.equal(template.consent.outlook_calendar, false);
  assert.equal(template.consent.automation_tools, false);
  assert.equal(template.capabilities.calendar_sync.enabled, false);
  assert.deepEqual(template.capabilities.calendar_sync.platforms, {
    apple_calendar: false,
    google_calendar: false,
    outlook_calendar: false,
    automation_tools: false,
  });

  const result = validate(template, loadJson("config/automation.schema.json"));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("automation writer: can add mail_access paths to legacy automation files", () => {
  const schema = loadJson("config/automation.schema.json");

  const platformPlan = planAutomationEdit({
    kind: "platform",
    capability: "mail_access",
    platform: "gmail",
    value: true,
    currentText: automationTextWithoutSetupMode,
    schema,
  });
  assert.equal(platformPlan.ok, true);
  assert.equal(platformPlan.valid, true, JSON.stringify(platformPlan.errors));
  assert.ok(platformPlan.nextText.includes("mail_access:"));
  assert.ok(platformPlan.nextText.includes("gmail: true"));
  assert.ok(platformPlan.nextText.includes("outlook: false"));
  assert.ok(platformPlan.nextText.includes("webmail: false"));

  const consentPlan = planAutomationEdit({
    kind: "consent",
    platform: "gmail",
    value: true,
    currentText: automationTextWithoutSetupMode,
    schema,
  });
  assert.equal(consentPlan.ok, true);
  assert.equal(consentPlan.valid, true, JSON.stringify(consentPlan.errors));
  assert.ok(consentPlan.nextText.includes("gmail: true"));
});

test("automation writer: can add relationship_sourcing paths to legacy automation files", () => {
  const schema = loadJson("config/automation.schema.json");

  const platformPlan = planAutomationEdit({
    kind: "platform",
    capability: "relationship_sourcing",
    platform: "linkedin",
    value: true,
    currentText: automationTextWithoutSetupMode,
    schema,
  });
  assert.equal(platformPlan.ok, true);
  assert.equal(platformPlan.valid, true, JSON.stringify(platformPlan.errors));
  assert.ok(platformPlan.nextText.includes("relationship_sourcing:"));
  assert.ok(platformPlan.nextText.includes("linkedin: true"));
  assert.ok(platformPlan.nextText.includes("wellfound: false"));
});

test("automation writer: can add calendar_sync paths to legacy automation files", () => {
  const schema = loadJson("config/automation.schema.json");

  const platformPlan = planAutomationEdit({
    kind: "platform",
    capability: "calendar_sync",
    platform: "google_calendar",
    value: true,
    currentText: automationTextWithoutSetupMode,
    schema,
  });
  assert.equal(platformPlan.ok, true);
  assert.equal(platformPlan.valid, true, JSON.stringify(platformPlan.errors));
  assert.ok(platformPlan.nextText.includes("calendar_sync:"));
  assert.ok(platformPlan.nextText.includes("apple_calendar: false"));
  assert.ok(platformPlan.nextText.includes("google_calendar: true"));
  assert.ok(platformPlan.nextText.includes("outlook_calendar: false"));
  assert.ok(platformPlan.nextText.includes("automation_tools: false"));

  const consentPlan = planAutomationEdit({
    kind: "consent",
    platform: "google_calendar",
    value: true,
    currentText: automationTextWithoutSetupMode,
    schema,
  });
  assert.equal(consentPlan.ok, true);
  assert.equal(consentPlan.valid, true, JSON.stringify(consentPlan.errors));
  assert.ok(consentPlan.nextText.includes("google_calendar: true"));
});

// ── planModeEdit / the setup_mode CLI gap ───────────────────────────────────
//
// mayRun() is a hard AND of setup_mode==="advanced" plus the three granular
// switches (global, platform, consent). Before this fix, the CLI
// (src/cli/automation.mjs) had `consent`/`enable`/`disable`/`revoke` verbs but
// no verb that could ever move setup_mode off its "basic" default, so the
// AGENTS.md-documented recipe (consent, enable, enable) could never reach
// allowed:true. planModeEdit is the pure edit-computation behind the new
// `mode <basic|advanced>` CLI verb.

test("resolveEditPath supports kind:mode", () => {
  assert.deepEqual(resolveEditPath({ kind: "mode" }), {
    parts: ["setup_mode"],
    label: "automation setup mode",
  });
});

test("planModeEdit rejects a value that isn't basic or advanced", () => {
  const plan = planModeEdit({ mode: "yolo", currentText: automationTextWithoutSetupMode });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /basic.*advanced|advanced.*basic/);
});

test("planModeEdit scaffolds setup_mode on a legacy file that predates the field", () => {
  // This input has no `setup_mode:` key at all — an install from
  // before this field existed. The edit must still succeed.
  assert.doesNotMatch(automationTextWithoutSetupMode, /setup_mode/);
  const schema = loadJson("config/automation.schema.json");
  const plan = planModeEdit({
    mode: "advanced",
    currentText: automationTextWithoutSetupMode,
    schema,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.valid, true, JSON.stringify(plan.errors));
  assert.equal(plan.changed, true);
  assert.match(plan.nextText, /^setup_mode: advanced$/m);

  const parsed = parseYaml(plan.nextText);
  assert.equal(parsed.setup_mode, "advanced");
  // Nothing else in the file moved.
  assert.equal(parsed.consent.linkedin, true);
});

test("planModeEdit is idempotent once already at the target mode", () => {
  const schema = loadJson("config/automation.schema.json");
  const first = planModeEdit({
    mode: "advanced",
    currentText: automationTextWithoutSetupMode,
    schema,
  });
  const second = planModeEdit({ mode: "advanced", currentText: first.nextText, schema });
  assert.equal(second.changed, false);
  assert.equal(second.nextText, first.nextText);
});

test("planModeEdit can move an advanced file back to basic", () => {
  const schema = loadJson("config/automation.schema.json");
  const advanced = planModeEdit({
    mode: "advanced",
    currentText: automationTextWithoutSetupMode,
    schema,
  });
  const backToBasic = planModeEdit({ mode: "basic", currentText: advanced.nextText, schema });
  assert.equal(backToBasic.ok, true);
  assert.equal(backToBasic.changed, true);
  assert.equal(parseYaml(backToBasic.nextText).setup_mode, "basic");
});

test("the AGENTS.md-documented CLI recipe (mode, consent, enable, enable) ends in mayRun() allowed:true", () => {
  const schema = loadJson("config/automation.schema.json");
  const template = readFileSync(join(root, "templates/automation.example.yml"), "utf8");

  // Before this fix, running consent + enable + enable alone (skipping a
  // setup_mode step no CLI verb could perform) left the capability
  // permanently unreachable. Confirm that failure mode still holds without
  // the new `mode` step, so the fix is demonstrably necessary...
  let text = template;
  let step = planAutomationEdit({
    kind: "consent",
    platform: "linkedin",
    value: true,
    currentText: text,
    schema,
  });
  assert.equal(step.ok, true);
  text = step.nextText;
  step = planAutomationEdit({
    kind: "capability",
    capability: "messaging",
    value: true,
    currentText: text,
    schema,
  });
  text = step.nextText;
  step = planAutomationEdit({
    kind: "platform",
    capability: "messaging",
    platform: "linkedin",
    value: true,
    currentText: text,
    schema,
  });
  text = step.nextText;
  const withoutMode = mayRun({
    capability: "messaging",
    platform: "linkedin",
    data: parseYaml(text),
  });
  assert.equal(withoutMode.allowed, false);
  assert.match(withoutMode.reasons.join(" "), /Basic mode/);

  // ...then confirm prepending the new `mode advanced --write` step (now
  // possible thanks to planModeEdit) is sufficient to reach allowed:true,
  // with no other change to the recipe.
  const modePlan = planModeEdit({ mode: "advanced", currentText: template, schema });
  assert.equal(modePlan.ok, true);
  let fullText = modePlan.nextText;
  step = planAutomationEdit({
    kind: "consent",
    platform: "linkedin",
    value: true,
    currentText: fullText,
    schema,
  });
  fullText = step.nextText;
  step = planAutomationEdit({
    kind: "capability",
    capability: "messaging",
    value: true,
    currentText: fullText,
    schema,
  });
  fullText = step.nextText;
  step = planAutomationEdit({
    kind: "platform",
    capability: "messaging",
    platform: "linkedin",
    value: true,
    currentText: fullText,
    schema,
  });
  fullText = step.nextText;

  const parsed = parseYaml(fullText);
  const validation = validate(parsed, schema);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  const verdict = mayRun({ capability: "messaging", platform: "linkedin", data: parsed });
  assert.equal(verdict.allowed, true, JSON.stringify(verdict.reasons));
});
