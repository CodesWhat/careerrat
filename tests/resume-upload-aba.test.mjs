import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateArtifactGet,
  candidateConfigGet,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";
import { buildMinimalPdf } from "./fixtures/pdf.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SECTIONS = {
  experience: 1,
  education: 0,
  skills: 1,
  projects: 0,
  other: 0,
};

function reply(name, line) {
  return {
    full_text: `${name}\nExperience\n${line}\nSkills\nJavaScript`,
    candidate: { full_name: name, domain: "" },
    claims: [{ claim: line, evidence: "Resume, Experience." }],
    sections: SECTIONS,
    targeting_suggestions: { role_buckets: [], keep_signals: [] },
  };
}
const A = {
  name: "Alice Aardvark",
  reply: reply("Alice Aardvark", "Led a team of five."),
};
const B = {
  name: "Bob Badger",
  reply: reply("Bob Badger", "Shipped three platforms."),
};
for (const doc of [A, B]) doc.bytes = buildMinimalPdf(doc.reply.full_text.split("\n")).bytes;

function fixture(t) {
  const dataRoot = mkdtempSync(join(tmpdir(), "careerrat-resume-aba-"));
  const pathCtx = { repoRoot, env: { CAREERRAT_HOME: dataRoot } };
  t.after(() => {
    closeAll();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  candidateSetupInitialize(pathCtx);
  const routes = new Map();
  let pending = null;
  let calls = 0;
  mountOnboardRoutes({
    ...pathCtx,
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    runSkillStream: async ({ onEvent }) => {
      calls++;
      onEvent({
        type: "assistant",
        data: {
          message: {
            content: [{ type: "text", text: JSON.stringify(pending.reply) }],
          },
        },
      });
    },
  });
  async function upload(doc, { stream = false } = {}) {
    pending = doc;
    const path = `/api/onboard/resume-ai${stream ? "-stream" : ""}`;
    const req = Readable.from([doc.bytes]);
    Object.assign(req, {
      method: "POST",
      url: `${path}?name=resume.pdf`,
      headers: {},
    });
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
  function canonical() {
    const cfg = candidateConfigGet(pathCtx);
    return {
      text: candidateArtifactGet({ ...pathCtx, id: "source-resume" })?.text,
      name: JSON.stringify(cfg).includes(B.name)
        ? "B"
        : JSON.stringify(cfg).includes(A.name)
          ? "A"
          : "none",
    };
  }
  return { upload, canonical, calls: () => calls };
}

for (const stream of [false, true]) {
  const label = stream ? "SSE" : "JSON";

  test(`${label}: upload A, B, A leaves A canonical without re-running extraction`, async (t) => {
    const { upload, canonical, calls } = fixture(t);
    await upload(A, { stream });
    await upload(B, { stream });
    assert.equal(canonical().text, B.reply.full_text);
    assert.equal(calls(), 2);
    const third = await upload(A, { stream });
    assert.equal(calls(), 2, "A's completed extraction is reused, not re-run");
    assert.equal(third.status, 200);
    const done = stream ? third.frames.at(-1) : { type: "done", data: third.body.data };
    assert.equal(done.type, "done");
    assert.equal(done.data.fullText, A.reply.full_text);
    assert.equal(canonical().text, A.reply.full_text);
    assert.equal(canonical().name, "A");
  });

  test(`${label}: consecutive A, A stays canonical and does not re-run`, async (t) => {
    const { upload, canonical, calls } = fixture(t);
    await upload(A, { stream });
    await upload(A, { stream });
    assert.equal(calls(), 1);
    assert.equal(canonical().text, A.reply.full_text);
    assert.equal(canonical().name, "A");
  });
}
