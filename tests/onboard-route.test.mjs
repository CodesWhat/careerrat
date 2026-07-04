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
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ApiError, extractResumeAi } from "../apps/web/src/lib/api.js";
import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { closeAll, dbExists } from "../src/core/db/connection.mjs";
import { candidateConfigGet } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";

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
  // M8: POST /api/onboard/resume-ai reads this schema straight off the repo
  // root (not through userPath — it's a checked-in config schema, never a
  // per-candidate file), so the temp fixture needs its own copy too.
  copyFileSync(
    join(REAL_ROOT, "config/resume-extract.schema.json"),
    join(tempRoot, "config/resume-extract.schema.json")
  );
  // M8 additive (Builder B): AUTOMATION_ROUTE_ENTRY's template+schema aren't
  // part of CANDIDATE_FILES/OPTIONAL_CANDIDATE_FILES (see onboard-route.mjs's
  // own comment on that entry — deliberately NOT auto-scaffolded by
  // ensureCandidateFiles), so this fixture copies them by hand too.
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

function candidatePath(root, relPath) {
  return userPath({ repoRoot: root }, relPath);
}

// Mirrors skill-run-route.test.mjs's bootRouteServer(): a minimal
// addRoute-based harness, no full tracker-dev.mjs dev server needed.
// `extra` optionally carries a stubbed `runSkillStream` (M8's
// POST /api/onboard/resume-ai tests) — every pre-existing caller omits it and
// gets the real default, untouched.
function bootServer(repoRoot, env = {}, extra = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountOnboardRoutes({ addRoute, repoRoot, env, ...extra });

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

// A fake runSkillStream() for POST /api/onboard/resume-ai: takes a list of
// canned assistant replies (one per attempt) and asserts the shape
// onboard-route.mjs's invokeResumeExtract() actually calls it with, mirroring
// tests/skill-runtime.test.mjs's fakeSdk/SAMPLE_RUN convention but at the
// runSkillStream layer (this route's own DI seam) rather than the SDK's.
function fakeRunSkillStream(replies, { onCall } = {}) {
  let callCount = 0;
  return async ({ skill, input, repoRoot, tools, onEvent }) => {
    onCall?.({ skill, input, repoRoot, tools });
    const reply = replies[Math.min(callCount, replies.length - 1)];
    callCount++;
    onEvent({
      type: "assistant",
      data: { message: { content: [{ type: "text", text: reply }] } },
    });
  };
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
  closeAll();
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

  it("reflects state after init: DB setup docs exist+validate, no resume yet", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      const body = await res.json();
      for (const f of body.files) {
        assert.equal(f.exists, true, `${f.name} should exist after init`);
        assert.equal(f.valid, true, `${f.name} should validate from DB defaults`);
      }
      assert.equal(body.sourceResumePresent, false);
      assert.equal(body.searchSourcesPresent, false);
      assert.equal(body.data.profile.candidate.full_name, "");
      assert.deepEqual(body.data.targeting.role_buckets, []);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/profile.yml")), false);
    } finally {
      await closeServer(server);
    }
  });

  it("exposes computed DB setup readiness for quick-start UI gates", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      await postJson(server, "/api/onboard/resume", {
        text: "Ada Lovelace\nada@example.com\nNew York, NY\n\nBuilt agent workflows.",
        save: true,
      });
      await postJson(server, "/api/onboard/candidate/profile", {
        data: {
          candidate: { full_name: "Ada Lovelace", email: "ada@example.com" },
          location: { home: "New York, NY", remote: true },
        },
      });
      await postJson(server, "/api/onboard/candidate/targeting", {
        data: { role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }] },
      });

      const body = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(body.data.setup.readiness.search_ready, true);
      assert.equal(body.data.setup.readiness.gate_ready, false);
      assert.match(body.data.setup.missing.gate_ready.join("\n"), /compensation floor/i);
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

  // M8 additive (Builder B): logo.dev credential PRESENCE, never echoed —
  // reused from logo-route.mjs's resolveLogoTokens() (see that route's own
  // two-credential header comment: publishable image token vs. secret
  // Brand Search key).
  it("logoImageTokenConfigured / logoSearchTokenConfigured reflect candidate/automation.yml#integrations", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const before = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(before.logoImageTokenConfigured, false);
      assert.equal(before.logoSearchTokenConfigured, false);

      await postJson(server, "/api/onboard/init", {});
      await postJson(server, "/api/onboard/candidate/automation", {
        data: { integrations: { logo_dev_token: "pk_test" } },
      });

      const after = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(after.logoImageTokenConfigured, true);
      assert.equal(after.logoSearchTokenConfigured, false);
      // Never echoed — the raw token value must not appear anywhere in the
      // state response.
      assert.equal(JSON.stringify(after).includes("pk_test"), false);
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboard/init
// ---------------------------------------------------------------------------

describe("POST /api/onboard/init", () => {
  it("initializes neutral DB setup docs on first run and never writes candidate YAML", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const first = await postJson(server, "/api/onboard/init", {});
      assert.equal(first.status, 200);
      assert.equal(first.body.ok, true);
      assert.equal(first.body.dbInitialized, true);

      const config = candidateConfigGet({ repoRoot });
      assert.equal(config.profile.candidate.full_name, "");
      assert.equal(config.profile.candidate.email, "");
      assert.deepEqual(config.targeting.role_buckets, []);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/profile.yml")), false);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/targeting.yml")), false);

      const second = await postJson(server, "/api/onboard/init", {});
      assert.equal(second.status, 200);
      assert.equal(second.body.ok, true);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/profile.yml")), false);
    } finally {
      await closeServer(server);
    }
  });
});

describe("POST /api/onboard/init", () => {
  it("initializes the local DB for app-first desktop use", async () => {
    const repoRoot = buildTempRoot();
    assert.equal(dbExists({ repoRoot }), false, "fixture starts without a db");
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postJson(server, "/api/onboard/init", {});
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(dbExists({ repoRoot }), true);
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

  it("save:true stores the source resume in SQLite without writing candidate/SOURCE_RESUME.md", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      const { status } = await postJson(server, "/api/onboard/resume", {
        text: SAMPLE_RESUME,
        save: true,
      });
      assert.equal(status, 200);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/SOURCE_RESUME.md")), false);
      const state = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(state.sourceResumePresent, true);
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
// POST /api/onboard/resume-ai — M8, MOCKED runtime only (no network, no
// ANTHROPIC_API_KEY needed): fakeRunSkillStream() above stands in for the
// real embedded SDK runtime end to end.
// ---------------------------------------------------------------------------

describe("POST /api/onboard/resume-ai", () => {
  const FAKE_PDF_BYTES = Buffer.from("%PDF-1.4 fake pdf bytes for a route test\n");
  const VALID_REPLY = JSON.stringify({
    candidate: { full_name: "Jane Doe", email: "jane.doe@example.com" },
    claims: [{ claim: "Led a team of 5 engineers.", evidence: "Resume, Experience section." }],
    sections: { experience: 1, education: 0, skills: 2, projects: 0, other: 0 },
    targeting_suggestions: {
      role_buckets: [
        {
          name: "Engineering leadership",
          priority: "primary",
          titles: ["Engineering Manager", "Staff Software Engineer"],
          notes: "Matches recent team leadership and architecture scope.",
        },
        {
          name: "Platform",
          priority: "secondary",
          titles: ["Platform Engineer"],
        },
      ],
      keep_signals: ["team leadership", "platform architecture"],
      tracked_companies: ["Stripe", "Ramp", "Linear"],
    },
  });
  const VALID_FENCED_REPLY = `Here you go:\n\`\`\`json\n${VALID_REPLY}\n\`\`\`\n`;

  async function postResumeAi(server, name, bytes) {
    const res = await fetch(
      `${baseUrl(server)}/api/onboard/resume-ai?name=${encodeURIComponent(name)}`,
      { method: "POST", body: bytes }
    );
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  it("happy path: returns the shared envelope with seed data under body.data and exact AI labels", async () => {
    const repoRoot = buildTempRoot();
    const runSkillStream = fakeRunSkillStream([VALID_FENCED_REPLY]);
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      await postJson(server, "/api/onboard/init", {});
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.profileSeed, undefined);
      assert.equal(body.data.source, "ai");
      assert.equal(body.data.profileSeed.candidate.full_name, "Jane Doe");
      assert.equal(body.data.profileSeed.candidate.email, "jane.doe@example.com");
      assert.equal(body.data.evidenceSeed.claims.length, 1);
      assert.equal(body.data.evidenceSeed.claims[0].id, "resume-001");
      assert.equal(body.data.sections.experience, 1);
      assert.equal(body.data.sections.skills, 2);
      assert.deepEqual(body.data.targetingSeed.role_buckets, [
        {
          name: "Engineering leadership",
          priority: "primary",
          titles: ["Engineering Manager", "Staff Software Engineer"],
          notes: "Matches recent team leadership and architecture scope.",
        },
        {
          name: "Platform",
          priority: "secondary",
          titles: ["Platform Engineer"],
        },
      ]);
      assert.deepEqual(body.data.targetingSeed.keep_signals, [
        "team leadership",
        "platform architecture",
      ]);
      assert.deepEqual(body.data.targetingSeed.tracked_companies, ["Stripe", "Ramp", "Linear"]);
      assert.deepEqual(body.ai, {
        used: true,
        label: "resume-extract:resume-ai:onboard.resume-ai",
        skill: "resume-extract",
        action: "resume-ai",
        operation: "onboard.resume-ai",
        mode: "fallback",
        retried: false,
      });
      assert.equal(body.manual.available, true);

      const uploadDir = candidatePath(repoRoot, "workspace/intake/resume-uploads");
      const saved = readdirSync(uploadDir);
      assert.equal(saved.length, 1);
      assert.match(saved[0], /^\d+-resume\.pdf$/);
      assert.ok(readFileSync(join(uploadDir, saved[0])).equals(FAKE_PDF_BYTES));

      const state = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(state.sourceResumePresent, true);
      assert.equal(
        state.data.setup.missing.search_ready.includes("source resume"),
        false,
        "PDF/image upload must satisfy the source-resume readiness input"
      );
    } finally {
      await closeServer(server);
    }
  });

  it("retry-then-ok: first attempt malformed, second (correction) attempt valid — 200, retried once", async () => {
    const repoRoot = buildTempRoot();
    const calls = [];
    const runSkillStream = fakeRunSkillStream(["not json at all", VALID_FENCED_REPLY], {
      onCall: (info) => calls.push(info),
    });
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.data.source, "ai");
      assert.equal(body.ai.retried, true);
      assert.equal(calls.length, 2, "invoke must be called exactly twice — one retry");
      assert.equal(calls[0].tools.length, 1);
      assert.equal(calls[0].tools[0], "Read");
      assert.match(calls[1].input, /Read the file at this exact path/);
    } finally {
      await closeServer(server);
    }
  });

  it("422s when the model never produces valid structured output, even after the retry", async () => {
    const repoRoot = buildTempRoot();
    const invalidReply = "still not json on retry either";
    const runSkillStream = fakeRunSkillStream(["still not json", invalidReply]);
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 422);
      assert.equal(body.ok, false);
      assert.equal(body.code, "AI_SCHEMA_INVALID");
      assert.equal(body.manual.available, true);
      assert.equal(body.raw, undefined);
      assert.equal(JSON.stringify(body).includes(invalidReply), false);
    } finally {
      await closeServer(server);
    }
  });

  it("413s over the 5MB cap and never invokes the runtime", async () => {
    const repoRoot = buildTempRoot();
    let called = false;
    const runSkillStream = async () => {
      called = true;
    };
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
      const { status } = await postResumeAi(server, "resume.pdf", oversized);
      assert.equal(status, 413);
      assert.equal(called, false);
    } finally {
      await closeServer(server);
    }
  });

  it("501s when runSkillStream rejects with NO_AI_ROUTE (no key configured)", async () => {
    const repoRoot = buildTempRoot();
    const runSkillStream = async () => {
      const err = new Error("no AI route configured");
      err.code = "NO_AI_ROUTE";
      throw err;
    };
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 501);
      assert.equal(body.ok, false);
      assert.equal(body.code, "NO_AI_ROUTE");
      assert.equal(body.ai.used, false);
      assert.equal(body.ai.skill, "resume-extract");
      assert.equal(body.ai.action, "resume-ai");
      assert.equal(body.ai.operation, "onboard.resume-ai");
      assert.equal(body.manual.available, true);
    } finally {
      await closeServer(server);
    }
  });

  it("502s when runSkillStream rejects with SDK_NOT_INSTALLED", async () => {
    const repoRoot = buildTempRoot();
    const runSkillStream = async () => {
      const err = new Error("the claude-agent-sdk devDependency is not installed");
      err.code = "SDK_NOT_INSTALLED";
      throw err;
    };
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 502);
      assert.equal(body.ok, false);
      assert.equal(body.code, "AI_PROVIDER_FAILED");
      assert.equal(body.ai.used, true);
      assert.equal(body.manual.available, true);
    } finally {
      await closeServer(server);
    }
  });

  it("502s when runSkillStream rejects with SKILL_NOT_ALLOWED", async () => {
    const repoRoot = buildTempRoot();
    const runSkillStream = async () => {
      const err = new Error("resume-extract is not in the runtime allowlist");
      err.code = "SKILL_NOT_ALLOWED";
      throw err;
    };
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 502);
      assert.equal(body.code, "AI_PROVIDER_FAILED");
    } finally {
      await closeServer(server);
    }
  });

  for (const [code, message] of [
    ["AI_PROVIDER_FAILED", "provider returned 500"],
    ["AI_PROXY_FAILED", "proxy unavailable"],
    ["AI_TIMEOUT", "provider timed out"],
    ["AI_TRANSPORT_FAILED", "transport disconnected"],
  ]) {
    it(`502s with AI_PROVIDER_FAILED when runSkillStream rejects with ${code}`, async () => {
      const repoRoot = buildTempRoot();
      const runSkillStream = async () => {
        const err = new Error(message);
        err.code = code;
        throw err;
      };
      const { server } = await bootServer(repoRoot, {}, { runSkillStream });
      try {
        const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
        assert.equal(status, 502);
        assert.equal(body.ok, false);
        assert.equal(body.code, "AI_PROVIDER_FAILED");
        assert.equal(body.ai.used, true);
        assert.equal(body.manual.available, true);
        assert.equal(JSON.stringify(body).includes(message), false);
      } finally {
        await closeServer(server);
      }
    });
  }

  it("keeps resume-extract constrained to the Read tool surface", async () => {
    const repoRoot = buildTempRoot();
    const calls = [];
    const runSkillStream = fakeRunSkillStream([VALID_FENCED_REPLY], {
      onCall: (info) => calls.push(info),
    });
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].skill, "resume-extract");
      assert.deepEqual(calls[0].tools, ["Read"]);
    } finally {
      await closeServer(server);
    }
  });

  it("400s when ?name= is missing", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const res = await fetch(`${baseUrl(server)}/api/onboard/resume-ai`, {
        method: "POST",
        body: FAKE_PDF_BYTES,
      });
      assert.equal(res.status, 400);
    } finally {
      await closeServer(server);
    }
  });

  it("400s on an unsupported extension (e.g. .docx / .txt)", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postResumeAi(server, "resume.docx", FAKE_PDF_BYTES);
      assert.equal(status, 400);
      assert.match(body.error, /resume-ai accepts PDF\/image uploads only/);
    } finally {
      await closeServer(server);
    }
  });

  it("400s on an empty request body", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", Buffer.alloc(0));
      assert.equal(status, 400);
      assert.match(body.error, /body is empty/);
    } finally {
      await closeServer(server);
    }
  });
});

describe("extractResumeAi", () => {
  it("unwraps shared success envelope data for ResumeStep.applySeed()", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              profileSeed: { candidate: { full_name: "Jane Doe" } },
              evidenceSeed: { claims: [] },
              sections: { experience: 1 },
              targetingSeed: { role_buckets: [] },
              source: "ai",
            },
            ai: { used: true },
            manual: { available: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );

      const result = await extractResumeAi({ name: "resume.pdf" });
      assert.equal(result.ok, undefined);
      assert.equal(result.source, "ai");
      assert.equal(result.profileSeed.candidate.full_name, "Jane Doe");
      assert.deepEqual(result.evidenceSeed.claims, []);
      assert.equal(result.sections.experience, 1);
      assert.deepEqual(result.targetingSeed.role_buckets, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves ApiError body for shared error envelopes", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: "AI_SCHEMA_INVALID",
            manual: { available: true },
          }),
          { status: 422, headers: { "content-type": "application/json" } }
        );

      await assert.rejects(
        () => extractResumeAi({ name: "resume.pdf" }),
        (err) =>
          err instanceof ApiError &&
          err.status === 422 &&
          err.body.code === "AI_SCHEMA_INVALID" &&
          err.body.manual.available === true
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboard/candidate/:name
// ---------------------------------------------------------------------------

describe("POST /api/onboard/candidate/:name", () => {
  it("deep-merges posted data onto neutral DB defaults, validates, and writes no YAML", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      const { status, body } = await postJson(server, "/api/onboard/candidate/profile", {
        data: { candidate: { full_name: "Ada Lovelace", email: "ada@example.com" } },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const written = candidateConfigGet({ repoRoot }).profile;
      assert.equal(written.candidate.full_name, "Ada Lovelace");
      assert.equal(written.candidate.email, "ada@example.com");
      // Sibling top-level keys from the neutral DB defaults survive an object-merge patch.
      assert.equal(written.compensation.target_base, null);
      // Sibling candidate.* fields not touched by the patch survive too.
      assert.equal(written.candidate.domain, "");
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/profile.yml")), false);
    } finally {
      await closeServer(server);
    }
  });

  it("400s on an invalid merge and does NOT write — a prior valid write is preserved untouched", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      const valid = await postJson(server, "/api/onboard/candidate/profile", {
        data: { candidate: { full_name: "Grace Hopper", email: "grace@example.com" } },
      });
      assert.equal(valid.status, 200);
      const beforeInvalid = candidateConfigGet({ repoRoot }).profile;

      // compensation must be an object per profile.schema.json — replacing it
      // with a bare string fails type validation.
      const invalid = await postJson(server, "/api/onboard/candidate/profile", {
        data: { compensation: "broken" },
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.ok, false);
      assert.ok(Array.isArray(invalid.body.errors) && invalid.body.errors.length > 0);

      const afterInvalid = candidateConfigGet({ repoRoot }).profile;
      assert.deepEqual(afterInvalid, beforeInvalid, "the DB doc must be unchanged on invalid");
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/profile.yml")), false);
    } finally {
      await closeServer(server);
    }
  });

  it("400s when body.data is missing or not an object", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
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
      await postJson(server, "/api/onboard/init", {});
      const { status, body } = await postJson(server, "/api/onboard/candidate/modes", {
        data: { usage_mode: "lean" },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      const written = candidateConfigGet({ repoRoot }).modes;
      assert.equal(written.usage_mode, "lean");
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/modes.yml")), false);
    } finally {
      await closeServer(server);
    }
  });

  it("404s for a name outside CANDIDATE_FILES + modes + automation", async () => {
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

  // M8 additive (Builder B): the Companies step's ONLY way to configure
  // logo.dev credentials — see onboard-route.mjs's AUTOMATION_ROUTE_ENTRY
  // comment for why this route exists despite "automation" not being an
  // OPTIONAL_CANDIDATE_FILES entry.
  it("mounts a route for 'automation' that merges integrations.* onto the template default", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      const { status, body } = await postJson(server, "/api/onboard/candidate/automation", {
        data: { integrations: { logo_dev_token: "pk_test", logo_dev_secret_key: "sk_test" } },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const written = candidateConfigGet({ repoRoot }).automation;
      assert.equal(written.integrations.logo_dev_token, "pk_test");
      assert.equal(written.integrations.logo_dev_secret_key, "sk_test");
      // The rest of the template's opt-in-off matrix survives untouched —
      // writing logo.dev credentials never flips any automation switch on.
      assert.equal(written.consent?.linkedin ?? false, false);
      assert.equal(written.capabilities?.authenticated_search?.enabled ?? false, false);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/automation.yml")), false);
    } finally {
      await closeServer(server);
    }
  });

  it("does NOT scaffold candidate/automation.yml on POST /api/onboard/init — its absence stays load-bearing", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/automation.yml")), false);
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
      await postJson(server, "/api/onboard/init", {});
      const seed = await postJson(server, "/api/onboard/evidence-seed", {
        claims: [
          {
            id: "project-001",
            claim: "Existing claim text.",
            evidence: "Prior evidence.",
          },
        ],
      });
      assert.equal(seed.status, 200);

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

      const written = candidateConfigGet({ repoRoot }).evidence;
      assert.equal(written.claims.length, 2);
      const ids = written.claims.map((c) => c.id);
      assert.equal(new Set(ids).size, 2, "ids must not collide");
      assert.ok(ids.includes("project-001"));
      const newClaim = written.claims.find((c) => c.claim === "Brand new claim from the resume.");
      assert.ok(newClaim);
      assert.notEqual(newClaim.id, "project-001");
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/evidence.yml")), false);
    } finally {
      await closeServer(server);
    }
  });

  it("400s when body.claims is missing or not an array", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
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
  it("400s when DB candidate setup has not been initialized yet", async () => {
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

  it("exports compatibility YAML, config/search-sources.yml, and candidate/AGENTS.md from DB setup", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      await postJson(server, "/api/onboard/candidate/profile", {
        data: { candidate: { full_name: "Ada Lovelace", email: "ada@example.com" } },
      });
      await postJson(server, "/api/onboard/candidate/targeting", {
        data: {
          role_buckets: [
            { name: "Applied AI", priority: "primary", titles: ["Applied AI Engineer"] },
          ],
          keep_signals: ["agents"],
          cut_signals: ["adtech"],
        },
      });
      const { status, body } = await postJson(server, "/api/onboard/write-config", {});
      assert.equal(status, 200);
      assert.ok(body.written.length >= 4);

      const exportedProfile = parseYaml(
        readFileSync(candidatePath(repoRoot, "candidate/profile.yml"), "utf8")
      );
      assert.equal(exportedProfile.candidate.full_name, "Ada Lovelace");

      const exportedTargeting = parseYaml(
        readFileSync(candidatePath(repoRoot, "candidate/targeting.yml"), "utf8")
      );
      assert.equal(exportedTargeting.role_buckets[0].titles[0], "Applied AI Engineer");

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
// POST /api/onboard/quick-start
// ---------------------------------------------------------------------------

describe("POST /api/onboard/quick-start", () => {
  it("409s when DB setup exists but is not search-ready", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});

      const { status, body } = await postJson(server, "/api/onboard/quick-start", {});
      assert.equal(status, 409);
      assert.equal(body.ok, false);
      assert.match(body.error, /not search-ready/i);
      assert.equal(body.readiness.search_ready, false);
      assert.deepEqual(body.missing.search_ready, ["source resume", "role titles"]);
      assert.equal(existsSync(candidatePath(repoRoot, "config/search-sources.yml")), false);
    } finally {
      await closeServer(server);
    }
  });

  it("writes search compatibility output and returns the discovery handoff once search-ready", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      await postJson(server, "/api/onboard/resume", {
        text: "Ada Lovelace\nada@example.com\nNew York, NY\n\nBuilt agent workflows.",
        save: true,
      });
      await postJson(server, "/api/onboard/candidate/profile", {
        data: {
          candidate: { full_name: "Ada Lovelace", email: "ada@example.com" },
          location: { home: "New York, NY", remote: true },
        },
      });
      await postJson(server, "/api/onboard/candidate/targeting", {
        data: {
          role_buckets: [
            { name: "Applied AI", priority: "primary", titles: ["Applied AI Engineer"] },
          ],
        },
      });

      const { status, body } = await postJson(server, "/api/onboard/quick-start", {});
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.readiness.search_ready, true);
      assert.equal(body.readiness.gate_ready, false);
      assert.equal(body.readiness.apply_ready, false);
      assert.equal(body.nextSkill, "research-boards");
      assert.match(body.nextMessage, /discover-companies/i);
      assert.ok(body.written.some((path) => path.endsWith("config/search-sources.yml")));
      assert.ok(body.written.some((path) => path.endsWith("candidate/AGENTS.md")));
      assert.equal(body.searches.count > 0, true);

      const searchSources = parseYaml(
        readFileSync(candidatePath(repoRoot, "config/search-sources.yml"), "utf8")
      );
      assert.ok(Array.isArray(searchSources.searches));
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/profile.yml")), true);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/targeting.yml")), true);
      assert.equal(
        existsSync(candidatePath(repoRoot, "candidate/SOURCE_RESUME.md")),
        false,
        "source resume remains DB artifact; quick-start only writes compatibility output"
      );
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
