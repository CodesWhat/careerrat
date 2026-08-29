// tests/onboard-setup-progress.test.mjs
// node:test coverage for the W4 chat-first onboarding surface's 7-item setup
// progress (commit c1d601e3, src/cli/onboard-route.mjs's computeSetupProgress
// and the setupProgress field it adds to GET /api/onboard/state). Split into
// its own file rather than appended to the already-2700-line
// tests/onboard-route.test.mjs — same rationale
// tests/workspace-agent-preview.test.mjs's header comment gives for its own
// split: lands without touching that file, reusing its
// mountDirectRoutes/getDirect/postJsonDirect/buildTempRoot conventions.

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { quickFactsDetailLine } from "../apps/web/src/onboarding/onboardingSetup.js";
import { computeSetupProgress, mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { deepIngestConfirmedItemUpsert } from "../src/core/db/verbs/index.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanupRoots = [];

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// computeSetupProgress — pure function, no server/DB needed
// ---------------------------------------------------------------------------

describe("computeSetupProgress", () => {
  it("marks all 8 items not-done, completedCount 0, and complete:false with no data at all", () => {
    const progress = computeSetupProgress({});
    assert.deepEqual(
      progress.items.map((i) => i.key),
      [
        "engine",
        "resume",
        "roles",
        "companies",
        "evidence",
        "guardrails",
        "quickFacts",
        "authorization",
      ]
    );
    assert.ok(progress.items.every((i) => i.done === false));
    assert.equal(progress.completedCount, 0);
    assert.equal(progress.total, 8);
    assert.equal(progress.complete, false);
  });

  it("engine flips on keyConfigured alone", () => {
    const progress = computeSetupProgress({ keyConfigured: true });
    assert.equal(progress.items.find((i) => i.key === "engine").done, true);
    assert.equal(progress.completedCount, 1);
  });

  it("resume flips on sourceResumePresent alone (data-independent)", () => {
    const progress = computeSetupProgress({ sourceResumePresent: true });
    assert.equal(progress.items.find((i) => i.key === "resume").done, true);
  });

  it("roles flips only when at least one role bucket has a non-empty titles array", () => {
    const empty = computeSetupProgress({
      data: { targeting: { role_buckets: [{ titles: [] }] } },
    });
    assert.equal(empty.items.find((i) => i.key === "roles").done, false);

    const withTitle = computeSetupProgress({
      data: { targeting: { role_buckets: [{ titles: [] }, { titles: ["Applied AI Engineer"] }] } },
    });
    assert.equal(withTitle.items.find((i) => i.key === "roles").done, true);
  });

  it("companies flips on a confirmed company thesis even when the user names no examples", () => {
    const broad = computeSetupProgress({
      data: { targeting: { company_preferences: { confirmed: true } } },
    });
    assert.equal(broad.items.find((i) => i.key === "companies").done, true);

    const unconfirmed = computeSetupProgress({
      data: { targeting: { company_preferences: { industries: ["fintech"] } } },
    });
    assert.equal(unconfirmed.items.find((i) => i.key === "companies").done, false);
  });

  it("keeps non-empty tracked_companies as a legacy completion signal", () => {
    const progress = computeSetupProgress({
      data: { targeting: { tracked_companies: ["Stripe"] } },
    });
    assert.equal(progress.items.find((i) => i.key === "companies").done, true);
    assert.equal(
      computeSetupProgress({ data: { targeting: { tracked_companies: [] } } }).items.find(
        (i) => i.key === "companies"
      ).done,
      false
    );
  });

  it("evidence flips on a non-empty evidence.claims array", () => {
    const progress = computeSetupProgress({
      data: { evidence: { claims: [{ claim: "Shipped a thing" }] } },
    });
    assert.equal(progress.items.find((i) => i.key === "evidence").done, true);
  });

  it("guardrails flips on a non-empty cut_signals array", () => {
    const progress = computeSetupProgress({
      data: { targeting: { cut_signals: ["Below $200K"] } },
    });
    assert.equal(progress.items.find((i) => i.key === "guardrails").done, true);
  });

  it("quickFacts requires both a location posture and a minimum base", () => {
    assert.equal(
      computeSetupProgress({ data: { profile: { location: { home: "Austin, TX" } } } }).items.find(
        (i) => i.key === "quickFacts"
      ).done,
      false
    );
    assert.equal(
      computeSetupProgress({
        data: {
          profile: {
            location: {
              home: "Austin, TX",
              hybrid: true,
              mode_preferences_confirmed: true,
            },
            compensation: { minimum_base: 180000 },
          },
        },
      }).items.find((i) => i.key === "quickFacts").done,
      true
    );
    assert.equal(
      computeSetupProgress({
        data: { profile: { compensation: { minimum_base: 180000 } } },
      }).items.find((i) => i.key === "quickFacts").done,
      false,
      "compensation without a location posture is still incomplete"
    );
    assert.equal(
      computeSetupProgress({
        data: {
          profile: {
            location: {
              home: "Austin, TX",
              remote: true,
              hybrid: true,
              mode_preferences_confirmed: true,
            },
            compensation: { comp_floors: { remote: 180000, hybrid: 195000 } },
          },
        },
      }).items.find((i) => i.key === "quickFacts").done,
      true,
      "arrangement-specific floors are a complete compensation gate without a flat fallback"
    );
    assert.equal(
      computeSetupProgress({
        data: {
          profile: {
            location: {
              remote: true,
              remote_scope: "worldwide",
              hybrid: false,
              onsite: false,
              mode_preferences_confirmed: true,
            },
            compensation: { minimum_base: 180000 },
          },
        },
      }).items.find((i) => i.key === "quickFacts").done,
      true,
      "confirmed remote-only candidates do not need a home, hybrid, on-site, or relocation market"
    );
    assert.equal(
      computeSetupProgress({
        data: {
          profile: {
            location: {
              home: "New York, NY",
              hybrid: true,
              mode_preferences_confirmed: true,
            },
            compensation: { minimum_annual_earnings: 90000 },
          },
        },
      }).items.find((i) => i.key === "quickFacts").done,
      true,
      "a total annual cash earnings floor completes compensation setup for tipped work"
    );
  });

  it("does not treat a resume location and the ambient remote fallback as a confirmed work-mode posture", () => {
    const resumeSeededProfile = {
      location: {
        home: "Brooklyn, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: false,
        onsite: false,
      },
      compensation: { minimum_base: 180000 },
    };

    assert.equal(
      computeSetupProgress({ data: { profile: resumeSeededProfile } }).items.find(
        (item) => item.key === "quickFacts"
      ).done,
      false,
      "a resume can establish the home market but cannot choose remote, hybrid, or on-site for the candidate"
    );
    assert.equal(
      computeSetupProgress({
        data: {
          profile: {
            ...resumeSeededProfile,
            location: {
              ...resumeSeededProfile.location,
              hybrid: true,
              mode_preferences_confirmed: true,
            },
          },
        },
      }).items.find((item) => item.key === "quickFacts").done,
      true
    );
  });

  it("authorization flips on work_authorized/requires_sponsorship===true, or a recorded decline", () => {
    assert.equal(
      computeSetupProgress({
        data: { profile: { authorization: { work_authorized: true } } },
      }).items.find((i) => i.key === "authorization").done,
      true
    );
    assert.equal(
      computeSetupProgress({
        data: { profile: { authorization: { requires_sponsorship: true } } },
      }).items.find((i) => i.key === "authorization").done,
      true
    );
    assert.equal(
      computeSetupProgress({
        data: {
          "form-defaults": {
            declined_fields: { authorization: { declined_at: "2026-08-09T12:00:00Z" } },
          },
        },
      }).items.find((i) => i.key === "authorization").done,
      true
    );
    // An untouched {false, false} — the freshly-initialized default's exact
    // shape — must NOT trivially read as done (see authorizationDeclared's
    // own header comment in src/core/db/verbs/candidate.mjs for why).
    assert.equal(
      computeSetupProgress({
        data: {
          profile: { authorization: { work_authorized: false, requires_sponsorship: false } },
        },
      }).items.find((i) => i.key === "authorization").done,
      false
    );
  });

  it("resume flips on a saved source résumé, or on a recorded 'I don't have one'", () => {
    assert.equal(
      computeSetupProgress({ sourceResumePresent: false }).items.find((i) => i.key === "resume")
        .done,
      false
    );
    assert.equal(
      computeSetupProgress({ sourceResumePresent: true }).items.find((i) => i.key === "resume")
        .done,
      true
    );
    // The résumé-less candidate ("I don't have a résumé. Help me start another
    // way." on the onboarding screen) must be able to reach 8 of 8 — without
    // this branch they sit one step short forever.
    assert.equal(
      computeSetupProgress({
        sourceResumePresent: false,
        data: {
          "form-defaults": {
            declined_fields: { resume: { declined_at: "2026-08-10T12:00:00Z" } },
          },
        },
      }).items.find((i) => i.key === "resume").done,
      true
    );
  });

  it("consent is not a setup item — automation.setup_mode never appears in items[] and never affects completedCount/complete", () => {
    const withMode = computeSetupProgress({ data: { automation: { setup_mode: "advanced" } } });
    assert.equal(
      withMode.items.some((i) => i.key === "consent"),
      false
    );
    assert.equal(withMode.completedCount, 0);

    const withoutAutomation = computeSetupProgress({ data: {} });
    assert.equal(withoutAutomation.total, withMode.total);
  });

  it("completedCount and complete track exactly how many of the 8 flags are true", () => {
    const sevenOfEight = computeSetupProgress({
      keyConfigured: true,
      sourceResumePresent: true,
      data: {
        targeting: {
          role_buckets: [{ titles: ["Applied AI Engineer"] }],
          tracked_companies: ["Stripe"],
          cut_signals: ["Below $200K"],
        },
        profile: {
          compensation: { minimum_base: 200000 },
          location: { home: "Austin, TX", mode_preferences_confirmed: true },
          authorization: { work_authorized: true },
        },
      },
    });
    assert.equal(sevenOfEight.completedCount, 7);
    assert.equal(sevenOfEight.complete, false);

    const allEight = computeSetupProgress({
      keyConfigured: true,
      sourceResumePresent: true,
      data: {
        targeting: {
          role_buckets: [{ titles: ["Applied AI Engineer"] }],
          tracked_companies: ["Stripe"],
          cut_signals: ["Below $200K"],
        },
        evidence: { claims: [{ claim: "Shipped a thing" }] },
        profile: {
          compensation: { minimum_base: 200000 },
          location: { home: "Austin, TX", mode_preferences_confirmed: true },
          authorization: { work_authorized: true },
        },
      },
    });
    assert.equal(allEight.completedCount, 8);
    assert.equal(allEight.complete, true);
  });

  // Regression — the live lockout bug this change fixes: ingest-profile's
  // Basic mode never writes candidate/automation.yml, and consentValuePresent()
  // used to require automation.setup_mode to be a string (or a recorded
  // consent decline) before setup could ever read complete. A CLI/Basic-mode
  // candidate with the other 8 items done, no automation.yml, and no consent
  // decline anywhere must read complete now that consent is no longer a
  // setup item at all.
  it("a CLI/Basic-mode candidate with the 8 remaining items done reads complete:true with no automation.yml and no consent decline anywhere", () => {
    const progress = computeSetupProgress({
      keyConfigured: true,
      sourceResumePresent: true,
      data: {
        targeting: {
          role_buckets: [{ titles: ["Applied AI Engineer"] }],
          tracked_companies: ["Stripe"],
          cut_signals: ["Below $200K"],
        },
        evidence: { claims: [{ claim: "Shipped a thing" }] },
        profile: {
          compensation: { minimum_base: 200000 },
          location: { home: "Austin, TX", mode_preferences_confirmed: true },
          authorization: { work_authorized: true },
        },
        // No `automation` key at all, and no form-defaults.declined_fields —
        // the exact shape ingest-profile's Basic mode leaves behind.
      },
    });
    assert.equal(
      progress.items.some((i) => i.key === "consent"),
      false
    );
    assert.equal(progress.completedCount, 8);
    assert.equal(progress.total, 8);
    assert.equal(progress.complete, true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/onboard/state's setupProgress field — both the file-fallback and
// SQLite-backed read paths (same repoRoot, same request, before/after
// POST /api/onboard/init — mirrors onboard-route.test.mjs's own "includes
// honesty prefill data from file fallback and SQLite state" test).
// ---------------------------------------------------------------------------

function buildTempRoot() {
  const tempRoot = mkdtempSync(join(tmpdir(), "careerrat-onboard-setup-progress-"));
  cleanupRoots.push(tempRoot);
  mkdirSync(join(tempRoot, "templates"), { recursive: true });
  mkdirSync(join(tempRoot, "config"), { recursive: true });

  for (const entry of [...CANDIDATE_FILES, ...OPTIONAL_CANDIDATE_FILES]) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(tempRoot, entry.templatePath));
    copyFileSync(join(REAL_ROOT, entry.schemaPath), join(tempRoot, entry.schemaPath));
  }
  for (const entry of COPY_ONLY_CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(tempRoot, entry.templatePath));
  }
  copyFileSync(join(REAL_ROOT, "templates/AGENTS.md"), join(tempRoot, "templates/AGENTS.md"));
  copyFileSync(
    join(REAL_ROOT, "config/resume-extract.schema.json"),
    join(tempRoot, "config/resume-extract.schema.json")
  );
  copyFileSync(
    join(REAL_ROOT, "templates/automation.example.yml"),
    join(tempRoot, "templates/automation.example.yml")
  );
  copyFileSync(
    join(REAL_ROOT, "config/automation.schema.json"),
    join(tempRoot, "config/automation.schema.json")
  );
  return tempRoot;
}

function mountDirectRoutes(repoRoot, env = {}) {
  const routes = new Map();
  mountOnboardRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env,
  });
  return routes;
}

async function postDirect(routes, path, body) {
  const handler = routes.get(`POST ${path}`);
  assert.ok(handler, `expected mounted route for POST ${path}`);
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
  req.method = "POST";
  req.url = path;
  req.headers = { "content-type": "application/json" };
  let status = 200;
  let responseBody = "";
  const res = {
    writeHead(nextStatus) {
      status = nextStatus;
      return this;
    },
    end(chunk = "") {
      responseBody += String(chunk);
    },
  };
  await handler(req, res);
  return { status, body: responseBody ? JSON.parse(responseBody) : {} };
}

async function getDirect(routes, path) {
  const handler = routes.get(`GET ${path}`);
  assert.ok(handler, `expected mounted route for GET ${path}`);
  const req = Readable.from([]);
  req.method = "GET";
  req.url = path;
  req.headers = {};
  let status = 200;
  let responseBody = "";
  const res = {
    writeHead(nextStatus) {
      status = nextStatus;
      return this;
    },
    end(chunk = "") {
      responseBody += String(chunk);
    },
  };
  await handler(req, res);
  return { status, body: responseBody ? JSON.parse(responseBody) : {} };
}

describe("GET /api/onboard/state — setupProgress", () => {
  it("returns an opaque stable draft owner and a canonical candidate-content revision", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      await postDirect(routes, "/api/onboard/init", {});

      const first = (await getDirect(routes, "/api/onboard/state")).body.draftContext;
      const repeated = (await getDirect(routes, "/api/onboard/state")).body.draftContext;
      assert.equal(typeof first?.owner?.workspaceId, "string");
      assert.ok(first.owner.workspaceId.length >= 16);
      assert.equal(typeof first?.owner?.candidateId, "string");
      assert.ok(first.owner.candidateId.length >= 16);
      assert.equal(typeof first?.base?.revision, "string");
      assert.ok(first.base.revision.length >= 16);
      assert.deepEqual(repeated, first);

      const alternateRoutes = mountDirectRoutes(repoRoot, {
        CAREERRAT_HOME: join(repoRoot, "alternate-private-home"),
      });
      await postDirect(alternateRoutes, "/api/onboard/init", {});
      const alternate = (await getDirect(alternateRoutes, "/api/onboard/state")).body.draftContext;
      assert.notEqual(
        alternate.owner.workspaceId,
        first.owner.workspaceId,
        "separate active data roots served by one installed package must not share drafts"
      );

      await postDirect(routes, "/api/onboard/candidate/profile", {
        data: {
          candidate: {
            full_name: "Ada Candidate",
            email: "ada.private@example.test",
          },
        },
      });
      const changed = (await getDirect(routes, "/api/onboard/state")).body.draftContext;

      assert.deepEqual(changed.owner, first.owner);
      assert.notEqual(changed.base.revision, first.base.revision);
      const exposedIdentity = JSON.stringify(changed.owner);
      // Match the submitted PII itself, not a bare "ada". owner is opaque hex ids, and
      // "ada" is three hex characters, so a bare substring check false-positives on
      // roughly 3% of runs (seen: candidateId "...0ecad741adac...").
      assert.doesNotMatch(exposedIdentity, /ada candidate|ada\.private|@|example\.test/i);
      assert.equal(exposedIdentity.includes(repoRoot), false);
      assert.equal(exposedIdentity.includes(tmpdir()), false);

      deepIngestConfirmedItemUpsert({
        repoRoot,
        lane: "writing_voice",
        fields: { summary: "Plain, direct, and newly updated." },
      });
      const voiceChanged = (await getDirect(routes, "/api/onboard/state")).body.draftContext;
      assert.deepEqual(voiceChanged.owner, first.owner);
      assert.notEqual(voiceChanged.base.revision, changed.base.revision);
    } finally {
      closeAll();
    }
  });

  it("rejects a Settings editor write when its captured base revision is stale", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      await postDirect(routes, "/api/onboard/init", {});
      const before = (await getDirect(routes, "/api/onboard/state")).body.draftContext;
      const external = await postDirect(routes, "/api/onboard/candidate/profile", {
        data: { candidate: { full_name: "New canonical name" } },
      });
      assert.equal(external.status, 200);

      const stale = await postDirect(routes, "/api/onboard/candidate/targeting", {
        expectedBaseRevision: before.base.revision,
        data: {
          role_buckets: [
            { name: "Primary targets", priority: "primary", titles: ["Principal Engineer"] },
          ],
        },
      });

      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, "SETTINGS_BASE_CHANGED");
    } finally {
      closeAll();
    }
  });

  it("file-fallback mode: template example content never marks a step done on a fresh workspace", async () => {
    // Before POST /api/onboard/init, GET /api/onboard/state's file-fallback
    // read path (readBaseDoc) falls back to the TEMPLATE default for any
    // candidate file that doesn't exist yet — and this repo's shipped
    // templates carry illustrative "Jane Candidate" demo content
    // (role_buckets/tracked_companies/cut_signals/claims/location/
    // work_authorized/setup_mode), not empty stubs. That fallback is right
    // for Settings prefill, but setupProgress must only count docs the user
    // actually saved: a brand-new workspace showed several steps green from
    // the example persona alone. So the route feeds computeSetupProgress a
    // present-files-only view, and a fresh workspace starts at zero.
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    const { status, body } = await getDirect(routes, "/api/onboard/state");
    assert.equal(status, 200);
    assert.equal(body.setupProgress.total, 8);
    const doneKeys = body.setupProgress.items.filter((i) => i.done).map((i) => i.key);
    assert.deepEqual(doneKeys, []);
    assert.equal(body.setupProgress.completedCount, 0);
    assert.equal(body.setupProgress.complete, false);
  });

  it("DB-backed mode: setupProgress flips as candidate files are written through the normal write routes", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      await postDirect(routes, "/api/onboard/init", {});

      // Unlike the file-fallback path above, candidateSetupInitialize()
      // seeds SQLite rows without the illustrative example content — and
      // candidate-defaults.mjs's canonical empty shape leaves every location
      // flag (including `remote`) unset, so nothing starts done on a
      // genuinely untouched candidate.
      const initial = await getDirect(routes, "/api/onboard/state");
      assert.equal(initial.status, 200);
      const initialDoneKeys = initial.body.setupProgress.items
        .filter((i) => i.done)
        .map((i) => i.key);
      assert.deepEqual(initialDoneKeys, []);
      assert.equal(initial.body.setupProgress.completedCount, 0);
      assert.equal(initial.body.setupProgress.complete, false);

      await postDirect(routes, "/api/onboard/candidate/targeting", {
        data: {
          role_buckets: [{ name: "Primary", priority: "primary", titles: ["Applied AI Engineer"] }],
          tracked_companies: ["Stripe"],
          cut_signals: ["Below $200K"],
        },
      });

      const afterTargeting = await getDirect(routes, "/api/onboard/state");
      const doneKeys = afterTargeting.body.setupProgress.items
        .filter((i) => i.done)
        .map((i) => i.key);
      assert.deepEqual(doneKeys.sort(), ["companies", "guardrails", "roles"]);
      assert.equal(afterTargeting.body.setupProgress.completedCount, 3);
      assert.equal(afterTargeting.body.setupProgress.complete, false);
    } finally {
      closeAll();
    }
  });

  it("DB-backed mode: resume + evidence flip via the same resume-save path the wizard/interview use", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      await postDirect(routes, "/api/onboard/init", {});
      await postDirect(routes, "/api/onboard/resume", {
        text: "Ada Lovelace\nada@example.com\n\nShipped an agent pipeline.",
        save: true,
      });
      const state = await getDirect(routes, "/api/onboard/state");
      assert.equal(state.body.sourceResumePresent, true);
      assert.ok(state.body.setupProgress.items.find((i) => i.key === "resume").done);
    } finally {
      closeAll();
    }
  });
});

// ---------------------------------------------------------------------------
// dbCandidateFiles() exists — Part 2 fix. candidateSetupInitialize()
// pre-inserts every singleton row (including candidate_profile, whose
// canonical default has location.remote === true — a recall-maximizing
// default, not a candidate answer, see candidate-defaults.mjs) at
// DB-creation time, so a row existing is never proof the candidate wrote
// anything. Before this fix dbCandidateFiles() hardcoded exists:true for
// every entry, which defeated onboardingSetup.js's fileWritten() gate and
// leaked the untouched default's "Remote" sub-line onto a fresh workspace.
// ---------------------------------------------------------------------------

describe("GET /api/onboard/state — files[].exists on a freshly-initialized DB workspace", () => {
  it("reports exists:false for the untouched profile doc, and the Quick facts row therefore renders no 'Remote' sub-line", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      await postDirect(routes, "/api/onboard/init", {});
      const { status, body } = await getDirect(routes, "/api/onboard/state");
      assert.equal(status, 200);

      const profileFile = body.files.find((f) => f.name === "profile");
      assert.ok(profileFile, "expected a files[] entry for profile");
      assert.equal(profileFile.exists, false);
      // The untouched default really does carry location.remote === true —
      // exists:false is what has to suppress it, not the data itself.
      assert.equal(body.data.profile.location.remote, true);

      assert.equal(quickFactsDetailLine({ state: body }), null);
    } finally {
      closeAll();
    }
  });

  it("flips exists:true without treating the ambient remote fallback as another answer", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      await postDirect(routes, "/api/onboard/init", {});
      await postDirect(routes, "/api/onboard/candidate/profile", {
        data: { location: { home: "Austin, TX" } },
      });
      const { body } = await getDirect(routes, "/api/onboard/state");
      const profileFile = body.files.find((f) => f.name === "profile");
      assert.equal(profileFile.exists, true);
      assert.equal(quickFactsDetailLine({ state: body }), null);
    } finally {
      closeAll();
    }
  });
});
