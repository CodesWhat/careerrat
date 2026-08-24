// Resume parser for CareerRat — ingests plain-text or markdown resumes into
// structured data that seeds a candidate's profile and evidence bank.
// CRITICAL: never invent facts. Only extract what is literally present in the text.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPERIENCE_KEYWORDS = new Set([
  "experience",
  "employment",
  "work history",
  "professional experience",
]);
const EDUCATION_KEYWORDS = new Set(["education"]);
const SKILLS_KEYWORDS = new Set(["skills", "technologies", "technical skills"]);
const PROJECTS_KEYWORDS = new Set(["projects", "selected projects"]);
const SUMMARY_KEYWORDS = new Set(["summary", "profile", "about", "objective"]);

const ACCOMPLISHMENT_VERBS = new Set([
  "built",
  "led",
  "shipped",
  "owned",
  "created",
  "designed",
  "implemented",
  "launched",
  "automated",
  "integrated",
  "reduced",
  "improved",
  "increased",
  "cut",
  "scaled",
  "drove",
  "delivered",
  "mentored",
]);

// Matches http(s) URLs.
const URL_RE = /https?:\/\/[^\s,<>"')]+/g;

// Matches scheme-less contact links for KNOWN hosts only (linkedin.com,
// github.com), optionally www.-prefixed, e.g. "linkedin.com/in/name" or
// "www.github.com/name". Requires a following "/path" so a bare mention of
// the host with nothing after it doesn't match. Deliberately not a general
// bare-domain matcher — that would false-positive on skill tokens like
// "node.js" or "socket.io". The leading \b also keeps "mygithub.com" from
// matching, since there's no word boundary between "my" and "github".
const BARE_CONTACT_URL_RE = /\b(?:www\.)?(?:linkedin|github)\.com\/[^\s,<>"')]+/gi;

// Matches a first RFC-ish email.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Matches a plausible phone number in various formats.
const PHONE_RE = /(?:\+?1[\s\-.]?)?(?:\(\d{3}\)|\d{3})[\s\-.]?\d{3}[\s\-.]?\d{4}/;

// ---------------------------------------------------------------------------
// Heading classification
// ---------------------------------------------------------------------------

function classifyHeading(line) {
  // Strip leading markdown # characters.
  const text = line.replace(/^#+\s*/, "").trim();
  const lower = text.toLowerCase();

  if (SUMMARY_KEYWORDS.has(lower)) return "summary";
  if (EXPERIENCE_KEYWORDS.has(lower)) return "experience";
  if (EDUCATION_KEYWORDS.has(lower)) return "education";
  if (SKILLS_KEYWORDS.has(lower)) return "skills";
  if (PROJECTS_KEYWORDS.has(lower)) return "projects";
  return "other";
}

function isHeading(line) {
  const trimmed = line.trim();

  // Top-level markdown headings (# or ##) are always section boundaries.
  if (/^#{1,2}\s+\S/.test(trimmed)) return true;

  // H3+ headings: only treat as a section boundary if they match a known keyword.
  if (/^#{3,}\s+\S/.test(trimmed)) {
    const lower = trimmed.replace(/^#+\s*/, "").toLowerCase();
    return (
      SUMMARY_KEYWORDS.has(lower) ||
      EXPERIENCE_KEYWORDS.has(lower) ||
      EDUCATION_KEYWORDS.has(lower) ||
      SKILLS_KEYWORDS.has(lower) ||
      PROJECTS_KEYWORDS.has(lower)
    );
  }

  // Short ALL-CAPS line (2–40 chars, only uppercase letters, spaces, punctuation).
  if (/^[A-Z][A-Z\s/&-]{1,39}$/.test(trimmed) && trimmed.length >= 2) {
    // Must be entirely uppercase letters (ignoring non-alpha), not just short mixed word.
    const letters = trimmed.replace(/[^A-Za-z]/g, "");
    if (letters.length > 0 && letters === letters.toUpperCase()) return true;
  }

  // Known keyword line (any case, no leading #).
  const lower = trimmed.toLowerCase();
  if (
    SUMMARY_KEYWORDS.has(lower) ||
    EXPERIENCE_KEYWORDS.has(lower) ||
    EDUCATION_KEYWORDS.has(lower) ||
    SKILLS_KEYWORDS.has(lower) ||
    PROJECTS_KEYWORDS.has(lower)
  )
    return true;

  return false;
}

// ---------------------------------------------------------------------------
// Contact extraction helpers
// ---------------------------------------------------------------------------

function extractEmail(text) {
  const m = text.match(EMAIL_RE);
  return m ? m[0] : null;
}

function extractPhone(text) {
  const m = text.match(PHONE_RE);
  return m ? m[0] : null;
}

function extractUrls(text) {
  const matches = text.match(URL_RE) || [];
  // Scheme-less contact links (linkedin.com/..., github.com/...) get an
  // https:// prefix so they normalize into the same shape as full URLs
  // before hostnameMatches/extractLinkedin/extractGithub see them.
  const bare = text.match(BARE_CONTACT_URL_RE) || [];
  const normalizedBare = bare.map((u) => `https://${u}`);
  // Dedupe while preserving first-seen order. A bare match that's actually
  // part of an already-captured https:// URL normalizes to an identical
  // string, so it collapses here instead of producing a duplicate.
  return [...new Set([...matches, ...normalizedBare])];
}

function hostnameMatches(url, domain) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === domain || h.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function extractLinkedin(urls) {
  return urls.find((u) => hostnameMatches(u, "linkedin.com")) || null;
}

function extractGithub(urls) {
  return urls.find((u) => hostnameMatches(u, "github.com")) || null;
}

function extractPortfolio(urls) {
  return (
    urls.find((u) => !hostnameMatches(u, "linkedin.com") && !hostnameMatches(u, "github.com")) ||
    null
  );
}

// Heuristic: the first non-empty line that is not a heading, has no @, no URL,
// and is not digits-heavy (i.e. not a phone/contact line).
function extractFullName(lines) {
  for (const line of lines) {
    const trimmed = line.trim().replace(/^#+\s*/, "");
    if (!trimmed) continue;
    // Skip only known-section headings (Experience, Skills, ...). A title-style
    // heading like "# Alex Rivera" is usually the candidate's name, so keep it.
    if (isHeading(line) && classifyHeading(line) !== "other") continue;
    if (trimmed.includes("@")) continue;
    // A contact line with only bare links ("linkedin.com/in/x") must skip
    // here the same way a full-URL line does, or it falls through to the
    // name check below and gets misclassified.
    if (URL_RE.test(trimmed) || BARE_CONTACT_URL_RE.test(trimmed)) {
      URL_RE.lastIndex = 0;
      BARE_CONTACT_URL_RE.lastIndex = 0;
      continue;
    }
    URL_RE.lastIndex = 0;
    BARE_CONTACT_URL_RE.lastIndex = 0;
    // Count digit clusters — a phone/contact line will have many.
    const digitMatches = trimmed.match(/\d+/g) || [];
    const totalDigits = digitMatches.reduce((s, m) => s + m.length, 0);
    if (totalDigits > 4) continue;
    // Must look like a name: at least two words of only letters, hyphens, apostrophes.
    if (!/^[A-Za-z][A-Za-z'-]+(?: [A-Za-z][A-Za-z'-]+)+$/.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

// Heuristic: find a "City, ST" or "City, Country" fragment near the top.
// We check only the first 15 lines.
function extractLocation(lines) {
  const top = lines.slice(0, 15);
  for (const line of top) {
    const trimmed = line.trim();
    // Look for patterns like "City, ST" or "City, Country" optionally surrounded by other text.
    const m = trimmed.match(
      /\b([A-Z][a-zA-Z\s]+),\s*([A-Z]{2}|[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/
    );
    if (m) {
      // Reject if it looks like an org name embedded in a URL.
      if (trimmed.includes("://")) continue;
      return `${m[1].trim()}, ${m[2].trim()}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

// Split text blocks on blank lines; trim and drop empties.
function splitBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n").trim());
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const b = current.join("\n").trim();
    if (b) blocks.push(b);
  }
  return blocks.filter(Boolean);
}

const EMPLOYMENT_DATE_RANGE_RE =
  /\b(?:19|20)\d{2}\s*(?:[-–—]|to)\s*(?:(?:19|20)\d{2}|present|current|now)\b/i;

function stripMarkdownHeading(line) {
  return String(line || "")
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

function looksLikeRoleHeader(line, nextLine = "") {
  const raw = String(line || "").trim();
  const text = stripMarkdownHeading(raw);
  if (!text || isBulletLine(raw) || text.length > 180) return false;

  // H3+ headings inside Experience are role headings, not top-level sections.
  if (/^#{3,6}\s+\S/.test(raw)) return true;

  const pipeParts = text.split("|").map((part) => part.trim());
  if (pipeParts.length >= 2) {
    const first = pipeParts[0];
    const rest = pipeParts.slice(1).join(" | ");
    // `New York, NY / Hybrid | 2022 - Present` is logistics, while
    // `Staff Platform Engineer | Juniper Relay` is an employment header.
    if (!(EMPLOYMENT_DATE_RANGE_RE.test(rest) && /,|\//.test(first))) return true;
  }

  if (/\s(?:—|–)\s/.test(text) || /\s+at\s+/i.test(text)) return true;

  // Plain title/company headings are often followed by a separate date or
  // location/date line. This also catches layouts that omit visual separators.
  return Boolean(nextLine && EMPLOYMENT_DATE_RANGE_RE.test(String(nextLine)));
}

// Blank lines in text extracted from PDFs frequently separate every bullet.
// Experience records are employment blocks, so once role headers are present,
// group by those headers instead of treating visual paragraph spacing as jobs.
function splitExperienceBlocks(lines) {
  const nextNonEmpty = lines.map((_line, index) => {
    for (let i = index + 1; i < lines.length; i++) {
      if (String(lines[i]).trim()) return lines[i];
    }
    return "";
  });
  const hasRoleHeaders = lines.some((line, index) =>
    looksLikeRoleHeader(line, nextNonEmpty[index])
  );
  if (!hasRoleHeaders) return splitBlocks(lines);

  const blocks = [];
  let current = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!String(line).trim()) continue;
    if (looksLikeRoleHeader(line, nextNonEmpty[index]) && current.length) {
      blocks.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n").trim());
  return blocks.filter(Boolean);
}

// Tokenize skills: split on commas, bullets, pipes, newlines; trim; dedupe.
function tokenizeSkills(lines) {
  const raw = lines.join("\n");
  const tokens = raw
    .split(/[,|•\n]|\s*[-*]\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set(tokens)];
}

// ---------------------------------------------------------------------------
// parseResume
// ---------------------------------------------------------------------------

export function parseResume(text) {
  const lines = text.split("\n");
  const allText = text;

  // Collect all URLs from the entire document.
  const links = extractUrls(allText);

  // Extract contact fields.
  const email = extractEmail(allText);
  const phone = extractPhone(allText);
  const linkedin = extractLinkedin(links);
  const github = extractGithub(links);
  const portfolio = extractPortfolio(links);
  const full_name = extractFullName(lines);
  const location = extractLocation(lines);

  // Parse sections by walking lines and detecting headings.
  const buckets = {
    summary: [],
    experience: [],
    education: [],
    skills: [],
    projects: [],
    other: [],
  };

  let currentBucket = null;
  let currentLines = [];

  function flushCurrent() {
    if (currentBucket === null || currentLines.length === 0) {
      currentLines = [];
      return;
    }
    buckets[currentBucket].push(...currentLines);
    currentLines = [];
  }

  for (const line of lines) {
    if (isHeading(line)) {
      flushCurrent();
      currentBucket = classifyHeading(line);
    } else {
      if (currentBucket !== null) {
        currentLines.push(line);
      }
    }
  }
  flushCurrent();

  // Build sections output.
  const sections = {
    experience: splitExperienceBlocks(buckets.experience),
    education: splitBlocks(buckets.education),
    skills: tokenizeSkills(buckets.skills),
    projects: splitBlocks(buckets.projects),
    other: splitBlocks(buckets.other),
  };

  const summary =
    buckets.summary.length > 0
      ? buckets.summary.join(" ").replace(/\s+/g, " ").trim() || null
      : null;

  return {
    contact: { full_name, email, phone, location, linkedin, github, portfolio },
    summary,
    sections,
    links,
    explicitTargetTitles: extractExplicitTargetTitles(lines),
  };
}

// ---------------------------------------------------------------------------
// deriveProfileSeed
// ---------------------------------------------------------------------------

export function deriveProfileSeed(parsed) {
  const src = parsed.contact;
  const candidate = {};
  for (const key of [
    "full_name",
    "email",
    "phone",
    "location",
    "linkedin",
    "github",
    "portfolio",
  ]) {
    if (src[key] !== null && src[key] !== undefined) {
      candidate[key] = src[key];
    }
  }
  return { candidate };
}

// ---------------------------------------------------------------------------
// deriveEvidenceSeed
// ---------------------------------------------------------------------------

// Strip leading bullet markers from a line.
function stripBullet(line) {
  return line.replace(/^[\s\-*•]+/, "").trim();
}

function isBulletLine(line) {
  return /^\s*[-*•]/.test(line);
}

// Resume text is usually hard-wrapped; a bullet's continuation lines are the
// non-bullet lines that follow it. Join them back so each claim is a whole
// accomplishment, not a mid-sentence fragment. Non-bullet lines that don't
// follow a bullet (headers, date ranges) stand alone.
function joinWrappedLines(lines) {
  const logical = [];
  let previousWasBullet = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      previousWasBullet = false;
      continue;
    }
    if (isBulletLine(raw) || !previousWasBullet || !logical.length) {
      logical.push(line);
      previousWasBullet = isBulletLine(raw);
    } else {
      logical[logical.length - 1] += ` ${line}`;
    }
  }
  return logical;
}

// A bare employment date range ("2021 - Present", "2018 – 2021") has digits
// but is not an accomplishment.
function isDateRange(line) {
  return /^\d{4}\s*(?:[-–—]|to)\s*(\d{4}|present|current|now)$/i.test(line);
}

function isEmploymentMetadata(line) {
  const text = stripMarkdownHeading(line);
  if (!text) return false;
  if (looksLikeRoleHeader(line)) return true;
  if (isDateRange(text)) return true;
  return EMPLOYMENT_DATE_RANGE_RE.test(text) && (/\||,|\//.test(text) || /^\d{4}/.test(text));
}

// Determine if a line qualifies as an accomplishment.
function isAccomplishment(line) {
  const stripped = stripBullet(line);
  if (!stripped) return false;
  if (isEmploymentMetadata(stripped)) return false;

  // Check for a strong past-tense accomplishment verb early in the line.
  // We look at the first few words (up to 4) to find the verb.
  const firstWords = stripped.toLowerCase().split(/\s+/).slice(0, 4);
  for (const word of firstWords) {
    // Strip any trailing punctuation for matching.
    const clean = word.replace(/[^a-z]/g, "");
    if (ACCOMPLISHMENT_VERBS.has(clean)) return true;
  }

  // Also qualifies if the line contains a number or percentage.
  if (/\d/.test(stripped)) return true;

  return false;
}

export function deriveEvidenceSeed(parsed) {
  const sources = [...parsed.sections.experience, ...parsed.sections.projects];

  const claims = [];
  let counter = 1;

  for (const block of sources) {
    const lines = joinWrappedLines(block.split("\n"));
    for (const line of lines) {
      if (!isAccomplishment(line)) continue;
      const claim = stripBullet(line);
      if (!claim) continue;
      const id = `resume-${String(counter).padStart(3, "0")}`;
      claims.push({
        id,
        claim,
        evidence: "Source: candidate resume (user-provided).",
      });
      counter++;
    }
  }

  return { claims };
}

// ---------------------------------------------------------------------------
// deriveTargetingSeed
// ---------------------------------------------------------------------------

const MAX_TARGETING_TITLES = 6;

// Separators that can join a job title to the rest of a header line (company,
// location, employment type, ...). Order here does not decide precedence —
// splitTitleFromHeader() picks whichever candidate occurs earliest in the
// line — this list just enumerates what counts as a separator at all.
const TITLE_SEPARATORS = [
  / — /, // em dash
  / – /, // en dash
  / - /, // spaced hyphen only (never a hyphenated word like "full-stack")
  / \| /,
  / @ /,
  / at /i, // word-bounded via the surrounding spaces
  /, /,
];

// Strip leading markdown heading markers (#, ##, ###), bold markers (**),
// bullet chars, and whitespace, repeatedly, so combinations like
// "- **Title**" reduce down to "Title**" (only leading markers are in
// scope — trailing bold asterisks, if any, are left for the plausibility
// check downstream).
function stripLeadingMarkers(line) {
  let s = line;
  let changed = true;
  while (changed) {
    changed = false;
    const noSpace = s.replace(/^\s+/, "");
    if (noSpace !== s) {
      s = noSpace;
      changed = true;
      continue;
    }
    const noHeading = s.replace(/^#{1,3}\s*/, "");
    if (noHeading !== s) {
      s = noHeading;
      changed = true;
      continue;
    }
    const noBold = s.replace(/^\*\*/, "");
    if (noBold !== s) {
      s = noBold;
      changed = true;
      continue;
    }
    const noBullet = s.replace(/^[-*•]\s*/, "");
    if (noBullet !== s) {
      s = noBullet;
      changed = true;
    }
  }
  return s;
}

// Split a cleaned header line on whichever known separator occurs earliest
// in the string, returning the left segment (the candidate title). Returns
// the whole line unchanged if no separator is present.
function splitTitleFromHeader(line) {
  let bestIndex = -1;
  for (const re of TITLE_SEPARATORS) {
    const m = line.match(re);
    if (m && (bestIndex === -1 || m.index < bestIndex)) {
      bestIndex = m.index;
    }
  }
  return bestIndex === -1 ? line : line.slice(0, bestIndex);
}

// Matches a bare 19xx/20xx year, the tell for a date-range fragment leaking
// into the candidate title (e.g. a header line with no separator at all).
const DATE_RANGE_RE = /\b(19|20)\d{2}\b/;

function isPlausibleTitle(candidate) {
  if (!candidate) return false;
  if (candidate.length > 60) return false;
  if (/\d/.test(candidate)) return false;
  if (candidate.includes("@")) return false;
  if (/http/i.test(candidate)) return false;
  if (DATE_RANGE_RE.test(candidate)) return false;
  return true;
}

const EXPLICIT_TARGET_ROLES_RE =
  /^(?:target|desired|preferred)\s+(?:roles?|titles?|positions?)\s*:\s*(.+)$/i;
const EXPLICIT_TARGET_ROLES_HEADING_RE =
  /^(?:target|desired|preferred)\s+(?:roles?|titles?|positions?)$/i;

function appendExplicitTargetTitles(output, seen, value) {
  for (const rawTitle of String(value || "")
    .replace(/[.;]+$/, "")
    .split(/\s*[;,|]\s*/)) {
    const title = rawTitle.trim();
    const key = title.toLowerCase();
    if (!isPlausibleTitle(title) || seen.has(key)) continue;
    seen.add(key);
    output.push(title);
    if (output.length >= MAX_TARGETING_TITLES) return true;
  }
  return false;
}

function extractExplicitTargetTitles(lines) {
  const titles = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const cleaned = stripBullet(stripMarkdownHeading(lines[index]));
    const inline = cleaned.match(EXPLICIT_TARGET_ROLES_RE);
    if (inline) {
      if (appendExplicitTargetTitles(titles, seen, inline[1])) return titles;
      continue;
    }
    if (!EXPLICIT_TARGET_ROLES_HEADING_RE.test(cleaned)) continue;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = String(lines[cursor] || "");
      if (!line.trim()) continue;
      if (isHeading(line)) break;
      if (!isBulletLine(line)) break;
      const value = stripBullet(line);
      if (/^[^:]{1,40}:\s*/.test(value)) break;
      if (appendExplicitTargetTitles(titles, seen, value)) return titles;
    }
  }

  return titles;
}

function explicitTargetTitles(parsed) {
  const titles = Array.isArray(parsed?.explicitTargetTitles)
    ? parsed.explicitTargetTitles.slice(0, MAX_TARGETING_TITLES)
    : [];
  const seen = new Set(titles.map((title) => title.toLowerCase()));
  if (titles.length >= MAX_TARGETING_TITLES) return titles;

  for (const block of [...(parsed?.sections?.other || []), parsed?.summary || ""]) {
    for (const line of String(block).split("\n")) {
      const match = stripBullet(line).match(EXPLICIT_TARGET_ROLES_RE);
      if (!match) continue;
      if (appendExplicitTargetTitles(titles, seen, match[1])) return titles;
    }
  }

  return titles;
}

// Derive a targeting-role seed from parsed experience blocks: each block's
// header line yields at most one plausible job title, generic separator/
// plausibility heuristics only (no hardcoded title/keyword lists — this repo
// stays domain-neutral). Returns null when no title survives so callers can
// skip sending an empty seed.
export function deriveTargetingSeed(parsed) {
  const statedTitles = explicitTargetTitles(parsed);
  if (statedTitles.length) {
    return {
      role_buckets: [{ name: "Primary", priority: "primary", titles: statedTitles }],
    };
  }

  const blocks = parsed?.sections?.experience || [];
  const titles = [];
  const seen = new Set();

  for (const block of blocks) {
    const lines = block.split("\n");
    const firstLine = lines.find((l) => l.trim() !== "");
    if (!firstLine) continue;

    const cleaned = stripLeadingMarkers(firstLine.trim());
    const candidate = splitTitleFromHeader(cleaned).trim();
    if (!isPlausibleTitle(candidate)) continue;

    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(candidate);
    if (titles.length >= MAX_TARGETING_TITLES) break;
  }

  if (!titles.length) return null;

  return {
    role_buckets: [{ name: "Primary", priority: "primary", titles }],
  };
}
