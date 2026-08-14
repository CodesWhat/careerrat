// deep-ingest-sources.mjs — pure, deterministic selection over the confirmed
// Library rows the deep-ingest reader verb produces (promotion-pipeline-
// design-2026-07-19.md "Selection module" contract). No DB, no AI: every
// export here is a plain function over already-loaded rows, called at
// prompt-build time once the query text (job body) and purpose are known.

import { containsForbiddenPhrase } from "../documents/tailor.mjs";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function cleanScalar(value) {
  return value == null ? "" : String(value).trim();
}

function capText(value, max) {
  const text = cleanScalar(value);
  return text.length > max ? text.slice(0, max) : text;
}

function capList(list, maxItems, maxCharsEach) {
  return (Array.isArray(list) ? list : [])
    .slice(0, maxItems)
    .map((item) => capText(item, maxCharsEach))
    .filter(Boolean);
}

function compareUpdatedAtDesc(a, b) {
  const av = cleanScalar(a?.updatedAt);
  const bv = cleanScalar(b?.updatedAt);
  if (av === bv) return 0;
  return av < bv ? 1 : -1;
}

function compareIdAsc(a, b) {
  const av = cleanScalar(a?.id);
  const bv = cleanScalar(b?.id);
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

// ---------------------------------------------------------------------------
// claimable story gate
// ---------------------------------------------------------------------------

function nonEmpty(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(cleanScalar(value));
}

function isClaimableStory(story) {
  if (!story || typeof story !== "object") return false;
  return (
    nonEmpty(story.title) &&
    nonEmpty(story.situation) &&
    nonEmpty(story.task) &&
    nonEmpty(story.action) &&
    nonEmpty(story.result) &&
    nonEmpty(story.supportingQuote) &&
    !(Array.isArray(story.openQuestions) && story.openQuestions.length > 0)
  );
}

// Non-claimable stories never enter prompts for any purpose. Exported (in
// addition to the pinned selectPacketStories/composePacketWritingVoice/
// selectPacketRoleSignals trio) so context.mjs can store the FULL claimable
// set on the packet context — purpose-specific scoring/caps happen later, at
// prompt-build time, via selectPacketStories.
export function filterClaimableStories(storyBank = []) {
  return (Array.isArray(storyBank) ? storyBank : []).filter(isClaimableStory);
}

// ---------------------------------------------------------------------------
// selectPacketStories
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "we",
  "were",
  "with",
  "you",
  "your",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function phraseInQuery(phrase, queryLower) {
  const text = cleanScalar(phrase).toLowerCase();
  return Boolean(text) && queryLower.includes(text);
}

// +12/roleSignal phrase in query (cap 36); +8/competency phrase in query
// (cap 24); +10 title phrase in query; +2/shared significant token across
// title+action+result (cap 20). Positive scores only.
function scoreStory(story, queryTokens, queryLower) {
  let score = 0;

  let roleSignalBonus = 0;
  for (const phrase of story.roleSignals || []) {
    if (phraseInQuery(phrase, queryLower)) roleSignalBonus += 12;
  }
  score += Math.min(roleSignalBonus, 36);

  let competencyBonus = 0;
  for (const phrase of story.competencies || []) {
    if (phraseInQuery(phrase, queryLower)) competencyBonus += 8;
  }
  score += Math.min(competencyBonus, 24);

  if (phraseInQuery(story.title, queryLower)) score += 10;

  const storyTokens = new Set(
    tokenize(`${story.title || ""} ${story.action || ""} ${story.result || ""}`)
  );
  let shared = 0;
  for (const token of storyTokens) {
    if (queryTokens.has(token)) shared += 1;
  }
  score += Math.min(shared * 2, 20);

  return score;
}

function rankClaimableStories(storyBank, queryText) {
  const queryLower = String(queryText || "").toLowerCase();
  const queryTokens = new Set(tokenize(queryText));

  return filterClaimableStories(storyBank)
    .map((story) => ({ story, score: scoreStory(story, queryTokens, queryLower) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const byUpdated = compareUpdatedAtDesc(a.story, b.story);
      if (byUpdated !== 0) return byUpdated;
      return compareIdAsc(a.story, b.story);
    })
    .map((entry) => entry.story);
}

// Résumé hints: metadata only, no story ids exposed as prompt fact sources —
// selection/style directives, never something citable (validatePacketEvidenceIds
// never sees a résumé storyHint as a groundable id).
function projectResumeHint(story) {
  return {
    id: story.id,
    title: cleanScalar(story.title),
    competencies: (Array.isArray(story.competencies) ? story.competencies : []).slice(0, 6),
    roleSignals: (Array.isArray(story.roleSignals) ? story.roleSignals : []).slice(0, 6),
  };
}

// Cover-letter/answers: full STAR prose, hard per-field caps applied first
// (never mid-field truncation past this point — a story that would still
// blow the remaining aggregate budget is skipped whole by packStories below).
function projectFullStory(story) {
  return {
    id: story.id,
    title: capText(story.title, 120),
    situation: capText(story.situation, 300),
    task: capText(story.task, 300),
    action: capText(story.action, 500),
    result: capText(story.result, 500),
    reflection: capText(story.reflection, 300),
    competencies: capList(story.competencies, 8, 80),
    roleSignals: capList(story.roleSignals, 8, 80),
    metrics: capList(story.metrics, 5, 80),
  };
}

// Packs ranked stories into an aggregate char budget: a story that would
// blow the remaining budget is skipped whole (never truncated mid-field) —
// later, smaller stories further down the ranking still get a chance to fit.
function packStories(stories, { maxCount, maxChars, project }) {
  const out = [];
  let used = 0;
  for (const story of stories) {
    if (out.length >= maxCount) break;
    const projected = project(story);
    const size = JSON.stringify(projected).length;
    if (used + size > maxChars) continue;
    out.push(projected);
    used += size;
  }
  return out;
}

export function selectPacketStories({
  storyBank = [],
  queryText = "",
  purpose = "cover-letter",
} = {}) {
  const ranked = rankClaimableStories(storyBank, queryText);
  if (purpose === "resume") {
    return packStories(ranked, { maxCount: 6, maxChars: 2000, project: projectResumeHint });
  }
  return packStories(ranked, { maxCount: 4, maxChars: 8000, project: projectFullStory });
}

// ---------------------------------------------------------------------------
// composePacketWritingVoice
// ---------------------------------------------------------------------------

function isNonemptyVoiceRow(row) {
  if (!row || typeof row !== "object") return false;
  return Boolean(
    cleanScalar(row.summary) ||
      (Array.isArray(row.doPhrases) && row.doPhrases.some(Boolean)) ||
      (Array.isArray(row.avoidPhrases) && row.avoidPhrases.some(Boolean))
  );
}

function containsForbidden(phrase, forbiddenPhrases) {
  return forbiddenPhrases.some((bad) => containsForbiddenPhrase(phrase, bad));
}

const WRITING_VOICE_ROW_CAP = 5;
const WRITING_VOICE_CHAR_CAP = 1500;

// Most-recent <=5 nonempty rows composed into one string, newline-joined,
// hard cap 1500 chars. `forbiddenPhrases` is optional (defaults to no-op so
// composePacketWritingVoice({ writingVoice }) alone still matches the pinned
// contract exactly) — context.mjs passes the confirmed honesty boundaries'
// own forbiddenWording values so a do-phrase that contradicts an enforced
// boundary never appears in the composed voice guidance (honesty wins). This
// is a hygiene pass on style guidance, not the enforcement gate itself — the
// full derived-phrase enforcement still runs downstream in forbiddenWordingFor.
export function composePacketWritingVoice({ writingVoice = [], forbiddenPhrases = [] } = {}) {
  const forbiddenTerms = (Array.isArray(forbiddenPhrases) ? forbiddenPhrases : [])
    .map(cleanScalar)
    .filter(Boolean);

  const rows = (Array.isArray(writingVoice) ? writingVoice : [])
    .filter(isNonemptyVoiceRow)
    .sort(compareUpdatedAtDesc)
    .slice(0, WRITING_VOICE_ROW_CAP);

  const lines = [];
  for (const row of rows) {
    const summary = cleanScalar(row.summary);
    const doPhrases = (Array.isArray(row.doPhrases) ? row.doPhrases : []).filter(
      (phrase) => !containsForbidden(phrase, forbiddenTerms)
    );
    const avoidPhrases = Array.isArray(row.avoidPhrases) ? row.avoidPhrases : [];

    const parts = [];
    if (summary) parts.push(summary);
    if (doPhrases.length) parts.push(`Do: ${doPhrases.join(", ")}.`);
    if (avoidPhrases.length) parts.push(`Avoid: ${avoidPhrases.join(", ")}.`);
    const line = parts.join(" ").trim();
    if (line) lines.push(line);
  }

  return lines.join("\n").slice(0, WRITING_VOICE_CHAR_CAP);
}

// ---------------------------------------------------------------------------
// selectPacketRoleSignals
// ---------------------------------------------------------------------------

function normalizeFamily(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ROLE_SIGNAL_CAP = 16;
const ROLE_SIGNAL_TEXT_CAP = 240;

// Rows where normalized(roleFamily) === normalized(family) exactly (no
// fuzzy match, no blank-means-global); signalType must be exactly
// "keep"|"cut"; text nonempty; capped 16 keep + 16 cut, text/rationale
// 240 chars each. family=null → [].
export function selectPacketRoleSignals({ roleSignals = [], family = null } = {}) {
  const normalizedFamily = normalizeFamily(family);
  if (!normalizedFamily) return [];

  const keep = [];
  const cut = [];
  for (const row of Array.isArray(roleSignals) ? roleSignals : []) {
    if (!row || typeof row !== "object") continue;
    if (normalizeFamily(row.roleFamily) !== normalizedFamily) continue;
    if (row.signalType !== "keep" && row.signalType !== "cut") continue;
    const text = cleanScalar(row.text);
    if (!text) continue;
    const projected = {
      id: row.id,
      roleFamily: row.roleFamily,
      signalType: row.signalType,
      text: capText(text, ROLE_SIGNAL_TEXT_CAP),
      rationale: capText(row.rationale, ROLE_SIGNAL_TEXT_CAP),
      updatedAt: row.updatedAt,
    };
    (row.signalType === "keep" ? keep : cut).push(projected);
  }

  return [...keep.slice(0, ROLE_SIGNAL_CAP), ...cut.slice(0, ROLE_SIGNAL_CAP)];
}
