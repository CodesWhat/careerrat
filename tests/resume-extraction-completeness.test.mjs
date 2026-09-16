import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { closeAll, requireDb } from "../src/core/db/connection.mjs";
import {
  candidateArtifactGet,
  candidateArtifactPut,
  candidateConfigGet,
  candidateSetupInitialize,
  resumeExtractionComplete,
  resumeExtractionGet,
  resumeExtractionStart,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { buildMinimalPdf } from "./fixtures/pdf.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const EMPTY_SECTIONS = { experience: 0, education: 0, skills: 0, projects: 0, other: 0 };
const TITLE_ONLY = {
  full_text: "Jane Doe Resume",
  candidate: { full_name: "Jane Doe", domain: "" },
  claims: [],
  sections: EMPTY_SECTIONS,
  targeting_suggestions: { role_buckets: [], keep_signals: [] },
};
const VALID = {
  ...TITLE_ONLY,
  full_text: "Jane Doe\nExperience\nLed a team of five engineers.\nSkills\nJavaScript",
  claims: [{ claim: "Led a team of five engineers.", evidence: "Resume, Experience." }],
  sections: { ...EMPTY_SECTIONS, experience: 1, skills: 1 },
};
const PDF = buildMinimalPdf(VALID.full_text.split("\n")).bytes;

function fixture(t, replies, { initialize = true } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), "careerrat-resume-completeness-"));
  const pathCtx = { repoRoot, env: { CAREERRAT_HOME: dataRoot } };
  t.after(() => {
    closeAll();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  if (initialize) candidateSetupInitialize(pathCtx);
  const routes = new Map();
  let calls = 0;
  mountOnboardRoutes({
    ...pathCtx,
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    runSkillStream: async ({ onEvent }) => {
      const reply = replies[Math.min(calls++, replies.length - 1)];
      onEvent({
        type: "assistant",
        data: { message: { content: [{ type: "text", text: JSON.stringify(reply) }] } },
      });
    },
  });
  async function upload({ stream = false } = {}) {
    const path = `/api/onboard/resume-ai${stream ? "-stream" : ""}`;
    const req = Readable.from([PDF]);
    Object.assign(req, { method: "POST", url: `${path}?name=resume.pdf`, headers: {} });
    let status = 200;
    let raw = "";
    const res = {
      on() {
        return this;
      },
      writeHead(code) {
        status = code;
        return this;
      },
      flushHeaders() {},
      write(chunk) {
        raw += String(chunk);
        return true;
      },
      end(chunk = "") {
        raw += String(chunk);
      },
    };
    await routes.get(`POST ${path}`)(req, res);
    return stream
      ? {
          status,
          frames: raw
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => JSON.parse(line.slice(5))),
        }
      : { status, body: JSON.parse(raw) };
  }
  return { pathCtx, upload, calls: () => calls };
}

test("title-only extraction fails without replacing an existing source resume", async (t) => {
  const { pathCtx, upload } = fixture(t, [TITLE_ONLY]);
  const previous = { text: VALID.full_text, source: "resume-text" };
  candidateArtifactPut({ ...pathCtx, id: "source-resume", kind: "source-resume", data: previous });
  const before = candidateConfigGet(pathCtx);
  const { status, body } = await upload();
  assert.equal(status, 422);
  assert.equal(body.code, "RESUME_EXTRACTION_INCOMPLETE");
  assert.equal(body.manual.available, true);
  assert.equal(body.operation.status, "failed");
  assert.deepEqual(candidateArtifactGet({ ...pathCtx, id: "source-resume" }), previous);
  assert.deepEqual(candidateConfigGet(pathCtx), before);
  assert.deepEqual(readFileSync(userPath(pathCtx, body.operation.uploadPath)), PDF);
});

test("streamed title-only extraction reports failure, and the same upload can be retried", async (t) => {
  const { pathCtx, upload, calls } = fixture(t, [TITLE_ONLY, VALID]);
  const failed = await upload({ stream: true });
  assert.equal(failed.frames.at(-1).type, "error");
  assert.equal(failed.frames.at(-1).status, 422);
  assert.equal(
    failed.frames.some((frame) => frame.type === "done"),
    false
  );
  assert.equal(candidateArtifactGet({ ...pathCtx, id: "source-resume" }), null);
  const operation = resumeExtractionGet(pathCtx).operation;
  assert.equal(operation.status, "failed");
  const retry = await upload({ stream: true });
  assert.equal(retry.frames.at(-1).type, "done");
  assert.equal(retry.frames.at(-1).operation.retryOf, operation.id);
  assert.equal(candidateArtifactGet({ ...pathCtx, id: "source-resume" }).text, VALID.full_text);
  await upload();
  assert.equal(calls(), 2, "a valid completion should still be reused");
});

test("legacy title-only extraction does not write SOURCE_RESUME.md", async (t) => {
  const { pathCtx, upload } = fixture(t, [TITLE_ONLY], { initialize: false });
  const { status } = await upload();
  assert.equal(status, 422);
  assert.equal(existsSync(userPath(pathCtx, "candidate/SOURCE_RESUME.md")), false);
});

test("a cached title-only completion from an older version is re-extracted", async (t) => {
  const { pathCtx, upload, calls } = fixture(t, [VALID]);
  const first = await upload();
  const old = first.body.operation;
  // Model the persisted result created by the previous, overly permissive check.
  old.result = {
    ...old.result,
    fullText: TITLE_ONLY.full_text,
    profileSeed: { candidate: TITLE_ONLY.candidate },
    evidenceSeed: { claims: [] },
    sections: EMPTY_SECTIONS,
  };
  requireDb(pathCtx)
    .prepare("UPDATE resume_extractions SET data = ? WHERE id = ?")
    .run(JSON.stringify(old), old.id);
  const retry = await upload();
  assert.equal(calls(), 2, "an incomplete cached result must not skip extraction");
  assert.equal(retry.body.operation.retryOf, old.id);
  assert.equal(retry.body.data.fullText, VALID.full_text);
  await upload();
  assert.equal(calls(), 2, "repaired complete results remain idempotent");
});

test("a successful local DOCX fallback remains reusable without AI section counts", (t) => {
  const { pathCtx } = fixture(t, []);
  const request = {
    ...pathCtx,
    uploadDigest: "local-docx-resume",
    uploadPath: "workspace/intake/resume-uploads/resume.docx",
    filename: "resume.docx",
    ownerId: "local-docx-worker",
  };
  const started = resumeExtractionStart(request).operation;
  const fullText =
    "Jane Doe\nSummary\nExperienced frontend developer focused on accessible websites and collaboration with designers and product teams.";
  resumeExtractionComplete({
    ...pathCtx,
    id: started.id,
    ownerId: request.ownerId,
    artifact: { text: fullText, source: "docx", extraction: "local" },
    result: {
      fullText,
      source: "docx",
      extraction: "local",
      sections: EMPTY_SECTIONS,
      evidenceSeed: { claims: [] },
    },
  });
  const repeat = resumeExtractionStart(request);
  assert.equal(repeat.reused, true);
  assert.equal(repeat.operation.id, started.id);
});

test("repeated starts reuse the active replacement even within the same millisecond", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const { pathCtx } = fixture(t, []);
  const request = {
    ...pathCtx,
    uploadDigest: "cached-incomplete-resume",
    uploadPath: "workspace/intake/resume-uploads/resume.pdf",
    filename: "resume.pdf",
    ownerId: "resume-worker",
  };
  const first = resumeExtractionStart(request).operation;
  resumeExtractionComplete({
    ...pathCtx,
    id: first.id,
    ownerId: request.ownerId,
    artifact: { text: TITLE_ONLY.full_text },
    result: { fullText: TITLE_ONLY.full_text, sections: EMPTY_SECTIONS },
  });
  const retry = resumeExtractionStart(request);
  const repeated = resumeExtractionStart(request);
  assert.equal(retry.reused, false);
  assert.equal(retry.operation.retryOf, first.id);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.operation.id, retry.operation.id);
});

for (const section of ["education", "skills", "projects", "other"]) {
  test(`a short ${section}-only resume does not require contact details or accomplishments`, async (t) => {
    const reply = {
      ...TITLE_ONLY,
      full_text: `${section}\nRelevant background`,
      candidate: { domain: "" },
      sections: { ...EMPTY_SECTIONS, [section]: 1 },
    };
    const { pathCtx, upload } = fixture(t, [reply]);
    assert.equal((await upload()).status, 200);
    assert.equal(candidateArtifactGet({ ...pathCtx, id: "source-resume" }).text, reply.full_text);
  });
}
