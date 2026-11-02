import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADJACENCY_NEXT_ACTION,
  adjacencyNote,
  targetingAdjacencyGaps,
} from "../src/core/profile/targeting-adjacency.mjs";

const PRIMARY_ONLY = { role_buckets: [{ name: "Core", priority: "primary", titles: ["Nurse"] }] };
const REMOTE = { location: { remote: true } };
const HYBRID = { location: { hybrid: true } };

describe("targetingAdjacencyGaps", () => {
  it("flags a targeting with only a primary bucket", () => {
    const gaps = targetingAdjacencyGaps(PRIMARY_ONLY, REMOTE);
    assert.equal(gaps.missingAdjacentTitles, true);
    assert.equal(gaps.missingCommuteCities, false);
    assert.equal(gaps.nextAction, ADJACENCY_NEXT_ACTION);
  });

  it("accepts a secondary bucket or role_families as adjacency", () => {
    const withBucket = {
      role_buckets: [
        ...PRIMARY_ONLY.role_buckets,
        { name: "Near", priority: "secondary", titles: ["Charge Nurse"] },
      ],
    };
    assert.equal(targetingAdjacencyGaps(withBucket, REMOTE).gaps.length, 0);
    const withFamilies = { ...PRIMARY_ONLY, role_families: [{ name: "n", patterns: ["nurse"] }] };
    assert.equal(targetingAdjacencyGaps(withFamilies, REMOTE).gaps.length, 0);
  });

  it("flags missing commute cities only for on-site or hybrid candidates", () => {
    const full = {
      ...PRIMARY_ONLY,
      role_families: [{ name: "n", patterns: ["nurse"] }],
    };
    const gaps = targetingAdjacencyGaps(full, HYBRID);
    assert.equal(gaps.missingAdjacentTitles, false);
    assert.equal(gaps.missingCommuteCities, true);
    assert.equal(
      targetingAdjacencyGaps(full, { location: { hybrid: true, commute_cities: ["Aurora, CO"] } })
        .gaps.length,
      0
    );
    assert.equal(targetingAdjacencyGaps(full, REMOTE).gaps.length, 0);
  });

  it("stays quiet before setup has any primary titles", () => {
    assert.equal(targetingAdjacencyGaps({ role_buckets: [] }, HYBRID).checked, false);
    assert.equal(targetingAdjacencyGaps(null, null).gaps.length, 0);
  });
});

describe("adjacencyNote", () => {
  it("is one line naming the next action, or null when nothing is missing", () => {
    const note = adjacencyNote(PRIMARY_ONLY, HYBRID);
    assert.match(note, /^Ran without adjacency config: /);
    assert.match(note, /no related titles/);
    assert.match(note, /no commute cities/);
    assert.match(note, /run search setup to add related titles/);
    assert.ok(!note.includes("\n"));
    assert.equal(adjacencyNote({ role_buckets: [] }, HYBRID), null);
  });
});
