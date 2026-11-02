import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLaneSpec,
  deriveLanes,
  laneMatch,
  normalizeTitle,
} from "../src/core/scoring/title-lanes.mjs";

test("normalization expands abbreviations and pulls rank markers out of the function", () => {
  assert.deepEqual(normalizeTitle("Sr. Customer Success Mgr").function, [
    "customer",
    "success",
    "manager",
  ]);
  assert.deepEqual(normalizeTitle("Sr. Customer Success Mgr").level, ["senior"]);
  assert.deepEqual(normalizeTitle("Customer Success Manager II").level, ["ii"]);
  assert.deepEqual(normalizeTitle("Platform Engineer L5").function, ["platform", "engineer"]);
  assert.deepEqual(normalizeTitle("Staff Accountant III").function, ["accountant"]);
});

test("location, work-mode and contract decorations are not part of the title", () => {
  for (const title of [
    "Registered Nurse (Remote)",
    "Registered Nurse - Contract",
    "Registered Nurse, Full Time",
    "Registered Nurse (13 weeks)",
    "Registered Nurse - Remote - US",
  ]) {
    assert.deepEqual(normalizeTitle(title).words, ["registered", "nurse"], title);
  }
});

test("team and qualifier suffixes stay qualifiers, not the function", () => {
  const normalized = normalizeTitle("Customer Success Manager, Enterprise (Strategic Accounts)");
  assert.deepEqual(normalized.function, ["customer", "success", "manager"]);
  assert.deepEqual(normalized.qualifiers, ["enterprise", "strategic", "accounts"]);
  // A title that is only rank words keeps them.
  assert.deepEqual(normalizeTitle("Senior Chief of Staff").function, ["chief", "staff"]);
});

test("lanes collapse to the shared function and keep the tier noun when it is all there is", () => {
  const lanes = deriveLanes(["Senior Program Manager", "Program Manager"]);
  assert.equal(lanes.length, 1);
  assert.deepEqual([...lanes[0].words].sort(), ["manager", "program"]);
  assert.equal(lanes[0].sources.length, 2);

  const cs = deriveLanes(["Customer Success Manager"]);
  assert.deepEqual([...cs[0].words].sort(), ["customer", "success"]);
});

test("lane matching reads words from head and qualifiers in any order", () => {
  const spec = buildLaneSpec(
    {
      role_buckets: [
        { name: "ICU", priority: "primary", titles: ["ICU Registered Nurse"] },
        { name: "Acute", priority: "secondary", titles: ["Step-Down Registered Nurse"] },
      ],
    },
    []
  );
  assert.equal(laneMatch("Registered Nurse - ICU (Night Shift)", spec), "lane");
  assert.equal(laneMatch("Step Down Registered Nurse", spec), "adjacent");
  assert.equal(laneMatch("Registered Nurse, Med-Surg", spec), null);
  assert.equal(laneMatch("Nurse Practitioner", spec), null);
});
