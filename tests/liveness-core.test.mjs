import assert from "node:assert/strict";
import test from "node:test";

import { classifyLiveness } from "../src/core/liveness/liveness-core.mjs";

test("classifies a visible apply control as active", () => {
  const result = classifyLiveness({
    status: 200,
    finalUrl: "https://jobs.example.com/role",
    bodyText: "Senior Forward Deployed Engineer\nAbout the role\nRequirements",
    applyControls: ["Apply for this job"],
  });

  assert.equal(result.result, "active");
  assert.equal(result.code, "apply_control_visible");
});

test("expired body text wins even when generic apply text is present", () => {
  const result = classifyLiveness({
    status: 200,
    finalUrl: "https://jobs.example.com/role",
    bodyText: "This job is no longer available. Apply to other roles on our careers page.",
    applyControls: ["Apply"],
  });

  assert.equal(result.result, "expired");
  assert.equal(result.code, "expired_body");
});

test("an inactive employer account wins over generic application-site controls", () => {
  const result = classifyLiveness({
    status: 200,
    finalUrl: "https://employer.applytojob.com/apply/abc/Assistant-General-Manager",
    bodyText: "JazzHR Inactive Career Page. This account is no longer active. Learn more.",
    applyControls: ["Apply"],
  });

  assert.equal(result.result, "expired");
  assert.equal(result.code, "expired_body");
});

test("a bare job-expired banner wins over recommendation and sign-in controls", () => {
  const result = classifyLiveness({
    status: 200,
    finalUrl: "https://aggregator.example/job-listing/event-operations-manager",
    bodyText: "Job expired. This job from Apr 30, 2026 is no longer available for applications.",
    applyControls: ["Apply", "Sign in"],
  });

  assert.equal(result.result, "expired");
  assert.equal(result.code, "expired_body");
});

test("an expired LinkedIn redirect is expired even when the destination has apply controls", () => {
  const result = classifyLiveness({
    status: 200,
    finalUrl: "https://www.linkedin.com/jobs/lead-bartender-jobs?trk=expired_jd_redirect",
    bodyText: "Lead bartender jobs in New York. Browse current opportunities.",
    applyControls: ["Apply"],
  });

  assert.equal(result.result, "expired");
  assert.equal(result.code, "expired_url");
});

test("bare expired and archived date banners win over recommendation apply controls", () => {
  for (const banner of ["Expired: Apr 21, 2026", "Archived: May 8, 2026"]) {
    const result = classifyLiveness({
      status: 200,
      finalUrl: "https://culinary.example/jobs/123-Bar-Manager",
      bodyText: `${banner}\nBar Manager\nSimilar jobs`,
      applyControls: ["Apply to a similar job"],
    });

    assert.equal(result.result, "expired", banner);
    assert.equal(result.code, "expired_body", banner);
  }
});

test("an archived recommendation card does not close the active primary posting", () => {
  const result = classifyLiveness({
    status: 200,
    finalUrl: "https://jobs.example.com/active-role",
    bodyText: `Active Bar Manager\nApply now\n${"Primary job details. ".repeat(140)}\nOther jobs you might like\nArchived: May 8, 2026`,
    applyControls: ["Apply now"],
  });

  assert.equal(result.result, "active");
  assert.equal(result.code, "apply_control_visible");
});

test("short pages without apply controls are treated as expired shell pages", () => {
  const result = classifyLiveness({
    status: 200,
    finalUrl: "https://jobs.example.com/role",
    bodyText: "Careers",
    applyControls: [],
  });

  assert.equal(result.result, "expired");
  assert.equal(result.code, "insufficient_content");
});
