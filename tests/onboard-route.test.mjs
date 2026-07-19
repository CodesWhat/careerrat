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
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ApiError, extractResumeAi } from "../apps/web/src/lib/api.js";
import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { appendUsageEvent } from "../src/core/ai/usage-log.mjs";
import { closeAll, dbExists } from "../src/core/db/connection.mjs";
import { sourceConfigGet, sourceConfigPut } from "../src/core/db/verbs/source-config.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunStart,
} from "../src/core/db/verbs/sourcing-runs.mjs";
import { candidateArtifactGet, candidateConfigGet } from "../src/core/db/verbs.mjs";
import {
  extractDocxResumeMarkdown,
  extractDocxResumeText,
} from "../src/core/onboarding/resume-docx.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";
import { parseYaml, stringifyYaml } from "../src/core/profile/yaml.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanupRoots = [];
const FORBIDDEN_CONTENT = [
  "PROMPT_SECRET_02_07",
  "RAW_MODEL_REPLY_02_07",
  "RESUME_SECRET_02_07",
  "JD_SECRET_02_07",
  "CANDIDATE_FACT_SECRET_02_07",
  "PAGE_BODY_SECRET_02_07",
];
const FORBIDDEN_TEXT = FORBIDDEN_CONTENT.join(" ");

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

function mountDirectRoutes(repoRoot, env = {}, extra = {}) {
  const routes = new Map();
  mountOnboardRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env,
    ...extra,
  });
  return routes;
}

async function postDirect(routes, path, body, headers = {}) {
  const requestPath = path.split("?")[0];
  const handler = routes.get(`POST ${requestPath}`);
  assert.ok(handler, `expected mounted route for POST ${requestPath}`);
  const req = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(String(body))]);
  req.method = "POST";
  req.url = path;
  req.headers = headers;
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

function postJsonDirect(routes, path, payload) {
  return postDirect(routes, path, JSON.stringify(payload ?? {}), {
    "content-type": "application/json",
  });
}

function postResumeDocxDirect(routes, name, bytes) {
  return postDirect(routes, `/api/onboard/resume-docx?name=${encodeURIComponent(name)}`, bytes);
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

// A fake runSkillStream() for POST /api/onboard/resume-ai: takes a list of
// canned assistant replies (one per attempt) and asserts the shape
// onboard-route.mjs's invokeResumeExtract() actually calls it with, mirroring
// tests/skill-runtime.test.mjs's fakeSdk/SAMPLE_RUN convention but at the
// runSkillStream layer (this route's own DI seam) rather than the SDK's.
function fakeRunSkillStream(replies, { onCall } = {}) {
  let callCount = 0;
  return async ({ skill, input, repoRoot, env, tools, onEvent }) => {
    onCall?.({ skill, input, repoRoot, env, tools });
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

function assertNoSensitiveRouteEnvelope(body) {
  const serialized = JSON.stringify(body);
  for (const key of ["prompt", "body", "raw", "rawText", "resume", "jd", "candidate", "bodyText"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${key}"\\s*:`));
  }
  for (const secret of FORBIDDEN_CONTENT) {
    assert.equal(serialized.includes(secret), false, `route envelope leaked ${secret}`);
  }
}

function assertNoRuntimeHandoff(body) {
  const serialized = JSON.stringify(body);
  for (const token of [
    "chat",
    "chatId",
    "nextSkill",
    "nextMessage",
    "research-boards",
    "discover-companies",
    "search-jobs",
    "/api/chat",
    "/api/skill/run",
  ]) {
    assert.equal(serialized.includes(token), false, `route envelope leaked ${token}`);
  }
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

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function firstSearchFetchStub() {
  return async () =>
    new Response(
      `<?xml version="1.0"?><rss><channel><item><title>Applied AI Engineer</title><link>https://example.test/jobs/1</link><description>Build agent workflows.</description></item></channel></rss>`,
      { status: 200 }
    );
}

async function postResumeDocx(server, name, bytes) {
  const res = await fetch(
    `${baseUrl(server)}/api/onboard/resume-docx?name=${encodeURIComponent(name)}`,
    { method: "POST", body: bytes }
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postResumeAiStreamDirect(routes, name, bytes, { onFrame } = {}) {
  const path = `/api/onboard/resume-ai-stream?name=${encodeURIComponent(name)}`;
  const handler = routes.get("POST /api/onboard/resume-ai-stream");
  assert.ok(handler, "expected mounted resume-ai-stream route");
  const req = Readable.from([bytes]);
  req.method = "POST";
  req.url = path;
  req.headers = {};
  let status = 200;
  let headers = {};
  let text = "";
  const listeners = new Map();
  const res = {
    on(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = nextHeaders;
      return this;
    },
    flushHeaders() {},
    write(chunk) {
      const value = String(chunk);
      text += value;
      if (value.startsWith("data:")) onFrame?.(JSON.parse(value.slice(5).trim()));
      return true;
    },
    end(chunk = "") {
      text += String(chunk);
    },
  };
  await handler(req, res);
  const contentType = headers["Content-Type"] || headers["content-type"] || "";
  if (!contentType.startsWith("text/event-stream")) {
    return { status, contentType, body: text ? JSON.parse(text) : {}, frames: [] };
  }
  const frames = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) frames.push(JSON.parse(line.slice(5).trim()));
  }
  return { status, contentType, text, frames, listeners };
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let k = 0; k < 8; k += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, value] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

function makeDocxResume(paragraphs) {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`)
    .join("");
  return makeZip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`,
    ],
  ]);
}

function makeDocxResumeWithHyperlink({ anchorText, url }) {
  return makeZip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    ],
    [
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(url)}" TargetMode="External"/>
</Relationships>`,
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body><w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>${xmlEscape(anchorText)}</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body>
</w:document>`,
    ],
  ]);
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

describe("GET /api/settings/usage", () => {
  it("returns token spend totals grouped by product feature", async () => {
    const root = buildTempRoot();
    const { server } = await bootServer(root);
    try {
      appendUsageEvent(
        {
          source: "byok",
          skill: "resume-extract",
          action: "resume-ai",
          operation: "onboard.resume-ai",
          model: "claude-sonnet-5",
          tokens_in: 1000,
          tokens_out: 100,
        },
        { root, autoPrune: false }
      );
      appendUsageEvent(
        {
          source: "proxy",
          feature: "company-discovery",
          skill: "discover-companies",
          action: "seed-generate",
          operation: "company-seeds",
          model: "claude-sonnet-5",
          tokens_in: 2000,
          tokens_out: 200,
        },
        { root, autoPrune: false }
      );

      const { status, body } = await getJson(server, "/api/settings/usage");

      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.summary.totals.requests, 2);
      assert.equal(body.summary.totals.tokens_in, 3000);
      assert.equal(body.summary.totals.tokens_out, 300);
      assert.deepEqual(
        body.summary.byFeature.map((entry) => entry.feature),
        ["company-discovery", "onboarding.resume-ingestion"]
      );
      assert.equal(body.summary.byFeature[0].breakdown[0].operation, "company-seeds");
      assertNoSensitiveRouteEnvelope(body);
    } finally {
      await closeServer(server);
    }
  });
});

describe("GET /api/onboard/state", () => {
  it("includes honesty prefill data from file fallback and SQLite state", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      const fileFallback = await getDirect(routes, "/api/onboard/state");
      assert.equal(fileFallback.status, 200);
      assert.equal(fileFallback.body.data.honesty.education.add_education_section, false);
      assert.deepEqual(fileFallback.body.data.honesty.tools.confirmed, ["Example Tool"]);

      await postJsonDirect(routes, "/api/onboard/init", {});
      const dbBacked = await getDirect(routes, "/api/onboard/state");
      assert.equal(dbBacked.status, 200);
      assert.equal(dbBacked.body.data.honesty.education.add_education_section, false);
      assert.deepEqual(dbBacked.body.data.honesty.tools.confirmed, []);
    } finally {
      closeAll();
    }
  });

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
      assert.equal(body.data.honesty.education.add_education_section, false);
      assert.deepEqual(body.data.honesty.claims.do_not_fabricate, [
        "degrees",
        "employers",
        "metrics",
        "tools",
        "security clearances",
        "work authorization",
      ]);
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
      assert.equal(body.data.honesty.education.add_education_section, false);
      assert.deepEqual(body.data.honesty.tools.confirmed, []);
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

  it("exposes durable first-search run status for onboarding reloads", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});

      const running = sourcingRunStart({
        repoRoot,
        purpose: "first-search",
        trigger: "search-ready",
      });
      const runningState = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(runningState.data.sourcing.firstSearchRun.run.id, running.run.id);
      assert.equal(runningState.data.sourcing.firstSearchRun.run.status, "running");
      assert.equal(runningState.sourcing.firstSearchRun.run.status, "running");

      sourcingRunFail({
        repoRoot,
        id: running.run.id,
        error: {
          code: "NO_DETERMINISTIC_SOURCES",
          message: "No deterministic first-search sources are ready.",
        },
      });
      const failedState = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(failedState.data.sourcing.firstSearchRun.run.status, "failed");
      assert.equal(
        failedState.data.sourcing.firstSearchRun.run.error.code,
        "NO_DETERMINISTIC_SOURCES"
      );

      const retry = sourcingRunStart({
        repoRoot,
        purpose: "first-search",
        retryFailed: true,
        trigger: "first-search-retry",
      });
      sourcingRunComplete({
        repoRoot,
        id: retry.run.id,
        summary: { sourcesAttempted: 2, rolesFound: 1 },
      });
      const completedState = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(completedState.data.sourcing.firstSearchRun.run.id, retry.run.id);
      assert.equal(completedState.data.sourcing.firstSearchRun.run.status, "completed");
      assert.deepEqual(completedState.data.sourcing.firstSearchRun.run.summary, {
        sourcesAttempted: 2,
        rolesFound: 1,
      });
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

  // M8 additive (Builder B): logo capability presence, never echoed — reused
  // from logo-route.mjs's resolveLogoTokens(). Image lookup has a built-in
  // publishable default; Brand Search still requires a separate secret key.
  it("logoImageTokenConfigured defaults on while logoSearchTokenConfigured reflects candidate/automation.yml#integrations", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const before = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(before.logoImageTokenConfigured, true);
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

  it("reports DB source readiness from stored SQLite search-sources without compatibility YAML", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      sourceConfigPut({
        repoRoot,
        name: "search-sources",
        data: {
          title_filter: { positive: [], negative: [] },
          location_filter: { always_allow: [], allow: [], block: [] },
          searches: [
            {
              provider: "HiringCafe",
              source_type: "rss",
              label: "Applied AI RSS",
              enabled: true,
              rssUrl: "https://example.test/jobs.xml",
            },
          ],
          tracked_companies: [],
          source_catalog: {},
        },
      });

      assert.equal(sourceConfigGet({ repoRoot, name: "search-sources" }).stored, true);
      assert.equal(existsSync(candidatePath(repoRoot, "config/search-sources.yml")), false);

      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.searchSourcesPresent, true);
      assert.deepEqual(body.deterministicSources, {
        attempted: 1,
        rss: 1,
        boards: 0,
        supportedAtsCompanies: 0,
        skipped: 0,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("does not report browser or URL-query sources as runnable first-search setup", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      sourceConfigPut({
        repoRoot,
        name: "search-sources",
        data: {
          title_filter: { positive: [], negative: [] },
          location_filter: { always_allow: [], allow: [], block: [] },
          searches: [
            {
              provider: "HiringCafe",
              source_type: "url-query",
              label: "HiringCafe — Applied AI",
              enabled: true,
              url: "https://hiring.cafe/?search=applied%20ai",
            },
            {
              provider: "Wellfound",
              source_type: "browser",
              label: "Wellfound — Applied AI",
              enabled: true,
              url: "https://wellfound.com/jobs",
            },
          ],
          tracked_companies: [],
          source_catalog: {},
        },
      });

      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.searchSourcesPresent, false);
      assert.deepEqual(body.deterministicSources, {
        attempted: 0,
        rss: 0,
        boards: 0,
        supportedAtsCompanies: 0,
        skipped: 2,
      });
      assert.deepEqual(
        body.data.sourcing.sourceSetup.deterministicSources,
        body.deterministicSources
      );
    } finally {
      await closeServer(server);
    }
  });

  it("reports supported sourced-scan ATS companies as runnable first-search setup", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      sourceConfigPut({
        repoRoot,
        name: "sourced-scan",
        data: {
          title_filter: {},
          location_filter: null,
          tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
        },
      });

      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.searchSourcesPresent, true);
      assert.deepEqual(body.deterministicSources, {
        attempted: 1,
        rss: 0,
        boards: 0,
        supportedAtsCompanies: 1,
        skipped: 0,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("ignores compatibility search-sources YAML when DB source config is absent", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      const configPath = candidatePath(repoRoot, "config/search-sources.yml");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        `${stringifyYaml({
          searches: [
            {
              provider: "HiringCafe",
              source_type: "url-query",
              label: "Compatibility only",
              enabled: true,
              url: "https://hiring.cafe/?search=compatibility",
            },
          ],
        })}\n`
      );

      assert.equal(sourceConfigGet({ repoRoot, name: "search-sources" }).stored, false);

      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.searchSourcesPresent, false);
    } finally {
      await closeServer(server);
    }
  });

  it("does not treat stored defaults or source-catalog metadata as DB source readiness", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});
      sourceConfigPut({
        repoRoot,
        name: "search-sources",
        data: {
          title_filter: { positive: [], negative: [] },
          location_filter: { always_allow: [], allow: [], block: [] },
          searches: [],
          tracked_companies: [],
          source_catalog: { examples: ["https://example.com/search"] },
        },
      });
      const configPath = candidatePath(repoRoot, "config/search-sources.yml");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, "searches: []\n");

      const stored = sourceConfigGet({ repoRoot, name: "search-sources" });
      assert.equal(stored.stored, true);
      assert.deepEqual(stored.data.searches, []);

      const res = await fetch(`${baseUrl(server)}/api/onboard/state`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.searchSourcesPresent, false);
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

// ---------------------------------------------------------------------------
// GET/POST /api/onboard/draft
// ---------------------------------------------------------------------------

describe("GET/POST /api/onboard/draft", () => {
  it("persists resumable wizard step and draft seeds in the private internal data root", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const before = await (await fetch(`${baseUrl(server)}/api/onboard/draft`)).json();
      assert.equal(before.ok, true);
      assert.deepEqual(before.draft, {
        stepIndex: 0,
        completedIndexes: [],
        draftSeeds: {},
        updatedAt: null,
      });

      const saved = await postJson(server, "/api/onboard/draft", {
        stepIndex: 3,
        completedIndexes: [1, 2, 99, -1, "3"],
        draftSeeds: {
          targeting: {
            role_buckets: [
              {
                name: "Primary",
                priority: "primary",
                titles: ["Applied AI Engineer"],
                fit_signals: ["agent workflows"],
              },
            ],
          },
        },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.draft.stepIndex, 3);
      assert.deepEqual(saved.body.draft.completedIndexes, [1, 2, 3, 7]);
      assert.equal(
        saved.body.draft.draftSeeds.targeting.role_buckets[0].titles[0],
        "Applied AI Engineer"
      );
      assert.match(saved.body.draft.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

      const draftPath = candidatePath(repoRoot, ".internal/onboarding-draft.json");
      assert.equal(existsSync(draftPath), true, "draft should be file-backed");
      assert.equal(
        existsSync(candidatePath(repoRoot, "workspace/setup-state.json")),
        false,
        "wizard draft must not claim the ingest-profile setup-state file"
      );

      const after = await (await fetch(`${baseUrl(server)}/api/onboard/draft`)).json();
      assert.equal(after.draft.stepIndex, 3);
      assert.deepEqual(after.draft.completedIndexes, [1, 2, 3, 7]);
      assert.equal(
        after.draft.draftSeeds.targeting.role_buckets[0].titles[0],
        "Applied AI Engineer"
      );
    } finally {
      await closeServer(server);
    }
  });

  it("clamps invalid draft payloads instead of returning unsafe wizard state", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      const saved = await postJson(server, "/api/onboard/draft", {
        stepIndex: 99,
        draftSeeds: "not an object",
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body.draft.draftSeeds, {});
      assert.equal(saved.body.draft.stepIndex, 7);
      assert.deepEqual(saved.body.draft.completedIndexes, []);
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
      assert.equal(body.resumeDocument.contact.email, "jane.doe@example.com");
      assert.equal(body.resumeDocument.summary, null);
      assert.equal(body.resumeDocument.experience.length, 1);
      assert.match(body.resumeDocument.experience[0].raw_text, /Built production AI workflows/);
      assert.deepEqual(body.resumeDocument.skills[0].items, ["Python", "JavaScript", "SQL"]);
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
// POST /api/onboard/resume-docx — RED contract for Phase 7 DOCX intake.
// ---------------------------------------------------------------------------

describe("DOCX resume extraction", () => {
  it("preserves hyperlink targets in markdown when raw text contains only the anchor", async () => {
    const url = "https://profile.example.test/public";
    const bytes = makeDocxResumeWithHyperlink({ anchorText: "Public profile", url });

    const rawText = await extractDocxResumeText(bytes);
    const markdown = await extractDocxResumeMarkdown(bytes);

    assert.equal(rawText, "Public profile");
    assert.equal(rawText.includes(url), false);
    assert.match(markdown, /Public profile/);
    assert.equal(markdown.includes(url), true);
  });
});

describe("POST /api/onboard/resume-docx", () => {
  const VALID_DOCX = makeDocxResume([
    "Jane Doe",
    "jane.doe@example.com",
    "New York, NY",
    "Experience",
    "Built deterministic onboarding workflows for local-first job search.",
    "Skills",
    "JavaScript, SQLite, React",
  ]);

  it("accepts valid DOCX bytes without AI, saves the original, seeds data, and marks source-resume ready", async () => {
    const repoRoot = buildTempRoot();
    let runSkillStreamCalled = false;
    const runSkillStream = async () => {
      runSkillStreamCalled = true;
      const err = new Error("DOCX must not use resume-ai");
      err.code = "NO_AI_ROUTE";
      throw err;
    };
    const routes = mountDirectRoutes(repoRoot, {}, { runSkillStream });
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});

      const { status, body } = await postResumeDocxDirect(
        routes,
        "../source resume.docx",
        VALID_DOCX
      );

      assert.equal(status, 200);
      assert.equal(body.source, "docx");
      assert.equal(body.extraction, "local");
      assert.notEqual(body.extraction, "ai");
      assert.equal(body.profileSeed.candidate.full_name, "Jane Doe");
      assert.equal(body.profileSeed.candidate.email, "jane.doe@example.com");
      assert.equal(body.sections.experience, 1);
      assert.equal(body.sections.skills, 3);
      assert.equal(body.evidenceSeed.claims.length, 1);
      assert.equal(runSkillStreamCalled, false, "DOCX parsing must not call resume-ai");

      const uploadDir = candidatePath(repoRoot, "workspace/intake/resume-uploads");
      const saved = readdirSync(uploadDir);
      assert.equal(saved.length, 1);
      assert.match(saved[0], /^\d+-source_resume\.docx$/);
      assert.ok(readFileSync(join(uploadDir, saved[0])).equals(VALID_DOCX));

      const artifact = candidateArtifactGet({ repoRoot, id: "source-resume" });
      assert.equal(artifact.source, "docx");
      const state = (await getDirect(routes, "/api/onboard/state")).body;
      assert.equal(state.sourceResumePresent, true);
      assert.equal(
        state.data.setup.missing.search_ready.includes("source resume"),
        false,
        "usable DOCX extraction must satisfy source-resume readiness"
      );
    } finally {
      closeAll();
    }
  });

  it("uses bounded AI when configured and persists AI-derived seeds and source text", async () => {
    const repoRoot = buildTempRoot();
    const markdown = [
      "# Resume Candidate",
      "[LinkedIn](https://www.linkedin.com/in/profile-handle)",
      "[GitHub](https://github.com/profile-handle)",
    ].join("\n");
    const fullText = "AI-derived source resume text.";
    const aiReply = JSON.stringify({
      full_text: fullText,
      candidate: {
        full_name: "Resume Candidate",
        email: "candidate@example.test",
        linkedin: "https://www.linkedin.com/in/profile-handle",
        github: "https://github.com/profile-handle",
      },
      claims: [{ claim: "Built platform systems.", evidence: "Resume experience." }],
      sections: { experience: 1, education: 0, skills: 1, projects: 0, other: 0 },
      targeting_suggestions: {
        role_buckets: [
          {
            name: "Platform engineering",
            priority: "primary",
            titles: ["Platform Engineer"],
          },
        ],
        keep_signals: ["platform systems"],
        tracked_companies: [],
      },
    });
    const calls = [];
    const runSkillStream = fakeRunSkillStream([aiReply], {
      onCall: (info) => calls.push(info),
    });
    const extractDocxResumeMarkdown = async () => markdown;
    const routes = mountDirectRoutes(
      repoRoot,
      { ANTHROPIC_API_KEY: "test-key" },
      { runSkillStream, extractDocxResumeMarkdown }
    );
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});

      const { status, body } = await postResumeDocxDirect(routes, "resume.docx", VALID_DOCX);

      assert.equal(status, 200);
      assert.equal(body.source, "docx");
      assert.equal(body.extraction, "ai");
      assert.equal(
        body.profileSeed.candidate.linkedin,
        "https://www.linkedin.com/in/profile-handle"
      );
      assert.equal(body.profileSeed.candidate.github, "https://github.com/profile-handle");
      assert.equal(body.targetingSeed.role_buckets[0].priority, "primary");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].tools, ["Read"]);
      assert.match(calls[0].input.path, /-resume\.docx\.md$/);
      assert.equal(readFileSync(calls[0].input.path, "utf8"), markdown);

      const artifact = candidateArtifactGet({ repoRoot, id: "source-resume" });
      assert.equal(artifact.source, "docx");
      assert.equal(artifact.extraction, "ai");
      assert.equal(artifact.text, fullText);
      // resume_document was dropped from the extract contract for speed —
      // the persisted artifact must not carry it either.
      assert.equal(artifact.resumeDocument, undefined);
    } finally {
      closeAll();
    }
  });

  it("falls back to local extraction after bounded AI exhausts its retry", async () => {
    const repoRoot = buildTempRoot();
    const calls = [];
    const runSkillStream = fakeRunSkillStream(["not json", "still not json"], {
      onCall: (info) => calls.push(info),
    });
    const routes = mountDirectRoutes(
      repoRoot,
      { ANTHROPIC_API_KEY: "test-key" },
      { runSkillStream, extractDocxResumeMarkdown: async () => "# Converted resume" }
    );
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});

      const { status, body } = await postResumeDocxDirect(routes, "resume.docx", VALID_DOCX);

      assert.equal(status, 200);
      assert.equal(body.source, "docx");
      assert.equal(body.extraction, "local");
      assert.equal(body.profileSeed.candidate.email, "jane.doe@example.com");
      assert.equal(calls.length, 2, "bounded AI should make one attempt and one retry");
      const uploadPath = candidatePath(repoRoot, body.savedPath);
      assert.ok(readFileSync(uploadPath).equals(VALID_DOCX));

      const artifact = candidateArtifactGet({ repoRoot, id: "source-resume" });
      assert.match(artifact.text, /Built deterministic onboarding workflows/);
    } finally {
      closeAll();
    }
  });

  it("keeps an empty DOCX upload but returns 422 without writing source-resume readiness", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot);
    try {
      await postJson(server, "/api/onboard/init", {});

      const emptyDocx = makeDocxResume(["", "   "]);
      const { status, body } = await postResumeDocx(server, "empty.docx", emptyDocx);

      assert.equal(status, 422);
      assert.equal(body.ok, false);
      assert.match(body.error, /could not read usable text/i);
      assert.match(body.savedPath, /^workspace\/intake\/resume-uploads\/\d+-empty\.docx$/);
      assert.ok(readFileSync(candidatePath(repoRoot, body.savedPath)).equals(emptyDocx));

      const state = await (await fetch(`${baseUrl(server)}/api/onboard/state`)).json();
      assert.equal(state.sourceResumePresent, false);
      assert.equal(state.data.setup.missing.search_ready.includes("source resume"), true);
    } finally {
      await closeServer(server);
    }
  });

  it("413s oversized DOCX uploads before extraction", async () => {
    const repoRoot = buildTempRoot();
    let extractorCalled = false;
    const extractDocxResumeText = async () => {
      extractorCalled = true;
      return { ok: true, text: "Jane Doe\njane@example.com" };
    };
    const { server } = await bootServer(repoRoot, {}, { extractDocxResumeText });
    try {
      await postJson(server, "/api/onboard/init", {});

      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
      const { status } = await postResumeDocx(server, "too-big.docx", oversized);

      assert.equal(status, 413);
      assert.equal(extractorCalled, false, "oversized uploads must fail before DOCX parsing");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects non-DOCX uploads before extraction", async () => {
    const repoRoot = buildTempRoot();
    let extractorCalled = false;
    const extractDocxResumeText = async () => {
      extractorCalled = true;
      return { ok: true, text: "Jane Doe\njane@example.com" };
    };
    const { server } = await bootServer(repoRoot, {}, { extractDocxResumeText });
    try {
      await postJson(server, "/api/onboard/init", {});

      const { status, body } = await postResumeDocx(server, "resume.pdf", Buffer.from("%PDF"));

      assert.equal(status, 400);
      assert.match(body.error, /resume-docx accepts DOCX/i);
      assert.equal(extractorCalled, false, "extension validation must fail before DOCX parsing");
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
  const VALID_FULL_TEXT = [
    "Jane Doe",
    "jane.doe@example.com",
    "",
    "Experience",
    "Led a team of 5 engineers.",
    "",
    "Skills",
    "JavaScript, SQLite",
  ].join("\n");
  const VALID_REPLY = JSON.stringify({
    full_text: VALID_FULL_TEXT,
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

  function postResumeAiDirect(routes, name, bytes) {
    return postDirect(routes, `/api/onboard/resume-ai?name=${encodeURIComponent(name)}`, bytes);
  }

  it("happy path: returns the shared envelope with seed data under body.data and exact AI labels", async () => {
    const repoRoot = buildTempRoot();
    const runSkillStream = fakeRunSkillStream([VALID_FENCED_REPLY]);
    const routes = mountDirectRoutes(repoRoot, {}, { runSkillStream });
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});
      const { status, body } = await postResumeAiDirect(routes, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.profileSeed, undefined);
      assert.equal(body.data.source, "ai");
      assert.equal(body.data.fullText, VALID_FULL_TEXT);
      // resume_document was dropped from the extract contract for speed —
      // the response must not carry it either.
      assert.equal(body.data.resumeDocument, undefined);
      assert.match(body.data.savedPath, /^workspace\/intake\/resume-uploads\/\d+-resume\.pdf$/);
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

      const state = (await getDirect(routes, "/api/onboard/state")).body;
      assert.equal(state.sourceResumePresent, true);
      assert.equal(
        state.data.setup.missing.search_ready.includes("source resume"),
        false,
        "PDF/image upload must satisfy the source-resume readiness input"
      );
    } finally {
      closeAll();
    }
  });

  it("legacy mode: writes AI-transcribed text to candidate/SOURCE_RESUME.md while preserving the raw upload", async () => {
    const repoRoot = buildTempRoot();
    const runSkillStream = fakeRunSkillStream([VALID_FENCED_REPLY]);
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 200);
      assert.equal(body.data.fullText, VALID_FULL_TEXT);

      const sourceResumePath = candidatePath(repoRoot, "candidate/SOURCE_RESUME.md");
      assert.equal(readFileSync(sourceResumePath, "utf8"), VALID_FULL_TEXT);

      const uploadPath = candidatePath(repoRoot, body.data.savedPath);
      assert.ok(readFileSync(uploadPath).equals(FAKE_PDF_BYTES));
    } finally {
      await closeServer(server);
    }
  });

  it("passes a blank full_text straight through with no resume_document-derived fallback", async () => {
    const repoRoot = buildTempRoot();
    const sparseReply = JSON.stringify({ ...JSON.parse(VALID_REPLY), full_text: "   " });
    const runSkillStream = fakeRunSkillStream([
      `Ignored prose\n\`\`\`json\n${sparseReply}\n\`\`\``,
    ]);
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 200);
      assert.equal(body.data.fullText, "");
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
    const invalidReply = `still not json on retry either ${FORBIDDEN_TEXT}`;
    const runSkillStream = fakeRunSkillStream([`still not json ${FORBIDDEN_TEXT}`, invalidReply]);
    const { server } = await bootServer(repoRoot, {}, { runSkillStream });
    try {
      const { status, body } = await postResumeAi(server, "resume.pdf", FAKE_PDF_BYTES);
      assert.equal(status, 422);
      assert.equal(body.ok, false);
      assert.equal(body.code, "AI_SCHEMA_INVALID");
      assert.equal(body.manual.available, true);
      assert.equal(body.raw, undefined);
      assert.equal(JSON.stringify(body).includes(invalidReply), false);
      assertNoSensitiveRouteEnvelope(body);
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
      const err = new Error(`no AI route configured ${FORBIDDEN_TEXT}`);
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
      assertNoSensitiveRouteEnvelope(body);
    } finally {
      await closeServer(server);
    }
  });

  it("502s when runSkillStream rejects with SDK_NOT_INSTALLED", async () => {
    const repoRoot = buildTempRoot();
    const runSkillStream = async () => {
      const err = new Error(
        `the claude-agent-sdk devDependency is not installed ${FORBIDDEN_TEXT}`
      );
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
      assertNoSensitiveRouteEnvelope(body);
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
    ["AI_PROVIDER_FAILED", `provider returned 500 ${FORBIDDEN_TEXT}`],
    ["AI_PROXY_FAILED", `proxy unavailable ${FORBIDDEN_TEXT}`],
    ["AI_TIMEOUT", `provider timed out ${FORBIDDEN_TEXT}`],
    ["AI_TRANSPORT_FAILED", `transport disconnected ${FORBIDDEN_TEXT}`],
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
        assertNoSensitiveRouteEnvelope(body);
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

describe("POST /api/onboard/resume-ai-stream", () => {
  const FAKE_PDF_BYTES = Buffer.from("%PDF-1.4 streamed route test\n");
  const FULL_TEXT = "Jane Doe\njane.doe@example.com\nLed platform delivery.";
  const VALID_REPLY = JSON.stringify({
    full_text: FULL_TEXT,
    candidate: { full_name: "Jane Doe", email: "jane.doe@example.com" },
    claims: [{ claim: "Led platform delivery.", evidence: "Resume experience." }],
    sections: { experience: 1, education: 0, skills: 1, projects: 0, other: 0 },
    targeting_suggestions: {
      role_buckets: [{ name: "Platform", priority: "primary", titles: ["Platform Engineer"] }],
      keep_signals: ["platform delivery"],
      tracked_companies: ["Example Corp"],
    },
  });

  it("streams saved, progress, JSON, and done only after registering the artifact", async () => {
    const repoRoot = buildTempRoot();
    let artifactAtDone;
    const runSkillStream = async ({ onEvent }) => {
      onEvent({ type: "system", data: {} });
      onEvent({
        type: "assistant",
        data: { message: { content: [{ type: "thinking", thinking: "Inspecting sections" }] } },
      });
      onEvent({
        type: "assistant",
        data: { message: { content: [{ type: "text", text: VALID_REPLY }] } },
      });
    };
    const routes = mountDirectRoutes(repoRoot, {}, { runSkillStream });
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});
      const result = await postResumeAiStreamDirect(routes, "resume.pdf", FAKE_PDF_BYTES, {
        onFrame(frame) {
          if (frame.type === "done") {
            artifactAtDone = candidateArtifactGet({ repoRoot, id: "source-resume" });
          }
        },
      });

      assert.equal(result.status, 200);
      assert.match(result.contentType, /^text\/event-stream/);
      assert.deepEqual(
        result.frames.map((frame) => frame.type),
        ["saved", "activity", "activity", "activity", "json", "done"]
      );
      assert.equal(result.frames[1].message, "Warming up the reader…");
      assert.equal(result.frames[2].message, "Reading resume.pdf…");
      assert.equal(result.frames[3].message, "Analyzing your resume…");
      assert.equal(result.frames[4].chunk, VALID_REPLY);

      const done = result.frames.at(-1).data;
      assert.deepEqual(Object.keys(done).sort(), [
        "evidenceSeed",
        "fullText",
        "profileSeed",
        "savedPath",
        "sections",
        "source",
        "targetingSeed",
      ]);
      assert.equal(done.fullText, FULL_TEXT);
      assert.equal(done.profileSeed.candidate.full_name, "Jane Doe");
      assert.deepEqual(done.evidenceSeed.claims, [
        {
          id: "resume-001",
          claim: "Led platform delivery.",
          evidence: "Resume experience.",
        },
      ]);
      assert.equal(done.sections.experience, 1);
      assert.equal(done.targetingSeed.role_buckets[0].name, "Platform");
      assert.equal(done.source, "ai");
      assert.match(done.savedPath, /^workspace\/intake\/resume-uploads\/\d+-resume\.pdf$/);
      assert.equal(done.resumeDocument, undefined);

      const artifact = candidateArtifactGet({ repoRoot, id: "source-resume" });
      assert.equal(artifactAtDone.text, FULL_TEXT);
      assert.equal(artifact.source, "resume-ai");
      assert.equal(artifact.text, FULL_TEXT);
      assert.equal(artifact.path, done.savedPath);
      assert.equal(artifact.resumeDocument, undefined);
    } finally {
      closeAll();
    }
  });

  it("returns a 400 JSON response, not SSE, for an unsupported extension", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    const result = await postResumeAiStreamDirect(routes, "resume.docx", FAKE_PDF_BYTES);
    assert.equal(result.status, 400);
    assert.match(result.contentType, /^application\/json/);
    assert.match(result.body.error, /resume-ai accepts PDF\/image uploads only/);
    assert.deepEqual(result.frames, []);
  });

  it("returns a 400 JSON response for an empty body", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    const result = await postResumeAiStreamDirect(routes, "resume.pdf", Buffer.alloc(0));
    assert.equal(result.status, 400);
    assert.match(result.contentType, /^application\/json/);
    assert.match(result.body.error, /body is empty/);
    assert.deepEqual(result.frames, []);
  });

  it("emits a scrubbed terminal error and does not register an artifact", async () => {
    const repoRoot = buildTempRoot();
    const secret = "provider detail RESUME_STREAM_SECRET";
    const runSkillStream = async () => {
      const error = new Error(secret);
      error.code = "AI_PROVIDER_FAILED";
      throw error;
    };
    const routes = mountDirectRoutes(repoRoot, {}, { runSkillStream });
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});
      const result = await postResumeAiStreamDirect(routes, "resume.pdf", FAKE_PDF_BYTES);
      const errorFrame = result.frames.at(-1);

      assert.equal(result.status, 200);
      assert.deepEqual(
        result.frames.map((frame) => frame.type),
        ["saved", "activity", "error"]
      );
      assert.equal(errorFrame.status, 502);
      assert.equal(errorFrame.message.includes(secret), false);
      assert.match(errorFrame.message, /failed|unavailable/i);

      const state = await getDirect(routes, "/api/onboard/state");
      assert.equal(state.body.sourceResumePresent, false);
    } finally {
      closeAll();
    }
  });

  it("restarts before a valid retry and applies the fast model only to the first attempt", async () => {
    const repoRoot = buildTempRoot();
    const calls = [];
    const runSkillStream = fakeRunSkillStream(["not JSON", VALID_REPLY], {
      onCall: (call) => calls.push(call),
    });
    const env = { ANTHROPIC_API_KEY: "test-key" };
    const routes = mountDirectRoutes(repoRoot, env, { runSkillStream });
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});
      const result = await postResumeAiStreamDirect(routes, "resume.pdf", FAKE_PDF_BYTES);

      assert.deepEqual(
        result.frames.map((frame) => frame.type),
        ["saved", "activity", "json", "restart", "json", "done"]
      );
      assert.equal(calls.length, 2);
      assert.equal(calls[0].env.ANTHROPIC_MODEL, "claude-haiku-4-5-20251001");
      assert.equal(calls[1].env, env);
      assert.equal(calls[1].env.ANTHROPIC_MODEL, undefined);
      assert.match(calls[1].input, /Read the file at this exact path/);
    } finally {
      closeAll();
    }
  });

  it("honors ROLESTER_RESUME_EXTRACT_MODEL on the first attempt only", async () => {
    const repoRoot = buildTempRoot();
    const calls = [];
    const runSkillStream = fakeRunSkillStream(["not JSON", VALID_REPLY], {
      onCall: (call) => calls.push(call),
    });
    const env = {
      ANTHROPIC_API_KEY: "test-key",
      ROLESTER_RESUME_EXTRACT_MODEL: "custom-fast-model",
    };
    const routes = mountDirectRoutes(repoRoot, env, { runSkillStream });
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});
      await postResumeAiStreamDirect(routes, "resume.pdf", FAKE_PDF_BYTES);

      assert.equal(calls[0].env.ANTHROPIC_MODEL, "custom-fast-model");
      assert.equal(calls[1].env, env);
      assert.equal(calls[1].env.ANTHROPIC_MODEL, undefined);
    } finally {
      closeAll();
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

describe("POST /api/onboard/candidate/evidence/remove", () => {
  it("removes one evidence claim and validates the required id", async () => {
    const repoRoot = buildTempRoot();
    const routes = mountDirectRoutes(repoRoot);
    try {
      await postJsonDirect(routes, "/api/onboard/init", {});
      await postJsonDirect(routes, "/api/onboard/candidate/evidence", {
        data: {
          claims: [
            { id: "resume-001", claim: "Built the workflow.", evidence: "Resume" },
            { id: "project-001", claim: "Led the rollout.", evidence: "Project notes" },
          ],
        },
      });

      const removed = await postJsonDirect(routes, "/api/onboard/candidate/evidence/remove", {
        id: "resume-001",
      });
      assert.equal(removed.status, 200);
      assert.equal(removed.body.ok, true);
      assert.equal(removed.body.removed, "resume-001");
      assert.deepEqual(
        candidateConfigGet({ repoRoot }).evidence.claims.map((claim) => claim.id),
        ["project-001"]
      );

      const missing = await postJsonDirect(routes, "/api/onboard/candidate/evidence/remove", {});
      assert.deepEqual(missing, {
        status: 400,
        body: { ok: false, error: "body.id is required" },
      });
    } finally {
      closeAll();
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

  it("exports compatibility YAML without clobbering existing DB search sources", async () => {
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
        },
      });

      const existingSource = {
        label: "Saved private search",
        platform: "linkedin",
        url: "https://www.linkedin.com/jobs/search/?keywords=agentic",
        enabled: false,
        auth: "browser",
        recency: { lastRunAt: "2026-07-01T12:00:00Z" },
      };
      sourceConfigPut({
        repoRoot,
        name: "search-sources",
        data: {
          title_filter: { positive: [], negative: [] },
          location_filter: { always_allow: [], allow: [], block: [] },
          searches: [existingSource],
          tracked_companies: [],
          source_catalog: {},
        },
      });

      const { status } = await postJson(server, "/api/onboard/write-config", {});
      assert.equal(status, 200);

      const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
      assert.equal(
        stored.searches.some((source) => source.label === "Saved private search"),
        true
      );
      const preserved = stored.searches.find((source) => source.label === "Saved private search");
      assert.equal(preserved.enabled, false);
      assert.equal(preserved.auth, "browser");
      assert.equal(preserved.recency.lastRunAt, "2026-07-01T12:00:00Z");

      const searchSources = parseYaml(
        readFileSync(candidatePath(repoRoot, "config/search-sources.yml"), "utf8")
      );
      assert.equal(
        searchSources.searches.some((source) => source.label === "Saved private search"),
        true
      );
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

  it("starts the durable first-search run without compatibility exports or discovery handoff", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot, {}, { fetchImpl: firstSearchFetchStub() });
    try {
      await postJson(server, "/api/onboard/init", {});
      await postJson(server, "/api/onboard/resume", {
        text: "Ada Lovelace\nada@example.com\nNew York, NY\n\nBuilt agent workflows.",
        save: true,
      });
      await postJson(server, "/api/onboard/candidate/profile", {
        data: {
          candidate: {
            full_name: "Ada Lovelace",
            email: "ada@example.com",
            domain: "software engineering",
          },
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
      assert.equal(status, 202);
      assert.equal(body.ok, true);
      assert.equal(body.readiness.search_ready, true);
      assert.equal(body.readiness.gate_ready, false);
      assert.equal(body.readiness.apply_ready, false);
      assert.equal(body.reused, false);
      assert.equal(body.run.purpose, "first-search");
      assert.equal(body.run.status, "running");
      assert.equal(body.sources.deterministicSources.attempted > 0, true);
      assertNoRuntimeHandoff(body);
      assert.equal(existsSync(candidatePath(repoRoot, "config/search-sources.yml")), false);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/profile.yml")), false);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/targeting.yml")), false);
      assert.equal(existsSync(candidatePath(repoRoot, "candidate/AGENTS.md")), false);
      assert.equal(
        existsSync(candidatePath(repoRoot, "candidate/SOURCE_RESUME.md")),
        false,
        "source resume remains DB artifact; quick-start does not export compatibility files"
      );
    } finally {
      await closeServer(server);
    }
  });

  it("quick-start preserves existing DB source config entries and watermarks", async () => {
    const repoRoot = buildTempRoot();
    const { server } = await bootServer(repoRoot, {}, { fetchImpl: firstSearchFetchStub() });
    try {
      await postJson(server, "/api/onboard/init", {});
      await postJson(server, "/api/onboard/resume", {
        text: "Ada Lovelace\nada@example.com\nNew York, NY\n\nBuilt agent workflows.",
        save: true,
      });
      await postJson(server, "/api/onboard/candidate/profile", {
        data: {
          candidate: {
            full_name: "Ada Lovelace",
            email: "ada@example.com",
            domain: "software engineering",
          },
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

      sourceConfigPut({
        repoRoot,
        name: "search-sources",
        data: {
          title_filter: { positive: [], negative: [] },
          location_filter: { always_allow: [], allow: [], block: [] },
          searches: [
            {
              label: "Existing board",
              platform: "linkedin",
              url: "https://www.linkedin.com/jobs/search/?keywords=existing",
              enabled: false,
              auth: "browser",
              recency: { lastRunAt: "2026-07-02T15:30:00Z" },
            },
          ],
          tracked_companies: [],
          source_catalog: {},
        },
      });

      const { status, body } = await postJson(server, "/api/onboard/quick-start", {});
      assert.equal(status, 202);
      assert.equal(body.ok, true);
      assert.equal(body.run.purpose, "first-search");
      assertNoRuntimeHandoff(body);

      const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
      const existing = stored.searches.find((source) => source.label === "Existing board");
      assert.ok(existing, "quick-start must preserve existing DB source entries");
      assert.equal(existing.enabled, false);
      assert.equal(existing.auth, "browser");
      assert.equal(existing.recency.lastRunAt, "2026-07-02T15:30:00Z");
      assert.equal(
        stored.searches.some((source) => source.label !== "Existing board"),
        true,
        "quick-start still adds generated baseline sources"
      );
      assert.equal(existsSync(candidatePath(repoRoot, "config/search-sources.yml")), false);
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
