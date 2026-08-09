import assert from "node:assert/strict";
import test from "node:test";
import { defaultAutomation } from "../src/core/automation/consent.mjs";
import {
  buildVerificationCodeMailPlan,
  canUseMailAccess,
  classifyMailAccessBlocker,
  extractVerificationCodes,
  inferMailAccessPlatformFromEmail,
  MAIL_ACCESS_FORBIDDEN_ACTIONS,
  supportsWebmailIngest,
} from "../src/core/automation/mail-access.mjs";

test("mail access: canUseMailAccess delegates to the automation switchboard", () => {
  const cfg = defaultAutomation();
  let verdict = canUseMailAccess({ platform: "outlook", data: cfg });
  assert.equal(verdict.allowed, false);

  cfg.setup_mode = "advanced";
  cfg.capabilities.mail_access.enabled = true;
  cfg.capabilities.mail_access.platforms.outlook = true;
  cfg.consent.outlook = true;

  verdict = canUseMailAccess({ platform: "outlook", data: cfg });
  assert.equal(verdict.allowed, true);
});

test("mail access: generic webmail is a first-class verification-code platform", () => {
  const cfg = defaultAutomation();
  cfg.setup_mode = "advanced";
  cfg.capabilities.mail_access.enabled = true;
  cfg.capabilities.mail_access.platforms.webmail = true;
  cfg.consent.webmail = true;

  const verdict = canUseMailAccess({ platform: "webmail", data: cfg });
  assert.equal(verdict.allowed, true);

  const plan = buildVerificationCodeMailPlan({
    platform: "webmail",
    providerName: "Fastmail",
    recipientEmail: "jane@fastmail.com",
  });
  assert.equal(plan.platform, "webmail");
  assert.equal(plan.providerName, "Fastmail");
  assert.equal(plan.mode, "verification-code-only");
  assert.ok(plan.privacyRule.includes("Never browse the broader inbox"));
});

test("mail access: email-domain inference falls back to generic webmail", () => {
  assert.equal(inferMailAccessPlatformFromEmail("jane@gmail.com"), "gmail");
  assert.equal(inferMailAccessPlatformFromEmail("jane@hotmail.com"), "outlook");
  assert.equal(inferMailAccessPlatformFromEmail("jane@fastmail.com"), "webmail");
  assert.equal(inferMailAccessPlatformFromEmail("not-an-email"), null);
});

test("mail access: verification plan is scoped to one recent code message", () => {
  const plan = buildVerificationCodeMailPlan({
    platform: "gmail",
    recipientEmail: "jane@example.com",
    issuer: "Acme Careers",
  });

  assert.equal(plan.capability, "mail_access");
  assert.equal(plan.platform, "gmail");
  assert.equal(plan.mode, "verification-code-only");
  assert.equal(plan.maxAgeMinutes, 15);
  assert.ok(plan.searchTerms.includes("Acme Careers"));
  assert.ok(plan.allowedActions.includes("open one matching recent message"));
  assert.deepEqual(plan.forbiddenActions, MAIL_ACCESS_FORBIDDEN_ACTIONS);
  assert.ok(plan.haltOn.includes("login wall"));
  assert.ok(plan.privacyRule.includes("Never browse the broader inbox"));
});

test("mail access: verification plan rejects unsupported mail platforms", () => {
  assert.throws(
    () => buildVerificationCodeMailPlan({ platform: "linkedin" }),
    /unsupported mail platform/
  );
});

test("mail access: fuller webmail ingest remains provider-specific", () => {
  assert.equal(supportsWebmailIngest("gmail"), true);
  assert.equal(supportsWebmailIngest("outlook"), true);
  assert.equal(supportsWebmailIngest("webmail"), false);
});

test("mail access: blocker classifier halts on login walls, 2FA, and captcha", () => {
  assert.equal(classifyMailAccessBlocker("Sign in to Gmail to continue")?.kind, "login_wall");
  assert.equal(
    classifyMailAccessBlocker("Enter the code from your authenticator app")?.kind,
    "two_factor"
  );
  assert.equal(classifyMailAccessBlocker("Complete this CAPTCHA to continue")?.kind, "captcha");
  assert.equal(classifyMailAccessBlocker("Your verification code is 123456"), null);
});

test("mail access: code extraction prefers verification-code context", () => {
  assert.deepEqual(extractVerificationCodes("Your Acme verification code is 123456."), ["123456"]);
  assert.deepEqual(extractVerificationCodes("Use one-time code AB-1234 to continue signing in."), [
    "AB1234",
  ]);
  assert.deepEqual(extractVerificationCodes("Call us at 555-123-4567 for support."), []);
});
