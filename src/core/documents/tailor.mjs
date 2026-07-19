// tailor.mjs — deterministic assembly of tailored resume/cover-letter artifacts.
// Selection, assembly, and validation only — NEVER fabricates content.
// Zero runtime dependencies.

import { lintArtifact } from "./placeholder-lint.mjs";

// ---------------------------------------------------------------------------
// indexEvidence
// ---------------------------------------------------------------------------

/**
 * Build a lookup index from a parsed evidence bank object ({ claims: [...] }).
 *
 * @param {{ claims: Array<{ id: string, claim: string, evidence: string, metrics?: string[], links?: string[], role_signals?: string[], allowed_wording?: string[], forbidden_wording?: string[] }> }} evidenceBank
 * @returns {{ byId: Map<string, object>, all: Array<object> }}
 */
export function indexEvidence(evidenceBank) {
  const all = Array.isArray(evidenceBank.claims) ? evidenceBank.claims : [];
  const byId = new Map();
  for (const claim of all) {
    byId.set(claim.id, claim);
  }
  return { byId, all };
}

// ---------------------------------------------------------------------------
// selectEvidenceForSignals
// ---------------------------------------------------------------------------

/**
 * Return claims whose role_signals intersect the given signals array.
 * Comparison is case-insensitive. Result is deduped by id, order preserved.
 * Empty signals array → returns [].
 *
 * @param {{ claims: Array<object> }} evidenceBank
 * @param {string[]} signals
 * @returns {Array<object>}
 */
export function selectEvidenceForSignals(evidenceBank, signals) {
  if (!Array.isArray(signals) || signals.length === 0) return [];

  const normalizedSignals = signals.map((s) => s.toLowerCase());
  const seen = new Set();
  const selected = [];

  for (const claim of evidenceBank.claims || []) {
    if (seen.has(claim.id)) continue;
    const claimSignals = (claim.role_signals || []).map((s) => s.toLowerCase());
    const matches = claimSignals.some((cs) => normalizedSignals.includes(cs));
    if (matches) {
      seen.add(claim.id);
      selected.push(claim);
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// mapClaimsToEvidence
// ---------------------------------------------------------------------------

/**
 * Produce a build-note mapping of each used claim to its evidence source.
 *
 * @param {Array<{ id: string, claim: string, evidence?: string, links?: string[] }>} claims
 * @returns {Array<{ id: string, claim: string, evidenceNote: string, links: string[] }>}
 */
export function mapClaimsToEvidence(claims) {
  return claims.map((c) => ({
    id: c.id,
    claim: c.claim,
    evidenceNote: c.evidence || "",
    links: Array.isArray(c.links) ? c.links : [],
  }));
}

// ---------------------------------------------------------------------------
// forbiddenWordingFor
// ---------------------------------------------------------------------------

// Confirmed honesty-boundary types the reader verb treats as restrictive
// (candidate-confirmed "don't say this" rows) vs. informational-only types
// (e.g. education/tool-disclosure boundaries) that stay prompt-visible but
// never derive an enforced phrase from their free-text `text` field.
const RESTRICTIVE_BOUNDARY_TYPES = new Set([
  "do_not_claim",
  "never_claim",
  "forbidden",
  "forbidden_wording",
  "avoid",
]);

// Leading phrasing a candidate's own boundary text commonly uses ("Never say
// I led the team") — stripped so the derived forbidden phrase is just the
// claim itself ("I led the team"), not the instruction wrapped around it.
const RESTRICTIVE_PREFIX_RE =
  /^(?:do not|don't|never|must not)\s+(?:say|state|claim|imply|describe(?:\s+me)?\s+as)\s+/i;

function derivedForbiddenPhrase(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(RESTRICTIVE_PREFIX_RE, "");
  return stripped.replace(/[.!?,;:]+$/, "").trim();
}

/**
 * Collect all forbidden phrases from claims' forbidden_wording,
 * honesty.tools.do_not_claim, and confirmed honesty-boundary rows.
 * Returns a deduped array (case-preserved as given, checked case-insensitively at assertion time).
 *
 * @param {Array<{ forbidden_wording?: string[] }>} claims
 * @param {{ tools?: { do_not_claim?: string[] } }} honesty
 * @param {Array<{ boundaryType?: string, text?: string, forbiddenWording?: string }>} [boundaryRows]
 * @returns {string[]}
 */
export function forbiddenWordingFor(claims, honesty, boundaryRows = []) {
  const seen = new Set();
  const result = [];

  const add = (phrase) => {
    const key = phrase.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(phrase);
    }
  };

  for (const claim of claims) {
    for (const phrase of claim.forbidden_wording || []) {
      add(phrase);
    }
  }

  for (const phrase of honesty?.tools?.do_not_claim || []) {
    add(phrase);
  }

  for (const row of boundaryRows || []) {
    const forbidden = String(row?.forbiddenWording ?? "").trim();
    if (forbidden) add(forbidden);

    const type = String(row?.boundaryType ?? "")
      .trim()
      .toLowerCase();
    if (RESTRICTIVE_BOUNDARY_TYPES.has(type)) {
      const derived = derivedForbiddenPhrase(row?.text);
      if (derived) add(derived);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// assertNoForbidden
// ---------------------------------------------------------------------------

/**
 * Throw if any forbidden phrase appears in text (case-insensitive).
 * Returns true if clean.
 *
 * @param {string} text
 * @param {string[]} forbidden
 * @returns {true}
 * @throws {Error}
 */
export function assertNoForbidden(text, forbidden) {
  const lowerText = text.toLowerCase();
  const hits = [];

  for (const phrase of forbidden) {
    if (lowerText.includes(phrase.toLowerCase())) {
      hits.push(phrase);
    }
  }

  if (hits.length > 0) {
    throw new Error(`Artifact contains forbidden wording: ${hits.map((h) => `"${h}"`).join(", ")}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// validateAtsSafe
// ---------------------------------------------------------------------------

/**
 * Check a markdown string for ATS-unsafe constructs.
 * Plain headings, bullets, and bold are allowed.
 *
 * @param {string} markdown
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function validateAtsSafe(markdown) {
  const issues = [];

  // Markdown tables (pipe-separated with separator row)
  if (/^\|[-| :]+\|/m.test(markdown)) {
    issues.push("markdown table detected (ATS-unsafe)");
  }

  // Images
  if (/!\[/.test(markdown)) {
    issues.push("markdown image detected (ATS-unsafe)");
  }

  // HTML tags
  if (/<\/?[a-zA-Z][^>]*>/.test(markdown)) {
    issues.push("HTML tag detected (ATS-unsafe)");
  }

  // Tab characters
  if (/\t/.test(markdown)) {
    issues.push("tab character detected (ATS-unsafe)");
  }

  // Box-drawing / multi-column glyphs (U+2500–U+257F and common box chars)
  if (/[─-╿│└┌┐┘]/.test(markdown)) {
    issues.push("box-drawing glyph detected (ATS-unsafe)");
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// buildResumeHeader
// ---------------------------------------------------------------------------

/**
 * Assemble the name/contact/links header block shared by both resume
 * builders (buildResumeMarkdown and buildStructuredResumeMarkdown).
 *
 * @param {{ candidate: { full_name: string, email?: string, phone?: string, location?: string, linkedin?: string, github?: string, portfolio?: string } }} profile
 * @returns {string}
 */
export function buildResumeHeader(profile) {
  const c = profile.candidate;
  const headerLines = [`# ${c.full_name}`];

  const contactParts = [];
  if (c.email) contactParts.push(c.email);
  if (c.phone) contactParts.push(c.phone);
  if (c.location) contactParts.push(c.location);
  if (contactParts.length > 0) {
    headerLines.push(contactParts.join(" | "));
  }

  const linkParts = [];
  if (c.linkedin) linkParts.push(`LinkedIn: ${c.linkedin}`);
  if (c.github) linkParts.push(`GitHub: ${c.github}`);
  if (c.portfolio) linkParts.push(`Portfolio: ${c.portfolio}`);
  if (linkParts.length > 0) {
    headerLines.push(linkParts.join(" | "));
  }

  return headerLines.join("\n");
}

// ---------------------------------------------------------------------------
// buildResumeMarkdown
// ---------------------------------------------------------------------------

/**
 * Assemble a complete tailored resume in ATS-safe markdown from REAL data only.
 * Never invents content — all bullets come verbatim from evidence bank claims.
 *
 * @param {{
 *   profile: { candidate: { full_name: string, email: string, phone?: string, location?: string, linkedin?: string, github?: string, portfolio?: string } },
 *   evidence: { claims: Array<object> },
 *   job: { signals?: string[], frontmatter?: object },
 *   honesty: { education?: { add_education_section?: boolean }, tools?: { do_not_claim?: string[] } },
 *   summary?: string
 * }} opts
 * @returns {string}
 */
export function buildResumeMarkdown({ profile, evidence, job, honesty, summary }) {
  const sections = [buildResumeHeader(profile)];

  // --- Summary (only if explicitly provided) ---
  if (summary && summary.trim().length > 0) {
    sections.push(`## Summary\n\n${summary.trim()}`);
  }

  // --- Experience / Highlights ---
  const signals = job?.signals || [];
  let selectedClaims = selectEvidenceForSignals(evidence, signals);
  if (selectedClaims.length === 0) {
    // Fall back to all claims
    selectedClaims = Array.isArray(evidence.claims) ? evidence.claims : [];
  }

  const bullets = selectedClaims.map((cl) => `- ${cl.claim}`).join("\n");
  const experienceHeading = signals.length > 0 ? "## Highlights" : "## Experience";
  sections.push(`${experienceHeading}\n\n${bullets}`);

  // --- Education (only if honesty.education.add_education_section === true) ---
  if (honesty?.education && honesty.education.add_education_section === true) {
    const degree = (honesty.education.highest_degree || "").trim();
    const educationBody = degree.length > 0 ? degree : "_See application for details._";
    sections.push(`## Education\n\n${educationBody}`);
  }

  const output = sections.join("\n\n");

  // --- Honesty validation ---
  const forbidden = forbiddenWordingFor(selectedClaims, honesty);
  assertNoForbidden(output, forbidden);

  // --- Placeholder lint gate ---
  const { clean, findings } = lintArtifact(output);
  if (!clean) {
    const detail = findings.map((f) => `line ${f.line}: ${f.text}`).join("; ");
    throw new Error(`buildResumeMarkdown produced unresolved placeholders: ${detail}`);
  }

  // --- ATS-safety gate ---
  // Pipe tables / HTML / box-drawing glyphs corrupt ATS text extraction, so
  // block them at build time before the artifact can ever reach an upload.
  const ats = validateAtsSafe(output);
  if (!ats.ok) {
    throw new Error(`buildResumeMarkdown produced ATS-unsafe output: ${ats.issues.join("; ")}`);
  }

  return output;
}

// ---------------------------------------------------------------------------
// buildStructuredResumeMarkdown
// ---------------------------------------------------------------------------

/**
 * Assemble a tailored resume from an AI-drafted proposal — a summary,
 * employer-grouped experience (roles nested under each employer, so a
 * promotion or multiple titles at one company render as one entry), optional
 * extra sections (e.g. Open Source, Projects), grouped skills, and education.
 * Assembly + validation only — every fact must already have been grounded in
 * the source résumé by the caller (see generate.mjs's validateResumeProposal);
 * this function never invents content, it only lays out what the proposal
 * provides.
 *
 * @param {{
 *   profile: { candidate: object },
 *   proposal: {
 *     summary?: string,
 *     experience: Array<{
 *       company: string, location?: string, dates?: string,
 *       roles: Array<{ title: string, dates?: string, bullets: string[] }>
 *     }>,
 *     sections?: Array<{ heading: string, bullets: string[] }>,
 *     skillGroups?: Array<{ label: string, items: string[] }>,
 *     education?: string[]
 *   },
 *   evidence: { claims: Array<object> },
 *   honesty: { education?: { add_education_section?: boolean }, tools?: { do_not_claim?: string[] } },
 *   boundaryRows?: Array<object>
 * }} opts
 * @returns {string}
 */
export function buildStructuredResumeMarkdown({
  profile,
  proposal,
  evidence,
  honesty,
  boundaryRows = [],
}) {
  const sections = [buildResumeHeader(profile)];

  // --- Summary (only if the proposal supplied one) ---
  if (proposal.summary && proposal.summary.trim().length > 0) {
    sections.push(`## Summary\n\n${proposal.summary.trim()}`);
  }

  // --- Experience, grouped by employer with roles nested underneath ---
  // Bold company lines and role headings are plain markdown, ATS-safe per
  // validateAtsSafe (no tables/images/HTML/tabs/box-drawing glyphs).
  const experienceBlocks = (proposal.experience || []).map((entry) => {
    let companyLine = `**${entry.company}**`;
    if (entry.location && entry.location.trim().length > 0) {
      companyLine += ` - ${entry.location.trim()}`;
    }
    if (entry.dates && entry.dates.trim().length > 0) {
      companyLine += ` | ${entry.dates.trim()}`;
    }
    const roleBlocks = (entry.roles || []).map((role) => {
      let titleLine = `### ${role.title}`;
      if (role.dates && role.dates.trim().length > 0) {
        titleLine += ` | ${role.dates.trim()}`;
      }
      const lines = [titleLine];
      for (const bullet of role.bullets || []) {
        lines.push(`- ${bullet}`);
      }
      return lines.join("\n");
    });
    return [companyLine, ...roleBlocks].join("\n\n");
  });
  sections.push(`## Experience\n\n${experienceBlocks.join("\n\n")}`);

  // --- Extra sections (e.g. Open Source, Projects) — never re-emit one of
  // the fixed headings this function already owns.
  const fixedHeadings = new Set(["summary", "experience", "skills", "education"]);
  for (const extra of proposal.sections || []) {
    if (fixedHeadings.has(String(extra.heading || "").toLowerCase())) continue;
    const bulletLines = (extra.bullets || []).map((bullet) => `- ${bullet}`).join("\n");
    sections.push(`## ${extra.heading}\n\n${bulletLines}`);
  }

  // --- Skills, one labeled group per line (ATS-safe: plain lines, no table/columns).
  // Blank-line separated: single newlines collapse into one paragraph when the
  // markdown is rendered to HTML/PDF.
  if (Array.isArray(proposal.skillGroups) && proposal.skillGroups.length > 0) {
    const skillLines = proposal.skillGroups
      .map((group) => `**${group.label}:** ${(group.items || []).join(", ")}`)
      .join("\n\n");
    sections.push(`## Skills\n\n${skillLines}`);
  }

  // --- Education (only if the proposal supplied entries and honesty allows it) ---
  if (
    Array.isArray(proposal.education) &&
    proposal.education.length > 0 &&
    honesty?.education?.add_education_section !== false
  ) {
    sections.push(`## Education\n\n${proposal.education.map((entry) => `- ${entry}`).join("\n")}`);
  }

  const output = sections.join("\n\n");

  // --- Honesty validation ---
  // Use ALL claims (not a signals-filtered subset) since the AI already did
  // the selection — every claim's forbidden wording still applies. Confirmed
  // honesty-boundary rows (Library) enforce alongside evidence/honesty YAML.
  const forbidden = forbiddenWordingFor(evidence.claims || [], honesty, boundaryRows);
  assertNoForbidden(output, forbidden);

  // --- Placeholder lint gate ---
  const { clean, findings } = lintArtifact(output);
  if (!clean) {
    const detail = findings.map((f) => `line ${f.line}: ${f.text}`).join("; ");
    throw new Error(`buildStructuredResumeMarkdown produced unresolved placeholders: ${detail}`);
  }

  // --- ATS-safety gate ---
  const ats = validateAtsSafe(output);
  if (!ats.ok) {
    throw new Error(
      `buildStructuredResumeMarkdown produced ATS-unsafe output: ${ats.issues.join("; ")}`
    );
  }

  return output;
}

// ---------------------------------------------------------------------------
// buildCoverLetterScaffold
// ---------------------------------------------------------------------------

/**
 * Assemble a complete cover letter from caller-supplied prose blocks.
 * The agent writes the paragraph prose; this function assembles + validates.
 * Throws if blocks is empty — the caller must supply paragraphs.
 *
 * @param {{
 *   profile: { candidate: { full_name: string } },
 *   job: { frontmatter?: { company?: string, role?: string } },
 *   evidence: { claims: Array<object> },
 *   blocks: string[] | object,
 *   boundaryRows?: Array<object>
 * }} opts
 * @returns {string}
 */
export function buildCoverLetterScaffold({ profile, job, evidence, blocks, boundaryRows = [] }) {
  // Normalise blocks to an array of non-empty strings
  const paragraphs = (Array.isArray(blocks) ? blocks : Object.values(blocks || {}))
    .map((b) => (b || "").trim())
    .filter((b) => b.length > 0);

  if (paragraphs.length === 0) {
    throw new Error(
      "buildCoverLetterScaffold requires at least one prose block. " +
        "The agent must supply the paragraph text; the core assembles and validates."
    );
  }

  const name = profile.candidate.full_name;
  const company = job?.frontmatter?.company || "";
  const role = job?.frontmatter?.role || "";

  // Greeting
  const greeting = company ? `Dear ${company} Hiring Team,` : "Dear Hiring Team,";

  // Subject line (informational, not an email header)
  const subjectParts = ["Re: Application"];
  if (role) subjectParts.push(role);
  if (company) subjectParts.push(`at ${company}`);
  const subject = subjectParts.join(" — ");

  // Sign-off
  const signOff = `Sincerely,\n${name}`;

  const letterParts = [subject, greeting, ...paragraphs, signOff];
  const output = letterParts.join("\n\n");

  // --- Placeholder lint gate ---
  const { clean, findings } = lintArtifact(output);
  if (!clean) {
    const detail = findings.map((f) => `line ${f.line}: ${f.text}`).join("; ");
    throw new Error(`buildCoverLetterScaffold produced unresolved placeholders: ${detail}`);
  }

  // --- Forbidden wording check ---
  const allClaims = Array.isArray(evidence.claims) ? evidence.claims : [];
  const forbidden = forbiddenWordingFor(allClaims, {}, boundaryRows);
  assertNoForbidden(output, forbidden);

  // --- ATS-safety gate ---
  const ats = validateAtsSafe(output);
  if (!ats.ok) {
    throw new Error(
      `buildCoverLetterScaffold produced ATS-unsafe output: ${ats.issues.join("; ")}`
    );
  }

  return output;
}

// ---------------------------------------------------------------------------
// buildShortAnswer
// ---------------------------------------------------------------------------

/**
 * Validate a caller-supplied answer (the agent writes the prose) and return it trimmed.
 * Throws with a clear message if: empty, contains placeholders, or contains forbidden wording.
 *
 * @param {{
 *   question: string,
 *   answer: string,
 *   honesty?: object,
 *   forbidden?: string[]
 * }} opts
 * @returns {string}
 */
export function buildShortAnswer({ question, answer, honesty, forbidden = [] }) {
  const trimmed = (answer || "").trim();

  if (trimmed.length === 0) {
    throw new Error(
      `buildShortAnswer: answer is empty for question "${question}". ` +
        "The agent must supply the answer text."
    );
  }

  // Placeholder check
  const { clean, findings } = lintArtifact(trimmed);
  if (!clean) {
    const detail = findings.map((f) => `line ${f.line}: ${f.text}`).join("; ");
    throw new Error(
      `buildShortAnswer: answer contains unresolved placeholders for question "${question}": ${detail}`
    );
  }

  // Forbidden wording check
  const allForbidden = [...(forbidden || []), ...forbiddenWordingFor([], honesty || {})];
  assertNoForbidden(trimmed, allForbidden);

  return trimmed;
}
