import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  resolveEditPath,
} from "../src/core/automation/consent.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";

const root = join(new URL("..", import.meta.url).pathname);

function loadJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

const legacyAutomationText = `version: 1
consent:
  linkedin: true
capabilities:
  one_click_apply:
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
  cfg.capabilities.one_click_apply.enabled = true;
  cfg.capabilities.one_click_apply.platforms.linkedin = true;
  cfg.consent.linkedin = true;
  const verdict = mayRun({ capability: "one_click_apply", platform: "linkedin", data: cfg });
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
    currentText: legacyAutomationText,
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
    currentText: legacyAutomationText,
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
    currentText: legacyAutomationText,
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
    currentText: legacyAutomationText,
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
    currentText: legacyAutomationText,
    schema,
  });
  assert.equal(consentPlan.ok, true);
  assert.equal(consentPlan.valid, true, JSON.stringify(consentPlan.errors));
  assert.ok(consentPlan.nextText.includes("google_calendar: true"));
});
