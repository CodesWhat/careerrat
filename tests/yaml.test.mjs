import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseYaml, stringifyYaml } from "../src/core/profile/yaml.mjs";

// ---------------------------------------------------------------------------
// Helper: read a template or config YAML file.
// ---------------------------------------------------------------------------

const TEMPLATE_DIR = new URL("../templates/", import.meta.url).pathname;
const CONFIG_DIR = new URL("../config/", import.meta.url).pathname;

function readTemplate(name) {
  return readFileSync(`${TEMPLATE_DIR}${name}`, "utf8");
}

function readConfig(name) {
  return readFileSync(`${CONFIG_DIR}${name}`, "utf8");
}

// ---------------------------------------------------------------------------
// profile.example.yml
// ---------------------------------------------------------------------------

test("parses profile.example.yml — top-level sections present", () => {
  const profile = parseYaml(readTemplate("profile.example.yml"));
  assert.ok(profile.candidate, "candidate section present");
  assert.ok(profile.compensation, "compensation section present");
  assert.ok(profile.location, "location section present");
  assert.ok(profile.authorization, "authorization section present");
});

test("parses profile.example.yml — candidate fields", () => {
  const { candidate } = parseYaml(readTemplate("profile.example.yml"));
  assert.equal(candidate.email, "jane@example.com");
  assert.equal(candidate.full_name, "Jane Candidate");
  assert.equal(candidate.preferred_name, "Jane");
  assert.equal(candidate.phone, "+1-555-0100");
  assert.equal(candidate.location, "New York, NY");
  assert.match(candidate.linkedin, /linkedin\.com/);
});

test("parses profile.example.yml — compensation nulls, numbers, booleans", () => {
  const { compensation } = parseYaml(readTemplate("profile.example.yml"));
  assert.equal(compensation.currency, "USD");
  assert.equal(compensation.current_comp_shareable, false);
  assert.equal(compensation.current_base, null);
  assert.equal(compensation.target_base, 165000);
  assert.equal(compensation.minimum_base, 140000);
  assert.equal(compensation.target_total_comp, null);
  assert.equal(compensation.cash_over_equity, true);
});

test("parses profile.example.yml — location booleans and empty array", () => {
  const { location } = parseYaml(readTemplate("profile.example.yml"));
  assert.equal(location.remote, true);
  assert.equal(location.onsite, false);
  assert.deepEqual(location.relocation, []);
});

test("parses profile.example.yml — authorization string value", () => {
  const { authorization } = parseYaml(readTemplate("profile.example.yml"));
  assert.equal(authorization.work_authorized, true);
  assert.equal(authorization.notice_period, "2 weeks");
});

// ---------------------------------------------------------------------------
// targeting.example.yml
// ---------------------------------------------------------------------------

test("parses targeting.example.yml — role_buckets sequence of mappings", () => {
  const targeting = parseYaml(readTemplate("targeting.example.yml"));
  assert.ok(Array.isArray(targeting.role_buckets));
  assert.equal(targeting.role_buckets.length, 2);
  assert.equal(targeting.role_buckets[0].name, "Primary");
  assert.equal(targeting.role_buckets[0].priority, "primary");
});

test("parses targeting.example.yml — nested titles array in sequence item", () => {
  const { role_buckets } = parseYaml(readTemplate("targeting.example.yml"));
  assert.ok(Array.isArray(role_buckets[0].titles));
  assert.equal(role_buckets[0].titles[0], "Forward Deployed Engineer");
  assert.equal(role_buckets[0].titles[1], "Applied AI Engineer");
  assert.equal(role_buckets[1].titles[0], "Solutions Engineer");
});

test("parses targeting.example.yml — excluded_companies is a non-empty string list", () => {
  const targeting = parseYaml(readTemplate("targeting.example.yml"));
  // Jane's example carries illustrative exclusions (moved out of code so the
  // scanner has no hardcoded company bias). Assert shape, not specific names.
  assert.ok(Array.isArray(targeting.excluded_companies));
  assert.ok(targeting.excluded_companies.length > 0);
  assert.ok(targeting.excluded_companies.every((c) => typeof c === "string" && c.length > 0));
});

test("parses targeting.example.yml — scalar arrays and string value", () => {
  const targeting = parseYaml(readTemplate("targeting.example.yml"));
  assert.ok(Array.isArray(targeting.keep_signals));
  assert.equal(targeting.keep_signals[0], "customer-facing deploy-and-adopt");
  assert.ok(targeting.cut_signals.includes("core platform SWE"));
  assert.equal(typeof targeting.degree_policy, "string");
  assert.match(targeting.degree_policy, /Do not fabricate/);
});

// ---------------------------------------------------------------------------
// evidence.example.yml
// ---------------------------------------------------------------------------

test("parses evidence.example.yml — claims array of objects with nested arrays", () => {
  const evidence = parseYaml(readTemplate("evidence.example.yml"));
  assert.ok(Array.isArray(evidence.claims));
  const claim = evidence.claims[0];
  assert.equal(claim.id, "project-001");
  assert.ok(typeof claim.claim === "string");
  assert.ok(Array.isArray(claim.metrics));
  assert.ok(Array.isArray(claim.links));
  assert.ok(Array.isArray(claim.role_signals));
  assert.ok(Array.isArray(claim.allowed_wording));
  assert.ok(Array.isArray(claim.forbidden_wording));
});

// ---------------------------------------------------------------------------
// honesty.example.yml
// ---------------------------------------------------------------------------

test("parses honesty.example.yml — education null and boolean", () => {
  const honesty = parseYaml(readTemplate("honesty.example.yml"));
  assert.equal(honesty.education.highest_degree, null);
  assert.equal(honesty.education.add_education_section, false);
});

test("parses honesty.example.yml — tools nested arrays", () => {
  const { tools } = parseYaml(readTemplate("honesty.example.yml"));
  assert.ok(Array.isArray(tools.confirmed));
  assert.ok(Array.isArray(tools.adjacent));
  assert.ok(Array.isArray(tools.do_not_claim));
  assert.equal(tools.confirmed[0], "Example Tool");
});

test("parses honesty.example.yml — nested claims and style arrays", () => {
  const honesty = parseYaml(readTemplate("honesty.example.yml"));
  assert.ok(Array.isArray(honesty.claims.do_not_fabricate));
  assert.ok(honesty.claims.do_not_fabricate.includes("degrees"));
  assert.ok(Array.isArray(honesty.style.avoid));
});

// ---------------------------------------------------------------------------
// form-defaults.example.yml
// ---------------------------------------------------------------------------

test("parses form-defaults.example.yml — string, null, boolean fields", () => {
  const fd = parseYaml(readTemplate("form-defaults.example.yml"));
  assert.equal(fd.source, "Job Board");
  assert.equal(fd.work_authorization, "Yes");
  assert.equal(fd.requires_sponsorship, "No");
  assert.equal(fd.current_employer, null);
  assert.equal(fd.current_title, null);
  assert.equal(fd.expected_base, null);
  assert.equal(fd.eeo_default, "Prefer not to answer");
  assert.deepEqual(fd.screening_answers, {});
  assert.equal(fd.confirm_current_role, false);
  assert.equal("auto_submit" in fd, false);
});

// ---------------------------------------------------------------------------
// search-sources.example.yml
// ---------------------------------------------------------------------------

test("parses search-sources.example.yml — ignores leading comment line", () => {
  const ss = parseYaml(readConfig("search-sources.example.yml"));
  assert.ok(ss.title_filter, "title_filter present despite leading comment");
});

test("parses search-sources.example.yml — nested filter arrays", () => {
  const { title_filter, location_filter } = parseYaml(readConfig("search-sources.example.yml"));
  assert.ok(Array.isArray(title_filter.positive));
  assert.ok(title_filter.positive.length > 0);
  assert.ok(title_filter.positive.every((t) => typeof t === "string"));
  assert.ok(Array.isArray(title_filter.negative));
  assert.ok(title_filter.negative.length > 0);
  assert.ok(Array.isArray(location_filter.always_allow));
  assert.ok(Array.isArray(location_filter.block));
});

test("parses search-sources.example.yml — searches sequence with nested objects", () => {
  const { searches } = parseYaml(readConfig("search-sources.example.yml"));
  assert.ok(Array.isArray(searches));
  assert.equal(searches[0].provider, "HiringCafe");
  assert.equal(searches[0].source_type, "url-query");
  assert.equal(searches[0].enabled, true);
  assert.equal(searches[0].recency.mode, "since-last-run");
  assert.equal(searches[0].recency.safetyMinutes, 30);
  assert.equal(searches[0].searchState.sortBy, "date");
});

test("parses search-sources.example.yml — tracked_companies empty array", () => {
  const ss = parseYaml(readConfig("search-sources.example.yml"));
  assert.deepEqual(ss.tracked_companies, []);
});

test("parses search-sources.example.yml — source_catalog object of arrays", () => {
  const { source_catalog } = parseYaml(readConfig("search-sources.example.yml"));
  assert.ok(Array.isArray(source_catalog.aggregators));
  assert.ok(source_catalog.aggregators.includes("HiringCafe"));
  assert.ok(Array.isArray(source_catalog.ats));
  assert.ok(source_catalog.ats.includes("Ashby"));
  assert.ok(Array.isArray(source_catalog.remote_boards));
  assert.ok(source_catalog.remote_boards.includes("RemoteOK"));
});

// ---------------------------------------------------------------------------
// Comment handling
// ---------------------------------------------------------------------------

test("strips full-line comments", () => {
  const yaml = `# this is a comment
key: value`;
  assert.deepEqual(parseYaml(yaml), { key: "value" });
});

test("strips inline comments from unquoted values", () => {
  const yaml = `key: value # inline comment`;
  assert.deepEqual(parseYaml(yaml), { key: "value" });
});

test("preserves # inside double-quoted strings", () => {
  const yaml = `key: "value # not a comment"`;
  assert.deepEqual(parseYaml(yaml), { key: "value # not a comment" });
});

// ---------------------------------------------------------------------------
// Quoted strings with special characters
// ---------------------------------------------------------------------------

test("parses quoted string containing colon", () => {
  const yaml = `key: "https://example.com/path"`;
  assert.deepEqual(parseYaml(yaml), { key: "https://example.com/path" });
});

test("parses quoted string with escaped quote", () => {
  const yaml = `key: "say \\"hello\\""`;
  assert.deepEqual(parseYaml(yaml), { key: 'say "hello"' });
});

test("parses single-quoted string", () => {
  const yaml = `key: 'it''s alive'`;
  assert.deepEqual(parseYaml(yaml), { key: "it's alive" });
});

// ---------------------------------------------------------------------------
// Scalars: booleans, numbers, null
// ---------------------------------------------------------------------------

test("parses booleans as JS booleans", () => {
  const yaml = `a: true\nb: false`;
  const v = parseYaml(yaml);
  assert.equal(v.a, true);
  assert.equal(v.b, false);
  assert.equal(typeof v.a, "boolean");
});

test("parses integers and decimals as JS numbers", () => {
  const yaml = `a: 42\nb: -7\nc: 3.14`;
  const v = parseYaml(yaml);
  assert.equal(v.a, 42);
  assert.equal(v.b, -7);
  assert.equal(v.c, 3.14);
  assert.equal(typeof v.a, "number");
});

test("parses empty value as null", () => {
  const yaml = `key:`;
  assert.deepEqual(parseYaml(yaml), { key: null });
});

test("parses explicit null and ~ as null", () => {
  const yaml = `a: null\nb: ~`;
  const v = parseYaml(yaml);
  assert.equal(v.a, null);
  assert.equal(v.b, null);
});

// ---------------------------------------------------------------------------
// Flow empties
// ---------------------------------------------------------------------------

test("parses [] as empty array", () => {
  const yaml = `key: []`;
  assert.deepEqual(parseYaml(yaml), { key: [] });
});

test("parses {} as empty object", () => {
  const yaml = `key: {}`;
  assert.deepEqual(parseYaml(yaml), { key: {} });
});

// ---------------------------------------------------------------------------
// Nested sequence-of-mappings
// ---------------------------------------------------------------------------

test("parses sequence of mappings with nested arrays", () => {
  const yaml = `items:
  - name: "Alpha"
    tags:
      - "one"
      - "two"
  - name: "Beta"
    tags:
      - "three"`;
  const v = parseYaml(yaml);
  assert.equal(v.items[0].name, "Alpha");
  assert.deepEqual(v.items[0].tags, ["one", "two"]);
  assert.equal(v.items[1].name, "Beta");
  assert.deepEqual(v.items[1].tags, ["three"]);
});

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

test("round-trip: nested objects, arrays of scalars, arrays of objects, booleans, numbers, null, empty array", () => {
  const obj = {
    meta: {
      version: 1,
      active: true,
      label: "test value",
      empty: null,
    },
    tags: ["alpha", "beta-gamma", "has:colon"],
    items: [
      { name: "First", priority: "high", score: 99, enabled: true },
      { name: "Second", priority: "low", score: 0, enabled: false },
    ],
    empty_list: [],
    nested: {
      deep: {
        value: 42,
        flag: false,
      },
    },
  };

  const yaml = stringifyYaml(obj);
  const parsed = parseYaml(yaml);
  assert.deepEqual(parsed, obj);
});

test("round-trip: string values that need quoting", () => {
  const obj = {
    url: "https://example.com/path",
    empty_str: "",
    with_hash: "value # looks like comment",
    leading_dash: "-not-a-seq",
    trueish: "true",
    nullish: "null",
    numeric: "42",
  };

  const yaml = stringifyYaml(obj);
  const parsed = parseYaml(yaml);
  assert.deepEqual(parsed, obj);
});

test("round-trip: profile-like structure", () => {
  const profile = {
    candidate: {
      full_name: "Jane Candidate",
      email: "jane@example.com",
      phone: "+1-555-0100",
    },
    compensation: {
      currency: "USD",
      current_base: null,
      target_base: 165000,
      cash_over_equity: true,
      current_comp_shareable: false,
    },
    location: {
      remote: true,
      relocation: [],
    },
  };

  const yaml = stringifyYaml(profile);
  const parsed = parseYaml(yaml);
  assert.deepEqual(parsed, profile);
});

test("round-trip: targeting-like structure with sequence of mappings", () => {
  const targeting = {
    role_buckets: [
      {
        name: "Primary",
        priority: "primary",
        titles: ["Forward Deployed Engineer", "Applied AI Engineer"],
        notes: "Core roles.",
      },
      {
        name: "Secondary",
        priority: "secondary",
        titles: ["Solutions Engineer"],
        notes: "Fallback.",
      },
    ],
    keep_signals: ["customer-facing", "prototype-to-production"],
    excluded_companies: [],
  };

  const yaml = stringifyYaml(targeting);
  const parsed = parseYaml(yaml);
  assert.deepEqual(parsed, targeting);
});
