// tests/linkedin-proposals-db.test.mjs — verb-level coverage for
// src/core/db/verbs/linkedin-proposals.mjs (linkedinProposalBatchPut/Get/
// Latest/Decide, table linkedin_profile_proposals from migration 011).
// Mirrors tests/company-health-verb.test.mjs's tempRepo()/openDb() setup
// idiom for a single-verb-file test rather than the CLI subprocess
// (CAREERRAT_HOME) convention used by the discovery-readiness CLI tests —
// these are direct in-process verb calls, no subprocess involved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  linkedinProposalBatchGet,
  linkedinProposalBatchLatest,
  linkedinProposalBatchPreflight,
  linkedinProposalBatchPut,
  linkedinProposalDecide,
  linkedinProposalUnapprove,
} from "../src/core/db/verbs/linkedin-proposals.mjs";

const cleanupRoots = [];
const KNOWN_IDS = ["evidence/ai-projects.md"];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-linkedin-proposals-db-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function surface(overrides = {}) {
  return {
    surfaceId: "headline",
    surface: "Headline",
    current: "Software Engineer",
    proposed: "Applied AI Engineer | LLM Systems",
    rationale: "Matches your targeting focus.",
    evidenceRef: "evidence/ai-projects.md",
    ...overrides,
  };
}

function twoSurfaceBatch(overrides = {}) {
  return {
    surfaces: [
      surface(),
      surface({
        surfaceId: "about",
        surface: "About",
        current: "I build software.",
        proposed: "I build applied AI systems end to end.",
        rationale: "Reflects recent evidence entries.",
      }),
    ],
    ...overrides,
  };
}

function rowCount(repoRoot) {
  return openDb({ repoRoot, env: {} })
    .prepare("SELECT COUNT(*) AS n FROM linkedin_profile_proposals")
    .get().n;
}

// ---------------------------------------------------------------------------
// linkedinProposalBatchPut
// ---------------------------------------------------------------------------

test("linkedinProposalBatchPut: assigns an id when missing, and stores status pending / version 1 with every decision reset to null", () => {
  const repoRoot = tempRepo();
  const { id, meta } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  assert.ok(id.startsWith("linkedin_proposal_"));
  assert.equal(meta.version, 1);

  const batch = linkedinProposalBatchGet({ repoRoot, env: {}, id });
  assert.equal(batch.status, "pending");
  assert.equal(batch.version, 1);
  assert.deepEqual(
    batch.surfaces.map((s) => s.decision),
    [null, null]
  );
});

test("linkedinProposalBatchPut: a comp leak in a surface's proposed field refuses the whole batch and persists nothing", () => {
  const repoRoot = tempRepo();

  assert.throws(
    () =>
      linkedinProposalBatchPut({
        repoRoot,
        env: {},
        batch: twoSurfaceBatch({
          surfaces: [
            surface({ proposed: "my current base is 180k" }),
            surface({ surfaceId: "about" }),
          ],
        }),
      }),
    (error) => {
      assert.equal(error.code, "LINKEDIN_PROPOSAL_COMP_LEAK");
      return true;
    }
  );
  assert.equal(rowCount(repoRoot), 0);
  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {}, status: null }), null);
});

test("linkedinProposalBatchPut: a comp leak in a surface's rationale field refuses the whole batch and persists nothing", () => {
  const repoRoot = tempRepo();

  assert.throws(
    () =>
      linkedinProposalBatchPut({
        repoRoot,
        env: {},
        batch: twoSurfaceBatch({
          surfaces: [
            surface({ surfaceId: "about" }),
            surface({ rationale: "my current base is 180k" }),
          ],
        }),
      }),
    (error) => {
      assert.equal(error.code, "LINKEDIN_PROPOSAL_COMP_LEAK");
      return true;
    }
  );
  assert.equal(rowCount(repoRoot), 0);
  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {}, status: null }), null);
});

test("linkedinProposalBatchPut: a comp leak in a surface's current field refuses the whole batch and persists nothing", () => {
  const repoRoot = tempRepo();

  assert.throws(
    () =>
      linkedinProposalBatchPut({
        repoRoot,
        env: {},
        batch: twoSurfaceBatch({
          surfaces: [
            surface({ current: "Engineer, my current base is 180k" }),
            surface({ surfaceId: "about" }),
          ],
        }),
      }),
    (error) => {
      assert.equal(error.code, "LINKEDIN_PROPOSAL_COMP_LEAK");
      return true;
    }
  );
  assert.equal(rowCount(repoRoot), 0);
  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {}, status: null }), null);
});

test("linkedinProposalBatchPut: a duplicate surfaceId across the batch throws BAD_REQUEST", () => {
  const repoRoot = tempRepo();

  assert.throws(
    () =>
      linkedinProposalBatchPut({
        repoRoot,
        env: {},
        batch: twoSurfaceBatch({
          surfaces: [surface(), surface({ surface: "Headline again" })],
        }),
      }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /surfaceIds must be unique/);
      return true;
    }
  );
  assert.equal(rowCount(repoRoot), 0);
});

test("linkedinProposalBatchPut: a missing or empty evidenceRef throws BAD_REQUEST", () => {
  const repoRoot = tempRepo();

  assert.throws(
    () =>
      linkedinProposalBatchPut({
        repoRoot,
        env: {},
        batch: twoSurfaceBatch({
          surfaces: [surface({ evidenceRef: "" }), surface({ surfaceId: "about" })],
        }),
      }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /evidenceRef/);
      return true;
    }
  );
  assert.equal(rowCount(repoRoot), 0);

  assert.throws(
    () =>
      linkedinProposalBatchPut({
        repoRoot,
        env: {},
        batch: twoSurfaceBatch({
          surfaces: [surface({ evidenceRef: undefined }), surface({ surfaceId: "about" })],
        }),
      }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /evidenceRef/);
      return true;
    }
  );
});

test("linkedinProposalBatchPut: a comp leak in an extra surface property (outside current/proposed/rationale) refuses the whole batch and persists nothing", () => {
  const repoRoot = tempRepo();

  assert.throws(
    () =>
      linkedinProposalBatchPut({
        repoRoot,
        env: {},
        batch: twoSurfaceBatch({
          surfaces: [surface({ note: "my current base is 180k" }), surface({ surfaceId: "about" })],
        }),
      }),
    (error) => {
      assert.equal(error.code, "LINKEDIN_PROPOSAL_COMP_LEAK");
      return true;
    }
  );
  assert.equal(rowCount(repoRoot), 0);
  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {}, status: null }), null);
});

// ---------------------------------------------------------------------------
// linkedinProposalBatchPreflight
// ---------------------------------------------------------------------------

test("linkedinProposalBatchPreflight: throws on a leaking payload without touching the DB", () => {
  const repoRoot = tempRepo();

  assert.throws(
    () =>
      linkedinProposalBatchPreflight({
        batch: twoSurfaceBatch({
          surfaces: [surface({ note: "my current base is 180k" }), surface({ surfaceId: "about" })],
        }),
      }),
    (error) => {
      assert.equal(error.code, "LINKEDIN_PROPOSAL_COMP_LEAK");
      return true;
    }
  );
  assert.equal(rowCount(repoRoot), 0);
});

test("linkedinProposalBatchPreflight: passes cleanly on a valid batch", () => {
  assert.doesNotThrow(() => linkedinProposalBatchPreflight({ batch: twoSurfaceBatch() }));
});

// ---------------------------------------------------------------------------
// linkedinProposalBatchLatest
// ---------------------------------------------------------------------------

test("linkedinProposalBatchLatest: respects the status filter and status:null matches any status", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {} }).id, batchId);
  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {}, status: "reviewed" }), null);
  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {}, status: null }).id, batchId);

  linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId,
    surfaceId: "headline",
    action: "approve",
    version: 1,
  });
  linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId,
    surfaceId: "about",
    action: "reject",
    version: 2,
  });

  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {} }), null);
  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {}, status: "reviewed" }).id, batchId);
  assert.equal(linkedinProposalBatchLatest({ repoRoot, env: {}, status: null }).id, batchId);
});

// ---------------------------------------------------------------------------
// linkedinProposalDecide
// ---------------------------------------------------------------------------

test("linkedinProposalDecide: bumps the batch version on every call and reaches status reviewed once every surface is decided", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  const afterFirst = linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId,
    surfaceId: "headline",
    action: "approve",
    version: 1,
  });
  assert.equal(afterFirst.version, 2);
  assert.equal(afterFirst.status, "pending");

  const afterSecond = linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId,
    surfaceId: "about",
    action: "reject",
    version: 2,
  });
  assert.equal(afterSecond.version, 3);
  assert.equal(afterSecond.status, "reviewed");
});

test("linkedinProposalDecide: a stale version throws CONFLICT", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  assert.throws(
    () =>
      linkedinProposalDecide({
        repoRoot,
        env: {},
        batchId,
        surfaceId: "headline",
        action: "approve",
        version: 99,
      }),
    (error) => {
      assert.equal(error.code, "CONFLICT");
      return true;
    }
  );
});

test("linkedinProposalDecide: an already-decided surface refuses a second decision", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId,
    surfaceId: "headline",
    action: "reject",
    version: 1,
  });

  assert.throws(
    () =>
      linkedinProposalDecide({
        repoRoot,
        env: {},
        batchId,
        surfaceId: "headline",
        action: "approve",
        version: 2,
      }),
    (error) => {
      assert.equal(error.code, "CONFLICT");
      return true;
    }
  );
});

test("linkedinProposalDecide: approve -> applied is the one allowed re-decision", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId,
    surfaceId: "headline",
    action: "approve",
    version: 1,
  });

  const batch = linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId,
    surfaceId: "headline",
    action: "applied",
    version: 2,
  });
  const headline = batch.surfaces.find((s) => s.surfaceId === "headline");
  assert.equal(headline.decision.action, "applied");
});

test("linkedinProposalDecide: reject -> applied is refused with CONFLICT (only approve -> applied is allowed)", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId,
    surfaceId: "headline",
    action: "reject",
    version: 1,
  });

  assert.throws(
    () =>
      linkedinProposalDecide({
        repoRoot,
        env: {},
        batchId,
        surfaceId: "headline",
        action: "applied",
        version: 2,
      }),
    (error) => {
      assert.equal(error.code, "CONFLICT");
      return true;
    }
  );
});

test("linkedinProposalDecide: applied on a never-decided surface is refused with CONFLICT (applied requires a prior approve)", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  assert.throws(
    () =>
      linkedinProposalDecide({
        repoRoot,
        env: {},
        batchId,
        surfaceId: "headline",
        action: "applied",
        version: 1,
      }),
    (error) => {
      assert.equal(error.code, "CONFLICT");
      return true;
    }
  );
  const batch = linkedinProposalBatchGet({ repoRoot, env: {}, id: batchId });
  assert.equal(batch.surfaces.find((s) => s.surfaceId === "headline").decision, null);
  assert.equal(batch.version, 1);
});

test("linkedinProposalDecide: a blank or missing version throws BAD_REQUEST, not a version CONFLICT", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  for (const version of ["", null, undefined]) {
    assert.throws(
      () =>
        linkedinProposalDecide({
          repoRoot,
          env: {},
          batchId,
          surfaceId: "headline",
          action: "approve",
          version,
        }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        return true;
      }
    );
  }
});

test("linkedinProposalDecide: a missing batch throws CONFLICT", () => {
  const repoRoot = tempRepo();

  assert.throws(
    () =>
      linkedinProposalDecide({
        repoRoot,
        env: {},
        batchId: "linkedin_proposal_missing",
        surfaceId: "headline",
        action: "approve",
        version: 1,
      }),
    (error) => {
      assert.equal(error.code, "CONFLICT");
      return true;
    }
  );
});

test("linkedinProposalDecide: a missing surface throws CONFLICT", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  assert.throws(
    () =>
      linkedinProposalDecide({
        repoRoot,
        env: {},
        batchId,
        surfaceId: "skills",
        action: "approve",
        version: 1,
      }),
    (error) => {
      assert.equal(error.code, "CONFLICT");
      return true;
    }
  );
});

test("linkedinProposalDecide: a comp leak smuggled in via reason throws LINKEDIN_PROPOSAL_COMP_LEAK and leaves the batch unchanged", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  assert.throws(
    () =>
      linkedinProposalDecide({
        repoRoot,
        env: {},
        batchId,
        surfaceId: "headline",
        action: "reject",
        version: 1,
        reason: "my current base is 180k",
      }),
    (error) => {
      assert.equal(error.code, "LINKEDIN_PROPOSAL_COMP_LEAK");
      return true;
    }
  );

  const batch = linkedinProposalBatchGet({ repoRoot, env: {}, id: batchId });
  assert.equal(batch.version, 1);
  assert.equal(batch.surfaces.find((s) => s.surfaceId === "headline").decision, null);
});

test("linkedinProposalDecide: an invalid action throws BAD_REQUEST", () => {
  const repoRoot = tempRepo();
  const { id: batchId } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });

  assert.throws(
    () =>
      linkedinProposalDecide({
        repoRoot,
        env: {},
        batchId,
        surfaceId: "headline",
        action: "delete",
        version: 1,
      }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// autoApprove staging and linkedinProposalUnapprove
// ---------------------------------------------------------------------------

test("linkedinProposalBatchPut autoApprove: clean surfaces are approved automatically, a held surface stays undecided", () => {
  const repoRoot = tempRepo();
  const batch = twoSurfaceBatch();
  batch.surfaces.push(
    surface({ surfaceId: "skills", surface: "Skills", proposed: "Add [your top tool] here" })
  );
  const saved = linkedinProposalBatchPut({
    repoRoot,
    env: {},
    batch,
    autoApprove: true,
    knownEvidenceIds: KNOWN_IDS,
  });
  assert.deepEqual(
    saved.staged.map((s) => s.surfaceId),
    ["headline", "about"]
  );
  assert.equal(saved.held.length, 1);
  assert.equal(saved.held[0].surfaceId, "skills");
  const stored = linkedinProposalBatchGet({ repoRoot, env: {}, id: saved.id });
  assert.equal(stored.status, "pending");
  assert.equal(stored.version, 3);
  const bySurface = Object.fromEntries(stored.surfaces.map((s) => [s.surfaceId, s.decision]));
  assert.equal(bySurface.headline.action, "approve");
  assert.equal(bySurface.headline.source, "automatic");
  assert.equal(bySurface.skills, null);
});

test("linkedinProposalBatchPut autoApprove: every clean surface staged makes the batch reviewed", () => {
  const repoRoot = tempRepo();
  const saved = linkedinProposalBatchPut({
    repoRoot,
    env: {},
    batch: twoSurfaceBatch(),
    autoApprove: true,
    knownEvidenceIds: KNOWN_IDS,
  });
  assert.equal(linkedinProposalBatchGet({ repoRoot, env: {}, id: saved.id }).status, "reviewed");
});

test("linkedinProposalBatchPut autoApprove: a surface citing a saved claim id is staged", () => {
  const repoRoot = tempRepo();
  const saved = linkedinProposalBatchPut({
    repoRoot,
    env: {},
    batch: { surfaces: [surface({ evidenceRef: " claim-007 " })] },
    autoApprove: true,
    knownEvidenceIds: ["claim-007", "claim-008"],
  });
  assert.deepEqual(
    saved.staged.map((s) => s.surfaceId),
    ["headline"]
  );
  assert.deepEqual(saved.held, []);
});

test("linkedinProposalBatchPut autoApprove: an unknown id or free-text evidenceRef is held", () => {
  const repoRoot = tempRepo();
  const saved = linkedinProposalBatchPut({
    repoRoot,
    env: {},
    batch: {
      surfaces: [
        surface({ surfaceId: "headline", evidenceRef: "claim-999" }),
        surface({ surfaceId: "about", evidenceRef: "my 2019 project at Acme" }),
        surface({ surfaceId: "skills", evidenceRef: "claim-007" }),
      ],
    },
    autoApprove: true,
    knownEvidenceIds: ["claim-007"],
  });
  assert.deepEqual(
    saved.staged.map((s) => s.surfaceId),
    ["skills"]
  );
  assert.deepEqual(
    saved.held.map((h) => [h.surfaceId, h.reason]),
    [
      ["headline", "it isn't backed by your evidence"],
      ["about", "it isn't backed by your evidence"],
    ]
  );
  const stored = linkedinProposalBatchGet({ repoRoot, env: {}, id: saved.id });
  assert.equal(stored.surfaces[0].decision, null);
  assert.equal(stored.surfaces[1].decision, null);
});

test("linkedinProposalBatchPut autoApprove: with no knownEvidenceIds nothing is staged", () => {
  const repoRoot = tempRepo();
  const saved = linkedinProposalBatchPut({
    repoRoot,
    env: {},
    batch: twoSurfaceBatch(),
    autoApprove: true,
  });
  assert.deepEqual(saved.staged, []);
  assert.equal(saved.held.length, 2);
  assert.equal(linkedinProposalBatchGet({ repoRoot, env: {}, id: saved.id }).status, "pending");
});

test("linkedinProposalBatchPut without autoApprove leaves every surface undecided", () => {
  const repoRoot = tempRepo();
  const saved = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });
  assert.deepEqual(saved.staged, []);
  const stored = linkedinProposalBatchGet({ repoRoot, env: {}, id: saved.id });
  assert.ok(stored.surfaces.every((s) => s.decision === null));
});

test("linkedinProposalUnapprove: returns a staged surface to undecided and the batch to pending, and a second undo is refused", () => {
  const repoRoot = tempRepo();
  const saved = linkedinProposalBatchPut({
    repoRoot,
    env: {},
    batch: twoSurfaceBatch(),
    autoApprove: true,
    knownEvidenceIds: KNOWN_IDS,
  });
  const decidedAt = saved.staged[0].decidedAt;
  const after = linkedinProposalUnapprove({
    repoRoot,
    env: {},
    batchId: saved.id,
    surfaceId: "headline",
    decidedAt,
  });
  assert.equal(after.surfaces.find((s) => s.surfaceId === "headline").decision, null);
  assert.equal(after.status, "pending");
  assert.equal(after.version, saved.meta.version + 1);
  assert.throws(
    () =>
      linkedinProposalUnapprove({
        repoRoot,
        env: {},
        batchId: saved.id,
        surfaceId: "headline",
        decidedAt,
      }),
    (error) => error.code === "CONFLICT"
  );
});

test("linkedinProposalUnapprove: refuses once the field is applied, and the applied decision stays", () => {
  const repoRoot = tempRepo();
  const saved = linkedinProposalBatchPut({
    repoRoot,
    env: {},
    batch: twoSurfaceBatch(),
    autoApprove: true,
    knownEvidenceIds: KNOWN_IDS,
  });
  const applied = linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId: saved.id,
    surfaceId: "headline",
    action: "applied",
    version: saved.meta.version,
  });
  assert.throws(
    () =>
      linkedinProposalUnapprove({
        repoRoot,
        env: {},
        batchId: saved.id,
        surfaceId: "headline",
        decidedAt: saved.staged[0].decidedAt,
      }),
    (error) => error.code === "CONFLICT" && error.reason === "applied"
  );
  const stored = linkedinProposalBatchGet({ repoRoot, env: {}, id: saved.id });
  assert.equal(stored.surfaces[0].decision.action, "applied");
  assert.equal(stored.version, applied.version);
});

test("linkedinProposalUnapprove: refuses a user's own approval and a wrong version", () => {
  const repoRoot = tempRepo();
  const { id } = linkedinProposalBatchPut({ repoRoot, env: {}, batch: twoSurfaceBatch() });
  linkedinProposalDecide({
    repoRoot,
    env: {},
    batchId: id,
    surfaceId: "headline",
    action: "approve",
    version: 1,
  });
  assert.throws(
    () => linkedinProposalUnapprove({ repoRoot, env: {}, batchId: id, surfaceId: "headline" }),
    (error) => error.code === "CONFLICT"
  );
  assert.throws(
    () =>
      linkedinProposalUnapprove({
        repoRoot,
        env: {},
        batchId: id,
        surfaceId: "headline",
        version: 99,
      }),
    (error) => error.code === "CONFLICT"
  );
});
