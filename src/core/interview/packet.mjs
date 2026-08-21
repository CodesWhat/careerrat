/**
 * interview/packet.mjs
 *
 * Interview-packet renderer + story-gap extractor for CareerRat.
 *
 * Rules:
 *  - Assemble packets from REAL provided data only (profile, evidence-bank
 *    claims verbatim, JD text).  NEVER invent stories or metrics.
 *  - JD-inferred prep (likely questions) is clearly separated from sourced
 *    facts.
 *  - NEVER expose profile.compensation.current_base in the packet (candidate-
 *    private prep artifact). Only expected/target/minimum comp may appear.
 *  - Prepared STAR+R stories come from the candidate-owned story bank
 *    (candidate/stories.yml) — they are rendered, not generated: every story in
 *    the bank already traces to evidence.yml (see story-bank.mjs). The packet
 *    only ever RENDERS provided stories; it never invents one.
 */

import { matchStories, renderStorySection } from "./story-bank.mjs";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalise a string for signal matching: lower-case, collapse whitespace. */
function normalise(str) {
  return String(str).toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Return true when `signal` matches any of the claim's role_signals.
 * Matching is case-insensitive substring: the normalised signal must appear
 * anywhere in a normalised role_signal string OR vice-versa.
 */
function signalMatchesClaim(signal, claim) {
  if (!Array.isArray(claim.role_signals)) return false;
  const ns = normalise(signal);
  return claim.role_signals.some((rs) => {
    const nrs = normalise(rs);
    return nrs.includes(ns) || ns.includes(nrs);
  });
}

/**
 * Find the first evidence claim that matches `signal`.
 * @param {string} signal
 * @param {object[]} evidence  – array of claim objects from evidence.yml
 * @returns {object|null}
 */
function findClaim(signal, evidence) {
  if (!Array.isArray(evidence)) return null;
  return evidence.find((c) => signalMatchesClaim(signal, c)) ?? null;
}

/** Escape pipe characters inside a markdown table cell. */
function escapeCell(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Count how many of `jobSignals` a claim matches — its overall relevance to
 * this JD. Used to prefer the strongest, most role-relevant claim per signal
 * rather than whichever claim happens to appear first in evidence.yml.
 *
 * @param {object} claim
 * @param {string[]} jobSignals
 * @returns {number}
 */
function overlapScore(claim, jobSignals) {
  if (!Array.isArray(jobSignals)) return 0;
  let n = 0;
  for (const s of jobSignals) if (signalMatchesClaim(s, claim)) n += 1;
  return n;
}

/**
 * Build JD signal-match table rows.
 *
 * For every jobSignal that has a matching evidence claim:
 *   - row.evidence  = the claim's `claim` text (verbatim)
 *   - row.howToSay  = first allowed_wording entry, else the claim text
 *
 * Selection is diversity-aware: per signal we prefer a claim not already
 * surfaced (so a late-but-highly-relevant claim isn't shadowed by an earlier
 * one that merely shares a single signal), and among the pool we pick the
 * claim with the highest overall JD overlap. Ties keep evidence.yml order, so
 * a single-signal lookup still resolves to the first matching claim.
 *
 * Signals with NO match are omitted (they become story gaps via
 * extractStoryGaps).
 *
 * @param {string[]} jobSignals
 * @param {object[]} evidence
 * @returns {{ signal: string, evidence: string, howToSay: string }[]}
 */
export function buildSignalMatchRows(jobSignals, evidence) {
  if (!Array.isArray(jobSignals)) return [];
  const claims = Array.isArray(evidence) ? evidence : [];
  const used = new Set();
  const rows = [];
  for (const signal of jobSignals) {
    const candidates = claims.filter((c) => signalMatchesClaim(signal, c));
    if (candidates.length === 0) continue;
    // Prefer claims not yet surfaced; fall back to all matches once exhausted.
    const unused = candidates.filter((c) => !used.has(c));
    const pool = unused.length > 0 ? unused : candidates;
    let claim = pool[0];
    let best = overlapScore(claim, jobSignals);
    for (const c of pool) {
      const score = overlapScore(c, jobSignals);
      if (score > best) {
        best = score;
        claim = c;
      }
    }
    used.add(claim);
    const howToSay =
      Array.isArray(claim.allowed_wording) && claim.allowed_wording.length > 0
        ? claim.allowed_wording[0]
        : claim.claim;
    rows.push({
      signal,
      evidence: claim.claim,
      howToSay,
    });
  }
  return rows;
}

/**
 * Extract story gaps: jobSignals that have NO matching evidence claim.
 *
 * @param {{ jobSignals: string[], evidence: object[] }} params
 * @returns {{ signal: string, note: string }[]}
 */
export function extractStoryGaps({ jobSignals, evidence }) {
  if (!Array.isArray(jobSignals)) return [];
  const gaps = [];
  for (const signal of jobSignals) {
    const claim = findClaim(signal, evidence);
    if (!claim) {
      gaps.push({
        signal,
        note: "No evidence claim yet. Add to candidate/evidence.yml before interview.",
      });
    }
  }
  return gaps;
}

/**
 * Return up to `limit` matched signal strings that have evidence backing.
 *
 * @param {{ jobSignals: string[], evidence: object[] }} params
 * @param {number} limit
 * @returns {string[]}
 */
export function topFitSignals({ jobSignals, evidence }, limit = 5) {
  if (!Array.isArray(jobSignals)) return [];
  const matched = jobSignals.filter((s) => findClaim(s, evidence) !== null);
  return matched.slice(0, limit);
}

/**
 * Build a markdown block for comp & logistics.
 *
 * Privacy invariant: current_base (and current_comp_shareable) NEVER appear
 * in the packet — the packet is a candidate-private artifact. Only expected/
 * target/minimum comp is emitted. Callers must not rely on current salary
 * being present regardless of profile settings.
 *
 * @param {{ profile: object }} params
 * @returns {string}
 */
export function buildCompAndLogistics({ profile }) {
  const comp = profile?.compensation ?? {};
  const auth = profile?.authorization ?? {};
  const lines = [];

  // expected / target / minimum comp only — never current_base
  if (comp.expected_base != null) {
    const curr = comp.currency ?? "USD";
    lines.push(`- **Expected base:** ${curr} ${comp.expected_base.toLocaleString()}`);
  }
  if (comp.target_base != null) {
    const curr = comp.currency ?? "USD";
    lines.push(`- **Target base:** ${curr} ${comp.target_base.toLocaleString()}`);
  }
  if (comp.minimum_base != null) {
    const curr = comp.currency ?? "USD";
    lines.push(`- **Minimum base:** ${curr} ${comp.minimum_base.toLocaleString()}`);
  }
  if (comp.target_total_comp != null) {
    const curr = comp.currency ?? "USD";
    lines.push(`- **Target total comp:** ${curr} ${comp.target_total_comp.toLocaleString()}`);
  }

  // logistics
  if (auth.notice_period != null) {
    lines.push(`- **Notice period:** ${auth.notice_period}`);
  }
  if (auth.work_authorized != null) {
    lines.push(`- **Work authorized:** ${auth.work_authorized ? "yes" : "no"}`);
  }
  if (auth.requires_sponsorship != null) {
    lines.push(`- **Requires sponsorship:** ${auth.requires_sponsorship ? "yes" : "no"}`);
  }

  return lines.length > 0 ? lines.join("\n") : "_No comp or logistics data provided._";
}

/**
 * Build a bullet list of do-not-overclaim items by combining:
 *   - honesty.claims.do_not_fabricate
 *   - honesty.tools.do_not_claim
 *   - union of all claims' forbidden_wording
 *
 * @param {{ evidence: object[], honesty: object }} params
 * @returns {string}
 */
export function buildDoNotOverclaim({ evidence, honesty }) {
  const items = new Set();

  const h = honesty ?? {};
  if (Array.isArray(h.claims?.do_not_fabricate)) {
    for (const x of h.claims.do_not_fabricate) items.add(String(x));
  }
  if (Array.isArray(h.tools?.do_not_claim)) {
    for (const x of h.tools.do_not_claim) items.add(String(x));
  }
  if (Array.isArray(evidence)) {
    for (const claim of evidence) {
      if (Array.isArray(claim.forbidden_wording)) {
        for (const x of claim.forbidden_wording) items.add(String(x));
      }
    }
  }

  if (items.size === 0) return "_No overclaim constraints recorded._";
  return [...items].map((x) => `- ${x}`).join("\n");
}

/**
 * Build the "Prepared Stories (STAR+R)" packet section from the candidate-owned
 * story bank, matched to this role's JD signals (+ optional target competencies).
 *
 * Renders ONLY provided stories — every story in candidate/stories.yml already
 * traces to evidence.yml (story-bank.mjs enforces it), so this section asserts
 * nothing the evidence bank doesn't back. Returns "" when the bank is empty so the
 * caller omits the section entirely for users who haven't built a bank yet.
 *
 * @param {{ jobSignals: string[], stories: object[], competencies?: string[], limit?: number }} params
 * @returns {string}
 */
export function buildStorySection({ jobSignals, stories, competencies = [], limit = 6 }) {
  const bank = Array.isArray(stories) ? stories : [];
  if (bank.length === 0) return "";
  const matched = matchStories({ stories: bank, jobSignals, competencies, limit });
  return renderStorySection(matched);
}

/**
 * A small, role-agnostic bank of behavioural/situational prompts.
 * These are clearly generic — they are NOT candidate stories.
 */
const GENERIC_QUESTION_BANK = [
  "Walk me through a project where you had to balance speed and quality.",
  "How do you handle disagreement with a stakeholder about priorities?",
  "Describe a situation where you had incomplete information and had to make a decision.",
  "How do you stay current in a fast-moving technical area?",
  "Tell me about a time you influenced a decision without direct authority.",
];

/**
 * Derive plausible interview questions from the JD.
 *
 * These are JD-inferred prompts — clearly NOT fabricated candidate stories.
 *
 * @param {{ job: object, profile: object }} params
 * @returns {string[]}
 */
export function likelyQuestions({ job, _profile }) {
  const questions = [];

  // JD-derived questions seeded from role title / family
  const role = job?.frontmatter?.role ?? job?.role ?? "";
  const company = job?.frontmatter?.company ?? job?.company ?? "";

  if (role) {
    questions.push(`Why are you interested in the ${role} role${company ? ` at ${company}` : ""}?`);
    questions.push(`What relevant experience do you bring to a ${role} position?`);
  }

  // Signals-derived questions (from job signals if available)
  const signals = Array.isArray(job?.signals) ? job.signals : [];
  for (const signal of signals.slice(0, 3)) {
    questions.push(`Can you walk me through your experience with ${signal}?`);
  }

  // Append generic behavioural bank
  for (const q of GENERIC_QUESTION_BANK) {
    questions.push(q);
  }

  return questions;
}

/**
 * Normalize a question/prompt for fuzzy matching (lowercase, strip punctuation,
 * collapse whitespace).
 */
function normalizeQuestion(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the banked story that answers a given question, by matching the question
 * against each story's `prompts[]` (the questions that story is meant to answer).
 * Returns the story, or null when nothing in the bank covers it.
 *
 * @param {string} question
 * @param {object[]} stories
 * @returns {object|null}
 */
function findStoryForQuestion(question, stories) {
  const bank = Array.isArray(stories) ? stories : [];
  const q = normalizeQuestion(question);
  if (!q) return null;
  for (const story of bank) {
    const prompts = Array.isArray(story.prompts) ? story.prompts : [];
    for (const p of prompts) {
      const np = normalizeQuestion(p);
      if (!np) continue;
      if (np === q || np.includes(q) || q.includes(np)) return story;
    }
  }
  return null;
}

/**
 * Render the "Likely Questions" section with a scripted-answer scaffold per
 * question. For each question this deterministically attaches an anchor:
 *   - a banked story (matched via the story's `prompts[]`),
 *   - the Positioning Thesis (for the "why this role" / "what experience" opener),
 *   - the JD Signal Match row (for "experience with <signal>" questions),
 *   - or, when nothing backs it, a 🔴 behavioural-gap flag.
 *
 * The renderer never invents the answer — it marks WHERE the answer comes from
 * and instructs the agent to script the verbatim words (SKILL.md STEP 5). Gap
 * questions are routed to the seed-a-story flow (STEP 2b); never improvised.
 *
 * @param {{ questions: string[], stories: object[] }} params
 * @returns {{ markdown: string, gaps: string[] }}
 */
function buildLikelyQuestionsSection({ questions, stories }) {
  const qs = Array.isArray(questions) ? questions : [];
  const gaps = [];
  const blocks = qs.map((question, i) => {
    const n = i + 1;
    const story = findStoryForQuestion(question, stories);
    if (story) {
      const ids = Array.isArray(story.evidence_ids) ? story.evidence_ids : [];
      const anchor = `Story "${story.title}"${ids.length ? ` (${ids.join(", ")})` : ""}`;
      return (
        `**${n}. ${question}**: _Anchor: ${anchor}_\n` +
        `> _Script a say-it-verbatim answer from this story. Carry the verbatim metric for any impact / "how do you measure success" question._`
      );
    }
    if (/^why are you interested|^what relevant experience/i.test(question)) {
      return (
        `**${n}. ${question}**: _Anchor: Positioning Thesis + Top Fit Signals; lead with the strongest Prepared Story_\n` +
        `> _Script a say-it-verbatim answer from the anchor above._`
      );
    }
    const sig = question.match(/experience with (.+?)\?*$/i);
    if (sig) {
      return (
        `**${n}. ${question}**: _Anchor: JD Signal Match ("${sig[1].trim()}", use the matched evidence claim)_\n` +
        `> _Script a say-it-verbatim answer in plain language from the matched evidence claim._`
      );
    }
    // No story, no evidence/positioning anchor → behavioural gap.
    gaps.push(question);
    return (
      `**${n}. 🔴 ${question}**  \n` +
      `_No backing story or evidence anchor, behavioural gap._\n` +
      `> _Do NOT improvise. Surface 2 evidence-grounded example angles and ask the candidate to seed a STAR+R story (STEP 2b), then bank it and replace this with the scripted answer._`
    );
  });
  return { markdown: blocks.join("\n\n"), gaps };
}

/**
 * A few role-appropriate questions for the candidate to ask.
 * Generic and JD-derived — not invented candidate-specific content.
 *
 * @param {object} job
 * @returns {string[]}
 */
function questionsToAsk(job) {
  const role = job?.frontmatter?.role ?? job?.role ?? "this role";
  const company = job?.frontmatter?.company ?? job?.company ?? "the company";
  return [
    `What does success look like in the first 90 days for the ${role}?`,
    `How does the team measure progress and impact?`,
    `What are the biggest challenges the ${role} will face in year one?`,
    `How does ${company} support professional development?`,
    `What is the team's current biggest priority, and how does this hire help with it?`,
  ];
}

/**
 * Render a complete interview packet as a markdown string.
 *
 * Follows the exact section order in templates/interview-packet.md.
 * Appends an "## Evidence Gaps" section so the candidate knows what to add.
 *
 * @param {{
 *   job: object,
 *   profile: object,
 *   evidence: object[],
 *   honesty: object,
 *   application?: object,
 *   inviteNotes?: string,
 *   audience?: "recruiter"|"hiring-manager"|"technical"|"panel",
 *   stories?: object[]
 * }} params
 * @returns {string}
 */
export function renderInterviewPacket({
  job,
  profile,
  evidence,
  honesty,
  _application,
  inviteNotes,
  audience,
  stories,
}) {
  // Accept either a bare claims array or the parsed evidence.yml object
  // ({ claims: [...] }) — the SKILL.md snippet passes the parsed file directly,
  // so a strict Array check here silently dropped every claim.
  const ev = Array.isArray(evidence)
    ? evidence
    : Array.isArray(evidence?.claims)
      ? evidence.claims
      : Array.isArray(evidence?.evidence)
        ? evidence.evidence
        : [];
  const jobSignals = Array.isArray(job?.signals) ? job.signals : [];

  const role = job?.frontmatter?.role ?? job?.role ?? "the role";
  const company = job?.frontmatter?.company ?? job?.company ?? "the company";

  const candidateName =
    profile?.candidate?.preferred_name ?? profile?.candidate?.full_name ?? "Candidate";

  // -- Positioning Thesis -----------------------------------------------------
  const topSignals = topFitSignals({ jobSignals, evidence: ev });
  const thesisParts = [];
  thesisParts.push(
    `${candidateName} brings directly relevant experience for the ${role} role at ${company}.`
  );
  if (topSignals.length > 0) {
    thesisParts.push(`Key fit signals: ${topSignals.join(", ")}.`);
  }
  const thesis = thesisParts.join(" ");

  // -- Top Fit Signals --------------------------------------------------------
  const topFitBullets =
    topSignals.length > 0
      ? topSignals.map((s) => `- ${s}`).join("\n")
      : "_No matched signals yet. Add evidence claims to candidate/evidence.yml._";

  // -- JD Signal Match table --------------------------------------------------
  const rows = buildSignalMatchRows(jobSignals, ev);
  const tableRows =
    rows.length > 0
      ? rows
          .map(
            (r) =>
              `| ${escapeCell(r.signal)} | ${escapeCell(r.evidence)} | ${escapeCell(r.howToSay)} |`
          )
          .join("\n")
      : "| N/A | N/A | N/A |";
  const signalTable = `| Signal | Evidence | How to say it |\n| --- | --- | --- |\n${tableRows}`;

  // -- Likely Questions -------------------------------------------------------
  // Each question is rendered with a scripted-answer anchor (a banked story, the
  // positioning thesis, or a JD-signal evidence row). Questions with no anchor
  // are flagged as behavioural gaps to seed via STEP 2b — never improvised.
  const questions = likelyQuestions({ job, profile });
  const { markdown: questionBlock, gaps: behaviouralGaps } = buildLikelyQuestionsSection({
    questions,
    stories,
  });

  // -- Questions To Ask -------------------------------------------------------
  const toAsk = questionsToAsk(job);
  const toAskBullets = toAsk.map((q) => `- ${q}`).join("\n");

  // -- Prepared Stories (STAR+R) ----------------------------------------------
  // Rendered only when the candidate has a story bank; each story traces to
  // evidence.yml. Empty bank → "" → section omitted below.
  const storyBlock = buildStorySection({ jobSignals, stories });

  // -- Comp And Logistics -----------------------------------------------------
  const compBlock = buildCompAndLogistics({ profile });

  // -- Do Not Overclaim -------------------------------------------------------
  const overclaim = buildDoNotOverclaim({ evidence: ev, honesty });

  // -- Evidence Gaps ----------------------------------------------------------
  const gaps = extractStoryGaps({ jobSignals, evidence: ev });
  const gapLines =
    gaps.length > 0
      ? gaps.map((g) => `- **${g.signal}**: ${g.note}`).join("\n")
      : "_All job signals have evidence backing, great!_";

  // -- Optional invite notes --------------------------------------------------
  const _inviteBlock = inviteNotes ? `\n> **Invite context:** ${inviteNotes}\n` : "";

  // -- Optional audience focus ------------------------------------------------
  const audienceBlock = audience
    ? `\n## Audience Focus (${audience})\n\n${audienceFocusNote(audience, role)}\n`
    : "";

  // -- Assemble ---------------------------------------------------------------
  return [
    `# Interview Packet`,
    ``,
    `**Role:** ${role}  `,
    `**Company:** ${company}  `,
    inviteNotes ? `**Invite notes:** ${inviteNotes}` : "",
    ``,
    `## Positioning Thesis`,
    ``,
    thesis,
    ``,
    `## Top Fit Signals`,
    ``,
    topFitBullets,
    ``,
    `## JD Signal Match`,
    ``,
    signalTable,
    ``,
    ...(storyBlock
      ? [
          `## Prepared Stories (STAR+R)`,
          ``,
          `> _Candidate-owned stories from candidate/stories.yml, matched to this role. Each traces to evidence, use them as answer anchors; don't improvise past them._`,
          ``,
          storyBlock,
          ``,
        ]
      : []),
    `## Likely Questions: with scripted answers`,
    ``,
    `> _Questions are JD-inferred; answers are scripted from the Prepared Stories and evidence above, say them close to verbatim. Each carries its anchor. Questions flagged 🔴 have no backing story, seed one via STEP 2b (ask the candidate for the anecdote), then replace the flag with the scripted answer. Never improvise a fabricated behavioural answer._`,
    ``,
    questionBlock,
    ``,
    ...(behaviouralGaps.length > 0
      ? [
          `## Behavioural Gaps (no backing story, seed before the interview)`,
          ``,
          `> _Competencies the JD probes that no banked story covers. For each, surface 2 evidence-grounded example angles, ask the candidate to seed the anecdote, then draft + bank a STAR+R story (STEP 2b). Never fabricate one._`,
          ``,
          behaviouralGaps.map((q) => `- ${q}`).join("\n"),
          ``,
        ]
      : []),
    `## Questions To Ask`,
    ``,
    toAskBullets,
    ``,
    `## Comp And Logistics`,
    ``,
    compBlock,
    ``,
    `## Do Not Overclaim`,
    ``,
    overclaim,
    audienceBlock,
    `## Evidence Gaps`,
    ``,
    gapLines,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Internal: audience focus note
// ---------------------------------------------------------------------------

function audienceFocusNote(audience, role) {
  switch (audience) {
    case "recruiter":
      return (
        "Focus on positioning clarity, comp alignment, and timeline. " +
        "Lead with the top fit signals and keep technical depth light. " +
        "Be ready to confirm work authorisation and notice period."
      );
    case "hiring-manager":
      return (
        "Focus on business impact, cross-functional collaboration, and " +
        "how your work maps to the team's current priorities. " +
        "Prepare specific examples from the JD signal match table."
      );
    case "technical":
      return (
        `Focus on depth: be ready to discuss architecture decisions, ` +
        `trade-offs, and specific technical implementations relevant to ${role}. ` +
        "Expect whiteboard or live-coding exercises."
      );
    case "panel":
      return (
        "Adapt tone to each panellist: technical depth for engineers, " +
        "impact framing for managers, culture/values for HR. " +
        "Prepare a clear two-minute intro that hits all fit signals."
      );
    default:
      return `Prepare for a ${audience} audience.`;
  }
}
