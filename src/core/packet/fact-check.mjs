// Deterministic fact check for generated artifacts (CR103).
//
// A rewrite may reorder and rephrase, but it may not add a number, tool,
// employer or name the candidate's own material never mentions. This runs in
// code, after the model, against the source résumé + profile + evidence claims
// + confirmed stories. It is the one check every artifact kind shares:
// résumé bullets, cover letters, screening answers and outreach drafts.
//
// What counts as a fact:
//   - a number (digits, with %, $, k/m/b and "million" style suffixes folded
//     to one canonical value, so "2M" and "2,000,000" match each other)
//   - a name-like token: capitalised mid-sentence ("Kubernetes", "Northwind"),
//     all-caps ("AWS"), camelCase ("GitHub"), or carrying . + # inside
//     ("Node.js", "C++")
//
// Known gaps: sentence-initial plain words are not treated as names (they are
// indistinguishable from ordinary capitalised prose), and spelled-out numbers
// ("three teams") are not extracted.

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// Capitalised words that are letter furniture, not claims about the candidate.
const FURNITURE = [
  "i",
  "a",
  "dear",
  "hello",
  "hi",
  "hiring",
  "manager",
  "team",
  "recruiter",
  "sincerely",
  "regards",
  "best",
  "thanks",
  "thank",
  "cheers",
  "respectfully",
  "needs",
  "you",
  "present",
  "current",
  "mr",
  "mrs",
  "ms",
  "dr",
  "re",
  "ps",
];

const IGNORED = new Set([...MONTHS, ...FURNITURE]);

const MULTIPLIERS = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

const NUMBER_RE =
  /(?<![\w.])(\d[\d,]*(?:\.\d+)?)(?:\s?(k|thousand|million|mm|m|billion|bn|b)\b)?/gi;
const WORD_RE = /[A-Za-z][A-Za-z0-9]*(?:[.+#'’-][A-Za-z0-9]+)*[+#]*/g;

function canonicalNumber(raw, suffix) {
  const base = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const mult = suffix ? MULTIPLIERS[suffix.toLowerCase()] || 1 : 1;
  return String(Number((base * mult).toPrecision(12)));
}

function numbersIn(text) {
  const out = new Set();
  for (const match of String(text || "").matchAll(NUMBER_RE)) {
    const value = canonicalNumber(match[1], match[2]);
    if (value !== null) out.add(value);
    // "2M" in a source also vouches for a bare "2" and vice versa is NOT true,
    // so only the folded value is recorded. A suffix-less base is recorded too
    // so "40 percent" in the source backs "40%" in the draft.
    const bare = canonicalNumber(match[1], null);
    if (bare !== null) out.add(bare);
  }
  return out;
}

// Reduce a token to the forms a source might legitimately spell it in:
// strip possessive, trailing period, and a plural s on acronyms.
function tokenForms(token) {
  const t = token.replace(/['’]s$/i, "").replace(/\.+$/, "");
  const forms = new Set([t.toLowerCase()]);
  if (/^[A-Z0-9]{2,}s$/.test(t)) forms.add(t.slice(0, -1).toLowerCase());
  if (/-/.test(t)) for (const part of t.split("-")) forms.add(part.toLowerCase());
  return { t, forms: [...forms] };
}

function sourceTokenSet(text) {
  const set = new Set();
  for (const match of String(text || "").matchAll(WORD_RE)) {
    const { forms } = tokenForms(match[0]);
    for (const form of forms) set.add(form);
    for (const part of match[0].split(/[-'’]/)) if (part) set.add(part.toLowerCase());
    // "Node.js" also vouches for "Node".
    for (const part of match[0].split(".")) if (part) set.add(part.toLowerCase());
  }
  return set;
}

function isSentenceStart(text, index) {
  let i = index - 1;
  while (i >= 0 && /[\s"“([*_>•\-–—]/.test(text[i])) {
    if (text[i] === "\n") return true;
    i -= 1;
  }
  if (i < 0) return true;
  return /[.!?:]/.test(text[i]);
}

function looksLikeName(token, sentenceStart) {
  const bare = token.replace(/['’]s$/i, "");
  if (/^[A-Z][A-Z0-9]+s?$/.test(bare) && bare.length >= 2) return true; // AWS, SQL, APIs
  if (/[a-z][A-Z]/.test(bare)) return true; // GitHub, iOS
  if (/[A-Za-z][.+#][A-Za-z0-9+#]*|[+#]$/.test(bare) && /^[A-Z]/.test(bare)) return true; // Node.js, C++
  if (/^[A-Z][a-z]/.test(bare)) return !sentenceStart;
  return false;
}

export function extractFacts(text) {
  const body = String(text || "");
  const numbers = new Map();
  for (const match of body.matchAll(NUMBER_RE)) {
    const value = canonicalNumber(match[1], match[2]);
    if (value !== null && !numbers.has(value)) numbers.set(value, match[0].trim());
  }
  const names = new Map();
  for (const match of body.matchAll(WORD_RE)) {
    const token = match[0];
    const start = isSentenceStart(body, match.index);
    if (!looksLikeName(token, start)) continue;
    const { t, forms } = tokenForms(token);
    if (forms.every((form) => IGNORED.has(form))) continue;
    if (!names.has(t)) names.set(t, forms);
  }
  return { numbers, names };
}

function flattenStrings(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) flattenStrings(item, out);
  else if (typeof value === "object")
    for (const item of Object.values(value)) flattenStrings(item, out);
  return out;
}

// The text a draft may legitimately draw its facts from. The job description is
// deliberately NOT here: a JD naming Kubernetes does not make the candidate a
// Kubernetes user. The target company and role are allowed, because a letter
// has to name them.
function factSourceText(context = {}) {
  const profile = context.profile || context.candidate || {};
  const { compensation: _comp, ...profileRest } = profile;
  const parts = [
    context.sourceResume?.text,
    ...flattenStrings(profileRest),
    ...(Array.isArray(context.evidence?.claims) ? flattenStrings(context.evidence.claims) : []),
    ...flattenStrings(context.storiesLearnings),
    ...flattenStrings(context.honesty?.tools?.confirmed),
    ...flattenStrings(context.factSources),
  ];
  return parts.filter(Boolean).join("\n");
}

function allowedText(context = {}, extraAllow = []) {
  return [
    context.app?.company,
    context.app?.role,
    context.job?.frontmatter?.company,
    context.job?.frontmatter?.role,
    ...flattenStrings(extraAllow),
  ]
    .filter(Boolean)
    .join("\n");
}

// Check one or more texts. Returns { ok, violations: [{ kind, value, message }] }.
// `texts` may be a string or an array; NEEDS YOU markers are skipped because
// they are an honest gap, not a claim.
export function checkArtifactFacts({ texts, context = {}, extraAllow = [], label = "" } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((text) => String(text || ""))
    .filter((text) => text.trim() && !/^\s*NEEDS YOU\b/.test(text));
  const sourceText = factSourceText(context);
  const knownNumbers = numbersIn(`${sourceText}\n${allowedText(context, extraAllow)}`);
  const knownTokens = sourceTokenSet(`${sourceText}\n${allowedText(context, extraAllow)}`);
  const violations = [];
  const seen = new Set();
  const prefix = label ? `${label}: ` : "";
  for (const text of list) {
    const { numbers, names } = extractFacts(text);
    for (const [value, shown] of numbers) {
      const key = `n:${value}`;
      if (knownNumbers.has(value) || seen.has(key)) continue;
      seen.add(key);
      violations.push({
        kind: "number",
        value: shown,
        message: `${prefix}number "${shown}" is not in your résumé or evidence`,
      });
    }
    for (const [token, forms] of names) {
      const key = `s:${token.toLowerCase()}`;
      if (seen.has(key) || forms.some((form) => knownTokens.has(form))) continue;
      seen.add(key);
      violations.push({
        kind: "name",
        value: token,
        message: `${prefix}"${token}" (name, tool or employer) is not in your résumé or evidence`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

export function factViolationMessages(result) {
  return (result?.violations || []).map((violation) => violation.message);
}
