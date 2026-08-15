// tests/intake-route.test.mjs — the HTTP surface for M9 Universal Intake
// (src/cli/intake-route.mjs), mounted on a bare addRoute Map wrapped in
// http.createServer, mirroring tests/data-route.test.mjs's bootServer() and
// tests/assist-route.test.mjs's fakeSdk() convention. `runSkillStream` and
// `chatRuntime` are hand-rolled stubs here — no real Agent SDK subprocess,
// no real chat-runtime session pump — so Lane A/B/C execution is fully
// observable and deterministic.
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
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { mountIntakeRoutes } from "../src/cli/intake-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import {
  intakeCapture,
  intakeOne,
  intakeUpdate,
  reconcileOrphanedLaneCIntakeItems,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-intake-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  for (const relPath of [
    "config/intake-classify.schema.json",
    "config/intake-extract.schema.json",
    "config/paste-intake-routes.json",
  ]) {
    copyFileSync(join(REAL_ROOT, relPath), join(repoRoot, relPath));
  }
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

// ---------------------------------------------------------------------------
// buildMinimalDocx — a hand-rolled, spec-minimal DOCX (ZIP of
// WordprocessingML), generated programmatically here rather than checking in
// a binary fixture, mirroring src/core/documents/export.mjs's own
// renderDocxOoxml()/buildZip() pattern (hand-rolled ZIP central directory +
// node:zlib DEFLATE, no external zip dependency). Just enough parts —
// [Content_Types].xml, _rels/.rels, word/document.xml — for mammoth's
// extractRawText() to read real paragraph text back out. Verified against a
// live mammoth call while building this fixture.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localHeaders = [];
  const centralDir = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const dataBytes = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(dataBytes, { level: 6 });
    const crc = crc32(dataBytes);
    const compSize = compressed.length;
    const uncompSize = dataBytes.length;

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(0, 10); // DOS date/time — not read back by mammoth
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compSize, 18);
    localHeader.writeUInt32LE(uncompSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);
    localHeaders.push(localHeader, compressed);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compSize, 20);
    cd.writeUInt32LE(uncompSize, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);
    centralDir.push(cd);

    offset += localHeader.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

function escapeXml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildMinimalDocx(paragraphs) {
  const bodyXml = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join("");
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${bodyXml}</w:body></w:document>`;

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
    'Target="word/document.xml"/></Relationships>';

  return buildZip([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: rootRels },
    { name: "word/document.xml", content: documentXml },
  ]);
}

const PROXY_ENV = {
  CAREERRAT_AI_PROXY_URL: "http://127.0.0.1:7788",
  CAREERRAT_AI_PROXY_TOKEN: "devtoken",
};

function fakeSdk(messages) {
  return {
    query: ({ options }) => {
      const { signal } = options.abortController;
      async function* gen() {
        for (const m of messages) {
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          yield m;
        }
      }
      const it = gen();
      it.return = async () => ({ value: undefined, done: true });
      return it;
    },
  };
}

function assistantTextRun(text) {
  return [
    {
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 500,
      num_turns: 1,
      session_id: "s1",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
    },
  ];
}

function jsonReply(obj) {
  return `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
}

function classificationFixture(overrides = {}) {
  return {
    kind: "jd-text",
    entities: {
      company: null,
      role: null,
      url: null,
      statusTo: null,
      statusNote: null,
      contactName: null,
      contactEmail: null,
      interviewDate: null,
    },
    proposedAction: "Evaluate this posting against your gate.",
    confidence: 0.9,
    needsUser: false,
    needsUserReason: null,
    ...overrides,
  };
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountIntakeRoutes({
    addRoute,
    repoRoot,
    env: opts.env ?? PROXY_ENV,
    fetchImpl: opts.fetchImpl,
    loadSdk: opts.loadSdk,
    runSkillStream: opts.runSkillStream,
    chatRuntime: opts.chatRuntime,
    workspaceAgentRuntime: opts.workspaceAgentRuntime,
    captureTextImpl: opts.captureTextImpl,
  });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    dispatchHttpRoute(route, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

async function postRaw(server, path, body, headers = {}) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers,
    body,
  });
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

function seedApp(repoRoot, app) {
  seedApps(repoRoot, [app]);
}

function seedApps(repoRoot, apps) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      { meta: {}, applications: apps, sourced: [], sources: [], communications: [] },
      null,
      2
    )
  );
  importFromTracker({ repoRoot, sourceDir });
}

async function waitForPredicate(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitForPredicate: condition never became true");
}

// ---------------------------------------------------------------------------
// Fail-closed: no db file yet -> 409 on every route.
// ---------------------------------------------------------------------------

test("every /api/intake route 409s with the fail-closed message when no db exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const capture = await postJson(server, "/api/intake", { text: "hello" });
    assert.equal(capture.status, 409);
    assert.match(capture.body.error, /no database yet/);

    const list = await getJson(server, "/api/intake/list");
    assert.equal(list.status, 409);

    const one = await getJson(server, "/api/intake/one?id=x");
    assert.equal(one.status, 409);

    const classify = await postJson(server, "/api/intake/classify", { id: "x" });
    assert.equal(classify.status, 409);

    const confirm = await postJson(server, "/api/intake/confirm", { id: "x" });
    assert.equal(confirm.status, 409);

    const dismiss = await postJson(server, "/api/intake/dismiss", { id: "x" });
    assert.equal(dismiss.status, 409);

    const upload = await postRaw(server, "/api/intake/upload?name=jd.pdf", Buffer.from("%PDF-1.7"));
    assert.equal(upload.status, 409);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake — capture + validation
// ---------------------------------------------------------------------------

test("POST /api/intake: 400 on missing/blank text", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const missing = await postJson(server, "/api/intake", {});
    assert.equal(missing.status, 400);
    const blank = await postJson(server, "/api/intake", { text: "   " });
    assert.equal(blank.status, 400);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: 400 on an invalid explicit inputKind", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "hi",
      inputKind: "screenshot",
    });
    assert.equal(status, 400);
    assert.match(body.error, /"text" or "url"/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake can preserve the current client contract while routing through workspace-main", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const calls = [];
  const server = await bootServer(repoRoot, {
    captureTextImpl: async (input) => {
      calls.push(input);
      return {
        id: "intake-workspace-1",
        status: "proposed",
        kind: "job-url",
        dispatchSummary: "Evaluate this job before any application work.",
      };
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "https://jobs.example.test/temporal/applied-ai-engineer",
      inputKind: "url",
    });
    assert.equal(status, 200);
    assert.equal(body.item.id, "intake-workspace-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].repoRoot, repoRoot);
    assert.equal(calls[0].text, "https://jobs.example.test/temporal/applied-ai-engineer");
    assert.equal(calls[0].inputKind, "url");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: a classified JD proposes evaluation in workspace-main", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({ kind: "jd-text", entities: { company: "Acme", role: "SRE" } })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "We are hiring an SRE at Acme...",
    });
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "jd-text");
    assert.deepEqual(body.item.dispatch, {
      lane: "W",
      action: "workspace_intent",
      params: { intentType: "job.evaluate-request" },
    });
    assert.equal(body.item.inputKind, "text");
    // M10 — every response carrying a dispatch also carries the matching
    // dispatchSummary string (dispatch-summary.mjs, shared with the confirm-
    // time activity-log title — one implementation, not a client-side mirror).
    assert.equal(body.item.dispatchSummary, "capture and evaluate this job in your workspace");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: direct apply intent survives JD classification and proposes preparation", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({ kind: "jd-text", entities: { company: "Acme", role: "SRE" } })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "Acme\nSRE\nKeep production reliable.",
      requestedAction: "prepare",
    });
    assert.equal(status, 200);
    assert.equal(body.item.requestedAction, "prepare");
    assert.deepEqual(body.item.dispatch, {
      lane: "W",
      action: "workspace_intent",
      params: { intentType: "job.prepare-request" },
    });
    assert.equal(
      body.item.dispatchSummary,
      "capture, evaluate, and prepare this application in your workspace"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake rejects an unsupported requested action", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "Acme\nSRE\nKeep production reliable.",
      requestedAction: "submit-without-confirmation",
    });
    assert.equal(status, 400);
    assert.match(body.error, /requestedAction must be "evaluate" or "prepare"/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: a bare URL auto-detects inputKind:'url' and skips AI when a known-ATS fetch resolves", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const url = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const server = await bootServer(repoRoot, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jobs: [
          {
            title: "Staff Engineer",
            absolute_url: url,
            location: { name: "Remote" },
            content: "<p>JD</p>",
          },
        ],
      }),
    }),
    loadSdk: async () => {
      throw new Error("must never be called — this posting resolves deterministically");
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", { text: url });
    assert.equal(status, 200);
    assert.equal(body.item.inputKind, "url");
    assert.equal(body.item.kind, "job-url");
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.classification.confidence, 1);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: an ambiguous/unclassifiable paste ends at 'needs_you'", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({
              kind: "other",
              needsUser: true,
              needsUserReason: "no clear owner",
            })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", { text: "a stray note" });
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.equal(body.item.dispatch, null);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: an unsupported extension (.zip) captures the binary under workspace/intake/uploads and queues a needs_you item, no extraction attempted", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  let runSkillStreamCalled = false;
  const server = await bootServer(repoRoot, {
    runSkillStream: async () => {
      runSkillStreamCalled = true;
      throw new Error("must never be called for an unsupported extension");
    },
  });
  try {
    const bytes = Buffer.from("PK\x03\x04fake zip body");
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=..%2Fprivate%20archive.zip",
      bytes,
      { "content-type": "application/zip" }
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.item.inputKind, "file");
    assert.equal(body.item.status, "needs_you");
    assert.equal(body.item.kind, "other");
    assert.equal(body.item.rawInput, null);
    assert.match(body.item.sourceFilePath, /^workspace\/intake\/uploads\/.+-private_archive\.zip$/);
    assert.equal(body.item.capturedPath, null);
    assert.equal(body.item.dispatch, null);
    assert.match(body.item.classification.needsUserReason, /isn't available for "\.zip" files/);
    assert.equal(runSkillStreamCalled, false);

    const savedAbsPath = userPath({ repoRoot }, body.item.sourceFilePath);
    assert.equal(existsSync(savedAbsPath), true);
    assert.deepEqual(readFileSync(savedAbsPath), bytes);

    const stored = intakeOne({ repoRoot, id: body.item.id });
    assert.equal(stored.sourceFilePath, body.item.sourceFilePath);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake/upload — file text extraction flowing into
// classifyAndPropose(), the same path pasted text already uses.
// ---------------------------------------------------------------------------

test("POST /api/intake/upload: .txt and .md uploads decode locally and flow into classification", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({ kind: "jd-text", entities: { company: "Acme", role: "SRE" } })
          )
        )
      ),
  });
  try {
    const txt = await postRaw(
      server,
      "/api/intake/upload?name=jd.txt",
      Buffer.from("We are hiring a Senior SRE at Acme...")
    );
    assert.equal(txt.status, 200);
    assert.equal(txt.body.item.status, "proposed");
    assert.equal(txt.body.item.kind, "jd-text");
    assert.equal(txt.body.item.inputKind, "file");
    assert.equal(txt.body.item.extraction, "local");
    assert.match(txt.body.item.rawInput, /We are hiring a Senior SRE at Acme/);
    // The extracted text is persisted to the DB row itself, not just echoed
    // back in the response — classifyAndPropose() patches rawInput onto the
    // item for inputKind:"file" (it was captured as null; see intakeCapture's
    // own inputKind:"file" special-case in verbs/intake.mjs).
    const stored = intakeOne({ repoRoot, id: txt.body.item.id });
    assert.match(stored.rawInput, /We are hiring a Senior SRE at Acme/);

    const md = await postRaw(
      server,
      "/api/intake/upload?name=jd.md",
      Buffer.from("# Senior SRE\n\nWe are hiring a Senior SRE at Acme...")
    );
    assert.equal(md.status, 200);
    assert.equal(md.body.item.status, "proposed");
    assert.equal(md.body.item.extraction, "local");
    assert.match(md.body.item.rawInput, /# Senior SRE/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload preserves direct apply intent for an attached JD", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({ kind: "jd-text", entities: { company: "Acme", role: "SRE" } })
          )
        )
      ),
  });
  try {
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=jd.txt&requestedAction=prepare",
      Buffer.from("Acme\nSRE\nKeep production reliable.")
    );
    assert.equal(status, 200);
    assert.equal(body.item.requestedAction, "prepare");
    assert.equal(body.item.dispatch.params.intentType, "job.prepare-request");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a .docx upload extracts real text via mammoth and flows into classification", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({
              kind: "jd-text",
              entities: { company: "Acme Corp", role: "Senior SRE" },
            })
          )
        )
      ),
  });
  try {
    const docxBytes = buildMinimalDocx([
      "Senior SRE — Acme Corp",
      "We are hiring a Senior SRE to own our core platform reliability.",
    ]);
    const { status, body } = await postRaw(server, "/api/intake/upload?name=jd.docx", docxBytes);
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "jd-text");
    assert.equal(body.item.extraction, "local");
    assert.match(body.item.rawInput, /Senior SRE — Acme Corp/);
    assert.match(body.item.rawInput, /own our core platform reliability/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a .docx upload mammoth can't parse lands needs_you with a docx-specific reason, no classification attempted", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () => {
      throw new Error("must never be called — extraction failed before classification");
    },
  });
  try {
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=broken.docx",
      Buffer.from("this is not a real docx zip")
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.equal(body.item.kind, "other");
    assert.equal(body.item.rawInput, null);
    assert.match(
      body.item.classification.needsUserReason,
      /automatic text extraction failed for this file/
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: an oversized .docx is rejected before any extraction attempt", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () => {
      throw new Error("must never be called — rejected before extraction");
    },
  });
  try {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, "a");
    const { status, body } = await postRaw(server, "/api/intake/upload?name=huge.docx", oversized);
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.match(
      body.item.classification.needsUserReason,
      /automatic text extraction failed for this file/
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a .pdf upload with no AI route configured lands needs_you naming the actual cause, runSkillStream never called", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  let runSkillStreamCalled = false;
  const server = await bootServer(repoRoot, {
    env: {},
    runSkillStream: async () => {
      runSkillStreamCalled = true;
      throw new Error("must never be called when no AI route is configured");
    },
  });
  try {
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=jd.pdf",
      Buffer.from("%PDF-1.7\nfake pdf body\n")
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.equal(body.item.kind, "other");
    assert.match(body.item.classification.needsUserReason, /no AI provider is configured/);
    assert.equal(runSkillStreamCalled, false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a .pdf upload with AI configured runs the intake-extract skill and flows extracted text into classification", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  let seenSkill = null;
  let seenPath = null;
  const server = await bootServer(repoRoot, {
    runSkillStream: async ({ skill, input, onEvent }) => {
      seenSkill = skill;
      seenPath = input?.path;
      onEvent({
        type: "assistant",
        data: {
          message: {
            content: [
              {
                type: "text",
                text: '```json\n{"full_text": "Subject: Staff Engineer at Acme\\n\\nWe are hiring."}\n```',
              },
            ],
          },
        },
      });
      return { ok: true };
    },
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({
              kind: "jd-text",
              entities: { company: "Acme", role: "Staff Engineer" },
            })
          )
        )
      ),
  });
  try {
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=jd.pdf",
      Buffer.from("%PDF-1.7\nfake pdf body\n")
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "jd-text");
    assert.equal(body.item.extraction, "ai");
    assert.match(body.item.rawInput, /Staff Engineer at Acme/);
    assert.equal(seenSkill, "intake-extract");
    assert.match(seenPath, /jd\.pdf$/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a .pdf upload whose extraction throws lands needs_you with a generic extraction-failed reason", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    runSkillStream: async () => {
      throw new Error("provider blew up");
    },
  });
  try {
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=jd.pdf",
      Buffer.from("%PDF-1.7\nfake pdf body\n")
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.equal(body.item.kind, "other");
    assert.match(
      body.item.classification.needsUserReason,
      /automatic text extraction failed for this file/
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a .pdf upload whose extraction reply never validates lands needs_you after the bounded retry", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    runSkillStream: async ({ onEvent }) => {
      onEvent({
        type: "assistant",
        data: { message: { content: [{ type: "text", text: "not json at all" }] } },
      });
      return { ok: true };
    },
  });
  try {
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=jd.pdf",
      Buffer.from("%PDF-1.7\nfake pdf body\n")
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.match(
      body.item.classification.needsUserReason,
      /automatic text extraction failed for this file/
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: an oversized .pdf is rejected before any extraction attempt", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  let runSkillStreamCalled = false;
  const server = await bootServer(repoRoot, {
    runSkillStream: async () => {
      runSkillStreamCalled = true;
      throw new Error("must never be called — rejected before extraction");
    },
  });
  try {
    const oversized = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(5 * 1024 * 1024, "a"),
    ]);
    const { status, body } = await postRaw(server, "/api/intake/upload?name=huge.pdf", oversized);
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.match(
      body.item.classification.needsUserReason,
      /automatic text extraction failed for this file/
    );
    assert.equal(runSkillStreamCalled, false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a plain .eml upload extracts From/Subject/body and flows into classification", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(assistantTextRun(jsonReply(classificationFixture({ kind: "recruiter-email" })))),
  });
  try {
    const eml = [
      "From: Jordan Lee <jordan@temporal.example>",
      "Subject: Next steps",
      "Content-Type: text/plain",
      "",
      "Can you talk Tuesday?",
      "",
    ].join("\r\n");
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=note.eml",
      Buffer.from(eml)
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "recruiter-email");
    assert.equal(body.item.extraction, "local");
    assert.match(body.item.rawInput, /Jordan Lee <jordan@temporal\.example>/);
    assert.match(body.item.rawInput, /Subject: Next steps/);
    assert.match(body.item.rawInput, /Can you talk Tuesday\?/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a quoted-printable .eml body decodes soft line breaks and =XX escapes", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(assistantTextRun(jsonReply(classificationFixture({ kind: "recruiter-email" })))),
  });
  try {
    const eml = [
      "From: Jordan Lee <jordan@temporal.example>",
      "Subject: Re: Applied AI Engineer",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "We=E2=80=99d love to schedule a call=",
      " next week.",
      "",
    ].join("\r\n");
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=note-qp.eml",
      Buffer.from(eml)
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.extraction, "local");
    assert.match(body.item.rawInput, /We’d love to schedule a call next week\./);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a base64 .eml body decodes to plain text", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(assistantTextRun(jsonReply(classificationFixture({ kind: "recruiter-email" })))),
  });
  try {
    const encodedBody = Buffer.from("Are you free for a call this Thursday?").toString("base64");
    const eml = [
      "From: Jordan Lee <jordan@temporal.example>",
      "Subject: Scheduling",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: base64",
      "",
      encodedBody,
      "",
    ].join("\r\n");
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=note-b64.eml",
      Buffer.from(eml)
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.extraction, "local");
    assert.match(body.item.rawInput, /Are you free for a call this Thursday\?/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/upload: a multipart .eml with only an HTML part degrades to needs_you rather than garbling output", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot, {
    loadSdk: async () => {
      throw new Error("must never be called — extraction failed before classification");
    },
  });
  try {
    const boundary = "BOUNDARY123";
    const eml = [
      "From: Jordan Lee <jordan@temporal.example>",
      "Subject: Next steps",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/html",
      "",
      "<p>Can you talk Tuesday?</p>",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const { status, body } = await postRaw(
      server,
      "/api/intake/upload?name=html-only.eml",
      Buffer.from(eml)
    );
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    assert.match(
      body.item.classification.needsUserReason,
      /automatic text extraction failed for this file/
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: a status-update paste naming only the company (no role) matches company_unique against the single tracked app, dispatches Lane A, and confirm actually writes the status", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  seedApps(repoRoot, [
    {
      id: "demo-app-1",
      company: "E Corp",
      role: "Staff Software Engineer",
      status: "applied",
      appliedAt: "2026-06-01",
    },
  ]);

  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({
              kind: "status-update",
              entities: {
                company: "E Corp",
                role: null,
                url: null,
                statusTo: "rejected",
                statusNote: "They passed after the final round, position filled internally.",
                contactName: null,
                contactEmail: null,
                interviewDate: null,
              },
              confidence: 0.95,
            })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "Just heard back from E Corp — they passed after the final round, position filled internally.",
    });
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "status-update");
    assert.equal(body.item.trackerMatch.matched, true);
    assert.equal(body.item.trackerMatch.confidence, "company_unique");
    assert.equal(body.item.trackerMatch.recordType, "application");
    assert.equal(body.item.trackerMatch.id, "demo-app-1");
    assert.deepEqual(body.item.dispatch, {
      lane: "A",
      action: "app_set_status",
      params: {
        applicationId: "demo-app-1",
        to: "rejected",
        note: "They passed after the final round, position filled internally.",
        matchedCompany: "E Corp",
        matchedRole: "Staff Software Engineer",
        matchedSummary: body.item.trackerMatch.summary,
      },
    });

    const confirmed = await postJson(server, "/api/intake/confirm", { id: body.item.id });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.item.status, "done");
    assert.equal(confirmed.body.item.result.applicationId, "demo-app-1");

    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("demo-app-1");
    assert.equal(JSON.parse(row.data).status, "rejected");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake: a company-only status-update stays needs_you when TWO tracked apps share that company (still ambiguous)", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedApps(repoRoot, [
    { id: "app-a", company: "E Corp", role: "Staff Software Engineer", status: "applied" },
    { id: "app-b", company: "E Corp", role: "Senior Backend Engineer", status: "interviewing" },
  ]);

  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(
        assistantTextRun(
          jsonReply(
            classificationFixture({
              kind: "status-update",
              entities: {
                company: "E Corp",
                role: null,
                url: null,
                statusTo: "rejected",
                statusNote: "They passed.",
                contactName: null,
                contactEmail: null,
                interviewDate: null,
              },
              confidence: 0.9,
            })
          )
        )
      ),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake", {
      text: "Just heard back from E Corp — they passed.",
    });
    assert.equal(status, 200);
    assert.equal(body.item.status, "needs_you");
    // dispatch is NOT null here (that only happens when the model itself
    // flags needsUser) — resolveIntakeDispatch ran, saw an unmatched
    // trackerMatch, and correctly refused to guess.
    assert.equal(body.item.dispatch.lane, null);
    assert.equal(body.item.dispatch.action, "needs_you");
    assert.match(body.item.dispatch.params.reason, /never guess/);
    assert.equal(body.item.trackerMatch.matched, false);
    assert.equal(body.item.trackerMatch.confidence, null);
    assert.equal(body.item.trackerMatch.companyHistory.length, 2);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// GET /api/intake/list, /api/intake/one
// ---------------------------------------------------------------------------

test("GET /api/intake/list + /api/intake/one round-trip a captured item", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "hello", inputKind: "text" });

  const server = await bootServer(repoRoot);
  try {
    const list = await getJson(server, "/api/intake/list");
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.items.map((i) => i.id),
      [id]
    );

    const one = await getJson(server, `/api/intake/one?id=${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.item.id, id);

    // A freshly-captured item has no resolved dispatch yet — dispatchSummary
    // is present but null, not just absent (see summarizeDispatch(null)).
    assert.equal(list.body.items[0].dispatchSummary, null);
    assert.equal(one.body.item.dispatchSummary, null);

    const missing = await getJson(server, "/api/intake/one?id=nope");
    assert.equal(missing.status, 404);

    const noId = await getJson(server, "/api/intake/one");
    assert.equal(noId.status, 400);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/intake/list + /api/intake/one both carry a non-null dispatchSummary matching a resolved dispatch", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "a JD", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "jd-text",
      classification: classificationFixture(),
      trackerMatch: null,
      dispatch: { lane: "B", action: "run_skill", params: { skill: "evaluate-job" } },
    },
  });

  const server = await bootServer(repoRoot);
  try {
    const list = await getJson(server, "/api/intake/list");
    const listed = list.body.items.find((i) => i.id === id);
    assert.equal(listed.dispatchSummary, "run evaluate-job");

    const one = await getJson(server, `/api/intake/one?id=${id}`);
    assert.equal(one.body.item.dispatchSummary, "run evaluate-job");
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake/classify (re-run)
// ---------------------------------------------------------------------------

test("POST /api/intake/classify: 404 for an unknown id, 400 for a missing id", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const server = await bootServer(repoRoot);
  try {
    const missing = await postJson(server, "/api/intake/classify", {});
    assert.equal(missing.status, 400);
    const unknown = await postJson(server, "/api/intake/classify", { id: "nope" });
    assert.equal(unknown.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/classify: 409 when the item is already confirmed", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  intakeUpdate({ repoRoot, id, patch: { status: "confirmed" } });
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/intake/classify", { id });
    assert.equal(status, 409);
    assert.match(body.error, /cannot be re-classified/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/classify: re-runs classification on an existing item and updates its status", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({
    repoRoot,
    rawInput: "some recruiter email text",
    inputKind: "text",
  });
  intakeUpdate({ repoRoot, id, patch: { status: "error", error: "first attempt failed" } });

  const server = await bootServer(repoRoot, {
    loadSdk: async () =>
      fakeSdk(assistantTextRun(jsonReply(classificationFixture({ kind: "recruiter-email" })))),
  });
  try {
    const { status, body } = await postJson(server, "/api/intake/classify", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "proposed");
    assert.equal(body.item.kind, "recruiter-email");
    assert.deepEqual(body.item.dispatch, {
      lane: "W",
      action: "workspace_intent",
      params: { intentType: "communication.capture-inbound" },
    });
    assert.equal(
      body.item.dispatchSummary,
      "capture the recruiter message in your workspace conversation"
    );
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake/confirm — Lane A/B/C execution
// ---------------------------------------------------------------------------

test("POST /api/intake/confirm: 400 missing id, 404 unknown id, 409 when not 'proposed'", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  intakeUpdate({ repoRoot, id, patch: { status: "needs_you" } });

  const server = await bootServer(repoRoot);
  try {
    const missing = await postJson(server, "/api/intake/confirm", {});
    assert.equal(missing.status, 400);

    const unknown = await postJson(server, "/api/intake/confirm", { id: "nope" });
    assert.equal(unknown.status, 404);

    const wrongStatus = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(wrongStatus.status, 409);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane A calls appSetStatus directly and settles at 'done'", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  seedApp(repoRoot, { id: "app-1", company: "Acme", role: "SRE", status: "applied" });

  const { id } = intakeCapture({ repoRoot, rawInput: "They rejected me", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "status-update",
      classification: classificationFixture({
        kind: "status-update",
        entities: { statusTo: "rejected" },
      }),
      trackerMatch: {
        matched: true,
        recordType: "application",
        id: "app-1",
        confidence: "exact_url",
      },
      dispatch: {
        lane: "A",
        action: "app_set_status",
        params: { applicationId: "app-1", to: "rejected", note: null },
      },
    },
  });

  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "done");
    assert.equal(body.item.result.applicationId, "app-1");

    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1");
    assert.equal(JSON.parse(row.data).status, "rejected");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: a JD evaluates through workspace-main and returns its typed result", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({
    repoRoot,
    rawInput: "Acme\nSRE\nKeep production reliable.",
    inputKind: "text",
  });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "jd-text",
      classification: classificationFixture({
        entities: { company: "Acme", role: "SRE" },
      }),
      dispatch: {
        lane: "W",
        action: "workspace_intent",
        params: { intentType: "job.evaluate-request" },
      },
    },
  });

  const seen = [];
  const evaluation = {
    gate: "keep",
    fitScore: 91,
    fitReasons: ["Strong reliability evidence"],
  };
  const server = await bootServer(repoRoot, {
    workspaceAgentRuntime: {
      async executeIntent(input) {
        seen.push(input);
        return {
          thread: { id: "workspace-main" },
          messages: [
            {
              kind: "action_result",
              text: "Evaluated Acme — SRE: Keep (91/100 fit).",
              artifacts: [{ kind: "job_evaluation", evaluation }],
              metadata: { applicationId: "app-acme", state: "keep" },
            },
          ],
        };
      },
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "done");
    assert.equal(body.item.result.summary, "Evaluated Acme — SRE: Keep (91/100 fit).");
    assert.equal(body.item.result.applicationId, "app-acme");
    assert.deepEqual(body.item.result.evaluation, evaluation);
    assert.deepEqual(seen, [
      {
        intent: {
          type: "job.evaluate-request",
          entity: { type: "intake", id },
        },
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm returns a prepared packet and supervised handoff for direct apply intake", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({
    repoRoot,
    rawInput: "Acme\nSRE\nKeep production reliable.",
    inputKind: "text",
    requestedAction: "prepare",
  });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "jd-text",
      classification: classificationFixture({
        entities: { company: "Acme", role: "SRE" },
      }),
      dispatch: {
        lane: "W",
        action: "workspace_intent",
        params: { intentType: "job.prepare-request" },
      },
    },
  });

  const packet = {
    kind: "packet_generation",
    status: "ready",
    uploadReady: true,
    gaps: [],
    blockingGapCount: 0,
  };
  const handoff = {
    kind: "application_handoff",
    url: "https://boards.greenhouse.io/acme/jobs/123",
  };
  const server = await bootServer(repoRoot, {
    workspaceAgentRuntime: {
      async executeIntent() {
        return {
          thread: { id: "workspace-main" },
          messages: [
            {
              kind: "action_result",
              text: "Evaluated Acme — SRE: Keep. Generated the application packet.",
              artifacts: [
                { kind: "job_evaluation", evaluation: { gate: "keep", fitScore: 91 } },
                packet,
                handoff,
              ],
              metadata: { applicationId: "app-acme", state: "ready", nextActions: [] },
            },
          ],
        };
      },
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "done");
    assert.deepEqual(body.item.result.artifacts, [
      { kind: "job_evaluation", evaluation: { gate: "keep", fitScore: 91 } },
      packet,
      handoff,
    ]);
  } finally {
    await closeServer(server);
  }
});

test("chat-first POST /api/intake/confirm routes an outcome button through workspace-main", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedApp(repoRoot, { id: "app-1", company: "Acme", role: "SRE", status: "applied" });
  const { id } = intakeCapture({ repoRoot, rawInput: "Acme rejected me", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "status-update",
      classification: classificationFixture({
        kind: "status-update",
        entities: { statusTo: "rejected", statusNote: "Role was filled internally." },
      }),
      trackerMatch: {
        matched: true,
        recordType: "application",
        id: "app-1",
        confidence: "company_unique",
      },
      dispatch: {
        lane: "A",
        action: "app_set_status",
        params: {
          applicationId: "app-1",
          to: "rejected",
          note: "Role was filled internally.",
        },
      },
    },
  });

  const seen = [];
  const server = await bootServer(repoRoot, {
    workspaceAgentRuntime: {
      async executeIntent(input) {
        seen.push(input);
        return {
          thread: { id: "workspace-main" },
          messages: [{ kind: "action_result", metadata: { state: "rejected" } }],
        };
      },
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "done");
    assert.equal(body.item.result.threadId, "workspace-main");
    assert.deepEqual(seen, [
      {
        intent: {
          type: "outcome.record",
          entity: { type: "application", id: "app-1" },
          input: {
            to: "rejected",
            note: "Role was filled internally.",
            sourceIntakeId: id,
          },
        },
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane B fires runSkillStream in the background — 'running' immediately, 'done' once it settles", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "a JD", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "jd-text",
      classification: classificationFixture(),
      trackerMatch: null,
      dispatch: { lane: "B", action: "run_skill", params: { skill: "evaluate-job" } },
    },
  });

  let seenSkill = null;
  const server = await bootServer(repoRoot, {
    runSkillStream: async ({ skill }) => {
      seenSkill = skill;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, subtype: "success" };
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "running");
    assert.equal(seenSkill, "evaluate-job");

    await waitForPredicate(() => intakeOne({ repoRoot, id }).status === "done");
    const settled = intakeOne({ repoRoot, id });
    assert.deepEqual(settled.result, { ok: true, subtype: "success" });
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane B settles to 'error' when the background run rejects", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "a JD", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "jd-text",
      classification: classificationFixture(),
      trackerMatch: null,
      dispatch: { lane: "B", action: "run_skill", params: { skill: "evaluate-job" } },
    },
  });

  const server = await bootServer(repoRoot, {
    runSkillStream: async () => {
      throw new Error("skill run blew up");
    },
  });
  try {
    const { body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(body.item.status, "running");

    await waitForPredicate(() => intakeOne({ repoRoot, id }).status === "error");
    const settled = intakeOne({ repoRoot, id });
    assert.match(settled.error, /skill run blew up/);
  } finally {
    await closeServer(server);
  }
});

test("ISSUE-038 POST /api/intake/confirm routes recruiter email through workspace-main, never a skill chat", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({
    repoRoot,
    rawInput:
      "From: Jordan Lee <jordan@temporal.example>\nSubject: Next steps\nCan you talk Tuesday?",
    inputKind: "text",
  });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "recruiter-email",
      classification: classificationFixture({
        kind: "recruiter-email",
        entities: {
          company: "Temporal Labs",
          role: "Applied AI Engineer",
          contactName: "Jordan Lee",
          contactEmail: "jordan@temporal.example",
        },
      }),
      trackerMatch: null,
      dispatch: {
        lane: "W",
        action: "workspace_intent",
        params: { intentType: "communication.capture-inbound" },
      },
    },
  });

  const seen = [];
  const server = await bootServer(repoRoot, {
    workspaceAgentRuntime: {
      async executeIntent(input) {
        seen.push(input);
        return {
          thread: { id: "workspace-main" },
          messages: [
            {
              kind: "action_result",
              metadata: { communicationId: "comm-temporal-applied-ai-engineer-email" },
            },
          ],
        };
      },
    },
    chatRuntime: {
      findBySkill() {
        throw new Error("recruiter intake must not consult skill chat sessions");
      },
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "done");
    assert.equal(body.item.result.threadId, "workspace-main");
    assert.equal(body.item.result.communicationId, "comm-temporal-applied-ai-engineer-email");
    assert.deepEqual(seen, [
      {
        intent: {
          type: "communication.capture-inbound",
          entity: { type: "intake", id },
        },
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane C starts a new chat session when none is live, and registers an onClose listener that resolves the item done", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "recruiter email text", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "recruiter-email",
      classification: classificationFixture({ kind: "recruiter-email" }),
      trackerMatch: null,
      dispatch: { lane: "C", action: "chat_skill", params: { skill: "email-comms" } },
    },
  });

  let startSessionCalled = null;
  const onCloseCallbacks = new Map();
  const chatRuntime = {
    findBySkill: () => null,
    postMessage: () => {
      throw new Error("must not postMessage when no live session exists");
    },
    startSession: async ({ skill, input }) => {
      startSessionCalled = { skill, input };
      return { chatId: "chat-new", skill, state: "running" };
    },
    onClose: (chatId, cb) => {
      onCloseCallbacks.set(chatId, cb);
    },
  };

  const server = await bootServer(repoRoot, { chatRuntime });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.status, "running");
    assert.equal(body.item.result.chatId, "chat-new");
    assert.equal(startSessionCalled.skill, "email-comms");
    assert.equal(startSessionCalled.input.intakeId, id);

    // Simulate chat-runtime's own onClose firing once the session ends —
    // "process_exited" (the generator returning on its own) maps to "done".
    assert.ok(onCloseCallbacks.has("chat-new"), "expected an onClose listener for chat-new");
    onCloseCallbacks.get("chat-new")({ reason: "process_exited", lastError: null });
    assert.equal(intakeOne({ repoRoot, id }).status, "done");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/intake/confirm: Lane C reuses an existing live session via postMessage instead of starting a new one, and its onClose reports an error with the last error message", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "recruiter email text", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "proposed",
      kind: "recruiter-email",
      classification: classificationFixture({ kind: "recruiter-email" }),
      trackerMatch: null,
      dispatch: { lane: "C", action: "chat_skill", params: { skill: "email-comms" } },
    },
  });

  let postMessageArgs = null;
  const onCloseCallbacks = new Map();
  const chatRuntime = {
    findBySkill: (skill) =>
      skill === "email-comms" ? { chatId: "chat-live", skill, state: "idle" } : null,
    postMessage: (chatId, text) => {
      postMessageArgs = { chatId, text };
      return { accepted: true };
    },
    startSession: async () => {
      throw new Error("must not start a new session when one is already live");
    },
    onClose: (chatId, cb) => {
      onCloseCallbacks.set(chatId, cb);
    },
  };

  const server = await bootServer(repoRoot, { chatRuntime });
  try {
    const { status, body } = await postJson(server, "/api/intake/confirm", { id });
    assert.equal(status, 200);
    assert.equal(body.item.result.chatId, "chat-live");
    assert.equal(postMessageArgs.chatId, "chat-live");
    assert.match(postMessageArgs.text, /recruiter email text/);

    assert.ok(onCloseCallbacks.has("chat-live"), "expected an onClose listener for chat-live");
    onCloseCallbacks.get("chat-live")({ reason: "error", lastError: "model blew up mid-turn" });
    const settled = intakeOne({ repoRoot, id });
    assert.equal(settled.status, "error");
    assert.match(settled.error, /model blew up mid-turn/);
  } finally {
    await closeServer(server);
  }
});

// Data-table-driven: every one of chat-runtime.mjs's 6 possible close reasons
// maps to the exact intake outcome the M10 decisions memo (§5) specifies. Each
// case confirms its OWN fresh intake item against a Lane C dispatch (sharing
// one fake chatRuntime whose findBySkill always misses, so every confirm
// starts a distinct new session) — isolating one close-reason -> outcome
// mapping per assertion, independent of the two scenario tests above.
test("POST /api/intake/confirm: Lane C's onClose maps every chat-runtime close reason to the correct intake outcome", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const cases = [
    { reason: "process_exited", lastError: null, status: "done" },
    { reason: "closed", lastError: null, status: "done" },
    { reason: "idle_timeout", lastError: null, status: "done" },
    {
      reason: "error",
      lastError: "the model threw",
      status: "error",
      errorMatch: /the model threw/,
    },
    { reason: "aborted", lastError: null, status: "error", errorMatch: /session aborted/ },
    {
      reason: "shutdown",
      lastError: null,
      status: "error",
      errorMatch: /server restarted mid-session/,
    },
  ];

  let sessionCounter = 0;
  const onCloseCallbacks = new Map();
  const chatRuntime = {
    findBySkill: () => null,
    postMessage: () => {
      throw new Error("must not postMessage — findBySkill always misses in this test");
    },
    startSession: async ({ skill }) => {
      sessionCounter += 1;
      const chatId = `chat-${sessionCounter}`;
      return { chatId, skill, state: "running" };
    },
    onClose: (chatId, cb) => {
      onCloseCallbacks.set(chatId, cb);
    },
  };

  const server = await bootServer(repoRoot, { chatRuntime });
  try {
    for (const testCase of cases) {
      const { id } = intakeCapture({
        repoRoot,
        rawInput: "recruiter email text",
        inputKind: "text",
      });
      intakeUpdate({
        repoRoot,
        id,
        patch: {
          status: "proposed",
          kind: "recruiter-email",
          classification: classificationFixture({ kind: "recruiter-email" }),
          trackerMatch: null,
          dispatch: { lane: "C", action: "chat_skill", params: { skill: "email-comms" } },
        },
      });

      const { body } = await postJson(server, "/api/intake/confirm", { id });
      const chatId = body.item.result.chatId;
      assert.ok(onCloseCallbacks.has(chatId), `expected an onClose listener for ${chatId}`);

      onCloseCallbacks.get(chatId)({ reason: testCase.reason, lastError: testCase.lastError });
      const settled = intakeOne({ repoRoot, id });
      assert.equal(
        settled.status,
        testCase.status,
        `close reason "${testCase.reason}" should map to status "${testCase.status}"`
      );
      if (testCase.errorMatch) assert.match(settled.error, testCase.errorMatch);
    }
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// POST /api/intake/dismiss
// ---------------------------------------------------------------------------

test("POST /api/intake/dismiss: happy path from 'proposed', 409 from a non-dismissable status", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id: idA } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  intakeUpdate({ repoRoot, id: idA, patch: { status: "proposed" } });

  const { id: idB } = intakeCapture({ repoRoot, rawInput: "y", inputKind: "text" });
  // idB stays at "captured" — not in DISMISSABLE_STATUSES.

  const server = await bootServer(repoRoot);
  try {
    const ok = await postJson(server, "/api/intake/dismiss", { id: idA });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.status, "dismissed");

    const rejected = await postJson(server, "/api/intake/dismiss", { id: idB });
    assert.equal(rejected.status, 409);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// reconcileOrphanedLaneCIntakeItems — M10 boot-time cleanup for chat-runtime's
// in-memory-only session lifetime (see src/core/db/verbs/intake.mjs's own doc
// comment). Server wiring (tracker-dev.mjs calling this once at boot) is
// covered by tests/api-server.test.mjs; this is the verb's own behavior.
// ---------------------------------------------------------------------------

test("reconcileOrphanedLaneCIntakeItems: flips a stuck running+Lane-C item to error, and leaves everything else untouched", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  // The orphan: running, Lane C dispatch, from a process lifetime that's gone.
  const { id: orphanId } = intakeCapture({
    repoRoot,
    rawInput: "recruiter email",
    inputKind: "text",
  });
  intakeUpdate({
    repoRoot,
    id: orphanId,
    patch: {
      status: "running",
      dispatch: { lane: "C", action: "chat_skill", params: { skill: "email-comms" } },
      result: { chatId: "chat-from-a-dead-process" },
    },
  });

  // A running Lane B item — untouched (its own runSkillStream background
  // promise, not chat-runtime, resolves it; not this routine's concern).
  const { id: laneBRunningId } = intakeCapture({ repoRoot, rawInput: "a JD", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id: laneBRunningId,
    patch: {
      status: "running",
      dispatch: { lane: "B", action: "run_skill", params: { skill: "evaluate-job" } },
    },
  });

  // An already-done Lane C item — untouched (not "running").
  const { id: laneCDoneId } = intakeCapture({
    repoRoot,
    rawInput: "recruiter email 2",
    inputKind: "text",
  });
  intakeUpdate({
    repoRoot,
    id: laneCDoneId,
    patch: {
      status: "done",
      dispatch: { lane: "C", action: "chat_skill", params: { skill: "email-comms" } },
      result: { chatId: "chat-that-finished-fine" },
    },
  });

  const result = reconcileOrphanedLaneCIntakeItems({ repoRoot });
  assert.deepEqual(result.reconciledIds, [orphanId]);

  const orphan = intakeOne({ repoRoot, id: orphanId });
  assert.equal(orphan.status, "error");
  assert.equal(orphan.error, "interrupted by restart");

  assert.equal(intakeOne({ repoRoot, id: laneBRunningId }).status, "running");
  assert.equal(intakeOne({ repoRoot, id: laneCDoneId }).status, "done");
});

test("reconcileOrphanedLaneCIntakeItems: a no-op pass (nothing running) returns an empty list without throwing", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const result = reconcileOrphanedLaneCIntakeItems({ repoRoot });
  assert.deepEqual(result.reconciledIds, []);
});

test("Universal Intake stays separate from the Deep ingest local route owner", () => {
  const source = readFileSync(join(REAL_ROOT, "src/cli/intake-route.mjs"), "utf8");
  assert.equal(source.includes("/api/deep-ingest"), false);
  assert.equal(source.includes("mountDeepIngestRoutes"), false);
});
