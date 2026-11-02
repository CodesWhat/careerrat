import assert from "node:assert/strict";
import test from "node:test";
import {
  titleFunctionClusters,
  titleFunctionRelation,
} from "../src/core/scoring/title-functions.mjs";

test("function clusters come from title words, not from a fixed job family", () => {
  assert.deepEqual([...titleFunctionClusters("Staff Frontend Engineer").keys()], ["web-frontend"]);
  assert.deepEqual(
    [...titleFunctionClusters("Principal Software Engineer, Web").keys()],
    ["web-frontend"]
  );
  assert.deepEqual([...titleFunctionClusters("Senior Delivery Manager").keys()], ["program-ops"]);
  assert.deepEqual([...titleFunctionClusters("Senior Chief of Staff").keys()], ["program-ops"]);
  assert.equal(titleFunctionClusters("Software Engineer").size, 0);
});

test("design counts as frontend work only beside an engineering noun", () => {
  assert.ok(titleFunctionClusters("Staff Design Engineer").has("web-frontend"));
  assert.ok(!titleFunctionClusters("Staff Design Engineer").has("design"));
  assert.ok(titleFunctionClusters("Design Lead, Mobile Product").has("design"));
  assert.ok(!titleFunctionClusters("Design Lead, Mobile Product").has("web-frontend"));
});

test("function relation separates synonyms, other lanes, and unknowns", () => {
  const relation = (actual, target) => titleFunctionRelation(actual, target).relation;
  assert.equal(relation("Frontend Architect", "Staff Frontend Engineer"), "shared");
  assert.equal(relation("Senior UX Designer", "Senior Product Designer"), "shared");
  assert.equal(relation("Senior Interaction Designer", "Senior Product Designer"), "shared");
  assert.equal(relation("Delivery Manager", "Senior Program Manager"), "shared");
  assert.equal(relation("Senior Implementation Manager", "Senior Program Manager"), "shared");
  assert.equal(relation("Staff Backend Engineer", "Staff Frontend Engineer"), "conflict");
  assert.equal(relation("Staff Data Engineer", "Staff Frontend Engineer"), "conflict");
  assert.equal(relation("Senior Product Manager", "Senior Product Designer"), "conflict");
  assert.equal(relation("Senior Accountant", "Senior Program Manager"), "conflict");
  assert.equal(relation("Staff Software Engineer", "Staff Frontend Engineer"), "unknown");
});

test("manager is the job noun, not a management tier, in program-style lanes", () => {
  assert.equal(titleFunctionRelation("Delivery Manager", "Program Manager").managerIsRole, true);
  assert.equal(
    titleFunctionRelation("Frontend Engineering Manager", "Frontend Engineer").managerIsRole,
    false
  );
});
