// packet-route.mjs — M4 of the paid-POC journey: the /packet view's HTTP
// surface over already-tailored (or not-yet-tailored) application artifacts.
// Split out the same way search-route.mjs/skill-run-route.mjs were:
// `addRoute` is the mount point, `sendJson` is imported from
// skill-run-route.mjs rather than duplicated.
//
// mountPacketRoutes({addRoute, repoRoot, env}) registers:
//
//   GET /api/packet/list   Every "gated-in" application row — one that either
//                           already has a resume/coverLetter/answers artifact
//                           stamped, or whose status has passed evaluate-job's
//                           gate and isn't terminal (rejected/withdrawn). See
//                           isGatedIn() below for the exact rule and why every
//                           applications[] row is *already* gated by
//                           construction (evaluate-job's GATE: CUT path never
//                           creates one — see .agents/skills/evaluate-job
//                           STEP "Route by verdict"). Returns
//                           [{id, company, role, status, hasResume,
//                           hasCoverLetter, hasAnswers, needsYouCount}].
//   GET /api/packet?id=<appId>
//                           One application's full packet: resume/coverLetter/
//                           answers, each resolved to {path, markdown, html}
//                           (or null if never stamped). `answers` additionally
//                           carries `needsYou`, the unresolved-question
//                           findings from placeholder-lint.mjs's own
//                           `needs-you-marker` pattern (reused, not
//                           reimplemented — see lintArtifact()). 404 on an
//                           unknown id.
//
// Artifact resolution: tailor-application's STEP 7 stamps
// applications[].artifacts.{resume,coverLetter,answers} as a workspace-
// relative path (e.g. "workspace/tailored/<Company> — <Role>.md"), but
// apply-job's own doc comment on artifacts.coverLetter ("the tailored cover
// letter text submitted") and tailor-application's STEP 7 stamp comment
// ("<cover letter path or inline text, if produced>") both allow a stamped
// value to be the artifact's raw text instead of a path. looksLikePath()
// below is the (deliberately narrow) heuristic that tells the two apart:
// single-line strings ending in a known artifact extension are resolved as
// files under workspace/; everything else is served as the artifact's
// markdown body directly.
//
// Path safety: resolveArtifactPath() below is the same two-step
// normalize-then-prefix-check traversal guard used by scoped workspace reads
// (unexported) resolveScoped() — reimplemented locally because this route
// resolves a *stamped tracker value* (which may carry a leading "workspace/"
// segment tailor-application writes literally into the path string) rather
// than an already-workspace-relative file read helper
// expects. A traversal attempt (".." after stripping "workspace/", an
// absolute path, a NUL byte) resolves to null, which every caller here
// treats exactly like "artifact was never stamped" — no different error
// surface that could hint at *why* the path was rejected.

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import { requireDb } from "../core/db/connection.mjs";
import { assembleTrackerObject } from "../core/db/export-to-tracker.mjs";
import { markdownToHtml } from "../core/documents/export.mjs";
import { lintArtifact } from "../core/documents/placeholder-lint.mjs";
import { evaluatePacketGate } from "../core/packet/gate.mjs";
import { resolveUserPaths } from "../core/paths/workspace.mjs";
import { classifyStage } from "../core/tracker/dashboard.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

// Mirrors dashboard.mjs's own (unexported) TERMINAL_STAGES set. Not imported
// directly since dashboard.mjs doesn't export it — see AGENTS.md's stage-
// taxonomy note: the canonical ladder is a small, deliberately-duplicated
// contract across a few homes, not a single importable constant everywhere.
const TERMINAL_STAGE_IDS = new Set(["rejected", "withdrawn"]);
const MAX_BODY_BYTES = 1024 * 1024;
const TEXT_ARTIFACT_RE = /\.(?:md|markdown|txt)$/i;
const BINARY_ARTIFACT_RE = /\.(?:pdf|docx)$/i;
const PACKET_ARTIFACT_KINDS = new Set(["resume", "coverLetter", "answers"]);

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

// True when `app` should appear in the /packet picker: it already has at
// least one tailored artifact (so the user can review/regenerate it,
// regardless of what its status has drifted to since), or its current status
// classifies to a non-terminal stage — i.e. it passed evaluate-job's gate
// (GATE: KEEP/REVIEW → status "reviewed-hold", see the evaluate-job SKILL.md)
// and hasn't since been rejected or withdrawn.
function isGatedIn(app, customStages) {
  const artifacts = app?.artifacts || {};
  if (artifacts.resume || artifacts.coverLetter || artifacts.answers) return true;
  const stage = classifyStage(app?.status, customStages);
  return !TERMINAL_STAGE_IDS.has(stage.id);
}

// Narrow heuristic distinguishing a stamped workspace-relative path from
// stamped inline artifact text — see this file's header comment. Multi-line
// strings and anything without a recognized artifact extension are always
// treated as inline text, never as a path to resolve on disk.
function looksLikePath(value) {
  if (typeof value !== "string") return false;
  if (value.includes("\n")) return false;
  if (value.length > 300) return false;
  const trimmed = value.trim();
  return TEXT_ARTIFACT_RE.test(trimmed) || BINARY_ARTIFACT_RE.test(trimmed);
}

function stripWorkspacePrefix(value) {
  return value.startsWith("workspace/") ? value.slice("workspace/".length) : value;
}

// Same normalize-then-prefix-check traversal guard as scoped workspace reads.
// resolveScoped() — see this file's header comment for why it's reimplemented
// rather than imported.
function resolveArtifactPath(workspaceDir, relPath) {
  const rel = normalize(String(relPath ?? ""));
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\0")) {
    return null;
  }
  const full = join(workspaceDir, rel);
  if (full !== workspaceDir && !full.startsWith(`${workspaceDir}${sep}`)) return null;
  return full;
}

function artifactKind(storedPath) {
  const ext = extname(storedPath).replace(/^\./, "").toLowerCase();
  return ext || "file";
}

function artifactContentType(storedPath) {
  const kind = artifactKind(storedPath);
  if (kind === "pdf") return "application/pdf";
  if (kind === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (kind === "md" || kind === "markdown") return "text/markdown; charset=utf-8";
  if (kind === "txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function artifactUrl(appId, kind) {
  return `/api/packet/artifact?id=${encodeURIComponent(String(appId))}&kind=${encodeURIComponent(kind)}`;
}

// Resolve one stamped artifact value to its { path, markdown } content.
// Returns null when the value is empty, the path is unsafe/unreadable, or the
// resolved file doesn't exist — every one of those collapses to the same
// "not available" shape the /packet UI already renders as "offer Generate".
function resolveArtifactContent(workspaceDir, storedValue, { appId = null, kind = null } = {}) {
  if (typeof storedValue !== "string" || !storedValue.trim()) return null;
  const trimmed = storedValue.trim();

  if (!looksLikePath(trimmed)) {
    return { path: null, markdown: trimmed };
  }

  const full = resolveArtifactPath(workspaceDir, stripWorkspacePrefix(trimmed));
  if (!full || !existsSync(full)) return null;
  if (BINARY_ARTIFACT_RE.test(trimmed)) {
    return {
      path: trimmed,
      markdown: null,
      html: null,
      binary: true,
      kind: artifactKind(trimmed),
      url: appId && kind ? artifactUrl(appId, kind) : null,
    };
  }

  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return null;
  }
  return { path: trimmed, markdown: text };
}

// Findings from placeholder-lint.mjs's lintArtifact(), filtered to just the
// "needs-you-marker" pattern (STEP 6 of tailor-application's unanswerable-
// question marker) — reused, not reimplemented, per that file's own doc
// comment on lintArtifact().
function needsYouFindings(markdown) {
  return lintArtifact(markdown).findings.filter((f) => f.pattern === "needs-you-marker");
}

function buildArtifactView(
  workspaceDir,
  storedValue,
  { includeNeedsYou = false, appId = null, kind = null } = {}
) {
  const resolved = resolveArtifactContent(workspaceDir, storedValue, { appId, kind });
  if (!resolved) return null;
  const view = {
    path: resolved.path,
    markdown: resolved.markdown,
    html: resolved.binary ? null : markdownToHtml(resolved.markdown || ""),
    binary: Boolean(resolved.binary),
    kind: resolved.kind ?? null,
    url: resolved.url ?? null,
  };
  if (includeNeedsYou && !resolved.binary) {
    view.needsYou = needsYouFindings(resolved.markdown).map((f) => ({
      line: f.line,
      text: f.text,
    }));
  }
  return view;
}

function countNeedsYou(workspaceDir, storedAnswersValue) {
  const resolved = resolveArtifactContent(workspaceDir, storedAnswersValue);
  if (!resolved || resolved.binary) return 0;
  return needsYouFindings(resolved.markdown).length;
}

export function readPacketApplicationsFromDb({ repoRoot, env = process.env } = {}) {
  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  return {
    applications: Array.isArray(tracker.applications) ? tracker.applications : [],
    stages: tracker.stages,
  };
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  return 500;
}

function respondError(res, err) {
  sendJson(res, statusForError(err), { ok: false, error: err?.message || String(err) });
}

export function mountPacketRoutes({ addRoute, repoRoot, env = process.env, packetGateInvoke }) {
  const pathCtx = { repoRoot, env };

  // -------------------------------------------------------------------------
  // POST /api/packet/gate
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/packet/gate", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, {
        ok: false,
        code: "BAD_REQUEST",
        error: { message: err.message },
      });
      return;
    }

    const result = await evaluatePacketGate({
      ...pathCtx,
      body,
      invoke: packetGateInvoke,
    });
    sendJson(res, result.status, result.body);
  });

  // -------------------------------------------------------------------------
  // GET /api/packet/list
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/packet/list", (_req, res) => {
    let packetRows;
    try {
      packetRows = readPacketApplicationsFromDb(pathCtx);
    } catch (err) {
      respondError(res, err);
      return;
    }

    const workspaceDir = resolveUserPaths(pathCtx).workspaceDir;
    const { applications, stages } = packetRows;

    const rows = applications
      .filter((app) => isGatedIn(app, stages))
      .map((app) => {
        const artifacts = app.artifacts || {};
        return {
          id: app.id,
          company: app.company ?? null,
          role: app.role ?? null,
          status: app.status ?? null,
          hasResume: Boolean(artifacts.resume),
          hasCoverLetter: Boolean(artifacts.coverLetter),
          hasAnswers: Boolean(artifacts.answers),
          needsYouCount: countNeedsYou(workspaceDir, artifacts.answers),
        };
      });

    sendJson(res, 200, rows);
  });

  // -------------------------------------------------------------------------
  // GET /api/packet?id=<appId>
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/packet", (req, res) => {
    const id = queryParam(req, "id");
    if (!id) {
      sendJson(res, 400, { error: "?id= is required" });
      return;
    }

    let packetRows;
    try {
      packetRows = readPacketApplicationsFromDb(pathCtx);
    } catch (err) {
      respondError(res, err);
      return;
    }

    const { applications } = packetRows;
    const app = applications.find((a) => String(a?.id) === String(id));
    if (!app) {
      sendJson(res, 404, { error: `no application with id "${id}"` });
      return;
    }

    const workspaceDir = resolveUserPaths(pathCtx).workspaceDir;
    const artifacts = app.artifacts || {};

    sendJson(res, 200, {
      id: app.id,
      company: app.company ?? null,
      role: app.role ?? null,
      resumeNote: artifacts.resumeNote ?? null,
      artifacts: {
        resume: buildArtifactView(workspaceDir, artifacts.resume, {
          appId: app.id,
          kind: "resume",
        }),
        coverLetter: buildArtifactView(workspaceDir, artifacts.coverLetter, {
          appId: app.id,
          kind: "coverLetter",
        }),
        answers: buildArtifactView(workspaceDir, artifacts.answers, {
          includeNeedsYou: true,
          appId: app.id,
          kind: "answers",
        }),
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/packet/artifact?id=<appId>&kind=resume|coverLetter|answers
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/packet/artifact", (req, res) => {
    const id = queryParam(req, "id");
    const kind = queryParam(req, "kind");
    if (!id || !PACKET_ARTIFACT_KINDS.has(kind)) {
      sendJson(res, 400, { error: "?id= and kind=resume|coverLetter|answers are required" });
      return;
    }

    let packetRows;
    try {
      packetRows = readPacketApplicationsFromDb(pathCtx);
    } catch (err) {
      respondError(res, err);
      return;
    }

    const app = packetRows.applications.find((a) => String(a?.id) === String(id));
    const storedPath = app?.artifacts?.[kind];
    if (!app || typeof storedPath !== "string" || !BINARY_ARTIFACT_RE.test(storedPath.trim())) {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }

    const workspaceDir = resolveUserPaths(pathCtx).workspaceDir;
    const full = resolveArtifactPath(workspaceDir, stripWorkspacePrefix(storedPath.trim()));
    if (!full || !existsSync(full)) {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }

    let body;
    try {
      body = readFileSync(full);
    } catch {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }

    const fileName = basename(full)
      .replace(/["\r\n]/g, "")
      .replace(/[^\x20-\x7E]/g, "_");
    res.writeHead(200, {
      "Content-Type": artifactContentType(storedPath),
      "Content-Disposition": `inline; filename="${fileName}"`,
      "Cache-Control": "no-store",
    });
    res.end(body);
  });
}
