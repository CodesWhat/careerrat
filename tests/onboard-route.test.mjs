// tests/onboard-route.test.mjs
// node:test suite for the non-AI onboarding wizard's HTTP surface (M1 —
// src/cli/onboard-route.mjs). Mirrors tests/skill-run-route.test.mjs's
// bootRouteServer harness (a bare addRoute Map wrapped in http.createServer,
// no full tracker-dev.mjs needed) and tests/candidate-setup.test.mjs's
// temp-repoRoot fixture (real templates + schemas copied into an isolated
// tempdir, never the real repo's candidate/ directory).

import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";
import { parseYaml, stringifyYaml } from "../src/core/profile/yaml.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanupRoots = [];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildTempRoot() {
  const tempRoot = mkdtempSync(join(tmpdir(), "rolester-onboard-route-"));
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

  return tempRoot;
}

function candidatePath(root, relPath) {
  return userPath({ repoRoot: root }, relPath);
}

// Mirrors skill-run-route.test.mjs's bootRouteServer(): a minimal
// addRoute-based harness, no full tracker-dev.mjs dev server needed.
function bootServer(repoRoot, env = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountOnboardRoutes({ addRoute, repoRoot, env });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, env }));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

after(() => {
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/onboard/state
// ---------------------------------------------------------------------------

describe("GET /api/onboard/state", () => {
  it("reports every candidate file missing before init, and no key/config", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.files.length, 5);
      for (const f of body.files) {
        assert.equal(f.exists, false, `${f.name} should not exist yet`);
        assert.equal(f.valid, false);
      }
      assert.equal(body.sourceResumePresent, false);
      assert.equal(body.keyConfigured, false);
      assert.equal(body.searchSourcesPresent, false);
    } finally {
      await closeServer(server);
    }
  });

  it("reflects state after init: files exist+valid, resume present", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      const body = await res.json();
      for (const f of body.files) {
        assert.equal(f.exists, true, `${f.name} should exist after init`);
        assert.equal(f.valid, true, `${f.name} should validate — it's the untouched template`);
      }
      assert.equal(body.sourceResumePresent, true);
      assert.equal(body.searchSourcesPresent, false);
    } finally {
      await closeServer(server);
    }
  });

  it("keyConfigured reflects resolveAIRoute(env)", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot, { ANTHROPIC_API_KEY: "sk-ant-already-set" });
    try {
      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      const body = await res.json();
      assert.equal(body.keyConfigured, true);
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboard/init
// ---------------------------------------------------------------------------

describe("POST /api/onboard/init", () => {
  it("creates 7 template files on first run, and never overwrites on the second", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const first = await postJson(server, "/api/onboard/init", {});
      assert.equal(first.status, 200);
      assert.equal(first.body.created.length, 7);
      assert.equal(first.body.existing.length, 0);

      const profilePath = candidatePath(repoRoot, "candidate/profile.yml");
      const sentinel = "# SENTINEL-DO-NOT-OVERWRITE\n";
      const original = readFileSync(profilePath, "utf8");
      writeFileSync(profilePath, sentinel + original);

      const second = await postJson(server, "/api/onboard/init", {});
      assert.equal(second.body.created.length, 0);
      assert.equal(second.body.existing.length, 7);
      const stillThere = readFileSync(profilePath, "utf8");
      assert.ok(stillThere.startsWith("# SENTINEL-DO-NOT-OVERWRITE"));
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboard/resume
// ---------------------------------------------------------------------------

describe("POST /api/onboard/resume", () => {
  const SAMPLE_RESUME = [
    "Jane Doe",
    "jane.doe@example.com",
    "New York, NY",
    "https://github.com/janedoe",
    "",
    "Experience",
    "Built production AI workflows from prototype to deployment.",
    "Led a team of 5 engineers across two products.",
    "",
    "Skills",
    "Python, JavaScript, SQL",
    "",
  ].join("\n");

  it("parses a plain-text resume into profileSeed/evidenceSeed/sections", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/resume", {
        text: SAMPLE_RESUME,
        save: false,
      });
      assert.equal(status, 200);
      assert.equal(body.profileSeed.candidate.email, "jane.doe@example.com");
      assert.equal(body.profileSeed.candidate.full_name, "Jane Doe");
      assert.equal(body.sections.experience, 1);
      assert.equal(body.sections.skills, 3);
      assert.equal(body.evidenceSeed.claims.length, 2);
      assert.ok(
        !existsSync(candidatePath(repoRoot, "candidate/SOURCE_RESUME.md")),
        "save:false must not write SOURCE_RESUME.md"
      );
    } finally {
      await closeServer(server);
    }
  });

  it("save:true writes candidate/SOURCE_RESUME.md via the atomic-write primitive", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status } = await postJson(server, "/api/onboard/resume", {
        text: SAMPLE_RESUME,
        save: true,
      });
      assert.equal(status, 200);
      const saved = readFileSync(candidatePath(repoRoot, "candidate/SOURCE_RESUME.md"), "utf8");
      assert.equal(saved, SAMPLE_RESUME);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects binary-looking text (a literal NUL byte) with 400 and the PDF/DOCX message", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/resume", {
        text: " %PDF-1.4 binary garbage that made it through FileReader.readAsText",
        save: false,
      });
      assert.equal(status, 400);
      assert.equal(body.error, "PDF/DOCX not supported — export resume as text or markdown");
      assert.ok(!existsSync(candidatePath(repoRoot, "candidate/SOURCE_RESUME.md")));
    } finally {
      await closeServer(server);
    }
  });

  it("rejects text dominated by U+FFFD replacement characters", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const garbage = `${"�".repeat(200)}a few real words`;
      const { status, body } = await postJson(server, "/api/onboard/resume", {
        text: garbage,
        save: false,
      });
      assert.equal(status, 400);
      assert.match(body.error, /PDF\/DOCX not supported/);
    } finally {
      await closeServer(server);
    }
  });

  it("400s when body.text is missing", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/resume", { save: true });
      assert.equal(status, 400);
      assert.match(body.error, /text is required/);
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboard/candidate/:name
// ---------------------------------------------------------------------------

describe("POST /api/onboard/candidate/:name", () => {
  it("deep-merges posted data onto the template default, validates, and writes", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/candidate/profile", {
        data: { candidate: { full_name: "Ada Lovelace", email: "ada@example.com" } },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const written = parseYaml(
        readFileSync(candidatePath(repoRoot, "candidate/profile.yml"), "utf8")
      );
      assert.equal(written.candidate.full_name, "Ada Lovelace");
      assert.equal(written.candidate.email, "ada@example.com");
      // Sibling top-level keys from the template survive an object-merge patch.
      assert.equal(written.compensation.target_base, 165000);
      // Sibling candidate.* fields not touched by the patch survive too.
      assert.equal(written.candidate.domain, "software engineering");
    } finally {
      await closeServer(server);
    }
  });

  it("400s on an invalid merge and does NOT write — a prior valid write is preserved untouched", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const valid = await postJson(server, "/api/onboard/candidate/profile", {
        data: { candidate: { full_name: "Grace Hopper", email: "grace@example.com" } },
      });
      assert.equal(valid.status, 200);
      const profilePath = candidatePath(repoRoot, "candidate/profile.yml");
      const beforeInvalid = readFileSync(profilePath, "utf8");

      // compensation must be an object per profile.schema.json — replacing it
      // with a bare string fails type validation.
      const invalid = await postJson(server, "/api/onboard/candidate/profile", {
        data: { compensation: "broken" },
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.ok, false);
      assert.ok(Array.isArray(invalid.body.errors) && invalid.body.errors.length > 0);

      const afterInvalid = readFileSync(profilePath, "utf8");
      assert.equal(
        afterInvalid,
        beforeInvalid,
        "the file must be byte-identical — no write on invalid"
      );
    } finally {
      await closeServer(server);
    }
  });

  it("400s when body.data is missing or not an object", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/candidate/targeting", {});
      assert.equal(status, 400);
      assert.equal(body.ok, false);
    } finally {
      await closeServer(server);
    }
  });

  it("mounts a route for the optional 'modes' name in addition to the 5 CANDIDATE_FILES", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/candidate/modes", {
        data: { usage_mode: "lean" },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      const written = parseYaml(
        readFileSync(candidatePath(repoRoot, "candidate/modes.yml"), "utf8")
      );
      assert.equal(written.usage_mode, "lean");
    } finally {
      await closeServer(server);
    }
  });

  it("404s for a name outside CANDIDATE_FILES + modes", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const res = await fetch(`${baseUrl(server)}/api/onboard/candidate/not-a-real-file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: {} }),
      });
      assert.equal(res.status, 404);
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboard/evidence-seed
// ---------------------------------------------------------------------------

describe("POST /api/onboard/evidence-seed", () => {
  it("dedupes exact-duplicate claim text and re-numbers new ids without collision", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      // Seed an existing claim with a known id/text (mirrors what init would
      // copy from templates/evidence.example.yml).
      const evidencePath = candidatePath(repoRoot, "candidate/evidence.yml");
      const seedDoc = {
        claims: [
          {
            id: "project-001",
            claim: "Existing claim text.",
            evidence: "Prior evidence.",
          },
        ],
      };
      mkdirSync(candidatePath(repoRoot, "candidate"), { recursive: true });
      writeFileSync(evidencePath, `${stringifyYaml(seedDoc)}\n`);

      const { status, body } = await postJson(server, "/api/onboard/evidence-seed", {
        claims: [
          { claim: "Existing claim text.", evidence: "duplicate attempt — should be skipped" },
          { claim: "Brand new claim from the resume.", evidence: "Real evidence." },
        ],
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.skipped, 1);
      assert.equal(body.added, 1);
      assert.equal(body.total, 2);

      const written = parseYaml(readFileSync(evidencePath, "utf8"));
      assert.equal(written.claims.length, 2);
      const ids = written.claims.map((c) => c.id);
      assert.equal(new Set(ids).size, 2, "ids must not collide");
      assert.ok(ids.includes("project-001"));
      const newClaim = written.claims.find((c) => c.claim === "Brand new claim from the resume.");
      assert.ok(newClaim);
      assert.notEqual(newClaim.id, "project-001");
    } finally {
      await closeServer(server);
    }
  });

  it("400s when body.claims is missing or not an array", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/evidence-seed", {});
      assert.equal(status, 400);
      assert.match(body.error, /claims must be an array/);
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboard/write-config
// ---------------------------------------------------------------------------

describe("POST /api/onboard/write-config", () => {
  it("400s when profile.yml/targeting.yml don't exist yet", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/write-config", {});
      assert.equal(status, 400);
      assert.ok(body.error);
      assert.ok(!existsSync(candidatePath(repoRoot, "config/search-sources.yml")));
    } finally {
      await closeServer(server);
    }
  });

  it("writes config/search-sources.yml and candidate/AGENTS.md once profile+targeting validate", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      const { status, body } = await postJson(server, "/api/onboard/write-config", {});
      assert.equal(status, 200);
      assert.equal(body.written.length, 2);

      const searchSources = parseYaml(
        readFileSync(candidatePath(repoRoot, "config/search-sources.yml"), "utf8")
      );
      assert.ok(Array.isArray(searchSources.searches));

      const agents = readFileSync(candidatePath(repoRoot, "candidate/AGENTS.md"), "utf8");
      assert.match(agents, /## Candidate Context/);
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// BYOK key storage
// ---------------------------------------------------------------------------

describe("POST /api/settings/ai-key + GET /api/settings/ai", () => {
  it("stores a key, never echoes it back, and GET reflects the resolved route", async () => {
    const repoRoot = buildTempRoot();
    const { server, env } = await bootServer(repoRoot);
    try {
      const write = await postJson(server, "/api/settings/ai-key", {
        apiKey: "sk-ant-do-not-leak-me",
      });
      assert.equal(write.status, 200);
      assert.deepEqual(write.body, { ok: true, route: "byok" });
      assert.ok(!JSON.stringify(write.body).includes("sk-ant-do-not-leak-me"));
      assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-do-not-leak-me");

      const read = await fetch(`${baseUrl(server)}/api/settings/ai`);
      const readBody = await read.json();
      assert.equal(read.status, 200);
      assert.deepEqual(readBody, { route: "byok", keyPresent: true });
      assert.ok(!JSON.stringify(readBody).includes("sk-ant-do-not-leak-me"));
    } finally {
      await closeServer(server);
    }
  });

  it("400s on a malformed key and leaves any prior key untouched", async () => {
    const repoRoot = buildTempRoot();
    const { server, env } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/settings/ai-key", { apiKey: "sk-ant-good" });
      const bad = await postJson(server, "/api/settings/ai-key", { apiKey: "sk ant with spaces" });
      assert.equal(bad.status, 400);
      assert.ok(bad.body.error);
      assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-good");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/settings/ai reports route 'none' when no key/proxy is configured", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot, {});
    try {
      const res = await fetch(`${baseUrl(server)}/api/settings/ai`);
      const body = await res.json();
      assert.equal(body.route, "none");
      assert.equal(body.keyPresent, false);
    } finally {
      await closeServer(server);
    }
  });
});
