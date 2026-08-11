// research-store.mjs — the safe read/write primitive for web-research artifacts.
//
// M11 lets CareerRat "go find things out": skills web-search a company, a market
// comp band, or new job boards and persist the findings as cited markdown under
// `workspace/research/` (see AGENTS.md → Research Memory). This module is the
// single safe primitive those skills write through and other skills (interview-prep,
// evaluate-job) read through — the research analog of `learnings.mjs`:
//
//   - **One slug rule.** A company resolves to exactly one file via
//     slugifyCompany(), so the writer (research-company) and readers
//     (interview-prep, evaluate-job) never disagree about which file a company maps
//     to. Comp-benchmark / board-log artifacts carry their own filename stem.
//   - **Citation-hygiene gate.** A "sourced" artifact (company-research,
//     comp-benchmark) is REFUSED unless its frontmatter lists at least one
//     `sources[]` entry — research that cites nothing cannot be written.
//   - **Honesty + privacy backstops.** The body is run through the shared
//     lintArtifact (no unresolved template residue) and the whole text through
//     findCurrentBaseToken (the candidate's private `current_base` field can never
//     be persisted — these files feed tailoring and are treated as outbound).
//   - **Atomic upsert.** Unlike append-only learnings, a research file is one doc
//     per subject, rewritten in place; the write is atomic (reusing gate-writer's
//     atomicWriteFile) so a crash can never leave a half-written file.
//   - **Domain-neutral.** The module imposes only the frontmatter contract and the
//     guards; the axes, prose, and sources are whatever the skill composed.
//
// The text operations (splitFrontmatter, computeResearchWrite, isStale) are pure so
// they are fully unit-testable; the fs touchpoints are thin and isolated at the end.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { lintArtifact } from "../documents/placeholder-lint.mjs";
import { displayPath, userPath } from "../paths/workspace.mjs";
import { findCurrentBaseToken } from "../profile/comp-guard.mjs";
import { atomicWriteFile, readTextIfExists } from "../profile/gate-writer.mjs";
import { parseYaml } from "../profile/yaml.mjs";

// Repo-root default (this file lives at src/core/research/).
const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// Research artifacts live under the gitignored workspace/ tree — private, never
// committed, treated as outbound (so the privacy guard applies).
export const RESEARCH_SUBDIR = "workspace/research";

// Known artifact types. The first two are "sourced" — they must cite at least one
// source. board-discovery-log is a lightweight audit note (the real artifact of
// board discovery is the updated config/search-sources.yml).
export const RESEARCH_TYPES = ["company-research", "comp-benchmark", "board-discovery-log"];
const SOURCED_TYPES = new Set(["company-research", "comp-benchmark"]);

// Fallback staleness window when an artifact omits staleness_days. Type-specific
// defaults (14d company, 30d comp) live in the skill that writes the frontmatter.
export const DEFAULT_STALENESS_DAYS = 14;

// ---------------------------------------------------------------------------
// Slug + paths — the single source of truth, shared by READ and WRITE.
// ---------------------------------------------------------------------------

// Make a company name (or any subject) filename-safe: lowercase, runs of
// non-alphanumerics → "-", trimmed. Idempotent — passing an already-slugged value
// through again is a no-op.
export function slugifyCompany(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "unknown";
}

export function researchRelPath(stem) {
  return `${RESEARCH_SUBDIR}/${slugifyCompany(stem)}.md`;
}

export function researchAbsPath(stem, root = DEFAULT_ROOT) {
  return userPath({ repoRoot: root }, researchRelPath(stem));
}

// ---------------------------------------------------------------------------
// Pure parsing + guards
// ---------------------------------------------------------------------------

// Split a `---\n<yaml>\n---\n<body>` document into its parsed frontmatter and body.
// Returns { frontmatter: object|null, body: string }. frontmatter is null when the
// document has no leading frontmatter block or the YAML fails to parse.
export function splitFrontmatter(text) {
  const t = String(text || "");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!m) return { frontmatter: null, body: t };
  let frontmatter = null;
  try {
    frontmatter = parseYaml(m[1]);
  } catch {
    frontmatter = null;
  }
  return { frontmatter, body: t.slice(m[0].length) };
}

// Convenience: just the frontmatter object (or {} when absent/invalid).
export function parseResearchFrontmatter(text) {
  return splitFrontmatter(text).frontmatter || {};
}

// Has this artifact aged past its staleness window? An unknown/invalid fetchedAt
// counts as stale (refresh rather than trust). `now` is injectable for tests.
export function isStale(fetchedAt, stalenessDays = DEFAULT_STALENESS_DAYS, now = Date.now()) {
  const fetched = Date.parse(fetchedAt);
  if (Number.isNaN(fetched)) return true;
  const nowMs = typeof now === "number" ? now : now.getTime();
  return nowMs - fetched > stalenessDays * 24 * 60 * 60 * 1000;
}

const sourcesOf = (fm) => (Array.isArray(fm?.sources) ? fm.sources : []);

// ---------------------------------------------------------------------------
// Plan: pure end-to-end (no fs). Validate a fully-composed artifact document and
// return its normalized text — or refuse with a reason.
// ---------------------------------------------------------------------------

export function computeResearchWrite({ text, now = Date.now() }) {
  const raw = String(text || "");
  const { frontmatter: fm, body } = splitFrontmatter(raw);

  if (!fm) {
    return { ok: false, error: "missing YAML frontmatter (--- block) at the top of the artifact" };
  }
  if (!fm.type || !RESEARCH_TYPES.includes(fm.type)) {
    return {
      ok: false,
      error: `frontmatter.type must be one of: ${RESEARCH_TYPES.join(", ")} (got ${JSON.stringify(fm.type)})`,
    };
  }
  if (!fm.fetchedAt) {
    return {
      ok: false,
      error: "frontmatter.fetchedAt is required (ISO date the research was run)",
    };
  }
  if (!fm.company && !fm.role) {
    return { ok: false, error: "frontmatter must name a company or a role" };
  }
  // Citation-hygiene gate: sourced research must cite.
  if (SOURCED_TYPES.has(fm.type) && sourcesOf(fm).length === 0) {
    return {
      ok: false,
      error: `frontmatter.sources[] must list at least one cited source for type "${fm.type}" (citation-hygiene rule)`,
    };
  }

  // Honesty backstop: no unresolved template residue in the prose body. (Citation
  // markers like `[source: ...]` / `[AGENT-INFERRED from: ...]` carry a colon and so
  // do not match the bracket-token pattern; markdown links `[t](u)` are exempt too.)
  const lint = lintArtifact(body);
  if (!lint.clean) {
    const f = lint.findings[0];
    return {
      ok: false,
      error: `unresolved placeholder (${f.pattern}) at line ${f.line}: "${f.text}"`,
      lint,
    };
  }

  // Privacy backstop: the candidate's private current_base field must never be
  // persisted to a research artifact (treated as outbound).
  const leak = findCurrentBaseToken(raw);
  if (leak) {
    return { ok: false, error: `refusing to persist a private comp input: "${leak.match}"`, leak };
  }

  const nextText = `${raw.replace(/\s+$/, "")}\n`;
  const stale = isStale(fm.fetchedAt, fm.staleness_days ?? DEFAULT_STALENESS_DAYS, now);
  return { ok: true, frontmatter: fm, body, nextText, stale };
}

// ---------------------------------------------------------------------------
// fs touchpoints
// ---------------------------------------------------------------------------

// READ by filename stem. Returns { text, frontmatter, stale } or null when absent.
export function readResearch(stem, { root = DEFAULT_ROOT, now = Date.now() } = {}) {
  const text = readTextIfExists(researchAbsPath(stem, root));
  if (text === null) return null;
  const frontmatter = parseResearchFrontmatter(text);
  const stale = isStale(
    frontmatter.fetchedAt,
    frontmatter.staleness_days ?? DEFAULT_STALENESS_DAYS,
    now
  );
  return { text, frontmatter, stale };
}

// READ a company's research file (research-company / interview-prep / evaluate-job).
export function readCompanyResearch(company, opts = {}) {
  return readResearch(slugifyCompany(company), opts);
}

// Enumerate every research artifact with a lightweight summary.
export function listResearch({ root = DEFAULT_ROOT, now = Date.now() } = {}) {
  const dir = userPath({ repoRoot: root }, RESEARCH_SUBDIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const text = readFileSync(path, "utf8");
      const fm = parseResearchFrontmatter(text);
      return {
        stem: name.replace(/\.md$/, ""),
        relPath: displayPath({ repoRoot: root }, `${RESEARCH_SUBDIR}/${name}`),
        path,
        type: fm.type ?? null,
        company: fm.company ?? null,
        role: fm.role ?? null,
        fetchedAt: fm.fetchedAt ?? null,
        sources: sourcesOf(fm).length,
        stale: isStale(fm.fetchedAt, fm.staleness_days ?? DEFAULT_STALENESS_DAYS, now),
        bytes: Buffer.byteLength(text, "utf8"),
      };
    });
}

// WRITE (research-company / research-comp): validate a fully-composed artifact and
// upsert it atomically, creating the directory on first write. Refuses on a missing
// citation, placeholder residue, or a private comp-field leak.
export function writeResearch({ stem, text, root = DEFAULT_ROOT, now = Date.now() }) {
  const plan = computeResearchWrite({ text, now });
  const relPath = researchRelPath(stem);
  if (!plan.ok) return { ok: false, error: plan.error, relPath, lint: plan.lint, leak: plan.leak };

  const path = researchAbsPath(stem, root);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, plan.nextText);
  return {
    ok: true,
    path,
    relPath: displayPath({ repoRoot: root }, relPath),
    stem: slugifyCompany(stem),
    frontmatter: plan.frontmatter,
    stale: plan.stale,
  };
}
