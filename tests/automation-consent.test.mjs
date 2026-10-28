import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  automationModePatch,
  automationStatus,
  CAPABILITIES,
  defaultAutomation,
  loadAutomation,
  mayRun,
  migrateLegacyAutomationText,
  normalizeAutomationConfig,
  PLATFORMS,
  planAutomationEdit,
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

// A file written before capabilities defaulted to on: no marker, retired
// consent/setup_mode keys, and capability values that were the old off default.
const legacyAutomationText = `version: 1
setup_mode: basic
consent:
  linkedin: false
capabilities:
  authenticated_apply_preparation:
    enabled: false
    platforms:
      linkedin: false
session:
  provider: extension
  profile_root: null
`;

const allOnCapabilities = (cfg) =>
  Object.entries(CAPABILITIES).every(
    ([cap, def]) =>
      cfg.capabilities[cap].enabled === true &&
      def.platforms.every((p) => cfg.capabilities[cap].platforms[p] === true)
  );

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
  const router = readFileSync(join(root, "AGENTS.md"), "utf8");

  assert.equal(Object.hasOwn(CAPABILITIES, "authenticated_search"), false);
  assert.equal(Object.hasOwn(defaultAutomation().capabilities, "authenticated_search"), false);
  assert.equal(Object.hasOwn(template.capabilities, "authenticated_search"), false);
  assert.equal(
    Object.hasOwn(schema.properties.capabilities.properties, "authenticated_search"),
    false
  );
  assert.doesNotMatch(router, /authenticated[_ ]search/i);
  assert.match(router, /Do you\s+want to log into <site> so I can use it\?/);
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
  assert.equal(
    mayRun({
      capability: "authenticated_apply_preparation",
      platform: "linkedin",
      data: cfg,
    }).allowed,
    true
  );
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

test("automation consent: the default is every capability and platform on", () => {
  const cfg = defaultAutomation();
  assert.equal(cfg.capabilities_default, "on");
  assert.equal(cfg.session.provider, "auto");
  assert.equal(Object.hasOwn(cfg, "setup_mode"), false);
  assert.equal(Object.hasOwn(cfg, "consent"), false);
  assert.equal(Object.hasOwn(cfg, "submit"), false);
  assert.ok(allOnCapabilities(cfg));
  for (const [cap, def] of Object.entries(CAPABILITIES)) {
    for (const platform of def.platforms) {
      const verdict = mayRun({ capability: cap, platform, data: cfg });
      assert.equal(verdict.allowed, true, `${cap} on ${platform}`);
      assert.deepEqual(verdict.reasons, []);
      assert.deepEqual(verdict.checks, { global: true, platform: true });
    }
  }
});

test("mayRun: an empty or partial doc means on, since missing keys mean on", () => {
  assert.equal(mayRun({ capability: "mail_access", platform: "gmail", data: {} }).allowed, true);
  assert.equal(
    mayRun({
      capability: "mail_access",
      platform: "gmail",
      data: { capabilities: { mail_access: { platforms: { outlook: false } } } },
    }).allowed,
    true
  );
});

test("mayRun: consent, setup_mode and scoped_grants are ignored", () => {
  const cfg = defaultAutomation();
  cfg.setup_mode = "basic";
  cfg.consent = { linkedin: false };
  cfg.capabilities.messaging.scoped_grants = { linkedin: false };
  assert.equal(mayRun({ capability: "messaging", platform: "linkedin", data: cfg }).allowed, true);
});

test("mayRun: a global switch set to false denies and names the enable command", () => {
  const cfg = defaultAutomation();
  cfg.capabilities.mail_access.enabled = false;
  const verdict = mayRun({ capability: "mail_access", platform: "gmail", data: cfg });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.checks, { global: false, platform: true });
  assert.match(verdict.reasons.join(" "), /careerrat automation enable mail_access --write/);
  // Other capabilities stay on.
  assert.equal(
    mayRun({ capability: "calendar_sync", platform: "google_calendar", data: cfg }).allowed,
    true
  );
});

test("mayRun: a platform switch set to false denies only that platform and names the command", () => {
  const cfg = defaultAutomation();
  cfg.capabilities.relationship_sourcing.platforms.linkedin = false;
  const verdict = mayRun({ capability: "relationship_sourcing", platform: "linkedin", data: cfg });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.checks, { global: true, platform: false });
  assert.match(
    verdict.reasons.join(" "),
    /careerrat automation enable relationship_sourcing linkedin --write/
  );
  assert.equal(
    mayRun({ capability: "relationship_sourcing", platform: "wellfound", data: cfg }).allowed,
    true
  );
});

test("mayRun: platform applicability and unknown capabilities still deny", () => {
  const cfg = defaultAutomation();
  const wrongPlatform = mayRun({ capability: "mail_access", platform: "linkedin", data: cfg });
  assert.equal(wrongPlatform.allowed, false);
  assert.match(wrongPlatform.reasons.join(" "), /does not apply to platform "linkedin"/);
  const unknown = mayRun({ capability: "nope", platform: "linkedin", data: cfg });
  assert.equal(unknown.allowed, false);
  assert.match(unknown.reasons.join(" "), /unknown capability/);
});

test("automationModePatch is a no-op now that setup modes are retired", () => {
  assert.deepEqual(automationModePatch("basic"), {});
  assert.deepEqual(automationModePatch("advanced"), {});
});

test("normalizeAutomationConfig: a legacy all-off doc with no marker reads as every capability on", () => {
  const legacy = {
    version: 1,
    setup_mode: "basic",
    consent: { linkedin: false },
    capabilities: {
      messaging: { enabled: false, platforms: { linkedin: false, wellfound: false } },
    },
    submit: "manual",
    session: { provider: "playwright", profile_root: "/tmp/profiles" },
  };
  const snapshot = structuredClone(legacy);
  const out = normalizeAutomationConfig(legacy);
  assert.ok(allOnCapabilities(out));
  assert.equal(out.capabilities_default, "on");
  assert.equal(out.submit, "manual");
  assert.deepEqual(out.session, { provider: "playwright", profile_root: "/tmp/profiles" });
  assert.equal(Object.hasOwn(out, "setup_mode"), false);
  assert.equal(Object.hasOwn(out, "consent"), false);
  assert.deepEqual(legacy, snapshot, "normalizing must not mutate its input");
  assert.equal(mayRun({ capability: "messaging", platform: "linkedin", data: out }).allowed, true);
});

test("normalizeAutomationConfig: with the marker, explicit false values are respected", () => {
  const out = normalizeAutomationConfig({
    capabilities_default: "on",
    capabilities: { messaging: { enabled: false, platforms: { linkedin: false } } },
  });
  assert.equal(out.capabilities.messaging.enabled, false);
  assert.equal(out.capabilities.messaging.platforms.linkedin, false);
  assert.equal(out.capabilities.messaging.platforms.wellfound, true);
  assert.equal(out.capabilities.mail_access.enabled, true);
  assert.equal(mayRun({ capability: "messaging", platform: "linkedin", data: out }).allowed, false);
});

test("normalizeAutomationConfig: null, empty and non-object docs read as the default", () => {
  for (const input of [null, undefined, {}, "x", []]) {
    assert.deepEqual(normalizeAutomationConfig(input), defaultAutomation());
  }
});

test("migrateLegacyAutomationText: marker-less text restarts from the template and keeps submit and session", () => {
  const template = readFileSync(join(root, "templates/automation.example.yml"), "utf8");
  const text = `${legacyAutomationText}submit: manual\n`;
  const migrated = migrateLegacyAutomationText(text, template);
  const parsed = parseYaml(migrated);
  assert.equal(parsed.capabilities_default, "on");
  assert.equal(parsed.submit, "manual");
  assert.equal(parsed.session.provider, "extension");
  assert.equal(parsed.session.profile_root, null);
  assert.ok(allOnCapabilities(parsed));
  assert.equal(Object.hasOwn(parsed, "setup_mode"), false);
  assert.equal(Object.hasOwn(parsed, "consent"), false);
});

test("migrateLegacyAutomationText: marked text is returned untouched", () => {
  const template = readFileSync(join(root, "templates/automation.example.yml"), "utf8");
  const marked = "capabilities_default: on\ncapabilities:\n  messaging:\n    enabled: false\n";
  assert.equal(migrateLegacyAutomationText(marked, template), marked);
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
  assert.equal(status.session.effectiveProvider, "playwright");
  assert.equal(status.session.options.find((option) => option.id === "auto").automatedApply, true);
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

test("automation consent: auto uses the app-owned Playwright browser outside Orca", () => {
  const status = automationStatus({ root: emptyRoot, env: {} });
  const autoOption = status.session.options.find((o) => o.id === "auto");
  assert.equal(status.session.provider, "auto", "the default config must leave provider on auto");
  assert.equal(status.session.effectiveProvider, "playwright");
  assert.equal(autoOption.automatedApply, true);
});

test("automation consent: status auto option reports automatedApply:false inside an Orca workspace", () => {
  const status = automationStatus({ root: emptyRoot, env: { ORCA_WORKTREE_ID: "worktree-123" } });
  const autoOption = status.session.options.find((o) => o.id === "auto");
  assert.equal(status.session.provider, "auto", "the default config must leave provider on auto");
  assert.equal(status.session.effectiveProvider, "orca");
  assert.equal(autoOption.automatedApply, false);
});

test("automation consent: status options list concrete providers with their fixed automatedApply, unaffected by env", () => {
  const status = automationStatus({ root: emptyRoot, env: {} });
  const byId = Object.fromEntries(status.session.options.map((o) => [o.id, o.automatedApply]));
  assert.equal(byId.extension, false);
  assert.equal(byId.orca, false);
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

test("automation consent: CLI edit paths support mail_access and webmail", () => {
  const platformEdit = resolveEditPath({
    kind: "platform",
    capability: "mail_access",
    platform: "gmail",
  });
  assert.deepEqual(platformEdit.parts, ["capabilities", "mail_access", "platforms", "gmail"]);

  const webmailEdit = resolveEditPath({
    kind: "platform",
    capability: "mail_access",
    platform: "webmail",
  });
  assert.deepEqual(webmailEdit.parts, ["capabilities", "mail_access", "platforms", "webmail"]);
});

test("automation consent: CLI edit paths support calendar_sync", () => {
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

  assert.throws(() => resolveEditPath({ kind: "consent", platform: "automation_tools" }));
  assert.throws(() => resolveEditPath({ kind: "mode" }));
});

test("automation template: ships on, carries the marker, and validates against schema", () => {
  const template = parseYaml(readFileSync(join(root, "templates/automation.example.yml"), "utf8"));
  assert.equal(template.capabilities_default, "on");
  assert.equal(Object.hasOwn(template, "consent"), false);
  assert.equal(Object.hasOwn(template, "setup_mode"), false);
  assert.ok(allOnCapabilities(template));
  for (const cap of Object.keys(CAPABILITIES)) {
    assert.deepEqual(
      Object.keys(template.capabilities[cap].platforms).sort(),
      [...CAPABILITIES[cap].platforms].sort(),
      `${cap} platforms`
    );
  }
  const result = validate(template, loadJson("config/automation.schema.json"));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("automation schema still accepts the deprecated consent and setup_mode keys", () => {
  const result = validate(
    { setup_mode: "basic", consent: { linkedin: false }, capabilities_default: "on" },
    loadJson("config/automation.schema.json")
  );
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const bad = validate({ capabilities_default: "off" }, loadJson("config/automation.schema.json"));
  assert.equal(bad.valid, false);
});

test("automation writer: scaffolds missing capability blocks as on, then applies the edit", () => {
  const schema = loadJson("config/automation.schema.json");
  const text = `capabilities_default: on\nversion: 1\ncapabilities:\n`;

  const mail = planAutomationEdit({
    kind: "platform",
    capability: "mail_access",
    platform: "gmail",
    value: false,
    currentText: text,
    schema,
  });
  assert.equal(mail.ok, true);
  assert.equal(mail.valid, true, JSON.stringify(mail.errors));
  assert.equal(mail.changed, true);
  assert.equal(mail.previous, "true");
  const parsed = parseYaml(mail.nextText);
  assert.equal(parsed.capabilities.mail_access.enabled, true);
  assert.deepEqual(parsed.capabilities.mail_access.platforms, {
    gmail: false,
    outlook: true,
    webmail: true,
  });

  const calendar = planAutomationEdit({
    kind: "capability",
    capability: "calendar_sync",
    value: false,
    currentText: mail.nextText,
    schema,
  });
  assert.equal(calendar.ok, true);
  assert.equal(calendar.valid, true, JSON.stringify(calendar.errors));
  const next = parseYaml(calendar.nextText);
  assert.equal(next.capabilities.calendar_sync.enabled, false);
  assert.equal(next.capabilities.calendar_sync.platforms.google_calendar, true);
  assert.equal(
    mayRun({ capability: "calendar_sync", platform: "google_calendar", data: next }).allowed,
    false
  );
  assert.equal(
    mayRun({ capability: "mail_access", platform: "outlook", data: next }).allowed,
    true
  );
});

test("automation writer: disabling is idempotent on an on-by-default template", () => {
  const schema = loadJson("config/automation.schema.json");
  const template = readFileSync(join(root, "templates/automation.example.yml"), "utf8");
  const first = planAutomationEdit({
    kind: "capability",
    capability: "messaging",
    value: false,
    currentText: template,
    schema,
  });
  assert.equal(first.changed, true);
  const second = planAutomationEdit({
    kind: "capability",
    capability: "messaging",
    value: false,
    currentText: first.nextText,
    schema,
  });
  assert.equal(second.changed, false);
  assert.equal(
    mayRun({ capability: "messaging", platform: "linkedin", data: parseYaml(first.nextText) })
      .allowed,
    false
  );
});

test("a legacy file migrated then disabled keeps one capability off and the rest on", () => {
  const schema = loadJson("config/automation.schema.json");
  const template = readFileSync(join(root, "templates/automation.example.yml"), "utf8");
  const base = migrateLegacyAutomationText(legacyAutomationText, template);
  const plan = planAutomationEdit({
    kind: "capability",
    capability: "mail_access",
    value: false,
    currentText: base,
    schema,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.valid, true, JSON.stringify(plan.errors));
  const cfg = parseYaml(plan.nextText);
  assert.equal(cfg.capabilities_default, "on");
  const denied = mayRun({ capability: "mail_access", platform: "gmail", data: cfg });
  assert.equal(denied.allowed, false);
  assert.match(denied.reasons.join(" "), /careerrat automation enable mail_access --write/);
  assert.equal(
    mayRun({ capability: "authenticated_apply_preparation", platform: "linkedin", data: cfg })
      .allowed,
    true
  );
  assert.equal(cfg.session.provider, "extension");
});

test("automation status: every capability and platform reads on for a fresh workspace, with no consent or mode fields", () => {
  const status = automationStatus({ root: emptyRoot, env: {} });
  assert.equal(Object.hasOwn(status, "consent"), false);
  assert.equal(Object.hasOwn(status, "mode"), false);
  assert.equal(status.submit, "auto");
  for (const cap of status.capabilities) {
    assert.equal(cap.enabled, true, cap.capability);
    for (const platform of cap.platforms) {
      assert.deepEqual(Object.keys(platform).sort(), ["allowed", "enabled", "platform"]);
      assert.equal(platform.enabled, true);
      assert.equal(platform.allowed, true);
    }
  }
  assert.equal(
    status.liveCount,
    Object.values(CAPABILITIES).reduce((n, def) => n + def.platforms.length, 0)
  );
});

test("an unreadable existing automation.yml fails closed for every capability; an absent one is all on", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-automation-readerr-"));
  const env = {};
  assert.equal(loadAutomation({ root: dir, env }).readError, null);
  assert.equal(
    mayRun({ capability: "mail_access", platform: "gmail", root: dir, env }).allowed,
    true
  );

  mkdirSync(join(dir, "candidate"), { recursive: true });
  writeFileSync(
    join(dir, "candidate", "automation.yml"),
    `version: 1
capabilities_default: on
capabilities:
  mail_access:
    enabled: false
  note: "unterminated
`
  );
  const loaded = loadAutomation({ root: dir, env });
  assert.equal(loaded.valid, false);
  assert.match(loaded.readError, /YAML parse error/);
  for (const [capability, platform] of [
    ["mail_access", "gmail"],
    ["messaging", "linkedin"],
    ["status_polling", "greenhouse"],
  ]) {
    const verdict = mayRun({ capability, platform, root: dir, env });
    assert.equal(verdict.allowed, false, capability);
    assert.match(verdict.reasons[0], /automation settings can't be read/);
    assert.match(verdict.reasons[0], /careerrat automation status/);
  }
  const status = automationStatus({ root: dir, env });
  assert.match(status.readError, /YAML parse error/);
  assert.equal(status.liveCount, 0);
});
