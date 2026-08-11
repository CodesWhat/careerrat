/**
 * form-questions.test.mjs — tests for src/core/apply/form-questions.mjs
 * and the src/cli/questions.mjs wrapper.
 * Run: node --test tests/form-questions.test.mjs
 *
 * Hermetic: fetchFormQuestions() is exercised only via an injected fetchImpl,
 * never real network. All fixtures are invented (no real company names/comp).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildQuestionsRequest,
  extractAshbyAppData,
  fetchFormQuestions,
  inferQuestionProvider,
  normalizeAshbyForm,
  normalizeGreenhouseQuestions,
  parseManualQuestions,
} from "../src/core/apply/form-questions.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Fixtures (invented — no real companies, comp, or names)
// ---------------------------------------------------------------------------

const GH_FIXTURE = {
  absolute_url: "https://job-boards.greenhouse.io/acmerobotics/jobs/1234567",
  questions: [
    {
      label: "First Name",
      required: true,
      fields: [{ name: "first_name", type: "input_text", values: [] }],
    },
    {
      label: "Resume/CV",
      required: false,
      fields: [
        { name: "resume", type: "input_file", values: [] },
        { name: "resume_text", type: "textarea", values: [] },
      ],
    },
    {
      label: "Do you require visa sponsorship?",
      required: true,
      fields: [
        {
          name: "question_sponsor",
          type: "multi_value_single_select",
          values: [
            { label: "Yes", value: 1 },
            { label: "No", value: 0 },
          ],
        },
      ],
    },
    {
      label: "Which offices could you work from?",
      required: true,
      fields: [
        {
          name: "question_offices",
          type: "multi_value_multi_select",
          values: [
            { label: "Austin", value: 1 },
            { label: "Remote", value: 2 },
            { label: "NYC", value: 3 },
          ],
        },
      ],
    },
    {
      label: "Why do you want to join Acme Robotics?",
      required: true,
      fields: [{ name: "question_why", type: "textarea", values: [] }],
    },
    {
      label: "Internal Tracking",
      required: false,
      fields: [{ name: "hidden_ref", type: "input_hidden", values: [] }],
    },
  ],
  location_questions: [
    {
      label: "What city are you applying from?",
      required: false,
      fields: [{ name: "city_q", type: "input_text", values: [] }],
    },
  ],
  compliance: [
    {
      type: "eeoc",
      description: "Voluntary self-identification.",
      questions: [
        {
          label: "Gender",
          required: false,
          fields: [
            {
              name: "gender",
              type: "multi_value_single_select",
              values: [{ label: "Woman", value: 1 }],
            },
          ],
        },
      ],
    },
  ],
  demographic_questions: null,
};

const GH_FIXTURE_NO_DEMOGRAPHIC = {
  absolute_url: "https://job-boards.greenhouse.io/acmerobotics/jobs/7654321",
  questions: [
    {
      label: "Email",
      required: true,
      fields: [{ name: "email", type: "input_text", values: [] }],
    },
  ],
  location_questions: [],
  compliance: [],
  demographic_questions: null,
};

function ashbyFieldEntry({
  path,
  title,
  type,
  isRequired = false,
  selectableValues,
  isDeactivated,
}) {
  return {
    field: {
      path,
      id: path,
      title,
      humanReadablePath: title,
      type,
      isDeactivated: Boolean(isDeactivated),
      ...(selectableValues ? { selectableValues } : {}),
    },
    isRequired,
  };
}

const ASHBY_POSTING = {
  applicationForm: {
    fieldEntries: [
      ashbyFieldEntry({
        path: "_systemfield_name",
        title: "Name",
        type: "String",
        isRequired: true,
      }),
      ashbyFieldEntry({
        path: "_systemfield_email",
        title: "Email",
        type: "Email",
        isRequired: true,
      }),
      ashbyFieldEntry({ path: "_systemfield_resume", title: "Resume", type: "File" }),
      ashbyFieldEntry({
        path: "cf-sponsor",
        title: "Do you require visa sponsorship?",
        type: "ValueSelect",
        isRequired: true,
        selectableValues: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
      }),
      ashbyFieldEntry({
        path: "cf-offices",
        title: "Which offices could you work from?",
        type: "MultiValueSelect",
        isRequired: true,
        selectableValues: [
          { label: "Remote", value: "remote" },
          { label: "NYC", value: "nyc" },
        ],
      }),
      ashbyFieldEntry({
        path: "cf-why",
        title: "Why do you want to join Acme Robotics?",
        type: "LongText",
        isRequired: true,
      }),
      ashbyFieldEntry({
        path: "cf-old",
        title: "Old Deactivated Question",
        type: "String",
        isDeactivated: true,
      }),
    ],
  },
  surveyForms: [
    {
      fieldEntries: [
        ashbyFieldEntry({
          path: "demo-age",
          title: "What is your age range?",
          type: "ValueSelect",
          selectableValues: [{ label: "18-24", value: "a" }],
        }),
      ],
    },
  ],
  surveyFormDefinitionIds: ["11111111-1111-4111-8111-111111111111"],
};

const ASHBY_POSTING_NO_DEMOGRAPHIC = {
  applicationForm: {
    fieldEntries: [
      ashbyFieldEntry({
        path: "_systemfield_name",
        title: "Name",
        type: "String",
        isRequired: true,
      }),
    ],
  },
  surveyForms: [],
  surveyFormDefinitionIds: [],
};

function ashbyHtmlPage(posting, extra = {}) {
  const appData = JSON.stringify({
    environment: "production",
    posting,
    ...extra,
  });
  return `<!doctype html><html><body><script nonce="abc123">
      window.__appData = ${appData};
    </script></body></html>`;
}

const ASHBY_JOB_URL = "https://jobs.ashbyhq.com/acme-robotics/00000000-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------
// inferQuestionProvider
// ---------------------------------------------------------------------------

describe("inferQuestionProvider", () => {
  it("recognizes Greenhouse hosts", () => {
    assert.equal(
      inferQuestionProvider("https://job-boards.greenhouse.io/acmerobotics/jobs/1234567"),
      "greenhouse"
    );
    assert.equal(
      inferQuestionProvider("https://job-boards.eu.greenhouse.io/acmerobotics/jobs/1234567"),
      "greenhouse"
    );
    assert.equal(
      inferQuestionProvider("https://boards.greenhouse.io/acmerobotics/jobs/1234567"),
      "greenhouse"
    );
    assert.equal(
      inferQuestionProvider(
        "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/1234567?questions=true"
      ),
      "greenhouse"
    );
  });

  it("recognizes Ashby hosts", () => {
    assert.equal(inferQuestionProvider(ASHBY_JOB_URL), "ashby");
  });

  it("returns null for unsupported hosts and malformed URLs", () => {
    assert.equal(inferQuestionProvider("https://jobs.lever.co/acme/1234"), null);
    assert.equal(inferQuestionProvider("https://acme.myworkdayjobs.com/careers/job/1"), null);
    assert.equal(inferQuestionProvider("not-a-url"), null);
    assert.equal(inferQuestionProvider(""), null);
    assert.equal(inferQuestionProvider(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// buildQuestionsRequest
// ---------------------------------------------------------------------------

describe("buildQuestionsRequest", () => {
  it("builds the Greenhouse questions=true endpoint from a job-boards.greenhouse.io URL", () => {
    const req = buildQuestionsRequest("https://job-boards.greenhouse.io/acmerobotics/jobs/1234567");
    assert.deepEqual(req, {
      provider: "greenhouse",
      url: "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/1234567?questions=true",
      responseType: "json",
    });
  });

  it("builds the same endpoint from the .eu mirror and the bare boards host", () => {
    const eu = buildQuestionsRequest(
      "https://job-boards.eu.greenhouse.io/acmerobotics/jobs/1234567"
    );
    assert.equal(
      eu.url,
      "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/1234567?questions=true"
    );

    const bare = buildQuestionsRequest("https://boards.greenhouse.io/acmerobotics/jobs/1234567");
    assert.equal(
      bare.url,
      "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/1234567?questions=true"
    );
  });

  it("passes through an already-API-form Greenhouse URL", () => {
    const req = buildQuestionsRequest(
      "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/1234567?content=true"
    );
    assert.equal(
      req.url,
      "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/1234567?questions=true"
    );
  });

  it("builds the Ashby SSR posting-page URL from org slug + uuid", () => {
    const req = buildQuestionsRequest(ASHBY_JOB_URL);
    assert.deepEqual(req, {
      provider: "ashby",
      url: ASHBY_JOB_URL,
      responseType: "html",
    });
  });

  it("returns null for unsupported hosts or URLs missing the ids it needs", () => {
    assert.equal(buildQuestionsRequest("https://jobs.lever.co/acme/1234"), null);
    // Greenhouse host but no /jobs/{id} — e.g. a bare careers listing page.
    assert.equal(buildQuestionsRequest("https://job-boards.greenhouse.io/acmerobotics"), null);
    // Ashby host but no uuid in the path.
    assert.equal(buildQuestionsRequest("https://jobs.ashbyhq.com/acme-robotics"), null);
  });
});

// ---------------------------------------------------------------------------
// normalizeGreenhouseQuestions
// ---------------------------------------------------------------------------

describe("normalizeGreenhouseQuestions", () => {
  it("normalizes required flags, select options, file fields, and drops hidden fields", () => {
    const result = normalizeGreenhouseQuestions(GH_FIXTURE, {
      fetchedAt: "2026-07-02T00:00:00.000Z",
    });

    assert.equal(result.source, "greenhouse");
    assert.equal(result.url, GH_FIXTURE.absolute_url);
    assert.equal(result.fetchedAt, "2026-07-02T00:00:00.000Z");

    const byLabel = Object.fromEntries(result.questions.map((q) => [q.label, q]));

    assert.equal(byLabel["First Name"].type, "text");
    assert.equal(byLabel["First Name"].required, true);

    // Resume/CV has both input_file and textarea fields — file wins.
    assert.equal(byLabel["Resume/CV"].type, "file");
    assert.equal(byLabel["Resume/CV"].id, "resume");
    assert.equal(byLabel["Resume/CV"].required, false);

    // Yes/No single-select is normalized to boolean.
    assert.equal(byLabel["Do you require visa sponsorship?"].type, "boolean");
    assert.equal(byLabel["Do you require visa sponsorship?"].options, null);

    // Multi-select keeps its option labels.
    assert.deepEqual(byLabel["Which offices could you work from?"].type, "multiselect");
    assert.deepEqual(byLabel["Which offices could you work from?"].options, [
      "Austin",
      "Remote",
      "NYC",
    ]);

    assert.equal(byLabel["Why do you want to join Acme Robotics?"].type, "textarea");

    // Hidden-only field and its question block are dropped entirely.
    assert.equal(byLabel["Internal Tracking"], undefined);

    // location_questions are folded into questions[].
    assert.equal(byLabel["What city are you applying from?"].type, "text");
  });

  it("flags demographicSectionPresent when compliance carries EEOC questions", () => {
    const result = normalizeGreenhouseQuestions(GH_FIXTURE);
    assert.equal(result.demographicSectionPresent, true);

    // The EEOC question itself never appears in questions[].
    assert.ok(!result.questions.some((q) => q.label === "Gender"));
  });

  it("reports demographicSectionPresent: false when no compliance/demographic content is present", () => {
    const result = normalizeGreenhouseQuestions(GH_FIXTURE_NO_DEMOGRAPHIC);
    assert.equal(result.demographicSectionPresent, false);
    assert.equal(result.questions.length, 1);
  });

  it("handles a missing/empty response defensively", () => {
    const result = normalizeGreenhouseQuestions({});
    assert.deepEqual(result.questions, []);
    assert.equal(result.demographicSectionPresent, false);
    assert.equal(result.url, "");
  });
});

// ---------------------------------------------------------------------------
// extractAshbyAppData
// ---------------------------------------------------------------------------

describe("extractAshbyAppData", () => {
  it("extracts the posting object from an embedded window.__appData blob", () => {
    const html = ashbyHtmlPage(ASHBY_POSTING);
    const posting = extractAshbyAppData(html);
    assert.deepEqual(posting, ASHBY_POSTING);
  });

  it("returns null when the marker is absent", () => {
    assert.equal(extractAshbyAppData("<html><body>no app data here</body></html>"), null);
  });

  it("returns null on malformed JSON after the marker", () => {
    assert.equal(extractAshbyAppData("<script>window.__appData = {not valid json</script>"), null);
  });

  it("returns null when the parsed object has no posting key", () => {
    const html = `<script>window.__appData = ${JSON.stringify({ environment: "production" })};</script>`;
    assert.equal(extractAshbyAppData(html), null);
  });
});

// ---------------------------------------------------------------------------
// normalizeAshbyForm
// ---------------------------------------------------------------------------

describe("normalizeAshbyForm", () => {
  it("normalizes required flags, select/multiselect options, file fields, and drops deactivated fields", () => {
    const result = normalizeAshbyForm(ASHBY_POSTING, {
      url: ASHBY_JOB_URL,
      fetchedAt: "2026-07-02T00:00:00.000Z",
    });

    assert.equal(result.source, "ashby");
    assert.equal(result.url, ASHBY_JOB_URL);
    assert.equal(result.fetchedAt, "2026-07-02T00:00:00.000Z");

    const byLabel = Object.fromEntries(result.questions.map((q) => [q.label, q]));

    assert.equal(byLabel.Name.type, "text");
    assert.equal(byLabel.Name.required, true);
    assert.equal(byLabel.Resume.type, "file");

    assert.equal(byLabel["Do you require visa sponsorship?"].type, "boolean");
    assert.equal(byLabel["Do you require visa sponsorship?"].options, null);

    assert.deepEqual(byLabel["Which offices could you work from?"].options, ["Remote", "NYC"]);
    assert.equal(byLabel["Why do you want to join Acme Robotics?"].type, "textarea");

    // Deactivated field never appears.
    assert.equal(byLabel["Old Deactivated Question"], undefined);
  });

  it("flags demographicSectionPresent when surveyForms carries fields, and excludes them from questions[]", () => {
    const result = normalizeAshbyForm(ASHBY_POSTING);
    assert.equal(result.demographicSectionPresent, true);
    assert.ok(!result.questions.some((q) => q.label === "What is your age range?"));
  });

  it("reports demographicSectionPresent: false with no survey forms", () => {
    const result = normalizeAshbyForm(ASHBY_POSTING_NO_DEMOGRAPHIC);
    assert.equal(result.demographicSectionPresent, false);
  });

  it("handles a missing/empty posting defensively", () => {
    const result = normalizeAshbyForm(null);
    assert.deepEqual(result.questions, []);
    assert.equal(result.demographicSectionPresent, false);
  });
});

// ---------------------------------------------------------------------------
// parseManualQuestions
// ---------------------------------------------------------------------------

describe("parseManualQuestions", () => {
  it("parses numbered lines", () => {
    const result = parseManualQuestions(
      "1. What is your favorite color?\n2) Describe your experience."
    );
    assert.equal(result.source, "manual");
    assert.deepEqual(
      result.questions.map((q) => q.label),
      ["What is your favorite color?", "Describe your experience."]
    );
    assert.ok(result.questions.every((q) => q.required === true && q.type === "text"));
    assert.deepEqual(
      result.questions.map((q) => q.id),
      ["q1", "q2"]
    );
  });

  it("parses bulleted lines (-, *, bullet char)", () => {
    const result = parseManualQuestions(
      "- Are you authorized to work in the US?\n* Do you require sponsorship\n• Why us?"
    );
    assert.deepEqual(
      result.questions.map((q) => q.label),
      ["Are you authorized to work in the US?", "Do you require sponsorship", "Why us?"]
    );
  });

  it("picks up bare lines ending in a question mark, or reading as an imperative prompt", () => {
    const result = parseManualQuestions(
      "Please answer the following:\nWhat's your notice period?\nThanks for applying."
    );
    assert.deepEqual(
      result.questions.map((q) => q.label),
      ["Please answer the following:", "What's your notice period?"]
    );
  });

  it("still drops a bare line that neither ends in '?' nor reads as an imperative prompt", () => {
    const result = parseManualQuestions("Thanks for applying.\nWe look forward to your reply.");
    assert.deepEqual(result.questions, []);
  });

  it("ignores blank lines and returns an empty list for non-question text", () => {
    const result = parseManualQuestions("\n\nJust a paragraph with no questions.\n\n");
    assert.deepEqual(result.questions, []);
    assert.equal(result.source, "manual");
  });

  it("defaults url/fetchedAt sanely and accepts overrides", () => {
    const result = parseManualQuestions("1. Hello?", { url: "https://example.com/job/1" });
    assert.equal(result.url, "https://example.com/job/1");
    assert.ok(typeof result.fetchedAt === "string" && result.fetchedAt.length > 0);
  });
});

// ---------------------------------------------------------------------------
// fetchFormQuestions (hermetic — injected fetchImpl only)
// ---------------------------------------------------------------------------

describe("fetchFormQuestions", () => {
  it("fetches and normalizes a Greenhouse job, hitting the derived questions=true URL", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => GH_FIXTURE };
    };

    const result = await fetchFormQuestions(
      "https://job-boards.greenhouse.io/acmerobotics/jobs/1234567",
      { fetchImpl }
    );

    assert.deepEqual(calls, [
      "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/1234567?questions=true",
    ]);
    assert.equal(result.source, "greenhouse");
    assert.ok(result.questions.length > 0);
  });

  it("fetches and normalizes an Ashby job by extracting the SSR page's embedded form", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => ashbyHtmlPage(ASHBY_POSTING) };
    };

    const result = await fetchFormQuestions(ASHBY_JOB_URL, { fetchImpl });

    assert.deepEqual(calls, [ASHBY_JOB_URL]);
    assert.equal(result.source, "ashby");
    assert.ok(result.questions.length > 0);
  });

  it("throws a clear error for an unsupported host without calling fetchImpl", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      throw new Error("should not be called");
    };

    await assert.rejects(
      fetchFormQuestions("https://jobs.lever.co/acme/1234", { fetchImpl }),
      /unsupported host/i
    );
    assert.equal(called, false);
  });

  it("throws a clear 404 error when the posting is gone", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });

    await assert.rejects(
      fetchFormQuestions("https://job-boards.greenhouse.io/acmerobotics/jobs/1234567", {
        fetchImpl,
      }),
      /404/
    );
  });

  it("throws a clear error on a non-2xx status other than 404", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });

    await assert.rejects(
      fetchFormQuestions("https://job-boards.greenhouse.io/acmerobotics/jobs/1234567", {
        fetchImpl,
      }),
      /HTTP 500/
    );
  });

  it("throws a clear error on a non-JSON Greenhouse response", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });

    await assert.rejects(
      fetchFormQuestions("https://job-boards.greenhouse.io/acmerobotics/jobs/1234567", {
        fetchImpl,
      }),
      /non-json/i
    );
  });

  it("throws a clear error when the Ashby page has no embedded application form", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => "<html><body>not the app you're looking for</body></html>",
    });

    await assert.rejects(
      fetchFormQuestions(ASHBY_JOB_URL, { fetchImpl }),
      /embedded application form/i
    );
  });
});

// ---------------------------------------------------------------------------
// CLI smoke tests (src/cli/questions.mjs) — --paste path only, no network
// ---------------------------------------------------------------------------

function runCli(args, { input } = {}) {
  return spawnSync(process.execPath, ["src/cli/questions.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    input,
  });
}

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "careerrat-questions-"));
}

const FIXTURE_JOB_MD = `---
company: "Acme Robotics"
role: "Senior Widget Engineer"
source: "https://jobs.ashbyhq.com/acme-robotics/00000000-0000-4000-8000-000000000000"
---

# Senior Widget Engineer - Acme Robotics

Body text.
`;

describe("questions CLI", () => {
  it("--help exits 0 and prints usage", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /careerrat questions/);
    assert.match(result.stdout, /--paste/);
  });

  it("exits 1 with no args", () => {
    const result = runCli([]);
    assert.equal(result.status, 1);
  });

  it("exits 1 for a saved-job path that does not exist", () => {
    const result = runCli(["workspace/jobs/does-not-exist.md"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not found/i);
  });

  it("exits 1 when the saved job has no source frontmatter key", () => {
    const dir = tempWorkspace();
    try {
      const jobPath = join(dir, "no-source.md");
      writeFileSync(jobPath, '---\ncompany: "Acme Robotics"\nrole: "Engineer"\n---\nBody.\n');

      const result = runCli([jobPath]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /expected a "source" key/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--paste parses stdin and writes <jobfile>.questions.json next to a saved job", () => {
    const dir = tempWorkspace();
    try {
      const jobPath = join(dir, "acme-robotics-senior-widget-engineer.md");
      writeFileSync(jobPath, FIXTURE_JOB_MD);

      const result = runCli([jobPath, "--paste"], {
        input: "1. Why do you want to work here?\n2. What is your notice period?\n",
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /2 questions \(2 required\)/);
      assert.match(result.stdout, /Wrote /);

      const written = JSON.parse(readFileSync(`${jobPath}.questions.json`, "utf8"));
      assert.equal(written.source, "manual");
      assert.equal(written.questions.length, 2);
      assert.equal(written.questions[0].label, "Why do you want to work here?");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--paste with a bare URL prints JSON to stdout and writes no file", () => {
    const result = runCli(["https://jobs.lever.co/acme/1234", "--paste"], {
      input: "Are you legally authorized to work?\n",
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.source, "manual");
    assert.equal(parsed.questions.length, 1);
  });

  it("--paste with empty stdin exits 1", () => {
    const result = runCli(["https://jobs.lever.co/acme/1234", "--paste"], { input: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs question text/i);
  });
});
