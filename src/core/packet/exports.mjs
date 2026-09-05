import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { hasUploadableResumeArtifact } from "../apply/apply-driver.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import {
  appListArtifactRegistrations,
  artifactReservationClaim,
  artifactReservationOwner,
  artifactReservationRelease,
  appRegisterPacketArtifacts as registerPacketArtifacts,
} from "../db/verbs.mjs";
import { validDocumentArtifact } from "../documents/artifact-validation.mjs";
import {
  exportArtifact as documentExportArtifact,
  MARKDOWN_SOURCE_MAX_BYTES,
  readBoundedSource,
} from "../documents/export.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Resolves `path` to a canonical form WITHOUT requiring `path` itself to
// exist: realpath() the parent directory (which, for every destination this
// module builds, already exists — it's the same directory a real source
// file lives in) and join the literal basename back on. Unlike
// realpathSync(path) directly, this works identically whether the
// destination has already been written or is still staged/unwritten, which
// matters once a destination's canonical display path has to be computed
// before promotion (see exportPacketArtifacts' staging phase).
function canonicalDestinationPath(path) {
  const parent = dirname(path);
  let canonicalParent;
  try {
    canonicalParent = realpathSync(parent);
  } catch {
    canonicalParent = resolve(parent);
  }
  return join(canonicalParent, basename(path));
}

// Resolves `parentDir`'s REAL filesystem identity -- creating it first if it
// doesn't exist yet, since a brand-new tailored directory or a not-yet-
// created packet manifest directory both legitimately don't exist before
// this call -- and rejects unless that real path sits inside `realRoot`.
// A lexical workspaceDir-prefix check (resolveWorkspacePath's `startsWith`)
// is exactly what a symlinked tailored directory defeats: the symlink's own
// path reads as "inside" the workspace right up until the OS follows it, so
// only a post-symlink comparison closes the gap.
function assertDestinationParentConfined(parentDir, realRoot) {
  mkdirSync(parentDir, { recursive: true });
  let realParent;
  try {
    realParent = realpathSync(parentDir);
  } catch (err) {
    const wrapped = new Error(
      `export destination parent could not be resolved: ${err?.message || err}`
    );
    wrapped.code = "EXPORT_DESTINATION_UNSAFE";
    throw wrapped;
  }
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    const err = new Error(`export destination escapes the workspace root: ${parentDir}`);
    err.code = "EXPORT_DESTINATION_UNSAFE";
    throw err;
  }
  return realParent;
}

// Canonicalizes `path` against `realRoot`, rejecting any escape, and
// returning ONLY the validated real form. Every promotion (a per-format
// document render, the packet manifest) must write through this return
// value rather than the original lexical `path`, so a symlinked ancestor
// discovered anywhere along the way can never redirect the actual write.
function confineDestination(path, realRoot) {
  const realParent = assertDestinationParentConfined(dirname(path), realRoot);
  return join(realParent, basename(path));
}

// Relativizing a canonical absPath against a lexical workspaceDir under a
// symlinked root (a symlinked CAREERRAT_HOME, or macOS's /var-to-/private/var
// alias) produces workspace/../ segments that registration rejects.
// Canonicalize both sides before deriving the stored relative path so the
// comparison is apples to apples regardless of which namespace either side
// started in, and regardless of whether `absPath` has been written yet.
function workspaceDisplayPath(workspaceDir, absPath) {
  const canonicalWorkspaceDir = safeRealpath(workspaceDir);
  const canonicalAbsPath = canonicalDestinationPath(absPath);
  return `workspace/${relative(canonicalWorkspaceDir, canonicalAbsPath).replaceAll(sep, "/")}`;
}

function randomToken() {
  return Math.random().toString(36).slice(2);
}

// Probes the real filesystem rather than assuming by platform: a
// case-sensitive volume can be mounted on macOS, and a case-insensitive one
// mounted on Linux. Writes and immediately removes a uniquely named marker
// file, then checks whether its upper-cased name resolves to the same file.
function detectCaseInsensitiveFs(dir) {
  const probeName = `.careerrat-fs-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const probePath = join(dir, probeName);
  try {
    writeFileSync(probePath, "", { flag: "wx" });
  } catch {
    return false;
  }
  let insensitive = false;
  try {
    insensitive = existsSync(join(dir, probeName.toUpperCase()));
  } catch {
    insensitive = false;
  } finally {
    try {
      unlinkSync(probePath);
    } catch {
      // best-effort cleanup of the probe file
    }
  }
  return insensitive;
}

function stripWorkspacePrefix(value) {
  return value.startsWith("workspace/") ? value.slice("workspace/".length) : value;
}

function resolveWorkspacePath(workspaceDir, storedPath) {
  const raw = cleanText(storedPath);
  if (!raw || raw.includes("\0")) return null;
  const rel = normalize(stripWorkspacePrefix(raw));
  if (!rel || rel === "." || rel.startsWith("..")) return null;
  const full = join(workspaceDir, rel);
  if (full !== workspaceDir && !full.startsWith(`${workspaceDir}${sep}`)) return null;
  return full;
}

function sourceKind(sourceKey) {
  if (sourceKey === "coverLetterSource") return "coverLetter";
  if (sourceKey === "answersSource") return "answers";
  return "resume";
}

// The registry of document kinds this export path knows how to produce.
// Reservation logic below enumerates every per-format artifact key from
// this list (via outputKey) rather than hand-listing resumePdf,
// resumeDocx, resumeText, coverLetterPdf, ... individually, so a future
// kind added here is automatically covered.
const DOCUMENT_KINDS = ["resume", "coverLetter", "answers"];

const FORMAT_SUFFIX = { pdf: "Pdf", docx: "Docx", text: "Text" };
const FORMAT_EXTENSION = { pdf: ".pdf", docx: ".docx", text: ".txt" };

function outputKey(kind, format) {
  return `${kind}${FORMAT_SUFFIX[format] || "Pdf"}`;
}

// Merges a run's artifact deltas onto the prior manifest artifacts, but an
// explicit `null` in `current` deletes the key instead of overwriting it
// with null — the packet manifest schema requires artifact values to be
// workspace-relative strings, so a cleared format key must vanish rather
// than persist as a literal null.
function mergeArtifacts(prior, current) {
  const merged = { ...(prior || {}) };
  for (const [key, value] of Object.entries(current || {})) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function titleFor(app, kind) {
  const label = kind === "coverLetter" ? "Cover Letter" : kind === "answers" ? "Answers" : "Resume";
  return [app.company, app.role, label].filter(Boolean).join(" - ") || label;
}

// tailor-application SKILL.md STEP 11b: every rendered resume/cover-letter
// PDF also gets a convenience copy under the real OS home, organized by
// company — never a workspace-relative location. CAREERRAT_DOWNLOADS_DIR lets
// tests redirect this away from the real home (mirroring the CAREERRAT_HOME
// override in paths/workspace.mjs); production always resolves the real
// os.homedir().
function downloadsRoot(env) {
  const override = String(env.CAREERRAT_DOWNLOADS_DIR || "").trim();
  if (override) return override;
  return join(homedir(), "Downloads", "careerrat");
}

// Only resume/coverLetter get the Downloads convenience copy per SKILL.md
// STEP 11b ("After every PDF renders (resume and cover letter)...") —
// answers artifacts are not part of that convention.
function downloadsLabelFor(kind) {
  if (kind === "resume") return "Resume";
  if (kind === "coverLetter") return "Cover Letter";
  return null;
}

function safePathSegment(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[/\\\0]/g, "-")
    .trim();
  return cleaned || fallback;
}

// A same-named file left by a prior round is displaced into archive/ first,
// so the company root only ever shows what's live (SKILL.md STEP 11b).
function archivePriorDownloadsCopy(companyDir, fileName) {
  const existing = join(companyDir, fileName);
  if (!existsSync(existing)) return;
  const archiveDir = join(companyDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  renameSync(existing, join(archiveDir, fileName));
}

// Non-fatal by design: a Downloads-copy failure must never fail the export
// itself, so every error is swallowed and returned for the caller to record
// rather than thrown.
function copyPdfToDownloads({ env, company, kind, absPath }) {
  const label = downloadsLabelFor(kind);
  if (!label) return null;
  try {
    const companyName = safePathSegment(company, "unknown");
    const companyDir = join(downloadsRoot(env), companyName);
    mkdirSync(companyDir, { recursive: true });
    const fileName = `${companyName} - ${label}.pdf`;
    archivePriorDownloadsCopy(companyDir, fileName);
    const dest = join(companyDir, fileName);
    copyFileSync(absPath, dest);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

const SUPPORTED_EXPORT_FORMATS = new Set(["pdf", "docx", "text"]);

// A nonempty request of supported formats is authoritative: it replaces the
// default rather than adding to it, so a text-only request stays text-only
// instead of always dragging a PDF export along. PDF is only the fallback
// when nothing supported was requested at all.
function requestedFormats({ request = {}, uploadRequirements = [] } = {}) {
  const requested = Array.isArray(request.formats) ? request.formats : [];
  const supportedRequested = requested.filter((format) => SUPPORTED_EXPORT_FORMATS.has(format));
  const formats = new Set(supportedRequested.length ? supportedRequested : ["pdf"]);
  for (const requirement of uploadRequirements || []) {
    const reqFormats = Array.isArray(requirement?.formats) ? requirement.formats : [];
    if (requirement?.required && reqFormats.includes("docx")) formats.add("docx");
  }
  return [...formats];
}

function findApplication({ repoRoot, env, appId }) {
  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  const app = (tracker.applications || []).find((row) => String(row?.id) === String(appId));
  if (!app) {
    const err = new Error(`no application with id "${appId}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return app;
}

function packetSourcesFromApp(app) {
  const artifacts = app.artifacts || {};
  return {
    resumeSource: artifacts.resumeSource,
    coverLetterSource: artifacts.coverLetterSource,
    answersSource: artifacts.answersSource,
    packetManifest: artifacts.packetManifest,
  };
}

function sourceEntries(packetSources = {}) {
  return Object.entries(packetSources).filter(
    ([key, value]) => key.endsWith("Source") && typeof value === "string" && value.trim()
  );
}

function readStoredManifest(workspaceDir, storedPath) {
  const full = resolveWorkspacePath(workspaceDir, storedPath);
  if (!full || !existsSync(full)) return null;
  try {
    const parsed = JSON.parse(readFileSync(full, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function appRegisterPacketArtifacts({
  repoRoot,
  env,
  appId,
  applicationId,
  artifacts = {},
  manifest,
  now = () => new Date(),
} = {}) {
  const id = cleanText(applicationId || appId);
  if (!id) throw new Error("appRegisterPacketArtifacts: appId is required");
  const generatedAt = now().toISOString();
  const packetManifest = manifest || {
    applicationId: id,
    generatedAt,
    artifacts,
    uploadReady: false,
    gapCount: 0,
    status: "exported",
  };
  return registerPacketArtifacts({
    repoRoot,
    env,
    id,
    artifacts,
    manifest: packetManifest,
    note: "packet exports registered",
  });
}

export async function exportPacketArtifacts({
  repoRoot,
  env = process.env,
  appId,
  applicationId,
  packetSources,
  request = {},
  formats,
  uploadRequirements = [],
  exportArtifact = documentExportArtifact,
  // Test-only fault-injection seam for the packet manifest's own write
  // (decision 6's rollback ordering): defaults to the real write. A real
  // ENOSPC/quota/permission failure is exercised this way in tests since
  // the staged sibling's random suffix can't otherwise be predicted or
  // reliably provoked to fail on demand.
  writeManifestFile = (path, content) => writeFileSync(path, content, "utf8"),
  now = () => new Date(),
} = {}) {
  const id = cleanText(applicationId || appId);
  if (!id) {
    const err = new Error("exportPacketArtifacts: appId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const app = findApplication({ repoRoot, env, appId: id });
  const sources = packetSources || packetSourcesFromApp(app);
  const selectedFormats = requestedFormats({
    request: { ...request, formats: formats || request.formats },
    uploadRequirements,
  });
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  // Resolved ONCE, before any rendering or promotion, and reused for every
  // destination this batch touches (decision 1). A lexical workspaceDir
  // check can't see a symlinked ancestor; comparing against the real root
  // is what actually confines a promotion.
  const realWorkspaceRoot = safeRealpath(workspaceDir);
  const storedManifest = readStoredManifest(workspaceDir, sources.packetManifest);
  const priorManifest =
    app.packetManifest && Object.keys(app.packetManifest).length
      ? app.packetManifest
      : storedManifest || {};
  const priorManifestForDb = { ...priorManifest };
  if (Array.isArray(priorManifestForDb.questions)) {
    if (priorManifestForDb.questionCaptureSource) {
      priorManifestForDb.questions = {
        source: priorManifestForDb.questionCaptureSource,
        capturedAt: priorManifestForDb.generatedAt || new Date().toISOString(),
        answerableCount: priorManifestForDb.questions.length,
        excludedCount: Array.isArray(priorManifestForDb.excludedQuestions)
          ? priorManifestForDb.excludedQuestions.length
          : 0,
        answerableIds: priorManifestForDb.questions.map((question) => String(question?.id || "")),
        excludedIds: Array.isArray(priorManifestForDb.excludedQuestions)
          ? priorManifestForDb.excludedQuestions.map((question) => String(question?.id || ""))
          : [],
        demographicSectionPresent: false,
      };
    } else {
      delete priorManifestForDb.questions;
    }
  }
  const artifacts = {};
  const userFacing = { resume: [], coverLetter: [], answers: [] };
  const downloadsErrors = [];
  const exportGaps = [];
  const generatedAt = now().toISOString();
  // Canonical workspace-relative paths this call has reserved via the
  // synchronous DB reservation (decision 2) -- always released in the outer
  // finally below, on every exit path, success or failure.
  const reservedPaths = [];
  // Downloads copies queued during rendering but not yet performed
  // (decision 5): { entry, finalPath } pairs, executed only once
  // registration durably commits, so a batch that fails after this point
  // never mutates Downloads at all.
  const pendingDownloads = [];

  // Every export format writes to `${outBase}${ext}`, so an outBase that
  // lands on a source path (e.g. a resume.txt source stripped to "resume"
  // colliding with its own text export) would overwrite that source. Check
  // the full set of stored source paths, not just the one being exported,
  // since a distinct source could also land there.
  //
  // A lexical, case-sensitive string comparison misses two real collisions:
  // a symlink alias whose lexical path differs from the source it points
  // at, and an extension-case alias (resume.TXT vs resume.txt) on a
  // case-insensitive filesystem. Compare canonical filesystem identity
  // instead — realpath() for anything that exists, and canonical-parent +
  // basename for a destination that doesn't exist yet (the common case for
  // an export destination) — folded to lowercase when the workspace
  // filesystem is itself case-insensitive.
  const caseInsensitiveFs = detectCaseInsensitiveFs(workspaceDir);
  const canonicalIdentity = (path) => {
    let identity;
    try {
      identity = realpathSync(path);
    } catch {
      const parent = dirname(path);
      let canonicalParent;
      try {
        canonicalParent = realpathSync(parent);
      } catch {
        canonicalParent = resolve(parent);
      }
      identity = join(canonicalParent, basename(path));
    }
    return caseInsensitiveFs ? identity.toLowerCase() : identity;
  };
  // Reserved identities start from every stored source path (an outBase
  // must never collide with a source) and grow as each source in this
  // batch picks its output base, so two sources that would otherwise
  // resolve to the same destination (e.g. resumeSource=application.txt and
  // coverLetterSource=application.md both stripping to "application")
  // never both land on application-export.txt.
  //
  // `sources` only covers the packetSources passed into this call — a
  // partial export (e.g. a caller regenerating just the resume) omits the
  // other kinds. But every source registered on the application row is
  // still live on disk and still readable by other code paths, so an
  // omitted source must be reserved too, or a partial export's outBase can
  // collide with it and silently rename over it while its artifact
  // pointer keeps pointing at the now-overwritten file.
  //
  // That same risk applies to the plain-key legacy/registered artifacts
  // (`artifacts.resume`, `artifacts.coverLetter`, `artifacts.answers`), not
  // just their `*Source` counterparts. A supported application can have
  // one registered without the other (e.g. a legacy `artifacts.coverLetter`
  // pointer with no `coverLetterSource`), and if its stem collides with an
  // exported resume's outBase, an unreserved plain-key artifact would get
  // silently overwritten while its pointer still referenced it.
  const plainArtifactPaths = DOCUMENT_KINDS.map((key) => app.artifacts?.[key]).filter(
    (value) => typeof value === "string" && value.trim()
  );
  // A partial export also omits whole document kinds (e.g. a
  // cover-letter-only call never touches "resume"). Every PDF, DOCX, and
  // text artifact already registered on the application row for an
  // omitted kind (resumePdf, resumeDocx, resumeText, coverLetterPdf, ...)
  // is just as live and readable as the plain-key/*Source artifacts
  // reserved above — none of those cover the format-specific keys — so an
  // omitted kind's format artifacts must be reserved too, or a partial
  // export's outBase can silently rename over a surviving resume (or
  // cover letter, or answers) render while its pointer keeps referencing
  // the now-overwritten file. Enumerated from the DOCUMENT_KINDS/
  // SUPPORTED_EXPORT_FORMATS registries rather than a hand list, so a
  // future kind or format is automatically covered.
  const exportingKinds = new Set(
    sourceEntries(sources).map(([sourceKey]) => sourceKind(sourceKey))
  );
  const omittedKindFormatPaths = DOCUMENT_KINDS.filter((kind) => !exportingKinds.has(kind))
    .flatMap((kind) =>
      [...SUPPORTED_EXPORT_FORMATS].map((format) => app.artifacts?.[outputKey(kind, format)])
    )
    .filter((value) => typeof value === "string" && value.trim());
  // The packet manifest is just as live and readable as the document
  // artifacts above, and sourceEntries() never picks it up (its key doesn't
  // end in "Source"). Without reserving it, a caller-supplied outBase whose
  // stem happens to collide with the manifest's own filename (this call's
  // sources.packetManifest, or the one already registered on the
  // application row when this call omits it) would get renamed over,
  // leaving the manifest gone while the application row's pointer still
  // referenced it.
  const packetManifestPaths = [
    sources.packetManifest,
    packetSourcesFromApp(app).packetManifest,
  ].filter((value) => typeof value === "string" && value.trim());
  const reservedIdentities = new Set(
    [...sourceEntries(sources), ...sourceEntries(packetSourcesFromApp(app))]
      .map(([, storedPath]) => storedPath)
      .concat(plainArtifactPaths)
      .concat(omittedKindFormatPaths)
      .concat(packetManifestPaths)
      .map((storedPath) => resolveWorkspacePath(workspaceDir, storedPath))
      .filter(Boolean)
      .map(canonicalIdentity)
  );
  // A candidate flagged by reservedIdentities is always unavailable. But an
  // unreserved candidate can still collide with a file already sitting on
  // disk that none of the reservations above know about at all: an
  // unregistered sibling left by hand, an imported file, or anything else
  // this export process has no record of (e.g. a hand-placed
  // workspace/tailored/resume.txt next to a resume.md source). Such a file
  // is only safe to replace when it is *this application's own* previously
  // registered artifact for the exact kind+format being produced right
  // now: the application row's outputKey(kind, format) pointer
  // already resolves to this candidate path, so this run is a same-owner
  // re-export overwriting its own prior output. Anything else found at the
  // candidate path is unavailable, exactly like a reserved identity, and
  // distinctOutBase must move on to the next suffix instead of clobbering
  // it.
  const registeredDestination = (kind, format) => {
    const storedPath = app.artifacts?.[outputKey(kind, format)];
    if (typeof storedPath !== "string" || !storedPath.trim()) return null;
    const abs = resolveWorkspacePath(workspaceDir, storedPath);
    return abs ? canonicalIdentity(abs) : null;
  };
  // registeredDestination above can only ever answer "did THIS application
  // register this path" — reading app.artifacts alone has no way to know
  // whether some OTHER application also points at the same canonical path,
  // or points at it while its own file happens to be missing right now. A
  // shared path (two applications' rows both pointing at the same physical
  // file, e.g. because they share a source resume that both exported from)
  // looked like "my own prior render" and got overwritten out from under
  // the other application; a foreign-registered path with no file on disk
  // looked merely unavailable-if-it-existed and got silently claimed.
  // Build the cross-application index once per call and use it to reserve
  // every path any OTHER application has ever registered, regardless of
  // that path's current on-disk state.
  const foreignOwnersByIdentity = new Map();
  for (const registration of appListArtifactRegistrations({ repoRoot, env })) {
    if (String(registration?.applicationId) === id) continue;
    const abs = resolveWorkspacePath(workspaceDir, registration?.path);
    if (!abs) continue;
    const identity = canonicalIdentity(abs);
    if (!foreignOwnersByIdentity.has(identity)) foreignOwnersByIdentity.set(identity, new Set());
    foreignOwnersByIdentity.get(identity).add(String(registration.applicationId));
  }
  const isForeignOwned = (identity) => foreignOwnersByIdentity.has(identity);
  const isUnavailable = (base, kind) =>
    selectedFormats.some((format) => {
      const ext = FORMAT_EXTENSION[format];
      if (!ext) return false;
      const candidatePath = `${base}${ext}`;
      const identity = canonicalIdentity(candidatePath);
      if (reservedIdentities.has(identity)) return true;
      if (isForeignOwned(identity)) return true;
      if (!existsSync(candidatePath)) return false;
      return identity !== registeredDestination(kind, format);
    });
  const reserve = (base) => {
    for (const format of selectedFormats) {
      const ext = FORMAT_EXTENSION[format];
      if (ext) reservedIdentities.add(canonicalIdentity(`${base}${ext}`));
    }
  };
  const distinctOutBase = (base, kind) => {
    let candidate = base;
    if (isUnavailable(candidate, kind)) {
      candidate = `${base}-export`;
      let suffix = 2;
      while (isUnavailable(candidate, kind)) {
        candidate = `${base}-export-${suffix}`;
        suffix += 1;
      }
    }
    reserve(candidate);
    return candidate;
  };

  // Every render for this batch goes to a confined staging directory first,
  // created under the same trusted root every destination is validated
  // against, and is only promoted (renamed) into its real workspace
  // destination once every document has rendered and validated. Without
  // this, a later missing source, a renderer error, or a registration
  // failure partway through a multi-document batch could leave an EARLIER
  // document's destination already overwritten with a fresh render while
  // the manifest/db still describe the previous (now-stale-on-disk) state.
  const stagingDir = join(workspaceDir, `.export-staging-${process.pid}-${randomToken()}`);
  mkdirSync(stagingDir, { recursive: true });
  const pendingPromotions = []; // { stagedPath, finalPath, displayPath }
  // Declared here (rather than down at the promotion site) so the
  // confinement + ownership + reservation check below can run before ANY
  // rendering starts, and so the promotion/write section further down
  // reuses the exact same validated path instead of re-deriving it.
  let manifestPath = null;
  let manifestDisplayPath = null;

  try {
    // ---- Packet manifest destination: confinement + ownership (decisions 1/3) ----
    // Resolved and validated up front, before any source renders, so a
    // manifest path that escapes the workspace root or collides with
    // another application's registration is rejected before this batch
    // does any work at all -- not discovered only once the render loop
    // reaches the manifest write at the very end.
    if (sources.packetManifest) {
      const rawManifestPath = resolveWorkspacePath(workspaceDir, sources.packetManifest);
      if (rawManifestPath) {
        manifestPath = confineDestination(rawManifestPath, realWorkspaceRoot);
        const manifestIdentity = canonicalIdentity(manifestPath);
        if (isForeignOwned(manifestIdentity)) {
          const err = new Error(
            `packet manifest destination is owned by another application: ${sources.packetManifest}`
          );
          err.code = "ARTIFACT_OWNED_BY_ANOTHER_APPLICATION";
          throw err;
        }
        manifestDisplayPath = workspaceDisplayPath(workspaceDir, manifestPath);
        artifactReservationClaim({ repoRoot, env, path: manifestDisplayPath, applicationId: id });
        reservedPaths.push(manifestDisplayPath);
      }
    }

    for (const [sourceKey, storedPath] of sourceEntries(sources)) {
      const full = resolveWorkspacePath(workspaceDir, storedPath);
      if (!full || !existsSync(full)) {
        const err = new Error(`packet source artifact is missing: ${sourceKey}`);
        err.code = "NOT_FOUND";
        throw err;
      }
      // Bounded read (decision 8): fstat-checks the source's on-disk size
      // before ever reading its bytes, so an oversized source is rejected
      // before this call allocates a big buffer or blocks the event loop —
      // exportArtifact's own assertMarkdownSourceSize (documents/export.mjs)
      // still guards any OTHER caller that hands it markdown already in
      // memory.
      const markdown = readBoundedSource(full, MARKDOWN_SOURCE_MAX_BYTES);
      const kind = sourceKind(sourceKey);
      // extname() returns "" for an extensionless source, and
      // full.slice(0, -"".length) is full.slice(0, -0). Because -0 === 0 in
      // JS, that behaves like full.slice(0, 0) and produces "" rather than
      // the whole path. Only slice when there's an actual extension to
      // strip, so an extensionless source keeps its full absolute path as
      // outBase instead of collapsing to an empty (and therefore relative,
      // process.cwd()-anchored) base.
      const sourceExt = extname(full);
      const rawOutBase = distinctOutBase(sourceExt ? full.slice(0, -sourceExt.length) : full, kind);
      // Confinement (decision 1): validated and canonicalized BEFORE any
      // rendering happens for this source, so a symlinked tailored
      // directory is rejected here rather than only once promotion tries
      // to rename into it.
      const outBase = confineDestination(rawOutBase, realWorkspaceRoot);
      // Ownership reservation (decision 2): every format this batch will
      // produce for this source claims its destination synchronously,
      // BEFORE the asynchronous render below starts, so a concurrent
      // export for a DIFFERENT application racing on the same destination
      // fails atomically here instead of both promoting into the same
      // path once rendering finishes.
      const formatDestinations = new Map(); // format -> { finalPath, displayPath }
      for (const format of selectedFormats) {
        const ext = FORMAT_EXTENSION[format];
        if (!ext) continue;
        const finalPath = `${outBase}${ext}`;
        const displayPath = workspaceDisplayPath(workspaceDir, finalPath);
        artifactReservationClaim({ repoRoot, env, path: displayPath, applicationId: id });
        reservedPaths.push(displayPath);
        formatDestinations.set(format, { finalPath, displayPath });
      }
      // sourceEntries(sources) yields at most one entry per DOCUMENT_KINDS
      // kind (resumeSource/coverLetterSource/answersSource each map to a
      // distinct kind), so `kind` alone is a unique, stable staging
      // filename for this batch — no risk of two sources colliding on the
      // same staged path the way two different outBase directories both
      // stripping to "resume" could if staged by basename instead.
      const stagingOutBase = join(stagingDir, kind);
      const result = await exportArtifact({
        markdown,
        outBase: stagingOutBase,
        formats: selectedFormats,
        title: titleFor(app, kind),
        ats: true,
        root: stagingDir,
      });

      artifacts[sourceKey] = storedPath;
      // BUG: the read path (GET /api/packet, isGatedIn) keys off the plain
      // artifacts.<kind> field, not this finer-grained <kind>Source key — stamp
      // it too, pointed at the same source markdown, so an export run
      // standalone (without generatePacket) still leaves the packet readable.
      artifacts[kind] = storedPath;
      artifacts[`${kind}GeneratedAt`] = generatedAt;
      // Authoritative-format-request semantics: a run that processes `kind`
      // owns every format key for that kind, not just the ones it was asked
      // to produce. Seed an explicit null for pdf/docx/text here so a
      // text-only or docx-only regeneration clears a stale resumePdf left
      // over from an earlier run instead of merging on top of it — apply
      // must not still be able to pick an artifact this run never produced.
      // A format the loop below exports successfully overwrites its null
      // with the real path; mergeArtifacts (manifest) and
      // appRegisterPacketArtifacts (app row) both treat a surviving null as
      // "delete this key".
      for (const format of ["pdf", "docx", "text"]) {
        artifacts[outputKey(kind, format)] = null;
      }
      for (const format of ["pdf", "docx", "text"]) {
        const stagedPath = result[format];
        if (!selectedFormats.includes(format)) continue;
        if (!stagedPath || !validDocumentArtifact(stagedPath)) {
          exportGaps.push({
            kind,
            code: "ARTIFACT_EXPORT_FAILED",
            message: `${titleFor(app, kind)} did not produce a valid ${format.toUpperCase()} file.`,
          });
          continue;
        }
        // The real destination this staged render is bound for — already
        // computed and reserved above (not derived from the staged path)
        // so artifacts[key] and pendingPromotions always agree on where
        // promotion will land it.
        const { finalPath, displayPath } = formatDestinations.get(format);
        const key = outputKey(kind, format);
        artifacts[key] = displayPath;
        pendingPromotions.push({ stagedPath, finalPath, displayPath });
        const entry = { format, path: artifacts[key], name: basename(finalPath) };
        if (format === "pdf") {
          // Downloads publish (decision 5): queued, not performed here. The
          // copy itself only runs once registration durably commits, and
          // reads from `finalPath` (the promoted file), not the staged
          // one — by the time the deferred copy runs, promotion has
          // already renamed the staged file into place, so the staging
          // copy no longer exists. A batch that fails before registration
          // commits must leave Downloads completely untouched.
          pendingDownloads.push({ entry, kind, finalPath });
        }
        userFacing[kind].push(entry);
      }
    }

    if (sources.packetManifest) artifacts.packetManifest = sources.packetManifest;

    // ---- Promote every staged file into its real destination ----
    // A destination that already exists is displaced to a `.bak-<rand>`
    // sibling first (never deleted outright); one with no predecessor is
    // tracked separately so a rollback can remove it instead of "restoring"
    // a backup that never existed. Both lists, plus the manifest's own
    // before-state, feed rollbackPromotion below if anything from here
    // through db registration fails.
    const fileBackups = []; // { finalPath, backupPath }
    const newFilePaths = [];
    let manifestBackupPath = null;
    let manifestIsNew = false;
    let manifestTouched = false;

    const rollbackPromotion = () => {
      for (const { finalPath, backupPath } of fileBackups) {
        try {
          renameSync(backupPath, finalPath);
        } catch {
          // best-effort restore
        }
      }
      for (const finalPath of newFilePaths) {
        try {
          unlinkSync(finalPath);
        } catch {
          // best-effort cleanup
        }
      }
      if (manifestTouched && manifestPath) {
        if (manifestIsNew) {
          try {
            unlinkSync(manifestPath);
          } catch {
            // best-effort cleanup
          }
        } else if (manifestBackupPath) {
          try {
            renameSync(manifestBackupPath, manifestPath);
          } catch {
            // best-effort restore
          }
        }
      }
    };

    let registered;
    try {
      for (const { stagedPath, finalPath } of pendingPromotions) {
        if (existsSync(finalPath)) {
          const backupPath = `${finalPath}.bak-${randomToken()}`;
          renameSync(finalPath, backupPath);
          fileBackups.push({ finalPath, backupPath });
        } else {
          newFilePaths.push(finalPath);
        }
        renameSync(stagedPath, finalPath);
      }

      // RESUME_UPLOAD_ARTIFACT_MISSING behaves like ARTIFACT_EXPORT_FAILED
      // for readiness recovery: both describe a transient export-time
      // shortfall, not an unresolved content decision, so a later
      // successful export that restores the missing artifact must be able
      // to clear it automatically rather than requiring a human to dismiss
      // a stuck content gap.
      const RECOVERABLE_GAP_CODES = new Set([
        "ARTIFACT_EXPORT_FAILED",
        "RESUME_UPLOAD_ARTIFACT_MISSING",
      ]);
      const priorGaps = Array.isArray(priorManifestForDb.gaps) ? priorManifestForDb.gaps : [];
      const priorRecoverable = priorGaps.some((gap) => RECOVERABLE_GAP_CODES.has(gap?.code));
      const contentGaps = priorGaps.filter((gap) => !RECOVERABLE_GAP_CODES.has(gap?.code));
      const generationReady =
        priorManifestForDb.uploadReady === true || (priorRecoverable && contentGaps.length === 0);
      const mergedArtifacts = mergeArtifacts(priorManifestForDb.artifacts, artifacts);

      // A text-only (or docx-only) export deletes the prior PDF/DOCX
      // pointers by design (the "Authoritative-format-request semantics"
      // note above), but the upload driver only accepts a .pdf or .docx
      // resume — never the raw text/markdown source. So overall readiness
      // must come from the post-export artifact set, not merely from
      // exportGaps being empty.
      const wouldBeUploadReady = generationReady && exportGaps.length === 0;
      // hasUploadableResumeArtifact must see the complete post-export
      // application artifact set the apply driver will actually read, not
      // just this export's own manifest-tracked view of it (mergedArtifacts,
      // above, derives from priorManifestForDb.artifacts, which only ever
      // learns about a key once some export call has passed it through). A
      // plain "resume" key can land on the application row directly, e.g. a
      // legacy or externally-registered PDF/DOCX that never went through
      // this export path, and the manifest-only merge would miss it
      // entirely. app.artifacts (read at the top of this call, before this
      // export's own changes) is the same source uploadArtifacts in
      // apply-driver.mjs reads from, so overlaying this export's fresh
      // `artifacts` on top of it (respecting its explicit nulls the same
      // way appRegisterPacketArtifacts will when it commits) reproduces
      // exactly what apply-driver will see once this export's registration
      // lands. Computed here, after promotion, so its existsSync-based
      // validation sees the files this run just wrote at their real
      // destinations rather than their now-vacated staging paths.
      const applicationArtifactsAfterExport = mergeArtifacts(app.artifacts, artifacts);
      const hasUploadableResume = hasUploadableResumeArtifact({
        repoRoot,
        env,
        artifacts: applicationArtifactsAfterExport,
      });
      // Derived independently of every OTHER gap, and always — not only
      // when this export would otherwise be declared upload-ready. A
      // text-only export sitting next to an unrelated open gap (a pending
      // answer confirmation, a content gap on a different kind) must still
      // carry this gap forward in the persisted manifest: the
      // answer-confirmation readiness recompute
      // (confirmOneOffScreeningAnswer in one-off-answer.mjs) only clears
      // gaps it specifically resolves, so a resume gap that was never
      // recorded here would silently vanish the moment an unrelated gap
      // gets confirmed away, leaving the packet wrongly marked
      // upload-ready. The one exception: if this run's own exportGaps
      // already recorded an ARTIFACT_EXPORT_FAILED for kind "resume", that
      // failure already explains the missing resume, and a second,
      // redundant gap would just double-report the same problem.
      const resumeExportFailedThisRun = exportGaps.some(
        (gap) => gap?.kind === "resume" && gap?.code === "ARTIFACT_EXPORT_FAILED"
      );
      const missingResumeArtifactGap =
        !hasUploadableResume && !resumeExportFailedThisRun
          ? {
              kind: "resume",
              code: "RESUME_UPLOAD_ARTIFACT_MISSING",
              message:
                "No PDF or DOCX resume is available to upload; a text-only export cannot be submitted as-is.",
            }
          : null;

      const gaps = [
        ...contentGaps,
        ...exportGaps,
        ...(missingResumeArtifactGap ? [missingResumeArtifactGap] : []),
      ];
      const uploadReady = wouldBeUploadReady && hasUploadableResume;

      const nextManifest = {
        ...priorManifestForDb,
        applicationId: id,
        generatedAt: priorManifestForDb.generatedAt || generatedAt,
        exportedAt: generatedAt,
        uploadReady,
        status: uploadReady ? "upload-ready" : "reviewable",
        gapCount: gaps.length,
        gaps,
        artifacts: mergedArtifacts,
      };

      // manifestPath was already resolved and confined against the real
      // workspace root before rendering began (decisions 1/3) — reused
      // as-is here rather than re-derived from the lexical stored path.
      if (manifestPath) {
        manifestIsNew = !existsSync(manifestPath);
        if (!manifestIsNew) {
          manifestBackupPath = `${manifestPath}.bak-${randomToken()}`;
          renameSync(manifestPath, manifestBackupPath);
        }
        // Manifest rollback (decision 6): the displacement (or "there was
        // no predecessor") is durable BEFORE the write is even attempted,
        // not after it succeeds — an ENOSPC/quota/permission failure
        // partway through the write must still find manifestTouched=true
        // so rollbackPromotion restores the backup instead of stranding it
        // under a random name with the canonical path missing or partial.
        // The write itself goes to a staged sibling and is only renamed
        // into place once fully written, so a failure never leaves a
        // truncated file at the canonical path; any partial staged output
        // is removed before the error propagates to rollbackPromotion.
        manifestTouched = true;
        const stagedManifestPath = `${manifestPath}.tmp-${randomToken()}`;
        try {
          writeManifestFile(stagedManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
          renameSync(stagedManifestPath, manifestPath);
        } catch (writeErr) {
          try {
            unlinkSync(stagedManifestPath);
          } catch {
            // best-effort cleanup of the partial staged write
          }
          throw writeErr;
        }
      }

      // Ownership reservation revalidation (decision 2): closes the window
      // between this batch's early reservations and this, its final
      // durable write — every destination this batch claimed must still
      // be reserved by THIS application right before that claim becomes
      // permanent via appRegisterPacketArtifacts.
      for (const path of reservedPaths) {
        const owner = artifactReservationOwner({ repoRoot, env, path });
        if (owner !== id) {
          const err = new Error(
            `export destination "${path}" is no longer reserved by this application`
          );
          err.code = "ARTIFACT_OWNED_BY_ANOTHER_APPLICATION";
          throw err;
        }
      }

      registered = await appRegisterPacketArtifacts({
        repoRoot,
        env,
        appId: id,
        artifacts,
        now,
        manifest: nextManifest,
      });
    } catch (err) {
      // ExportFailedError (err.committed === true) means the database write
      // itself already succeeded and only the tracker.json/activity.jsonl
      // mirror regeneration failed afterward — the application row and the
      // promoted files ARE already the correct new state for that committed
      // row, so rolling back here would put the files out of sync with the
      // row that now points at them. Anything else means nothing durable
      // committed, so every promoted file and the manifest are restored to
      // exactly what they were before this call.
      if (!err?.committed) rollbackPromotion();
      throw err;
    }

    // Success: drop the backups, nothing left to restore.
    for (const { backupPath } of fileBackups) {
      try {
        unlinkSync(backupPath);
      } catch {
        // best-effort cleanup
      }
    }
    if (manifestBackupPath) {
      try {
        unlinkSync(manifestBackupPath);
      } catch {
        // best-effort cleanup
      }
    }

    // Downloads publish (decision 5): performed ONLY now, after promotion
    // and registration have both durably committed. Reads from `finalPath`
    // (the promoted file, real destination) rather than the vacated
    // staging path. Never fatal to the export itself — a copy failure here
    // is recorded the same way it always was, via downloadsErrors.
    for (const { entry, kind, finalPath } of pendingDownloads) {
      const copy = copyPdfToDownloads({
        env,
        company: app.company,
        kind,
        absPath: finalPath,
      });
      if (copy?.ok) entry.downloadsPath = copy.path;
      else if (copy && !copy.ok) downloadsErrors.push({ kind, format: "pdf", message: copy.error });
    }

    return {
      appId: id,
      applicationId: id,
      formats: selectedFormats,
      artifacts,
      userFacing,
      ...(downloadsErrors.length ? { downloadsErrors } : {}),
      registered,
    };
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    // Reservations are ephemeral (decision 2): released on every exit path,
    // success or failure. A successful export's permanent claim now lives
    // in the application row itself (appRegisterPacketArtifacts, above),
    // which appListArtifactRegistrations reads for every FUTURE export's
    // foreign-ownership check — this batch's own reservations have nothing
    // left to protect once the call is over.
    for (const path of reservedPaths) {
      try {
        artifactReservationRelease({ repoRoot, env, path, applicationId: id });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
