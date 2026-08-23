import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  computeEvidenceWrite,
  loadEvidence,
  parseEvidence,
  slugifyClaimId,
  validateClaims,
  writeEvidence,
} from "../src/core/profile/evidence-writer.mjs";

function goodClaim(overrides = {}) {
  return {
    id: "portal",
    claim: "Built a self-serve analytics portal.",
    evidence: "Designed and shipped it; scanned from the repo.",
    role_signals: ["self-serve tooling"],
    ...overrides,
  };
}

const SCHEMA = JSON.parse(
  readFileSync(new URL("../config/evidence.schema.json", import.meta.url), "utf8")
);

// ---------------------------------------------------------------------------
// slug + parse
// ---------------------------------------------------------------------------

test("slugifyClaimId normalises and is idempotent", () => {
  assert.equal(slugifyClaimId("Built A Portal!"), "built-a-portal");
  assert.equal(slugifyClaimId("built-a-portal"), "built-a-portal");
  assert.equal(slugifyClaimId(""), "claim");
});

test("parseEvidence reads claims[] and tolerates absence", () => {
  assert.deepEqual(parseEvidence("claims: []").claims, []);
  assert.deepEqual(parseEvidence("").claims, []);
  const { claims } = parseEvidence("claims:\n  - id: a\n    claim: A\n    evidence: E\n");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, "a");
});

// ---------------------------------------------------------------------------
// validateClaims — firewall
// ---------------------------------------------------------------------------

test("validateClaims accepts a well-formed claim", () => {
  assert.equal(validateClaims([goodClaim()]).ok, true);
});

test("validateClaims requires id, claim, and evidence", () => {
  for (const f of ["id", "claim", "evidence"]) {
    const c = goodClaim();
    delete c[f];
    const v = validateClaims([c]);
    assert.equal(v.ok, false, `expected failure for missing ${f}`);
  }
});

test("validateClaims flags duplicate ids", () => {
  const v = validateClaims([goodClaim(), goodClaim()]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("duplicate claim id")));
});

test("validateClaims refuses placeholder residue", () => {
  const v = validateClaims([goodClaim({ claim: "Built [Product] for the team." })]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("placeholder")));
});

test("validateClaims refuses the private current_base field token", () => {
  const v = validateClaims([goodClaim({ evidence: "Logged current_base in the notes." })]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("current_base")));
});

test("validateClaims rejects links/role_signals/forbidden_wording that aren't arrays", () => {
  for (const field of ["links", "role_signals", "forbidden_wording"]) {
    const v = validateClaims([goodClaim({ [field]: "not-an-array" })]);
    assert.equal(v.ok, false, `expected failure for ${field} as a bare string`);
    assert.ok(
      v.errors.some((e) => e.message.includes(`"${field}"`) && e.message.includes("array"))
    );
  }
});

test("validateClaims rejects non-string entries inside links/role_signals/forbidden_wording", () => {
  for (const field of ["links", "role_signals", "forbidden_wording"]) {
    const v = validateClaims([goodClaim({ [field]: [123] })]);
    assert.equal(v.ok, false, `expected failure for ${field}[0] as a number`);
    assert.ok(v.errors.some((e) => e.message.includes(`${field}[0]`)));
  }
});

test("validateClaims rejects empty-string entries inside links/role_signals/forbidden_wording", () => {
  const v = validateClaims([goodClaim({ links: ["   "] })]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes("links[0]")));
});

test("validateClaims flags placeholder residue inside links/role_signals/forbidden_wording", () => {
  for (const field of ["links", "role_signals", "forbidden_wording"]) {
    const v = validateClaims([goodClaim({ [field]: ["Built [Product] integration"] })]);
    assert.equal(v.ok, false, `expected placeholder failure for ${field}`);
    assert.ok(v.errors.some((e) => e.message.includes("placeholder")));
  }
});

test("validateClaims accepts well-formed links/role_signals/forbidden_wording", () => {
  const v = validateClaims([
    goodClaim({
      links: ["https://example.com/portal"],
      role_signals: ["self-serve tooling"],
      forbidden_wording: ["invented a new architecture"],
    }),
  ]);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("validateClaims does NOT false-positive on legit 'currently' accomplishment prose", () => {
  // The tight guard (current_base token) must not trip on production phrasing the
  // broad findCompLeak would have flagged.
  const v = validateClaims([
    goodClaim({ evidence: "The system is currently making 500 widgets/day." }),
  ]);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

// ---------------------------------------------------------------------------
// computeEvidenceWrite — upsert
// ---------------------------------------------------------------------------

test("computeEvidenceWrite appends a new claim", () => {
  const plan = computeEvidenceWrite({ newClaim: goodClaim(), currentClaims: [] });
  assert.equal(plan.ok, true);
  assert.equal(plan.replaced, false);
  assert.equal(plan.nextClaims.length, 1);
});

test("computeEvidenceWrite upserts by id (replace, not duplicate)", () => {
  const current = [goodClaim()];
  const plan = computeEvidenceWrite({
    newClaim: goodClaim({ claim: "Reworked it." }),
    currentClaims: current,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.replaced, true);
  assert.equal(plan.nextClaims.length, 1);
  assert.equal(plan.nextClaims[0].claim, "Reworked it.");
});

test("computeEvidenceWrite derives an id from the claim text and leads with it", () => {
  const c = goodClaim();
  delete c.id;
  const plan = computeEvidenceWrite({ newClaim: c, currentClaims: [] });
  assert.equal(plan.ok, true);
  assert.equal(plan.claim.id, "built-a-self-serve-analytics-portal");
  // id must be the FIRST key so the serialized claim reads id-first.
  assert.equal(Object.keys(plan.claim)[0], "id");
});

test("computeEvidenceWrite drops empty arrays and unknown fields", () => {
  const plan = computeEvidenceWrite({
    newClaim: goodClaim({ metrics: [], bogus: "x" }),
    currentClaims: [],
  });
  assert.equal(plan.ok, true);
  assert.ok(!("metrics" in plan.claim));
  assert.ok(!("bogus" in plan.claim));
});

test("computeEvidenceWrite refuses a claim that fails the firewall", () => {
  const plan = computeEvidenceWrite({ newClaim: goodClaim({ evidence: "" }), currentClaims: [] });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /missing evidence/);
});

// ---------------------------------------------------------------------------
// writeEvidence + loadEvidence — fs round-trip + guards
// ---------------------------------------------------------------------------

test("writeEvidence + loadEvidence round-trips and passes the schema guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-ev-"));
  try {
    const claims = [
      goodClaim(),
      goodClaim({
        id: "migration",
        claim: "Led a migration.",
        evidence: "Coordinated three teams.",
      }),
    ];
    const res = writeEvidence({ claims, root: dir, schema: SCHEMA });
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);

    const loaded = loadEvidence({ root: dir });
    assert.equal(loaded.exists, true);
    assert.equal(loaded.claims.length, 2);
    assert.equal(loaded.claims[0].id, "portal");
    // The loaded bank still validates (no corruption on round-trip).
    assert.equal(validateClaims(loaded.claims).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEvidence reports a missing bank without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-ev-empty-"));
  try {
    const loaded = loadEvidence({ root: dir });
    assert.equal(loaded.exists, false);
    assert.deepEqual(loaded.claims, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: compute then write a derived-id claim, reload by that id", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-ev-e2e-"));
  try {
    const c = goodClaim();
    delete c.id;
    const plan = computeEvidenceWrite({ newClaim: c, currentClaims: [] });
    const res = writeEvidence({ claims: plan.nextClaims, root: dir, schema: SCHEMA });
    assert.equal(res.ok, true);
    const loaded = loadEvidence({ root: dir });
    assert.equal(loaded.claims[0].id, "built-a-self-serve-analytics-portal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
