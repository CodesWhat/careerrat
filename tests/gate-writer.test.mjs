import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendToSequence,
  assertNoPrivateLeak,
  atomicWriteFile,
  coerceValue,
  computeGateEdit,
  findKeyPath,
  GATE_ROUTES,
  resolveRoute,
  setScalar,
  validateText,
} from "../src/core/profile/gate-writer.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readTpl = (p) => readFileSync(join(ROOT, p), "utf8");
const readSchema = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

// ── routing & coercion ───────────────────────────────────────────────────────

test("GATE_ROUTES covers the documented gate types with file/path/friction", () => {
  for (const [type, r] of Object.entries(GATE_ROUTES)) {
    assert.ok(r.file, `${type} has a file`);
    assert.ok(r.path, `${type} has a path`);
    assert.ok(["append", "set"].includes(r.op), `${type} op is append|set`);
    assert.ok(["report", "confirm"].includes(r.friction), `${type} friction is report|confirm`);
  }
  assert.equal(GATE_ROUTES["exclude-company"].friction, "confirm");
  assert.equal(GATE_ROUTES["cut-signal"].friction, "report");
});

test("resolveRoute throws on an unknown type", () => {
  assert.throws(() => resolveRoute("nonsense"), /unknown gate type/);
});

test("coerceValue parses comp numbers and rejects junk", () => {
  assert.equal(coerceValue({ coerce: "number", label: "x" }, "$190,000"), 190000);
  assert.equal(coerceValue({ coerce: "number", label: "x" }, 200000), 200000);
  assert.throws(() => coerceValue({ coerce: "number", label: "x" }, "lots"), /not a valid/);
  assert.throws(() => coerceValue({ coerce: "number", label: "x" }, -5), /not a valid/);
  assert.equal(coerceValue({ label: "x" }, "  Palantir "), "Palantir");
});

test("assertNoPrivateLeak blocks current_base outside profile / in form-defaults", () => {
  assert.throws(() => assertNoPrivateLeak("form-defaults", "current_base"), /private/);
  assert.throws(() => assertNoPrivateLeak("targeting", "compensation.current_base"), /private/);
  assert.doesNotThrow(() => assertNoPrivateLeak("profile", "compensation.current_base"));
});

// ── findKeyPath ──────────────────────────────────────────────────────────────

test("findKeyPath locates top-level and nested keys, returns null for missing", () => {
  const lines = [
    "compensation:",
    "  current_base:",
    "  minimum_base: 200000",
    "location:",
    '  home: "NYC"',
  ];
  assert.deepEqual(findKeyPath(lines, ["compensation"]), { index: 0, indent: 0 });
  assert.deepEqual(findKeyPath(lines, ["compensation", "minimum_base"]), { index: 2, indent: 2 });
  assert.equal(findKeyPath(lines, ["compensation", "nope"]), null);
  assert.equal(findKeyPath(lines, ["missing"]), null);
});

test("findKeyPath does not match a key name that only appears as a sequence item", () => {
  const lines = ["cut_signals:", "  - minimum_base", "other: 1"];
  // "minimum_base" appears as a list value, not a mapping key — must not match.
  assert.equal(findKeyPath(lines, ["minimum_base"]), null);
});

// ── appendToSequence ─────────────────────────────────────────────────────────

const EXCLUDE_FIXTURE = `# targeting
excluded_companies:        # hard-penalize at triage
  - "Palantir"
  - "Tesla"
degree_policy: "flexible"
`;

test("appendToSequence adds a quoted item, preserving comments and siblings", () => {
  const out = appendToSequence(EXCLUDE_FIXTURE, ["excluded_companies"], "Acme Corp");
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.match(out.text, /# hard-penalize at triage/); // comment preserved
  assert.match(out.text, /- "Palantir"/);
  assert.match(out.text, /- "Acme Corp"/); // quoted to match siblings
  assert.match(out.text, /degree_policy: "flexible"/); // trailing key intact
  // new item sits after the last existing item, before degree_policy
  const lines = out.text.split("\n");
  assert.ok(lines.indexOf('  - "Acme Corp"') > lines.indexOf('  - "Tesla"'));
  assert.ok(lines.indexOf('  - "Acme Corp"') < lines.indexOf('degree_policy: "flexible"'));
});

test("appendToSequence is idempotent when the value already exists", () => {
  const out = appendToSequence(EXCLUDE_FIXTURE, ["excluded_companies"], "Palantir");
  assert.equal(out.changed, false);
  assert.equal(out.text, EXCLUDE_FIXTURE);
});

test("appendToSequence is idempotent against an existing entry with a trailing inline comment", () => {
  // A commented entry ('- "Palantir" # note') must still be recognized as the
  // same value on re-add — otherwise it duplicates on every run and the
  // existing (commented) line must stay untouched.
  const fixture = `excluded_companies:
  - "Palantir" # laid off my friend there
  - "Tesla"
degree_policy: "flexible"
`;
  const out = appendToSequence(fixture, ["excluded_companies"], "Palantir");
  assert.equal(out.ok, true);
  assert.equal(out.changed, false);
  assert.equal(out.text, fixture); // the commented line is left exactly as-is
});

test("appendToSequence recognizes a single-quoted commented entry too", () => {
  const fixture = "excluded_companies:\n  - 'Palantir' # note\n";
  const out = appendToSequence(fixture, ["excluded_companies"], "Palantir");
  assert.equal(out.changed, false);
});

test("appendToSequence still appends a genuinely new value alongside a commented sibling", () => {
  const fixture = `excluded_companies:
  - "Palantir" # laid off my friend there
`;
  const out = appendToSequence(fixture, ["excluded_companies"], "Acme Corp");
  assert.equal(out.changed, true);
  assert.match(out.text, /- "Palantir" # laid off my friend there/); // untouched
  assert.match(out.text, /- "Acme Corp"/);
});

test("appendToSequence matches unquoted sibling style", () => {
  const fixture = "cut_signals:\n  - pure research\n  - on-call heavy\n";
  const out = appendToSequence(fixture, ["cut_signals"], "ml-research");
  assert.match(out.text, /- ml-research$/m); // no quotes, matching siblings
});

test("appendToSequence converts an inline empty [] into block form", () => {
  const fixture = "location:\n  relocation: []\n  remote: true\n";
  const out = appendToSequence(fixture, ["location", "relocation"], "Austin, TX");
  assert.equal(out.changed, true);
  assert.match(out.text, /relocation:\s*\n\s+- "Austin, TX"/);
  assert.match(out.text, /remote: true/); // following key intact
  assert.doesNotMatch(out.text, /\[\]/);
});

test("appendToSequence appends under a bare key with no existing items", () => {
  const fixture = "tools:\n  do_not_claim:\n  confirmed:\n    - Python\n";
  const out = appendToSequence(fixture, ["tools", "do_not_claim"], "Kubernetes");
  assert.equal(out.changed, true);
  assert.match(out.text, /do_not_claim:\n {4}- "Kubernetes"/);
  assert.match(out.text, /confirmed:\n {4}- Python/); // sibling block untouched
});

test("appendToSequence errors on a missing key", () => {
  const out = appendToSequence(EXCLUDE_FIXTURE, ["nope"], "x");
  assert.equal(out.ok, false);
  assert.match(out.error, /key not found/);
});

// ── setScalar ────────────────────────────────────────────────────────────────

const COMP_FIXTURE = `compensation:
  currency: "USD"
  current_base:
  minimum_base: 140000        # walk-away floor
  target_base: 165000
`;

test("setScalar replaces a number and preserves the inline comment", () => {
  const out = setScalar(COMP_FIXTURE, ["compensation", "minimum_base"], 130000);
  assert.equal(out.changed, true);
  assert.equal(out.previous, "140000");
  assert.match(
    out.text,
    /minimum_base: 130000 {8}# walk-away floor|minimum_base: 130000\s+# walk-away floor/
  );
  assert.match(out.text, /target_base: 165000/);
});

test("setScalar fills an empty scalar key", () => {
  const out = setScalar(COMP_FIXTURE, ["compensation", "current_base"], 180000);
  assert.equal(out.changed, true);
  assert.match(out.text, /current_base: 180000/);
});

test("setScalar is a no-op when the value is unchanged", () => {
  const out = setScalar(COMP_FIXTURE, ["compensation", "target_base"], 165000);
  assert.equal(out.changed, false);
  assert.equal(out.text, COMP_FIXTURE);
});

test("setScalar refuses a key that owns a block", () => {
  const out = setScalar(COMP_FIXTURE, ["compensation"], 1);
  assert.equal(out.ok, false);
  assert.match(out.error, /block, not a scalar/);
});

test("setScalar quotes a string value that needs it", () => {
  const fixture = 'compensation:\n  relo_package_needs: ""\n';
  const out = setScalar(fixture, ["compensation", "relo_package_needs"], "full relo: door to door");
  assert.match(out.text, /relo_package_needs: "full relo: door to door"/);
  assert.ok(parseYaml(out.text).compensation.relo_package_needs.includes("door to door"));
});

// ── validateText ─────────────────────────────────────────────────────────────

test("validateText accepts the real targeting template against its schema", () => {
  const r = validateText(
    readTpl("templates/targeting.example.yml"),
    readSchema("config/targeting.schema.json")
  );
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test("validateText reports a schema violation", () => {
  const bad = 'role_buckets: []\nkeep_signals: "not-an-array"\ncut_signals: []\n';
  const r = validateText(bad, readSchema("config/targeting.schema.json"));
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test("validateText with a null schema only checks that it parses", () => {
  assert.equal(validateText("a: 1\nb: 2\n", null).valid, true);
});

// ── computeGateEdit (end-to-end, pure) ───────────────────────────────────────

const TARGETING = readTpl("templates/targeting.example.yml");
const TARGETING_SCHEMA = readSchema("config/targeting.schema.json");
const PROFILE = readTpl("templates/profile.example.yml");
const PROFILE_SCHEMA = readSchema("config/profile.schema.json");
const HONESTY = readTpl("templates/honesty.example.yml");
const HONESTY_SCHEMA = readSchema("config/honesty.schema.json");

test("computeGateEdit: exclude-company appends, stays schema-valid, confirm-first", () => {
  const plan = computeGateEdit({
    type: "exclude-company",
    value: "Initech",
    currentText: TARGETING,
    schema: TARGETING_SCHEMA,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.changed, true);
  assert.equal(plan.valid, true);
  assert.equal(plan.friction, "confirm");
  assert.equal(plan.file, "targeting");
  assert.match(plan.nextText, /Initech/);
  assert.ok(parseYaml(plan.nextText).excluded_companies.includes("Initech"));
});

test("computeGateEdit: cut-signal is write-and-report friction", () => {
  const plan = computeGateEdit({
    type: "cut-signal",
    value: "graveyard on-call",
    currentText: TARGETING,
    schema: TARGETING_SCHEMA,
  });
  assert.equal(plan.changed, true);
  assert.equal(plan.valid, true);
  assert.equal(plan.friction, "report");
  assert.ok(parseYaml(plan.nextText).cut_signals.includes("graveyard on-call"));
});

test("computeGateEdit: comp-floor sets a number, confirm-first", () => {
  const plan = computeGateEdit({
    type: "comp-floor",
    value: "$215,000",
    currentText: PROFILE,
    schema: PROFILE_SCHEMA,
  });
  assert.equal(plan.changed, true);
  assert.equal(plan.valid, true);
  assert.equal(plan.friction, "confirm");
  assert.equal(parseYaml(plan.nextText).compensation.minimum_base, 215000);
});

test("computeGateEdit: do-not-claim appends to honesty", () => {
  const plan = computeGateEdit({
    type: "do-not-claim",
    value: "Rust",
    currentText: HONESTY,
    schema: HONESTY_SCHEMA,
  });
  assert.equal(plan.changed, true);
  assert.equal(plan.valid, true);
  assert.ok(parseYaml(plan.nextText).tools.do_not_claim.includes("Rust"));
});

test("computeGateEdit: idempotent append reports no change", () => {
  const once = computeGateEdit({
    type: "exclude-company",
    value: "DupCo",
    currentText: TARGETING,
    schema: TARGETING_SCHEMA,
  });
  const twice = computeGateEdit({
    type: "exclude-company",
    value: "DupCo",
    currentText: once.nextText,
    schema: TARGETING_SCHEMA,
  });
  assert.equal(twice.changed, false);
});

test("computeGateEdit: refuses (valid:false) when the result would break the schema", () => {
  // Fixture missing the required cut_signals key — ANY edit leaves it invalid.
  const broken = "role_buckets: []\nkeep_signals:\n  - ships fast\n";
  const plan = computeGateEdit({
    type: "keep-signal",
    value: "small team",
    currentText: broken,
    schema: TARGETING_SCHEMA,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.changed, true);
  assert.equal(plan.valid, false);
  assert.ok(plan.errors.length > 0);
});

// ── atomicWriteFile ──────────────────────────────────────────────────────────

test("atomicWriteFile writes content and leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-gate-"));
  try {
    const target = join(dir, "out.yml");
    writeFileSync(target, "old: 1\n");
    atomicWriteFile(target, "new: 2\n");
    assert.equal(readFileSync(target, "utf8"), "new: 2\n");
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftover, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
