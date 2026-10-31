import assert from "node:assert/strict";
import { test } from "node:test";

import { cloneCandidateDefault } from "../src/core/profile/candidate-defaults.mjs";
import { classifyConfigChange } from "../src/core/profile/loosening.mjs";

const honesty = (over = {}) => ({
  claims: { do_not_fabricate: ["a degree"], ...over.claims },
  tools: { confirmed: ["Postgres"], adjacent: ["Kafka"], do_not_claim: ["Rust"], ...over.tools },
  ...over.top,
});

test("removing a do_not_claim entry loosens, adding one does not", () => {
  const before = honesty();
  const removed = classifyConfigChange("honesty", before, honesty({ tools: { do_not_claim: [] } }));
  assert.equal(removed.loosens, true);
  assert.match(removed.reasons[0], /Rust/);
  const added = classifyConfigChange(
    "honesty",
    before,
    honesty({ tools: { do_not_claim: ["Rust", "Go"] } })
  );
  assert.deepEqual(added, { loosens: false, reasons: [] });
});

test("removing a do_not_fabricate or boundaries entry loosens", () => {
  const before = honesty({ top: { boundaries: ["no titles I did not hold"] } });
  const fabricate = classifyConfigChange(
    "honesty",
    before,
    honesty({ claims: { do_not_fabricate: [] }, top: { boundaries: ["no titles I did not hold"] } })
  );
  assert.equal(fabricate.loosens, true);
  const boundaries = classifyConfigChange("honesty", before, honesty({ top: { boundaries: [] } }));
  assert.equal(boundaries.loosens, true);
});

test("a tool moving from adjacent into confirmed loosens", () => {
  const before = honesty();
  const verdict = classifyConfigChange(
    "honesty",
    before,
    honesty({ tools: { confirmed: ["Postgres", "Kafka"], adjacent: [] } })
  );
  assert.equal(verdict.loosens, true);
  assert.match(verdict.reasons[0], /Kafka/);
});

test("the first confirmed tool on a fresh workspace is a first-time value, not loosening", () => {
  const before = cloneCandidateDefault("honesty");
  const after = { ...before, tools: { ...before.tools, confirmed: ["Postgres"] } };
  assert.deepEqual(classifyConfigChange("honesty", before, after), { loosens: false, reasons: [] });
  assert.equal(
    classifyConfigChange("honesty", {}, { tools: { confirmed: ["Postgres"] } }).loosens,
    false
  );
});

test("a do_not_claim tool moving into confirmed loosens, case-insensitively", () => {
  const before = cloneCandidateDefault("honesty");
  before.tools.do_not_claim = ["Rust"];
  const after = { ...before, tools: { ...before.tools, confirmed: [" rust "] } };
  const verdict = classifyConfigChange("honesty", before, after);
  assert.equal(verdict.loosens, true);
  assert.match(verdict.reasons[0], /rust/);
});

test("an adjacent tool moving into confirmed loosens on a default-shaped doc", () => {
  const before = cloneCandidateDefault("honesty");
  before.tools.adjacent = ["Kafka"];
  const after = { ...before, tools: { ...before.tools, confirmed: ["kafka"] } };
  assert.equal(classifyConfigChange("honesty", before, after).loosens, true);
});

test("lowering a pay floor or target loosens; first-time and raised values do not", () => {
  const comp = (value) => ({ compensation: value });
  const before = comp({ minimum_base: 150000, target_base: 200000, current_base: 99000 });
  const lowered = classifyConfigChange("profile", before, comp({ minimum_base: 140000 }));
  assert.equal(lowered.loosens, true);
  assert.equal(JSON.stringify(lowered).includes("140000"), false);
  assert.equal(JSON.stringify(lowered).includes("150000"), false);
  assert.equal(
    classifyConfigChange("profile", before, comp({ target_base: 180000 })).loosens,
    true
  );
  assert.equal(
    classifyConfigChange("profile", before, comp({ minimum_base: 150000, target_base: 250000 }))
      .loosens,
    false
  );
  assert.equal(
    classifyConfigChange("profile", comp({}), comp({ minimum_base: 90000 })).loosens,
    false
  );
  assert.equal(
    classifyConfigChange("profile", undefined, comp({ minimum_base: 90000 })).loosens,
    false
  );
});

test("clearing a stored floor loosens, and other docs never do", () => {
  const before = { compensation: { minimum_annual_earnings: 60000 } };
  const cleared = classifyConfigChange("profile", before, {
    compensation: { minimum_annual_earnings: null },
  });
  assert.equal(cleared.loosens, true);
  assert.equal(classifyConfigChange("targeting", { a: 1 }, { a: 0 }).loosens, false);
});
