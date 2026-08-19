// story-bank.mjs — the STAR+R behavioural story bank, layered over evidence.yml.
//
// The interview packet renderer is deliberately story-shy: packet.mjs matches JD
// signals to atomic evidence CLAIMS and refuses to invent narratives ("NEVER
// invent stories or metrics", packet.mjs:9). That keeps the packet honest but
// leaves every interview loop rebuilding behavioural answers from scratch.
//
// This module adds the missing layer: a candidate-owned bank of STAR+R stories
// (Situation, Task, Action, Result, Reflection) that interview-prep assembles into
// packets and reuses across loops. The honesty firewall is the same one the rest of
// CareerRat uses, applied to narrative:
//
//   - **Trace, don't invent.** Every story must cite >=1 `evidence_ids`, and each id
//     must resolve to a real claim in candidate/evidence.yml. The agent DRAFTS a
//     story from evidence claims; the candidate confirms it; a story that asserts
//     something the evidence bank doesn't back is refused. This is the narrative
//     analog of "generated text must map back to user-layer evidence".
//   - **No placeholder residue, no comp leak.** Story text passes the shared
//     lintArtifact + findCompLeak backstops before any write — a STAR story about a
//     salary negotiation can't smuggle current_base into an outbound packet.
//   - **Domain-neutral.** The competency vocabulary (COMMON_COMPETENCIES) is the set
//     of axes behavioural interviews probe in EVERY field — never a tech/role
//     assumption — and is overridable. role_signals reuse evidence.yml's free-form
//     vocabulary, so matching stays domain-agnostic.
//
// Pure text/logic ops (validate, match, gaps, render, computeStoryWrite) take no fs
// so they unit-test cleanly; the fs touchpoints (load, atomic upsert) are thin and
// isolated at the bottom — the same shape as learnings.mjs / research-store.mjs.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintArtifact } from "../documents/placeholder-lint.mjs";
import { displayPath, userPath } from "../paths/workspace.mjs";
import { findCompLeak } from "../profile/comp-guard.mjs";
import { atomicWriteFile, readTextIfExists } from "../profile/gate-writer.mjs";
import { parseYaml, stringifyYaml } from "../profile/yaml.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// Candidate-owned, gitignored truth layer — never committed, never outbound raw.
export const STORIES_REL_PATH = "candidate/stories.yml";

// The five STAR+R narrative fields every story must fill.
export const STAR_FIELDS = ["situation", "task", "action", "result", "reflection"];

// Domain-neutral behavioural themes used only for coverage-gap analysis. These are
// the universal axes a behavioural interview probes in any field — NOT a domain
// assumption — and coverageGaps() accepts an override so a candidate can supply
// their own set (e.g. from targeting.yml).
export const COMMON_COMPETENCIES = [
  "leadership",
  "conflict",
  "ambiguity",
  "failure-and-recovery",
  "measurable-impact",
  "influence-without-authority",
  "collaboration",
  "prioritization",
  "ownership",
  "communication",
  "learning-agility",
  "customer-focus",
];

// ---------------------------------------------------------------------------
// Paths + slug
// ---------------------------------------------------------------------------

export function storiesAbsPath(root = DEFAULT_ROOT) {
  return userPath({ repoRoot: root }, STORIES_REL_PATH);
}

// Filename/id-safe slug, idempotent (passing an already-slugged id is a no-op).
export function slugifyStoryId(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "story";
}

// ---------------------------------------------------------------------------
// Internal matching helpers (mirror packet.mjs signal matching)
// ---------------------------------------------------------------------------

function normalise(str) {
  return String(str ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Case-insensitive substring overlap in either direction.
function overlaps(a, b) {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// Display helper: collapse whitespace/newlines to a single line but PRESERVE case
// and punctuation (normalise() lowercases — that's for matching only, never display).
function oneLine(str) {
  return String(str ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Parse / load
// ---------------------------------------------------------------------------

export function parseStories(text) {
  const data = parseYaml(text) || {};
  const stories = Array.isArray(data.stories) ? data.stories : [];
  return { stories, data };
}

// READ side: { exists, stories[] }. A missing bank is normal — callers skip.
export function loadStories({ root = DEFAULT_ROOT } = {}) {
  const text = readTextIfExists(storiesAbsPath(root));
  if (text === null) return { exists: false, stories: [] };
  return { exists: true, ...parseStories(text) };
}

// ---------------------------------------------------------------------------
// Validation — the honesty firewall (pure)
// ---------------------------------------------------------------------------

// Validate a set of stories against the evidence bank. Returns { ok, errors[] }.
// Each error is { id, message }. evidenceClaims is the array from evidence.yml's
// `claims:`; when it is empty (evidence not loaded) the evidence-id EXISTENCE check
// is skipped, but the structural rules (>=1 evidence_id, STAR+R fields, no
// placeholder/comp leak, unique ids) still apply.
export function validateStories(stories, evidenceClaims = []) {
  if (!Array.isArray(stories)) {
    return { ok: false, errors: [{ id: null, message: "stories must be an array" }] };
  }
  const errors = [];
  const claimIds = new Set(
    (Array.isArray(evidenceClaims) ? evidenceClaims : [])
      .map((c) => c?.id)
      .filter(Boolean)
      .map(String)
  );
  const haveEvidence = claimIds.size > 0;
  const seen = new Set();

  stories.forEach((s, i) => {
    const where = s?.id ? `story "${s.id}"` : `stories[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      errors.push({ id: null, message: `${where} is not an object` });
      return;
    }

    if (!s.id || !String(s.id).trim()) {
      errors.push({ id: null, message: `${where} is missing id` });
    } else {
      const id = String(s.id);
      if (seen.has(id)) errors.push({ id, message: `duplicate story id "${id}"` });
      seen.add(id);
    }

    if (!s.title || !String(s.title).trim()) {
      errors.push({ id: s.id ?? null, message: `${where} is missing title` });
    }

    for (const f of STAR_FIELDS) {
      if (!s[f] || !String(s[f]).trim()) {
        errors.push({ id: s.id ?? null, message: `${where} is missing ${f}` });
      }
    }

    // Trace firewall: >=1 evidence_id, each resolving to a real claim.
    const ids = Array.isArray(s.evidence_ids) ? s.evidence_ids.map(String) : [];
    if (ids.length === 0) {
      errors.push({
        id: s.id ?? null,
        message: `${where} cites no evidence_ids: every story must trace to candidate/evidence.yml (no invented narratives)`,
      });
    } else if (haveEvidence) {
      for (const ref of ids) {
        if (!claimIds.has(ref)) {
          errors.push({
            id: s.id ?? null,
            message: `${where} cites evidence id "${ref}" that is not in evidence.yml`,
          });
        }
      }
    }

    // Honesty backstops on the narrative text (title + STAR+R + metrics).
    const probe = [
      s.title,
      ...STAR_FIELDS.map((f) => s[f]),
      ...(Array.isArray(s.metrics) ? s.metrics : []),
    ]
      .filter(Boolean)
      .join("\n");
    const lint = lintArtifact(probe);
    if (!lint.clean) {
      const first = lint.findings[0];
      errors.push({
        id: s.id ?? null,
        message: `${where} has unresolved placeholder (${first.pattern}): "${first.text}"`,
      });
    }
    const leak = findCompLeak(probe);
    if (leak) {
      errors.push({
        id: s.id ?? null,
        message: `${where} leaks a private comp input: "${leak.match}"`,
      });
    }
  });

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Match + coverage (pure)
// ---------------------------------------------------------------------------

// Rank stories for a role by overlap with JD signals (weighted x2) and target
// competencies (x1). Returns [{ story, score, matchedSignals[], matchedComps[] }].
// With no query (no signals, no competencies) the whole bank is surfaced (top
// `limit`); with a query, only stories that actually match are returned.
export function matchStories({ stories, jobSignals = [], competencies = [], limit = 6 } = {}) {
  const list = Array.isArray(stories) ? stories : [];
  const sigs = (Array.isArray(jobSignals) ? jobSignals : []).filter(Boolean);
  const comps = (Array.isArray(competencies) ? competencies : []).filter(Boolean);
  const hasQuery = sigs.length > 0 || comps.length > 0;

  const scored = list.map((s) => {
    const sSignals = Array.isArray(s.role_signals) ? s.role_signals : [];
    const sComps = Array.isArray(s.competencies) ? s.competencies : [];
    const matchedSignals = sigs.filter((sig) => sSignals.some((rs) => overlaps(sig, rs)));
    const matchedComps = comps.filter((c) => sComps.some((sc) => overlaps(c, sc)));
    const score = matchedSignals.length * 2 + matchedComps.length;
    return { story: s, score, matchedSignals, matchedComps };
  });

  // Array.prototype.sort is stable, so equal-score stories keep bank order.
  const ranked = scored.slice().sort((a, b) => b.score - a.score);
  const chosen = hasQuery ? ranked.filter((r) => r.score > 0) : ranked;
  return chosen.slice(0, limit);
}

// Competencies (default: COMMON_COMPETENCIES) that no story in the bank covers.
export function coverageGaps({ stories, competencies = COMMON_COMPETENCIES } = {}) {
  const list = Array.isArray(stories) ? stories : [];
  const covered = [];
  for (const s of list) {
    for (const c of Array.isArray(s.competencies) ? s.competencies : []) covered.push(normalise(c));
  }
  return (Array.isArray(competencies) ? competencies : []).filter((c) => {
    return !covered.some((cov) => overlaps(cov, c));
  });
}

// ---------------------------------------------------------------------------
// Render (pure) — packet section
// ---------------------------------------------------------------------------

// Render matched stories (either match wrappers from matchStories() or bare story
// objects) as a markdown STAR+R block for the interview packet.
export function renderStorySection(matched) {
  const items = Array.isArray(matched) ? matched : [];
  if (items.length === 0) {
    return "_No prepared stories matched this role yet. Draft STAR+R stories from candidate/evidence.yml via interview-prep (`careerrat stories gaps` shows what's uncovered)._";
  }
  const blocks = items.map((m) => {
    const s = m?.story ? m.story : m;
    const tagLine =
      Array.isArray(s.competencies) && s.competencies.length
        ? ` _(${s.competencies.join(" · ")})_`
        : "";
    const lines = [
      `### ${s.title ?? s.id}${tagLine}`,
      ``,
      `- **Situation:** ${oneLine(s.situation)}`,
      `- **Task:** ${oneLine(s.task)}`,
      `- **Action:** ${oneLine(s.action)}`,
      `- **Result:** ${oneLine(s.result)}`,
      `- **Reflection:** ${oneLine(s.reflection)}`,
    ];
    if (Array.isArray(s.evidence_ids) && s.evidence_ids.length) {
      lines.push(`- _Evidence: ${s.evidence_ids.join(", ")}_`);
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

// Lightweight summary for `list` / doctor.
export function summarizeStories(stories) {
  return (Array.isArray(stories) ? stories : []).map((s) => ({
    id: s.id,
    title: s.title,
    competencies: Array.isArray(s.competencies) ? s.competencies : [],
    role_signals: Array.isArray(s.role_signals) ? s.role_signals : [],
    evidence_ids: Array.isArray(s.evidence_ids) ? s.evidence_ids : [],
  }));
}

// ---------------------------------------------------------------------------
// Story enrichment (pure) — derive the "give me more context" mirror
// ---------------------------------------------------------------------------

// Derive the dashboard story-enrichment mirror from the bank: one entry per
// story that still carries open_questions (context the candidate hasn't filled
// in yet). The caller persists this to tracker.storyEnrichment so the read-only
// dashboard can raise a self-clearing "give me more context" action. Pure — no
// I/O, idempotent, returns [] when nothing needs enrichment.
export function computeStoryEnrichment(stories) {
  const out = [];
  for (const s of Array.isArray(stories) ? stories : []) {
    if (!s || typeof s !== "object") continue;
    const missing = (Array.isArray(s.open_questions) ? s.open_questions : [])
      .map((q) => String(q ?? "").trim())
      .filter(Boolean);
    if (!missing.length) continue;
    out.push({
      storyId: String(s.id ?? "").trim(),
      title: String(s.title ?? s.id ?? "").trim(),
      missing,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write plan (pure) — guarded upsert by id
// ---------------------------------------------------------------------------

// Compute the next story set after adding/replacing one story. Validates the new
// story against evidence (the firewall), then upserts by slugified id. Returns
// { ok, story, nextStories, replaced } or { ok:false, error, errors }.
export function computeStoryWrite({ newStory, currentStories = [], evidence = [] }) {
  if (!newStory || typeof newStory !== "object" || Array.isArray(newStory)) {
    return { ok: false, error: "no story object provided" };
  }
  const story = { ...newStory };
  if ((!story.id || !String(story.id).trim()) && story.title) {
    story.id = slugifyStoryId(story.title);
  }
  if (!story.id || !String(story.id).trim()) {
    return { ok: false, error: "story needs an id or a title to derive one from" };
  }
  story.id = slugifyStoryId(story.id);

  const v = validateStories([story], evidence);
  if (!v.ok) {
    return { ok: false, error: v.errors.map((e) => e.message).join("; "), errors: v.errors };
  }

  const existing = Array.isArray(currentStories) ? currentStories.slice() : [];
  const idx = existing.findIndex((s) => slugifyStoryId(s?.id) === story.id);
  let replaced = false;
  if (idx >= 0) {
    existing[idx] = story;
    replaced = true;
  } else {
    existing.push(story);
  }
  return { ok: true, story, nextStories: existing, replaced };
}

// ---------------------------------------------------------------------------
// fs touchpoints
// ---------------------------------------------------------------------------

export function readStoriesText(root = DEFAULT_ROOT) {
  return readTextIfExists(storiesAbsPath(root));
}

export function storiesExist(root = DEFAULT_ROOT) {
  return existsSync(storiesAbsPath(root));
}

// Atomically write the whole bank back to candidate/stories.yml (creating the
// candidate/ dir on first write). Callers pass the validated, merged story set.
export function writeStories({ stories, root = DEFAULT_ROOT }) {
  const path = storiesAbsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const body = stringifyYaml({ stories: Array.isArray(stories) ? stories : [] });
  atomicWriteFile(path, body.endsWith("\n") ? body : `${body}\n`);
  return {
    ok: true,
    path,
    relPath: displayPath({ repoRoot: root }, STORIES_REL_PATH),
    count: Array.isArray(stories) ? stories.length : 0,
  };
}
