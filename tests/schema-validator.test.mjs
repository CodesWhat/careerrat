import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatErrors, validate } from "../src/core/profile/schema-validator.mjs";

// ---------------------------------------------------------------------------
// Load real schemas from config/
// ---------------------------------------------------------------------------

const CONFIG_DIR = new URL("../config/", import.meta.url).pathname;

function loadSchema(name) {
  return JSON.parse(readFileSync(`${CONFIG_DIR}${name}`, "utf8"));
}

const profileSchema = loadSchema("profile.schema.json");
const formDefaultsSchema = loadSchema("form-defaults.schema.json");
const targetingSchema = loadSchema("targeting.schema.json");
const searchSourcesSchema = loadSchema("search-sources.schema.json");

// ---------------------------------------------------------------------------
// Fixture helpers — minimal valid objects mirroring template examples
// ---------------------------------------------------------------------------

function makeProfile(overrides = {}) {
  return {
    candidate: {
      full_name: "Jane Candidate",
      email: "jane@example.com",
    },
    compensation: {
      currency: "USD",
      current_comp_shareable: false,
      current_base: null,
      target_base: 165000,
      cash_over_equity: true,
    },
    location: {
      home: "New York, NY",
      remote: true,
    },
    authorization: {
      work_authorized: true,
    },
    ...overrides,
  };
}

function makeTargeting(overrides = {}) {
  return {
    role_buckets: [
      {
        name: "Primary",
        priority: "primary",
        titles: ["Forward Deployed Engineer"],
      },
    ],
    keep_signals: ["customer-facing"],
    cut_signals: ["core platform SWE"],
    ...overrides,
  };
}

function makeSearchSources(overrides = {}) {
  return {
    searches: [
      {
        provider: "HiringCafe",
        label: "FDE roles",
        enabled: true,
        query: "forward deployed engineer",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Profile — valid
// ---------------------------------------------------------------------------

test("profile: valid complete object → { valid: true, errors: [] }", () => {
  const result = validate(makeProfile(), profileSchema);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("profile: negative compensation values are rejected", () => {
  const data = makeProfile();
  data.compensation.expected_base = -1;
  const result = validate(data, profileSchema);

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.path === "compensation.expected_base" && /at least 0/.test(error.message)
    ),
    `expected a non-negative compensation error, got: ${JSON.stringify(result.errors)}`
  );
});

test("form defaults: negative expected base is rejected", () => {
  const result = validate({ expected_base: -1 }, formDefaultsSchema);

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.path === "expected_base" && /at least 0/.test(error.message)
    )
  );
});

test("form defaults: final submission has no configurable setting", () => {
  const defaults = validate({}, formDefaultsSchema);
  assert.equal(defaults.valid, true, JSON.stringify(defaults.errors));

  const removedSetting = validate({ auto_submit: false }, formDefaultsSchema);
  assert.equal(removedSetting.valid, false);
  assert.ok(
    removedSetting.errors.some(
      (error) => error.path === "auto_submit" && /unexpected property/.test(error.message)
    ),
    JSON.stringify(removedSetting.errors)
  );
});

// ---------------------------------------------------------------------------
// Profile — missing required property
// ---------------------------------------------------------------------------

test("profile: missing candidate.email → invalid, error at candidate path mentions email", () => {
  const data = makeProfile();
  data.candidate = { full_name: "Jane Candidate" }; // no email
  const result = validate(data, profileSchema);
  assert.equal(result.valid, false);
  const emailError = result.errors.find(
    (e) => e.path === "candidate" && e.message.includes("email")
  );
  assert.ok(
    emailError,
    `expected error at path 'candidate' mentioning 'email', got: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// Profile — additionalProperties: false at top level
// ---------------------------------------------------------------------------

test("profile: extra top-level key (additionalProperties:false) → unexpected property error", () => {
  const data = makeProfile({ sneaky_extra: "oops" });
  const result = validate(data, profileSchema);
  assert.equal(result.valid, false);
  const extra = result.errors.find(
    (e) => e.message.includes("unexpected property") && e.message.includes("sneaky_extra")
  );
  assert.ok(extra, `expected unexpected-property error, got: ${JSON.stringify(result.errors)}`);
});

// ---------------------------------------------------------------------------
// Profile — type union ["number", "null"]
// ---------------------------------------------------------------------------

test("profile: compensation.current_base accepts null", () => {
  const data = makeProfile();
  data.compensation.current_base = null;
  const result = validate(data, profileSchema);
  assert.equal(result.valid, true);
});

test("profile: compensation.current_base accepts a number", () => {
  const data = makeProfile();
  data.compensation.current_base = 180000;
  const result = validate(data, profileSchema);
  assert.equal(result.valid, true);
});

test("profile: compensation.current_base rejects a string", () => {
  const data = makeProfile();
  data.compensation.current_base = "a lot";
  const result = validate(data, profileSchema);
  assert.equal(result.valid, false);
  const typeError = result.errors.find(
    (e) => e.path === "compensation.current_base" && e.message.includes("expected type")
  );
  assert.ok(
    typeError,
    `expected type error at compensation.current_base, got: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// Targeting — enum validation
// ---------------------------------------------------------------------------

test("targeting: valid → { valid: true, errors: [] }", () => {
  const result = validate(makeTargeting(), targetingSchema);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("targeting: role_buckets[0].priority 'bogus' → invalid enum at role_buckets[0].priority", () => {
  const data = makeTargeting();
  data.role_buckets[0].priority = "bogus";
  const result = validate(data, targetingSchema);
  assert.equal(result.valid, false);
  const enumError = result.errors.find(
    (e) =>
      e.path === "role_buckets[0].priority" && e.message.includes("not one of the allowed values")
  );
  assert.ok(
    enumError,
    `expected enum error at role_buckets[0].priority, got: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// Search-sources — anyOf
// ---------------------------------------------------------------------------

test("search-sources: valid search with query → { valid: true, errors: [] }", () => {
  const result = validate(makeSearchSources(), searchSourcesSchema);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("search-sources: valid search with url (no query) → valid", () => {
  const data = makeSearchSources({
    searches: [
      {
        provider: "LinkedIn",
        label: "LinkedIn search",
        enabled: true,
        url: "https://linkedin.com/jobs/search",
      },
    ],
  });
  const result = validate(data, searchSourcesSchema);
  assert.equal(result.valid, true);
});

test("search-sources: valid search with rssUrl (no query/url) → valid", () => {
  const data = makeSearchSources({
    searches: [
      {
        provider: "RSS Feed",
        label: "My RSS",
        enabled: true,
        rssUrl: "https://example.com/feed.rss",
      },
    ],
  });
  const result = validate(data, searchSourcesSchema);
  assert.equal(result.valid, true);
});

test("search-sources: searches item missing all of query/url/rssUrl → invalid (anyOf)", () => {
  const data = makeSearchSources({
    searches: [
      {
        provider: "Mystery",
        label: "No source",
        enabled: false,
        // intentionally omit query, url, rssUrl
      },
    ],
  });
  const result = validate(data, searchSourcesSchema);
  assert.equal(result.valid, false);
  const anyOfError = result.errors.find(
    (e) => e.path === "searches[0]" && e.message.includes("anyOf")
  );
  assert.ok(
    anyOfError,
    `expected anyOf error at searches[0], got: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// source_catalog — additionalProperties with object subschema
// ---------------------------------------------------------------------------

test("search-sources: source_catalog validates additionalProperties as arrays of strings", () => {
  const data = makeSearchSources({
    source_catalog: {
      aggregators: ["HiringCafe", "Ashby"],
      ats: ["Greenhouse"],
    },
  });
  const result = validate(data, searchSourcesSchema);
  assert.equal(result.valid, true);
});

test("search-sources: source_catalog with invalid array item type → invalid", () => {
  const data = makeSearchSources({
    source_catalog: {
      aggregators: [42], // should be strings
    },
  });
  const result = validate(data, searchSourcesSchema);
  assert.equal(result.valid, false);
  const typeError = result.errors.find(
    (e) => e.path.startsWith("source_catalog.aggregators[") && e.message.includes("expected type")
  );
  assert.ok(
    typeError,
    `expected type error inside source_catalog.aggregators, got: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// formatErrors
// ---------------------------------------------------------------------------

test("formatErrors: returns one line per error", () => {
  const data = makeProfile({ sneaky: "extra" });
  data.candidate = {}; // missing full_name and email
  const { errors } = validate(data, profileSchema);
  assert.ok(errors.length >= 2, `expected at least 2 errors, got ${errors.length}`);
  const formatted = formatErrors(errors);
  const lines = formatted.split("\n");
  assert.equal(lines.length, errors.length);
});

test("formatErrors: empty path shown as (root)", () => {
  // Validate a non-object against the profile schema to trigger a root-level error.
  const { errors } = validate("not an object", profileSchema);
  assert.ok(errors.length > 0, "expected at least one error");
  const formatted = formatErrors(errors);
  assert.ok(formatted.includes("(root)"), `expected (root) in output, got: ${formatted}`);
});

test("formatErrors: each line contains path and message separated by colon", () => {
  const data = makeTargeting();
  data.role_buckets[0].priority = "wrong";
  const { errors } = validate(data, targetingSchema);
  const formatted = formatErrors(errors);
  const lines = formatted.split("\n");
  for (const line of lines) {
    assert.ok(line.includes(":"), `line should contain ':': ${line}`);
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("validate: collects ALL errors, does not stop at first", () => {
  // Missing all required top-level fields and an extra field
  const data = { sneaky: true };
  const { errors } = validate(data, profileSchema);
  // Should have errors for all 4 missing required fields plus the extra property
  assert.ok(
    errors.length >= 4,
    `expected at least 4 errors, got ${errors.length}: ${JSON.stringify(errors)}`
  );
});

test("validate: nested required fields validated correctly", () => {
  const data = makeProfile();
  data.candidate = { email: "x@x.com" }; // missing full_name
  const { errors } = validate(data, profileSchema);
  assert.ok(errors.length > 0);
  const nameErr = errors.find((e) => e.path === "candidate" && e.message.includes("full_name"));
  assert.ok(nameErr, `expected missing full_name error, got: ${JSON.stringify(errors)}`);
});

test("validate: array items type-checked", () => {
  const data = makeTargeting();
  data.keep_signals = ["valid", 42]; // 42 is not a string
  const { errors } = validate(data, targetingSchema);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, "keep_signals[1]");
  assert.ok(errors[0].message.includes("expected type string"));
});

// ---------------------------------------------------------------------------
// minItems / maxItems
// ---------------------------------------------------------------------------

test("validate: array shorter than minItems is rejected", () => {
  const schema = { type: "array", items: { type: "string" }, minItems: 2 };
  const result = validate(["only-one"], schema);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === "");
  assert.ok(error, `expected a root-level error, got: ${JSON.stringify(result.errors)}`);
  assert.equal(error.message, "must have at least 2 items");
});

test("validate: array longer than maxItems is rejected", () => {
  const schema = { type: "array", items: { type: "string" }, maxItems: 3 };
  const result = validate(["a", "b", "c", "d"], schema);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === "");
  assert.ok(error, `expected a root-level error, got: ${JSON.stringify(result.errors)}`);
  assert.equal(error.message, "must have at most 3 items");
});

test("validate: array within minItems/maxItems range is valid", () => {
  const schema = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 };
  const result = validate(["a", "b"], schema);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validate: maxItems violation on a nested property reports the property's path", () => {
  const schema = {
    type: "object",
    properties: {
      fitReasons: { type: "array", maxItems: 3, items: { type: "string" } },
    },
  };
  const result = validate({ fitReasons: ["a", "b", "c", "d"] }, schema);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === "fitReasons");
  assert.ok(error, `expected an error at fitReasons, got: ${JSON.stringify(result.errors)}`);
  assert.equal(error.message, "must have at most 3 items");
});

// ---------------------------------------------------------------------------
// minLength / maxLength
// ---------------------------------------------------------------------------

test("validate: string shorter than minLength is rejected", () => {
  const schema = { type: "string", minLength: 5 };
  const result = validate("hi", schema);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === "");
  assert.ok(error, `expected a root-level error, got: ${JSON.stringify(result.errors)}`);
  assert.equal(error.message, "must have at least 5 characters");
});

test("validate: string longer than maxLength is rejected", () => {
  const schema = { type: "string", maxLength: 3 };
  const result = validate("too long", schema);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === "");
  assert.ok(error, `expected a root-level error, got: ${JSON.stringify(result.errors)}`);
  assert.equal(error.message, "must have at most 3 characters");
});

test("validate: string within minLength/maxLength range is valid", () => {
  const schema = { type: "string", minLength: 1, maxLength: 10 };
  const result = validate("just right", schema);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validate: maxLength violation on a nested property reports the property's path", () => {
  const schema = {
    type: "object",
    properties: {
      fitSummary: { type: "string", maxLength: 10 },
    },
  };
  const result = validate({ fitSummary: "way too long for this field" }, schema);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === "fitSummary");
  assert.ok(error, `expected an error at fitSummary, got: ${JSON.stringify(result.errors)}`);
  assert.equal(error.message, "must have at most 10 characters");
});
