/**
 * apply-form-fill.test.mjs — tests for src/core/apply/form-fill.mjs
 * Run: node --test tests/apply-form-fill.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLOCKER_SIGNALS,
  buildFillPlan,
  CANONICAL_FIELDS,
  confirmationCheck,
  hostnameToPortal,
  mapFormDefaults,
  PORTAL_RECIPES,
  resolveFieldValue,
  resolveScreeningAnswer,
  submitGuard,
  uniqueVoluntaryDeclineOption,
} from "../src/core/apply/form-fill.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE_FULL = {
  candidate: {
    full_name: "Jane Doe",
    email: "jane@example.com",
    phone: "555-1234",
    location: "San Francisco, CA",
    linkedin: "https://linkedin.com/in/janedoe",
    github: "https://github.com/janedoe",
    portfolio: "https://janedoe.dev",
  },
  compensation: {
    currency: "USD",
    current_comp_shareable: false,
    current_base: 180000,
    target_base: 200000,
    minimum_base: 175000,
  },
  location: {
    home: "San Francisco, CA",
    remote: true,
  },
  authorization: {
    work_authorized: true,
    requires_sponsorship: false,
    notice_period: "2 weeks",
  },
};

const PROFILE_SHAREABLE = {
  ...PROFILE_FULL,
  compensation: {
    ...PROFILE_FULL.compensation,
    current_comp_shareable: true,
  },
};

const FORM_DEFAULTS_BASIC = {
  source: "Job Board",
  work_authorization: "Yes",
  requires_sponsorship: "No",
  expected_base: 210000,
  eeo_default: "Prefer not to answer",
};

// ---------------------------------------------------------------------------
// CANONICAL_FIELDS
// ---------------------------------------------------------------------------

describe("CANONICAL_FIELDS", () => {
  it("is an array", () => {
    assert.ok(Array.isArray(CANONICAL_FIELDS));
  });

  it("contains all required fields", () => {
    const required = [
      "full_name",
      "first_name",
      "last_name",
      "email",
      "phone",
      "location",
      "linkedin",
      "github",
      "portfolio",
      "work_authorization",
      "requires_sponsorship",
      "source",
      "current_employer",
      "current_title",
      "expected_base",
      "eeo",
    ];
    for (const f of required) {
      assert.ok(CANONICAL_FIELDS.includes(f), `Missing canonical field: ${f}`);
    }
  });

  it("does not contain current_base", () => {
    assert.ok(
      !CANONICAL_FIELDS.includes("current_base"),
      "current_base must NOT be in CANONICAL_FIELDS"
    );
  });
});

// ---------------------------------------------------------------------------
// PORTAL_RECIPES
// ---------------------------------------------------------------------------

describe("PORTAL_RECIPES", () => {
  it("has all five portals", () => {
    for (const portal of ["greenhouse", "lever", "ashby", "workable", "smartrecruiters"]) {
      assert.ok(PORTAL_RECIPES[portal], `Missing portal: ${portal}`);
      assert.ok(typeof PORTAL_RECIPES[portal].labelMap === "object");
    }
  });

  it("greenhouse maps common fields", () => {
    const lm = PORTAL_RECIPES.greenhouse.labelMap;
    assert.equal(lm["first name"], "first_name");
    assert.equal(lm.email, "email");
    assert.equal(lm["linkedin profile"], "linkedin");
  });

  it("greenhouse maps work_authorization and requires_sponsorship", () => {
    const lm = PORTAL_RECIPES.greenhouse.labelMap;
    assert.equal(lm["are you authorized to work"], "work_authorization");
    assert.equal(lm["will you now or in the future require sponsorship"], "requires_sponsorship");
  });

  it("no portal labelMap references current_base", () => {
    for (const [portalName, recipe] of Object.entries(PORTAL_RECIPES)) {
      for (const [, canonical] of Object.entries(recipe.labelMap)) {
        assert.notEqual(
          canonical,
          "current_base",
          `Portal ${portalName} labelMap must not map to current_base`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// mapFormDefaults
// ---------------------------------------------------------------------------

describe("mapFormDefaults", () => {
  it("maps candidate full_name, email, phone, location", () => {
    const result = mapFormDefaults({}, PROFILE_FULL);
    assert.equal(result.full_name, "Jane Doe");
    assert.equal(result.email, "jane@example.com");
    assert.equal(result.phone, "555-1234");
    assert.equal(result.location, "San Francisco, CA");
  });

  it("splits first_name and last_name from full_name", () => {
    const result = mapFormDefaults({}, PROFILE_FULL);
    assert.equal(result.first_name, "Jane");
    assert.equal(result.last_name, "Doe");
  });

  it("handles multi-word last name", () => {
    const profile = {
      ...PROFILE_FULL,
      candidate: { ...PROFILE_FULL.candidate, full_name: "Mary Ann Smith" },
    };
    const result = mapFormDefaults({}, profile);
    assert.equal(result.first_name, "Mary");
    assert.equal(result.last_name, "Ann Smith");
  });

  it("expected_base from formDefaults when set", () => {
    const result = mapFormDefaults(FORM_DEFAULTS_BASIC, PROFILE_FULL);
    assert.equal(result.expected_base, 210000);
  });

  it("expected_base falls back to target_base when formDefaults.expected_base not set", () => {
    const fd = { ...FORM_DEFAULTS_BASIC, expected_base: null };
    const result = mapFormDefaults(fd, PROFILE_FULL);
    assert.equal(result.expected_base, 200000);
  });

  it("expected_base is empty string when neither formDefaults nor target_base set", () => {
    const profile = {
      ...PROFILE_FULL,
      compensation: { current_comp_shareable: false, current_base: 180000 },
    };
    const result = mapFormDefaults({}, profile);
    assert.ok(!("expected_base" in result), "expected_base should be omitted when no value");
  });

  it("NEVER includes current_base even when present in profile", () => {
    const result = mapFormDefaults(FORM_DEFAULTS_BASIC, PROFILE_FULL);
    assert.ok(!("current_base" in result), "current_base must never appear in mapped output");
    const values = Object.values(result);
    assert.ok(
      !values.includes(180000),
      "The current_base value (180000) must never appear in mapped output"
    );
  });

  it("NEVER includes current_base even with current_comp_shareable true", () => {
    const result = mapFormDefaults(FORM_DEFAULTS_BASIC, PROFILE_SHAREABLE);
    assert.ok(!("current_base" in result));
    const values = Object.values(result);
    assert.ok(!values.includes(180000));
  });

  it("work_authorization derived from profile.authorization when not in formDefaults", () => {
    const fd = { ...FORM_DEFAULTS_BASIC };
    delete fd.work_authorization;
    const result = mapFormDefaults(fd, PROFILE_FULL);
    assert.equal(result.work_authorization, "Yes");
  });

  it("work_authorization from formDefaults overrides profile", () => {
    const result = mapFormDefaults({ work_authorization: "No" }, PROFILE_FULL);
    assert.equal(result.work_authorization, "No");
  });

  it("requires_sponsorship derived from profile.authorization when not in formDefaults", () => {
    const fd = { ...FORM_DEFAULTS_BASIC };
    delete fd.requires_sponsorship;
    const result = mapFormDefaults(fd, PROFILE_FULL);
    assert.equal(result.requires_sponsorship, "No");
  });

  it("never treats legacy eeo_default as consent", () => {
    const result = mapFormDefaults(FORM_DEFAULTS_BASIC, PROFILE_FULL);
    assert.equal("eeo" in result, false);
  });

  it("maps source", () => {
    const result = mapFormDefaults(FORM_DEFAULTS_BASIC, PROFILE_FULL);
    assert.equal(result.source, "Job Board");
  });

  it("omits keys with null/undefined/empty-string values", () => {
    const result = mapFormDefaults({}, PROFILE_FULL);
    for (const [, v] of Object.entries(result)) {
      assert.ok(
        v !== null && v !== undefined && v !== "",
        `Value should not be null/undefined/empty: ${v}`
      );
    }
  });

  it("handles null formDefaults", () => {
    const result = mapFormDefaults(null, PROFILE_FULL);
    assert.equal(result.email, "jane@example.com");
  });
});

// ---------------------------------------------------------------------------
// resolveFieldValue
// ---------------------------------------------------------------------------

describe("resolveFieldValue", () => {
  const ctx = { formDefaults: FORM_DEFAULTS_BASIC, profile: PROFILE_FULL };

  it("resolves 'Email Address' → email", () => {
    const v = resolveFieldValue("Email Address", ctx);
    assert.equal(v, "jane@example.com");
  });

  it("resolves 'LinkedIn Profile' → linkedin URL", () => {
    const v = resolveFieldValue("LinkedIn Profile", ctx);
    assert.equal(v, "https://linkedin.com/in/janedoe");
  });

  it("resolves 'Expected Salary' → expected_base", () => {
    const v = resolveFieldValue("Expected Salary", ctx);
    assert.equal(v, 210000);
  });

  it("resolves 'Desired Compensation' → expected_base", () => {
    const v = resolveFieldValue("Desired Compensation", ctx);
    assert.equal(v, 210000);
  });

  it("'Current Salary' → null when current_comp_shareable false", () => {
    const v = resolveFieldValue("Current Salary", ctx);
    assert.equal(v, null);
    // Also assert the actual current_base number is not returned
  });

  it("'Current Compensation' → null when current_comp_shareable false", () => {
    const v = resolveFieldValue("Current Compensation", ctx);
    assert.equal(v, null);
  });

  it("'Current Salary' never returns current_base value (180000)", () => {
    const v = resolveFieldValue("Current Salary", ctx);
    assert.notEqual(v, 180000);
  });

  it("unknown label → null", () => {
    const v = resolveFieldValue("Favorite Color", ctx);
    assert.equal(v, null);
  });

  it("resolves 'First Name'", () => {
    const v = resolveFieldValue("First Name", ctx);
    assert.equal(v, "Jane");
  });

  it("resolves 'Phone Number'", () => {
    const v = resolveFieldValue("Phone Number", ctx);
    assert.equal(v, "555-1234");
  });

  it("resolves 'GitHub' → github URL", () => {
    const v = resolveFieldValue("GitHub", ctx);
    assert.equal(v, "https://github.com/janedoe");
  });

  it("uses portal labelMap when portal is provided", () => {
    const v = resolveFieldValue("Are you authorized to work", { ...ctx, portal: "greenhouse" });
    assert.equal(v, "Yes");
  });

  it("resolves 'Work Authorization' via generic matcher", () => {
    const v = resolveFieldValue("Work Authorization", ctx);
    assert.equal(v, "Yes");
  });
});

// ---------------------------------------------------------------------------
// BLOCKER_SIGNALS
// ---------------------------------------------------------------------------

describe("BLOCKER_SIGNALS", () => {
  it("is an array of strings", () => {
    assert.ok(Array.isArray(BLOCKER_SIGNALS));
    for (const s of BLOCKER_SIGNALS) {
      assert.equal(typeof s, "string");
    }
  });

  it("includes key safety signals", () => {
    const required = ["captcha", "verify you are human", "application limit", "coding exercise"];
    for (const sig of required) {
      assert.ok(BLOCKER_SIGNALS.includes(sig), `Missing blocker signal: ${sig}`);
    }
  });
});

// ---------------------------------------------------------------------------
// submitGuard
// ---------------------------------------------------------------------------

describe("submitGuard", () => {
  it("blocks on pageText containing 'verify you are human'", () => {
    const result = submitGuard({
      pageText: "Please verify you are human to continue.",
    });
    assert.equal(result.canSubmit, false);
    assert.equal(result.mode, "manual");
    assert.ok(result.blockers.includes("verify you are human"));
  });

  it("blocks on pageText containing 'captcha'", () => {
    const result = submitGuard({ pageText: "Complete the CAPTCHA below." });
    assert.equal(result.canSubmit, false);
    assert.equal(result.mode, "manual");
  });

  it("returns mode=manual and canSubmit=true with a clean page", () => {
    const result = submitGuard({
      pageText: "Please fill in your details.",
    });
    assert.equal(result.canSubmit, true);
    assert.equal(result.mode, "manual");
    assert.deepEqual(result.blockers, []);
  });

  it("blocks when pageSignals.captcha === true", () => {
    const result = submitGuard({
      pageText: "Fill out the form below.",
      pageSignals: { captcha: true },
    });
    assert.equal(result.canSubmit, false);
    assert.equal(result.mode, "manual");
    assert.ok(result.blockers.includes("captcha"));
  });

  it("blocks when pageSignals.appLimit === true", () => {
    const result = submitGuard({
      pageText: "",
      pageSignals: { appLimit: true },
    });
    assert.equal(result.canSubmit, false);
    assert.equal(result.mode, "manual");
    assert.ok(result.blockers.includes("application limit"));
  });

  it("blocks when pageSignals.requiredExercise === true", () => {
    const result = submitGuard({
      pageText: "",
      pageSignals: { requiredExercise: true },
    });
    assert.equal(result.canSubmit, false);
    assert.equal(result.mode, "manual");
  });

  it("handles no arguments (empty call)", () => {
    const result = submitGuard();
    assert.equal(result.canSubmit, true);
    assert.equal(result.mode, "manual");
    assert.deepEqual(result.blockers, []);
  });

  it("returns canSubmit false and mode manual when a blocker exists", () => {
    const result = submitGuard({
      pageText: "You have reached the application limit for this role.",
    });
    assert.equal(result.canSubmit, false);
    assert.equal(result.mode, "manual");
  });
});

// ---------------------------------------------------------------------------
// buildFillPlan
// ---------------------------------------------------------------------------

describe("buildFillPlan", () => {
  const fields = ["First Name", "Last Name", "Email Address", "Favorite Color", "Expected Salary"];

  it("returns fill actions for known labels", () => {
    const plan = buildFillPlan({
      fields,
      formDefaults: FORM_DEFAULTS_BASIC,
      profile: PROFILE_FULL,
    });
    const firstNameStep = plan.find((s) => s.label === "First Name");
    assert.equal(firstNameStep.action, "fill");
    assert.equal(firstNameStep.value, "Jane");
  });

  it("carries candidate-configured dropdown aliases on the matching canonical field", () => {
    const plan = buildFillPlan({
      fields: ["Location", "How did you hear about us?"],
      formDefaults: {
        source: "Community event",
        option_aliases: {
          location: ["Metro City"],
          source: ["Other"],
        },
      },
      profile: PROFILE_FULL,
    });

    assert.deepEqual(plan[0].optionAliases, ["Metro City"]);
    assert.deepEqual(plan[1].optionAliases, ["Other"]);
  });

  it("returns skip for unknown labels", () => {
    const plan = buildFillPlan({
      fields,
      formDefaults: FORM_DEFAULTS_BASIC,
      profile: PROFILE_FULL,
    });
    const unknownStep = plan.find((s) => s.label === "Favorite Color");
    assert.equal(unknownStep.action, "skip");
    assert.equal(unknownStep.canonicalField, null);
    assert.equal(unknownStep.value, null);
  });

  it("leaves voluntary self-identification blank unless explicitly enabled", () => {
    const [step] = buildFillPlan({
      fields: [{ label: "Race / Ethnicity", type: "select" }],
      formDefaults: {
        eeo_default: "Prefer not to answer",
        screening_answers: { "race ethnicity": "White" },
        voluntary_self_identification: {
          enabled: false,
          default_action: "decline_when_available",
          confirmed_at: "2026-08-26T12:00:00Z",
          answers: {},
        },
      },
      profile: { candidate: { race: "White" } },
    });

    assert.deepEqual(step, {
      label: "Race / Ethnicity",
      canonicalField: "eeo",
      value: null,
      action: "skip",
      reason: "voluntary_self_identification_disabled",
    });
  });

  it("uses only an exact normalized saved self-identification question answer", () => {
    const formDefaults = {
      voluntary_self_identification: {
        enabled: true,
        default_action: "leave_blank",
        confirmed_at: "2026-08-26T12:00:00Z",
        answers: {
          "race ethnicity": { value: "Two or more races", confirmed_at: "2026-08-26T12:00:00Z" },
        },
      },
    };
    const [exact, notExact] = buildFillPlan({
      fields: [
        { label: "Race / Ethnicity", type: "select" },
        { label: "Please choose your race / ethnicity", type: "select" },
      ],
      formDefaults,
    });

    assert.equal(exact.action, "fill");
    assert.equal(exact.value, "Two or more races");
    assert.equal(exact.source, "form-defaults.voluntary_self_identification.answers");
    assert.equal(notExact.action, "skip");
  });

  it("does not act on enabled self-identification settings without real confirmation", () => {
    const [missing, invalid] = [null, "not-a-date"].map(
      (confirmedAt) =>
        buildFillPlan({
          fields: [{ label: "Gender", type: "select" }],
          formDefaults: {
            voluntary_self_identification: {
              enabled: true,
              default_action: "decline_when_available",
              confirmed_at: confirmedAt,
              answers: {},
            },
          },
        })[0]
    );

    assert.equal(missing.action, "skip");
    assert.equal(missing.reason, "voluntary_self_identification_unconfirmed");
    assert.equal(invalid.action, "skip");
    assert.equal(invalid.reason, "voluntary_self_identification_unconfirmed");
  });

  it("uses decline_when_available only for one tight semantic radio option", () => {
    const base = {
      enabled: true,
      default_action: "decline_when_available",
      confirmed_at: "2026-08-26T12:00:00Z",
      answers: {},
    };
    const [unique, ambiguous, absent] = buildFillPlan({
      fields: [
        {
          label: "Gender",
          type: "radio",
          options: [
            { label: "Woman", ref: "e1" },
            { label: "Prefer not to answer", ref: "e2" },
          ],
        },
        {
          label: "Veteran status",
          type: "radio",
          options: [
            { label: "Decline to self-identify", ref: "e3" },
            { label: "I don't wish to answer", ref: "e4" },
          ],
        },
        {
          label: "Disability status",
          type: "radio",
          options: [{ label: "Prefer not to say", ref: "e5" }],
        },
      ],
      formDefaults: { voluntary_self_identification: base },
    });

    assert.equal(unique.action, "fill");
    assert.equal(unique.value, "Prefer not to answer");
    assert.equal(unique.declinePolicy, true);
    assert.equal(ambiguous.action, "skip");
    assert.equal(absent.action, "skip");
  });

  it("accepts only the narrow decline phrases and requires exactly one", () => {
    assert.equal(
      uniqueVoluntaryDeclineOption(["Yes", "I do not wish to answer"]),
      "I do not wish to answer"
    );
    assert.equal(
      uniqueVoluntaryDeclineOption(["Yes", "I do not want to answer"]),
      "I do not want to answer"
    );
    assert.equal(uniqueVoluntaryDeclineOption(["Yes", "Prefer not to say"]), null);
    assert.equal(
      uniqueVoluntaryDeclineOption(["Prefer not to answer", "Decline to self-identify"]),
      null
    );
  });

  it("never returns a submit action", () => {
    const plan = buildFillPlan({
      fields,
      formDefaults: FORM_DEFAULTS_BASIC,
      profile: PROFILE_FULL,
    });
    for (const step of plan) {
      assert.notEqual(step.action, "submit");
    }
  });

  it("fills expected_base", () => {
    const plan = buildFillPlan({
      fields,
      formDefaults: FORM_DEFAULTS_BASIC,
      profile: PROFILE_FULL,
    });
    const salaryStep = plan.find((s) => s.label === "Expected Salary");
    assert.equal(salaryStep.action, "fill");
    assert.equal(salaryStep.value, 210000);
  });

  it("skips Current Salary when current_comp_shareable false", () => {
    const plan = buildFillPlan({
      fields: ["Current Salary"],
      formDefaults: FORM_DEFAULTS_BASIC,
      profile: PROFILE_FULL,
    });
    assert.equal(plan[0].action, "skip");
    assert.equal(plan[0].value, null);
  });

  it("returns empty array for empty fields", () => {
    const plan = buildFillPlan({
      fields: [],
      formDefaults: FORM_DEFAULTS_BASIC,
      profile: PROFILE_FULL,
    });
    assert.deepEqual(plan, []);
  });

  it("handles undefined formDefaults and profile gracefully", () => {
    const plan = buildFillPlan({ fields: ["First Name"] });
    assert.equal(plan[0].action, "skip");
  });

  it("fills explicit configured screening answers instead of skipping ambiguous labels", () => {
    const plan = buildFillPlan({
      fields: ["Why are you interested in this role?"],
      formDefaults: {
        ...FORM_DEFAULTS_BASIC,
        screening_answers: {
          "why are you interested in this role":
            "I like customer-facing AI implementation work where I can build useful prototypes quickly.",
        },
      },
      profile: PROFILE_FULL,
    });
    assert.equal(plan[0].action, "fill");
    assert.equal(
      plan[0].value,
      "I like customer-facing AI implementation work where I can build useful prototypes quickly."
    );
    assert.equal(plan[0].source, "form-defaults.screening_answers");
  });

  it("derives routine screening answers from profile instead of asking", () => {
    const profile = {
      ...PROFILE_FULL,
      location: {
        remote: true,
        hybrid: true,
        onsite: false,
        relocation: ["New York, NY", "Austin, TX"],
        travel_tolerance: "Up to 25% travel for customer work.",
      },
      authorization: {
        ...PROFILE_FULL.authorization,
        notice_period: "2 weeks",
      },
    };
    const plan = buildFillPlan({
      fields: [
        "Notice period",
        "Are you open to remote work?",
        "Are you open to onsite work?",
        "Are you open to working in-person in one of our offices 25% of the time?",
        "Are you willing to relocate?",
        'What is the address from which you plan on working? If you would need to relocate, please type "relocating".',
        "How much travel are you comfortable with?",
      ],
      formDefaults: FORM_DEFAULTS_BASIC,
      profile,
    });
    assert.equal(plan.find((s) => s.label === "Notice period").value, "2 weeks");
    assert.equal(plan.find((s) => s.label === "Are you open to remote work?").value, "Yes");
    assert.equal(plan.find((s) => s.label === "Are you open to onsite work?").value, "No");
    assert.equal(plan.find((s) => /in-person/.test(s.label)).value, "Yes");
    assert.equal(plan.find((s) => s.label === "Are you willing to relocate?").value, "Yes");
    assert.equal(plan.find((s) => /type "relocating"/.test(s.label)).value, "relocating");
    assert.equal(
      plan.find((s) => s.label === "How much travel are you comfortable with?").value,
      "Up to 25% travel for customer work."
    );
  });
});

// ---------------------------------------------------------------------------
// resolveScreeningAnswer
// ---------------------------------------------------------------------------

describe("resolveScreeningAnswer", () => {
  it("does not let saved screening answers bypass voluntary self-identification policy", () => {
    const labels = [
      "Do you identify as LGBTQ+?",
      "What is your religion?",
      "What is your marital status?",
      "What is your national origin?",
      "Which age range are you in?",
    ];

    for (const label of labels) {
      const answer = resolveScreeningAnswer(label, {
        formDefaults: { screening_answers: { [label]: "private demographic answer" } },
      });
      assert.equal(answer.action, "skip", label);
      assert.equal(answer.value, null, label);
      assert.equal(answer.reason, "voluntary_self_identification_disabled", label);
    }
  });

  it("resolves demographic answers only through the confirmed voluntary policy", () => {
    const answer = resolveScreeningAnswer("Do you identify as LGBTQ+?", {
      formDefaults: {
        screening_answers: { "do you identify as lgbtq": "screening bypass" },
        voluntary_self_identification: {
          enabled: true,
          default_action: "leave_blank",
          confirmed_at: "2026-08-26T12:00:00Z",
          answers: {
            "do you identify as lgbtq": {
              value: "Prefer not to answer",
              confirmed_at: "2026-08-26T12:00:00Z",
            },
          },
        },
      },
    });

    assert.equal(answer.action, "fill");
    assert.equal(answer.value, "Prefer not to answer");
    assert.equal(answer.source, "form-defaults.voluntary_self_identification.answers");
  });

  it("answers confirmed tool-experience questions from honesty.yml", () => {
    const answer = resolveScreeningAnswer("Do you have experience with Python?", {
      honesty: {
        tools: {
          confirmed: ["Python"],
          do_not_claim: ["Kubernetes production ownership"],
        },
      },
    });
    assert.equal(answer.action, "fill");
    assert.equal(answer.value, "Yes");
    assert.equal(answer.source, "honesty.tools.confirmed");
  });

  it("answers no for tool ownership explicitly disallowed by honesty.yml", () => {
    const answer = resolveScreeningAnswer("Do you have Kubernetes production ownership?", {
      honesty: {
        tools: {
          confirmed: ["Python"],
          do_not_claim: ["Kubernetes production ownership"],
        },
      },
    });
    assert.equal(answer.action, "fill");
    assert.equal(answer.value, "No");
    assert.equal(answer.source, "honesty.tools.do_not_claim");
  });

  it("does not invent unsupported tool experience", () => {
    const answer = resolveScreeningAnswer("Do you have experience with Erlang?", {
      honesty: { tools: { confirmed: ["Python"], do_not_claim: [] } },
    });
    assert.equal(answer.action, "skip");
    assert.equal(answer.value, null);
  });

  it("does not answer private current-compensation screening questions", () => {
    const answer = resolveScreeningAnswer("What is your current compensation?", {
      formDefaults: { screening_answers: { "current compensation": 200000 } },
      profile: PROFILE_FULL,
    });
    assert.equal(answer.action, "skip");
    assert.equal(answer.value, null);
    assert.equal(answer.reason, "private_current_compensation");
  });
});

// ---------------------------------------------------------------------------
// confirmationCheck
// ---------------------------------------------------------------------------

describe("confirmationCheck", () => {
  it("detects 'Thank you for applying'", () => {
    const r = confirmationCheck({ pageText: "Thank you for applying to Acme Corp!" });
    assert.equal(r.submitted, true);
    assert.equal(r.signal, "thank you for applying");
  });

  it("detects 'application received'", () => {
    const r = confirmationCheck({ pageText: "Your application received. We will be in touch." });
    assert.equal(r.submitted, true);
  });

  it("detects 'successfully submitted'", () => {
    const r = confirmationCheck({ pageText: "Your application has been successfully submitted." });
    assert.equal(r.submitted, true);
  });

  it("returns submitted=false when not a confirmation page", () => {
    const r = confirmationCheck({ pageText: "Please complete all required fields." });
    assert.equal(r.submitted, false);
    assert.equal(r.signal, null);
  });

  it("handles no arguments", () => {
    const r = confirmationCheck();
    assert.equal(r.submitted, false);
  });

  it("is case-insensitive", () => {
    const r = confirmationCheck({ pageText: "THANK YOU FOR APPLYING!" });
    assert.equal(r.submitted, true);
  });
});

// ---------------------------------------------------------------------------
// hostnameToPortal [#4]
// ---------------------------------------------------------------------------

describe("hostnameToPortal", () => {
  it("maps Greenhouse board URL", () => {
    assert.equal(hostnameToPortal("https://boards.greenhouse.io/acme/jobs/123"), "greenhouse");
  });

  it("maps Greenhouse job-boards URL", () => {
    assert.equal(hostnameToPortal("https://job-boards.greenhouse.io/acme/jobs/123"), "greenhouse");
  });

  it("maps Lever URL", () => {
    assert.equal(hostnameToPortal("https://jobs.lever.co/acme/abc123"), "lever");
  });

  it("maps Ashby URL", () => {
    assert.equal(hostnameToPortal("https://jobs.ashbyhq.com/acme/apply"), "ashby");
  });

  it("maps Workable URL", () => {
    assert.equal(hostnameToPortal("https://apply.workable.com/acme/j/ABC123/"), "workable");
  });

  it("maps SmartRecruiters careers URL", () => {
    assert.equal(
      hostnameToPortal("https://careers.smartrecruiters.com/Acme/job123"),
      "smartrecruiters"
    );
  });

  it("maps SmartRecruiters jobs URL", () => {
    assert.equal(
      hostnameToPortal("https://jobs.smartrecruiters.com/Acme/job123"),
      "smartrecruiters"
    );
  });

  it("returns null for unknown ATS", () => {
    assert.equal(hostnameToPortal("https://mycompany.com/careers/apply"), null);
  });

  it("returns null for malformed URL without throwing", () => {
    assert.equal(hostnameToPortal("not-a-url"), null);
    assert.equal(hostnameToPortal(""), null);
    assert.equal(hostnameToPortal(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// PORTAL_RECIPES: smartrecruiters [#22]
// ---------------------------------------------------------------------------

describe("PORTAL_RECIPES.smartrecruiters", () => {
  const lm = PORTAL_RECIPES.smartrecruiters?.labelMap;

  it("exists with a labelMap", () => {
    assert.ok(lm && typeof lm === "object");
  });

  it("maps first name and last name", () => {
    assert.equal(lm["first name"], "first_name");
    assert.equal(lm["last name"], "last_name");
  });

  it("maps email", () => {
    assert.equal(lm.email, "email");
  });

  it("maps phone", () => {
    assert.equal(lm.phone, "phone");
  });

  it("maps linkedin profile url", () => {
    assert.equal(lm["linkedin profile url"], "linkedin");
  });

  it("maps resume / attach resume", () => {
    assert.equal(lm.resume, "resume");
    assert.equal(lm["attach resume"], "resume");
  });

  it("maps work_authorization", () => {
    assert.equal(lm["are you authorized to work"], "work_authorization");
  });

  it("maps requires_sponsorship", () => {
    assert.equal(lm["require sponsorship"], "requires_sponsorship");
  });

  it("maps current_employer and current_title", () => {
    assert.equal(lm["current employer"], "current_employer");
    assert.equal(lm["current title"], "current_title");
  });

  it("maps expected salary", () => {
    assert.equal(lm["expected salary"], "expected_base");
  });

  it("does not map to current_base", () => {
    for (const v of Object.values(lm)) {
      assert.notEqual(v, "current_base", "smartrecruiters labelMap must not map to current_base");
    }
  });
});

// ---------------------------------------------------------------------------
// confirmationCheck: URL segments and new phrases [#8]
// ---------------------------------------------------------------------------

describe("confirmationCheck URL-segment detection", () => {
  it("confirms on /confirmation path", () => {
    const r = confirmationCheck({
      currentUrl: "https://jobs.example.com/apply/confirmation?id=123",
    });
    assert.equal(r.submitted, true);
    assert.equal(r.signal, "/confirmation");
  });

  it("confirms on /thank-you path", () => {
    const r = confirmationCheck({ currentUrl: "https://jobs.example.com/jobs/123/thank-you" });
    assert.equal(r.submitted, true);
    assert.equal(r.signal, "/thank-you");
  });

  it("confirms on /thanks path", () => {
    const r = confirmationCheck({ currentUrl: "https://jobs.example.com/thanks" });
    assert.equal(r.submitted, true);
    assert.equal(r.signal, "/thanks");
  });

  it("confirms on /submitted path", () => {
    const r = confirmationCheck({ currentUrl: "https://jobs.example.com/submitted" });
    assert.equal(r.submitted, true);
    assert.equal(r.signal, "/submitted");
  });

  it("confirms on /apply/success path", () => {
    const r = confirmationCheck({ currentUrl: "https://jobs.example.com/apply/success" });
    assert.equal(r.submitted, true);
    assert.equal(r.signal, "/apply/success");
  });

  it("confirms on /application/complete path", () => {
    const r = confirmationCheck({ currentUrl: "https://jobs.example.com/application/complete" });
    assert.equal(r.submitted, true);
    assert.equal(r.signal, "/application/complete");
  });

  it("does not confirm on an unrelated path", () => {
    const r = confirmationCheck({ currentUrl: "https://jobs.example.com/apply/step-2" });
    assert.equal(r.submitted, false);
  });

  it("handles malformed currentUrl without throwing", () => {
    const r = confirmationCheck({ currentUrl: "not-a-url", pageText: "" });
    assert.equal(r.submitted, false);
  });

  it("existing call sites (no currentUrl) still work", () => {
    const r = confirmationCheck({ pageText: "Thank you for applying to Acme!" });
    assert.equal(r.submitted, true);
    assert.equal(r.signal, "thank you for applying");
  });
});

describe("confirmationCheck new text phrases [#8]", () => {
  it("detects 'your application has been submitted'", () => {
    const r = confirmationCheck({ pageText: "Your application has been submitted." });
    assert.equal(r.submitted, true);
  });

  it("detects 'application submitted'", () => {
    const r = confirmationCheck({ pageText: "Application submitted. We will be in touch." });
    assert.equal(r.submitted, true);
  });

  it("detects 'application complete'", () => {
    const r = confirmationCheck({ pageText: "Application complete. Thanks!" });
    assert.equal(r.submitted, true);
  });

  it("detects 'thanks for applying'", () => {
    const r = confirmationCheck({ pageText: "Thanks for applying to our role." });
    assert.equal(r.submitted, true);
  });
});

// ---------------------------------------------------------------------------
// buildFillPlan: requiresConfirmation flag [#16]
// ---------------------------------------------------------------------------

describe("buildFillPlan requiresConfirmation [#16]", () => {
  const FD_WITH_EMPLOYER = {
    ...FORM_DEFAULTS_BASIC,
    current_employer: "Acme Corp",
    current_title: "Staff Engineer",
  };

  it("current_employer from form-defaults is treated as preconfigured disclosure", () => {
    const plan = buildFillPlan({
      fields: ["Current Employer"],
      formDefaults: FD_WITH_EMPLOYER,
      profile: PROFILE_FULL,
    });
    const step = plan.find((s) => s.canonicalField === "current_employer");
    assert.ok(step, "expected a current_employer step");
    assert.equal(step.requiresConfirmation, undefined);
  });

  it("current_title from form-defaults is treated as preconfigured disclosure", () => {
    const plan = buildFillPlan({
      fields: ["Current Title"],
      formDefaults: FD_WITH_EMPLOYER,
      profile: PROFILE_FULL,
    });
    const step = plan.find((s) => s.canonicalField === "current_title");
    assert.ok(step, "expected a current_title step");
    assert.equal(step.requiresConfirmation, undefined);
  });

  it("other fields do NOT have requiresConfirmation", () => {
    const plan = buildFillPlan({
      fields: ["First Name", "Email Address", "Expected Salary"],
      formDefaults: FD_WITH_EMPLOYER,
      profile: PROFILE_FULL,
    });
    for (const step of plan) {
      assert.ok(
        step.requiresConfirmation == null,
        `Field ${step.label} should not have requiresConfirmation but got ${step.requiresConfirmation}`
      );
    }
  });

  it("action enum is unchanged (still 'fill') for confirmed fields", () => {
    const plan = buildFillPlan({
      fields: ["Current Employer"],
      formDefaults: FD_WITH_EMPLOYER,
      profile: PROFILE_FULL,
    });
    const step = plan.find((s) => s.canonicalField === "current_employer");
    assert.equal(step.action, "fill");
  });

  it("confirm_current_role restores a confirmation pause when explicitly configured", () => {
    const plan = buildFillPlan({
      fields: ["Current Employer"],
      formDefaults: { ...FD_WITH_EMPLOYER, confirm_current_role: true },
      profile: PROFILE_FULL,
    });
    const step = plan.find((s) => s.canonicalField === "current_employer");
    assert.equal(step.requiresConfirmation, true);
  });
});

// ---------------------------------------------------------------------------
// BLOCKER_SIGNALS: verification-code phrases [#6][#7]
// ---------------------------------------------------------------------------

describe("BLOCKER_SIGNALS verification-code phrases [#6][#7]", () => {
  const VERIFICATION_PHRASES = [
    "verification code",
    "enter the code",
    "check your email",
    "we sent you a code",
    "one-time code",
    "enter the 6-digit code",
  ];

  it("includes all verification-code phrases", () => {
    for (const phrase of VERIFICATION_PHRASES) {
      assert.ok(BLOCKER_SIGNALS.includes(phrase), `Missing blocker signal: ${phrase}`);
    }
  });

  it("still includes captcha and assessment signals", () => {
    assert.ok(BLOCKER_SIGNALS.includes("captcha"));
    assert.ok(BLOCKER_SIGNALS.includes("verify you are human"));
    assert.ok(BLOCKER_SIGNALS.includes("complete the assessment"));
    assert.ok(BLOCKER_SIGNALS.includes("coding exercise"));
  });

  it("submitGuard blocks on 'verification code' in pageText", () => {
    const result = submitGuard({
      pageText: "Please enter your verification code to continue.",
    });
    assert.equal(result.canSubmit, false);
    assert.equal(result.mode, "manual");
    assert.ok(result.blockers.includes("verification code"));
  });

  it("submitGuard blocks on 'check your email' in pageText", () => {
    const result = submitGuard({
      pageText: "Check your email for a one-time link.",
    });
    assert.equal(result.canSubmit, false);
    assert.ok(result.blockers.includes("check your email"));
  });

  it("submitGuard blocks on 'enter the 6-digit code'", () => {
    const result = submitGuard({
      pageText: "Enter the 6-digit code we sent to your phone.",
    });
    assert.equal(result.canSubmit, false);
    assert.ok(result.blockers.includes("enter the 6-digit code"));
  });
});

// ---------------------------------------------------------------------------
// End-to-end: current_base privacy
// ---------------------------------------------------------------------------

describe("E2E: current_base privacy", () => {
  const PROFILE_WITH_CURRENT = {
    candidate: {
      full_name: "Alex Smith",
      email: "alex@example.com",
    },
    compensation: {
      current_comp_shareable: false,
      current_base: 999999,
      target_base: 150000,
    },
    location: {},
    authorization: {
      work_authorized: true,
      requires_sponsorship: false,
    },
  };

  const allLabels = [
    "Current Salary",
    "Current Compensation",
    "Current Pay",
    "Expected Salary",
    "Email Address",
    "First Name",
    "LinkedIn Profile",
  ];

  it("mapFormDefaults never exposes current_base (999999)", () => {
    const result = mapFormDefaults(FORM_DEFAULTS_BASIC, PROFILE_WITH_CURRENT);
    const allValues = JSON.stringify(result);
    assert.ok(
      !allValues.includes("999999"),
      `current_base leaked in mapFormDefaults: ${allValues}`
    );
  });

  it("resolveFieldValue never returns 999999 for any label", () => {
    const ctx = { formDefaults: FORM_DEFAULTS_BASIC, profile: PROFILE_WITH_CURRENT };
    for (const label of allLabels) {
      const v = resolveFieldValue(label, ctx);
      assert.notEqual(v, 999999, `current_base (999999) leaked via resolveFieldValue("${label}")`);
    }
  });

  it("buildFillPlan never fills current_base (999999)", () => {
    const plan = buildFillPlan({
      fields: allLabels,
      formDefaults: FORM_DEFAULTS_BASIC,
      profile: PROFILE_WITH_CURRENT,
    });
    const allValues = JSON.stringify(plan);
    assert.ok(
      !allValues.includes("999999"),
      `current_base (999999) leaked in buildFillPlan: ${allValues}`
    );
  });

  it("submitGuard is unaffected by compensation data", () => {
    const result = submitGuard({
      pageText: "Fill out the form.",
      profile: PROFILE_WITH_CURRENT,
    });
    assert.equal(result.canSubmit, true);
    assert.equal(result.mode, "manual");
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("999999"));
  });
});
