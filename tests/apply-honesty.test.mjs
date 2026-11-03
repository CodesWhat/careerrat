// Apply honesty: the label, receipt and status rules that decide whether
// CareerRat fills a field, trusts a confirmation, or records an application.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  unrecognizedRequiredUploads,
  uploadTargetsFromSnapshot,
} from "../src/core/apply/apply-driver.mjs";
import { buildFillPlan, confirmationCheck } from "../src/core/apply/form-fill.mjs";
import { automationStatus } from "../src/core/automation/consent.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  appSetStatus,
  appUpsert,
  candidateSetupInitialize,
  kvUpsert,
} from "../src/core/db/verbs.mjs";
import { classifySelfIdentificationQuestion } from "../src/core/packet/questions.mjs";

const PROFILE = {
  candidate: {
    full_name: "Jane Doe",
    email: "jane@example.com",
    phone: "555-1234",
    location: "Springfield",
    portfolio: "https://janedoe.dev",
  },
  location: { home: "Springfield" },
};
const FORM_DEFAULTS = { source: "Job Board" };

function planFor(label) {
  const [step] = buildFillPlan({ fields: [label], formDefaults: FORM_DEFAULTS, profile: PROFILE });
  return step;
}

describe("label matching only fills the field it names", () => {
  for (const [label, value] of [
    ["Phone", "555-1234"],
    ["Website", "https://janedoe.dev"],
    ["How did you hear about us?", "Job Board"],
  ]) {
    it(`fills "${label}"`, () => {
      assert.equal(planFor(label).value, value);
    });
  }

  for (const label of [
    "Phone extension",
    "Phone type",
    "Company website",
    "Link to your open source contributions",
    "Are you open to working with open source tools?",
    "Human resources contact",
    "Location of your current office",
  ]) {
    it(`leaves "${label}" alone`, () => {
      assert.equal(planFor(label).action, "skip");
    });
  }
});

describe("self-identification keywords inside work questions", () => {
  for (const label of [
    "Describe a time you debugged race conditions in production",
    "Describe your gender-inclusive design work",
    "Do you have experience with veteran-owned procurement?",
    "Describe accessibility features for users with a disability",
  ]) {
    it(`is not self-ID: ${label}`, () => {
      assert.equal(classifySelfIdentificationQuestion(label).excluded, false);
    });
  }

  for (const label of ["What is your gender?", "Race", "Veteran status", "Disability status"]) {
    it(`still self-ID: ${label}`, () => {
      assert.equal(classifySelfIdentificationQuestion(label).excluded, true);
    });
  }
});

describe("confirmationCheck", () => {
  const prose = "FAQ\nYour application has been submitted to our recruiting team.";

  it("accepts receipt wording by default", () => {
    assert.equal(confirmationCheck({ pageText: prose }).submitted, true);
  });

  it("ignores receipt wording when the caller has not seen the form yet", () => {
    assert.equal(confirmationCheck({ pageText: prose, allowProse: false }).submitted, false);
  });

  it("still accepts a confirmation URL on a page we only just opened", () => {
    const result = confirmationCheck({
      pageText: "",
      currentUrl: "https://jobs.example.com/apply/thank-you",
      allowProse: false,
    });
    assert.equal(result.submitted, true);
  });
});

describe("upload recognition", () => {
  function snapshot(name, { required = true, fileInput = true, group } = {}) {
    const flags = required ? "[required, ref=e1]" : "[ref=e1]";
    const button = `${group ? "  " : ""}- button "${name}" ${flags}`;
    return {
      pageText: group ? `- group "${group}" [ref=g1]\n${button}` : button,
      refs: { e1: { role: "button", name, required, ...(fileInput ? { fileInput: true } : {}) } },
    };
  }

  for (const name of ["Upload your resume", "Attach resume", "Résumé/CV", "CV / Resume (PDF)"]) {
    it(`recognizes a file input named "${name}"`, () => {
      const [target] = uploadTargetsFromSnapshot(snapshot(name));
      assert.equal(target?.kind, "resume");
      assert.equal(target?.required, true);
    });
  }

  it("does not treat a Remove resume button as an upload", () => {
    assert.deepEqual(
      uploadTargetsFromSnapshot(snapshot("Remove resume", { fileInput: false })),
      []
    );
  });

  it("reports a required file input no rule claims", () => {
    const found = unrecognizedRequiredUploads(snapshot("Official transcript"));
    assert.deepEqual(
      found.map((item) => item.label),
      ["Official transcript"]
    );
  });

  it("does not report one that is optional, attached, or already a resume", () => {
    assert.deepEqual(unrecognizedRequiredUploads(snapshot("Transcript", { required: false })), []);
    assert.deepEqual(unrecognizedRequiredUploads(snapshot("Upload your resume")), []);
    const attached = snapshot("Transcript");
    attached.refs.e1.fileAttached = true;
    assert.deepEqual(unrecognizedRequiredUploads(attached), []);
  });
});

describe("recording a status", () => {
  const cleanup = [];
  after(() => {
    closeAll();
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), "careerrat-honesty-db-"));
    cleanup.push(dir);
    mkdirSync(join(dir, "templates"), { recursive: true });
    const env = {
      ...process.env,
      CAREERRAT_HOME: join(dir, "home"),
      CAREERRAT_NO_UPDATE_CHECK: "1",
    };
    candidateSetupInitialize({ repoRoot: dir, env });
    appUpsert({
      repoRoot: dir,
      env,
      row: { id: "app-1", company: "Acme", role: "Engineer", status: "evaluated" },
    });
    return { dir, env };
  }

  it("rejects a status CareerRat doesn't know", () => {
    const { dir, env } = workspace();
    assert.throws(
      () => appSetStatus({ repoRoot: dir, env, id: "app-1", to: "bogus-status" }),
      (error) => error.code === "BAD_STATUS" && /applied/.test(error.message)
    );
  });

  it("accepts a stage configured in tracker.stages", () => {
    const { dir, env } = workspace();
    kvUpsert({
      repoRoot: dir,
      env,
      key: "stages",
      value: [{ id: "panel", label: "Panel", order: 40, patterns: ["onsite loop"] }],
    });
    assert.equal(appSetStatus({ repoRoot: dir, env, id: "app-1", to: "panel" }).to, "panel");
    assert.equal(
      appSetStatus({ repoRoot: dir, env, id: "app-1", to: "Onsite loop booked" }).to,
      "Onsite loop booked"
    );
    assert.throws(
      () => appSetStatus({ repoRoot: dir, env, id: "app-1", to: "bogus-status" }),
      (error) => error.code === "BAD_STATUS"
    );
  });

  it("rejects submitted-unverified, which is a run result and not a status", () => {
    const { dir, env } = workspace();
    assert.throws(
      () => appSetStatus({ repoRoot: dir, env, id: "app-1", to: "submitted-unverified" }),
      (error) => error.code === "BAD_STATUS"
    );
  });

  it("stamps appliedAt when a row moves to an applied status", () => {
    const { dir, env } = workspace();
    const result = appSetStatus({ repoRoot: dir, env, id: "app-1", to: "awaiting" });
    assert.ok(result.appliedAt, "appliedAt is set");
    assert.ok(!Number.isNaN(Date.parse(result.appliedAt)));
  });

  it("does not stamp appliedAt for a rejection of a role never applied to", () => {
    const { dir, env } = workspace();
    const result = appSetStatus({ repoRoot: dir, env, id: "app-1", to: "rejected" });
    assert.equal(result.appliedAt, null);
  });
});

describe("automation status in a database workspace", () => {
  it("warns that a leftover automation.yml is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "careerrat-honesty-auto-"));
    try {
      const env = {
        ...process.env,
        CAREERRAT_HOME: join(dir, "home"),
        CAREERRAT_NO_UPDATE_CHECK: "1",
      };
      candidateSetupInitialize({ repoRoot: dir, env });
      assert.equal(automationStatus({ root: dir, env }).ignoredFile, null);
      const candidateDir = join(dir, "home", "candidate");
      mkdirSync(candidateDir, { recursive: true });
      writeFileSync(join(candidateDir, "automation.yml"), "submit: manual\n");
      const status = automationStatus({ root: dir, env });
      assert.equal(status.submit, "auto", "the file does not change the effective mode");
      assert.match(String(status.ignoredFile), /automation\.yml/);
    } finally {
      closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
