// learnings.mjs — the safe read/append primitive for per-role-family learning files.
//
// CareerRat compounds: it should get better at each role-track the more the user
// runs it. Durable lessons live in per-role-family markdown files at
// `candidate/learnings/<family>.md` (see AGENTS.md → Learning Memory). Three
// skills WRITE them (track-outcomes, reevaluate-strategy, interview-prep); three
// READ them (tailor-application, evaluate-job, search-jobs). Until now every skill
// described that read/append in prose — each re-deriving the family slug with its
// own three-tier rule and hand-appending markdown. That is the same hazard the
// gate-writer closed for YAML gates: prose-driven hand-editing drifts, can corrupt
// a file on a bad write, and re-implements the slug rule N times.
//
// This module is the single safe primitive those skills call instead, mirroring
// gate-writer.mjs for the markdown learning store:
//
//   - **One slug rule.** resolveFamilySlug() wraps classifyRoleFamily() (the same
//     targeting-driven role_families → role_buckets → neutral-slug ladder the
//     analytics use) and slugifies it filename-safe — so READ and WRITE always
//     agree on which file a role maps to.
//   - **Honesty backstop.** An entry that carries unresolved placeholder residue
//     (reusing the shared lintArtifact patterns) or leaks a private comp input
//     (current_base) is refused before it can be written — learnings must pass the
//     same placeholder lint the skills already run over candidate/learnings/.
//   - **Atomic + comment-free.** Learning files are append-only markdown, so we
//     append a dated entry and write it atomically (reusing gate-writer's
//     atomicWriteFile); a crash mid-write can never leave a half-written file.
//   - **Domain-neutral.** The module imposes only the dated `## <date> — <title>`
//     entry frame; the body is whatever durable lesson the skill composed. No
//     industry, stack, or role taxonomy is baked in.
//
// The text operations (computeAppend, formatEntry, lint/leak checks) are pure so
// they are fully unit-testable; the fs touchpoints (read, list, atomic append) are
// thin and isolated at the bottom.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintArtifact } from "../documents/placeholder-lint.mjs";
import { displayPath, userPath } from "../paths/workspace.mjs";
import { classifyRoleFamily } from "../tracker/outcome-analysis.mjs";
import { findCompLeak } from "./comp-guard.mjs";
import { atomicWriteFile, readTextIfExists } from "./gate-writer.mjs";

// Re-exported for backward compatibility — the leak guard now lives in the shared
// comp-guard.mjs so learnings and research-store apply the identical rule.
export { findCompLeak };

// Repo-root default (this file lives at src/core/profile/).
const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// The learning store lives under the gitignored candidate/ directory — private,
// never committed, never outbound.
export const LEARNINGS_SUBDIR = "candidate/learnings";

// ---------------------------------------------------------------------------
// Family slug — the single source of truth, shared by READ and WRITE.
// ---------------------------------------------------------------------------

// Make any family name filename-safe: lowercase, runs of non-alphanumerics → "-",
// trimmed. Idempotent, so passing an already-slugged value through again is a
// no-op (the CLI's --family path relies on this).
export function slugifyFamily(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "uncategorized";
}

// Classify a role title into its family slug using the candidate's own taxonomy
// (targeting.role_families → role_buckets → neutral slug when no config). This is
// the prose rule the skills each spelled out, now in one place.
export function resolveFamilySlug(role, targeting) {
  return slugifyFamily(classifyRoleFamily(role, targeting));
}

export function learningsRelPath(family) {
  return `${LEARNINGS_SUBDIR}/${slugifyFamily(family)}.md`;
}

export function learningsAbsPath(family, root = DEFAULT_ROOT) {
  return userPath({ repoRoot: root }, learningsRelPath(family));
}

// ---------------------------------------------------------------------------
// Pure formatting + guards
// ---------------------------------------------------------------------------

// File header written once when a family's learning file is first created.
// Domain-neutral; names the skills + the privacy invariant, nothing personal.
export function learningsHeader(family) {
  const slug = slugifyFamily(family);
  return `# Learnings · ${slug}

Durable, evidence-linked lessons for the **${slug}** role family. Append-only.
Written by track-outcomes, reevaluate-strategy, and interview-prep; read by
tailor-application, evaluate-job, and search-jobs. Private, never leaves this
gitignored directory; never record current_base or any other private gate input.
`;
}

// A single dated entry: `## <date>: <title>` then a blank line then the body.
// Entries written before the em-dash copy sweep use `## <date> — <title>`;
// readers (strategy/review.mjs's compactLearnings) accept both.
export function formatEntry({ date, title, body }) {
  const heading = `## ${date}: ${String(title).trim()}`;
  return `${heading}\n\n${String(body).trim()}\n`;
}

// Count `## ` entry headings (ignores the top-level `# ` file title).
export function countEntries(text) {
  if (!text) return 0;
  return (text.match(/^## /gm) || []).length;
}

// The private-comp-leak backstop (findCompLeak) is imported from comp-guard.mjs
// above and re-exported; computeAppend below calls it before any write.

// ---------------------------------------------------------------------------
// Plan: pure end-to-end (no fs). Given the current file text, compute the next
// text after appending a dated entry — or refuse with a reason.
// ---------------------------------------------------------------------------

export function computeAppend({ family, date, title, body, currentText = null }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(String(date))) {
    return { ok: false, error: `invalid or missing ISO date: ${JSON.stringify(date)}` };
  }
  const t = String(title || "").trim();
  const b = String(body || "").trim();
  if (!t) return { ok: false, error: "title is required" };
  if (!b) return { ok: false, error: "body is required" };

  // Honesty backstops: no template residue, no private comp leak.
  const probe = `${t}\n${b}`;
  const lint = lintArtifact(probe);
  if (!lint.clean) {
    const first = lint.findings[0];
    return { ok: false, error: `unresolved placeholder (${first.pattern}): "${first.text}"`, lint };
  }
  const leak = findCompLeak(probe);
  if (leak) {
    return { ok: false, error: `refusing to record a private comp input: "${leak.match}"`, leak };
  }

  const entry = formatEntry({ date, title: t, body: b });
  const created = currentText === null || String(currentText).trim() === "";
  const nextText = created
    ? `${learningsHeader(family)}\n${entry}`
    : `${String(currentText).replace(/\s+$/, "")}\n\n${entry}`;

  return { ok: true, family: slugifyFamily(family), entry, nextText, created };
}

// ---------------------------------------------------------------------------
// fs touchpoints
// ---------------------------------------------------------------------------

// READ side (tailor-application / evaluate-job / search-jobs): the learning file
// text, or null when the family has no file yet (callers skip silently).
export function readLearnings(family, { root = DEFAULT_ROOT } = {}) {
  return readTextIfExists(learningsAbsPath(family, root));
}

// Enumerate every existing family file with a lightweight summary.
export function listLearnings({ root = DEFAULT_ROOT } = {}) {
  const dir = userPath({ repoRoot: root }, LEARNINGS_SUBDIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const text = readFileSync(path, "utf8");
      return {
        family: name.replace(/\.md$/, ""),
        relPath: displayPath({ repoRoot: root }, `${LEARNINGS_SUBDIR}/${name}`),
        path,
        entries: countEntries(text),
        bytes: Buffer.byteLength(text, "utf8"),
      };
    });
}

// WRITE side (track-outcomes / reevaluate-strategy / interview-prep): append a
// dated entry atomically, creating the file + directory on first write. Refuses
// on placeholder residue or a private comp leak.
export function appendLearning({ family, date, title, body, root = DEFAULT_ROOT }) {
  const path = learningsAbsPath(family, root);
  const currentText = readTextIfExists(path);
  const plan = computeAppend({ family, date, title, body, currentText });
  if (!plan.ok) return { ok: false, error: plan.error, path, lint: plan.lint, leak: plan.leak };

  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, plan.nextText);
  return {
    ok: true,
    path,
    relPath: displayPath({ repoRoot: root }, learningsRelPath(family)),
    family: plan.family,
    created: plan.created,
    entry: plan.entry,
  };
}
