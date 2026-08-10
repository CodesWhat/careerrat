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

import { computeSetupProgress, mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
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
  it("marks all 9 items not-done, completedCount 0, and complete:false with no data at all", () => {
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
        "consent",
      ]
    );
    assert.ok(progress.items.every((i) => i.done === false));
    assert.equal(progress.completedCount, 0);
    assert.equal(progress.total, 9);
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

  it("companies flips on a non-empty tracked_companies array", () => {
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

  it("quickFacts flips on home text OR any of remote/hybrid/onsite, independently", () => {
    assert.equal(
      computeSetupProgress({ data: { profile: { location: { home: "Austin, TX" } } } }).items.find(
        (i) => i.key === "quickFacts"
      ).done,
      true
    );
    assert.equal(
      computeSetupProgress({ data: { profile: { location: { remote: true } } } }).items.find(
        (i) => i.key === "quickFacts"
      ).done,
      true
    );
    assert.equal(
      computeSetupProgress({
        data: { profile: { location: { home: "   " } } },
      }).items.find((i) => i.key === "quickFacts").done,
      false,
      "whitespace-only home must not count as set"
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

  it("consent flips once automation.setup_mode is explicitly written, or a recorded decline", () => {
    assert.equal(
      computeSetupProgress({ data: { automation: {} } }).items.find((i) => i.key === "consent")
        .done,
      false
    );
    assert.equal(
      computeSetupProgress({
        data: { automation: { setup_mode: "basic" } },
      }).items.find((i) => i.key === "consent").done,
      true
    );
    assert.equal(
      computeSetupProgress({
        data: { automation: { setup_mode: "advanced" } },
      }).items.find((i) => i.key === "consent").done,
      true
    );
    assert.equal(
      computeSetupProgress({
        data: {
          "form-defaults": {
            declined_fields: { consent: { declined_at: "2026-08-09T12:00:00Z" } },
          },
        },
      }).items.find((i) => i.key === "consent").done,
      true
    );
  });

  it("completedCount and complete track exactly how many of the 9 flags are true", () => {
    const eightOfNine = computeSetupProgress({
      keyConfigured: true,
      sourceResumePresent: true,
      data: {
        targeting: {
          role_buckets: [{ titles: ["Applied AI Engineer"] }],
          tracked_companies: ["Stripe"],
          cut_signals: ["Below $200K"],
        },
        evidence: { claims: [{ claim: "Shipped a thing" }] },
        profile: { location: { remote: true }, authorization: { work_authorized: true } },
      },
    });
    assert.equal(eightOfNine.completedCount, 8);
    assert.equal(eightOfNine.complete, false);

    const allNine = computeSetupProgress({
      keyConfigured: true,
      sourceResumePresent: true,
      data: {
        targeting: {
          role_buckets: [{ titles: ["Applied AI Engineer"] }],
          tracked_companies: ["Stripe"],
          cut_signals: ["Below $200K"],
        },
        evidence: { claims: [{ claim: "Shipped a thing" }] },
        profile: { location: { remote: true }, authorization: { work_authorized: true } },
        automation: { setup_mode: "basic" },
      },
    });
    assert.equal(allNine.completedCount, 9);
    assert.equal(allNine.complete, true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/onboard/state's setupProgress field — both the file-fallback and
// SQLite-backed read paths (same repoRoot, same request, before/after
// POST /api/onboard/init — mirrors onboard-route.test.mjs's own "includes
// honesty prefill data from file fallback and SQLite state" test).
// ---------------------------------------------------------------------------

function buildTempRoot() {
  const tempRoot = mkdtempSync(join(tmpdir(), "rolester-onboard-setup-progress-"));
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
  it("file-fallback mode: reflects the shipped example persona's illustrative candidate/targeting.yml content (engine/resume still unset)", async () => {
    // Before POST /api/onboard/init, GET /api/onboard/state's file-fallback
    // read path (readBaseDoc) falls back to the TEMPLATE default for any
    // candidate file that doesn't exist yet — and this repo's shipped
    // candidate/targeting.example.yml, evidence.example.yml, and
    // profile.example.yml ship illustrative "Jane Candidate" demo content
    // (role_buckets/tracked_companies/cut_signals/claims/location), not
    // empty stubs. So setupProgress in fallback mode reports those items done
    // from the example content alone — only engine (no key) and resume (no
    // source résumé saved) start unset. The example persona's
    // profile.example.yml ships work_authorized: true (authorization done)
    // and templates/automation.example.yml ships setup_mode: basic (consent
    // done) — same "illustrative example content, not an empty stub" pattern
    // as roles/companies/evidence/guardrails/quickFacts below.
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    const { status, body } = await getDirect(routes, "/api/onboard/state");
    assert.equal(status, 200);
    assert.equal(body.setupProgress.total, 9);
    const doneKeys = body.setupProgress.items.filter((i) => i.done).map((i) => i.key);
    assert.deepEqual(doneKeys.sort(), [
      "authorization",
      "companies",
      "consent",
      "evidence",
      "guardrails",
      "quickFacts",
      "roles",
    ]);
    assert.equal(body.setupProgress.items.find((i) => i.key === "engine").done, false);
    assert.equal(body.setupProgress.items.find((i) => i.key === "resume").done, false);
    assert.equal(body.setupProgress.completedCount, 7);
    assert.equal(body.setupProgress.complete, false);
  });

  it("DB-backed mode: setupProgress flips as candidate files are written through the normal write routes", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      await postDirect(routes, "/api/onboard/init", {});

      // Unlike the file-fallback path above, candidateSetupInitialize()
      // seeds SQLite rows without the illustrative example content — only
      // quickFacts starts done (from the profile template's default
      // location flags).
      const initial = await getDirect(routes, "/api/onboard/state");
      assert.equal(initial.status, 200);
      const initialDoneKeys = initial.body.setupProgress.items
        .filter((i) => i.done)
        .map((i) => i.key);
      assert.deepEqual(initialDoneKeys, ["quickFacts"]);
      assert.equal(initial.body.setupProgress.completedCount, 1);
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
      assert.deepEqual(doneKeys.sort(), ["companies", "guardrails", "quickFacts", "roles"]);
      assert.equal(afterTargeting.body.setupProgress.completedCount, 4);
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
