import { dbExists } from "../db/connection.mjs";
import { candidateArtifactGet, candidateConfigGet } from "../db/verbs/candidate.mjs";
import { deepIngestConfirmedForGeneration } from "../db/verbs/deep-ingest.mjs";
import { checkArtifactFacts, factViolationMessages } from "../packet/fact-check.mjs";

// CR103: outreach and recruiter-reply drafts get the same deterministic fact check
// as résumé bullets, cover letters and screening answers. A draft that names a
// number, tool, employer or person absent from the candidate's résumé, evidence
// and confirmed stories is held, not stored or delivered as ready.

function factContext({ repoRoot, env }) {
  if (!dbExists({ repoRoot, env })) return {};
  const config = candidateConfigGet({ repoRoot, env });
  const sourceResume = candidateArtifactGet({
    repoRoot,
    env,
    id: "source-resume",
    kind: "source-resume",
  });
  const deepIngest = deepIngestConfirmedForGeneration({ repoRoot, env });
  return {
    profile: config.profile || {},
    evidence: config.evidence || { claims: [] },
    honesty: config.honesty || {},
    ...(sourceResume ? { sourceResume } : {}),
    storiesLearnings: deepIngest.storyBank || [],
  };
}

// A reply legitimately names the thread it answers, but the other side's words
// are not evidence about the candidate: a recruiter writing "requires Kubernetes
// and 10 years" does not make "I have 10 years of Kubernetes" true. Rules:
//   - Identity fields (company, role, contact, participants, sender) are always
//     allowed.
//   - A span the draft quotes back from an inbound message is exempt only inside
//     the quotation marks; the same terms outside the quotes are checked normally.
//   - Terms from the inbound text are allowed only in sentences that don't assert
//     the candidate's own experience or achievements ("I'd like to discuss
//     Kubernetes" passes; "I have 10 years of Kubernetes" does not). Claim
//     sentences must be backed by the résumé, profile, evidence and stories.
function inboundText(comm = {}) {
  const messages = Array.isArray(comm.messages) ? comm.messages : [];
  return messages
    .filter((message) => message?.direction === "inbound")
    .flatMap((message) => [message.summary, message.subject, message.body])
    .filter(Boolean)
    .join("\n");
}

function normalizeSpan(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Blank out quoted spans that appear verbatim in an inbound message.
function stripQuotedInbound(inbound, text) {
  const haystack = normalizeSpan(inbound);
  if (!haystack) return String(text || "");
  return String(text || "").replace(/["“]([^"“”]{3,200})["”]/g, (whole, span) =>
    haystack.includes(normalizeSpan(span)) ? " " : whole
  );
}

const CLAIM_VERBS =
  "led|built|used|worked|saved|grew|managed|shipped|delivered|launched|created|developed|designed|cut|reduced|increased|improved|scaled|ran|run|owned|drove|wrote|deployed|migrated|founded|mentored|finished|won|earned|achieved|spent|taught|architected|implemented|handled|oversaw|started";
const CLAIM_PATTERNS = [
  // "I led", "I also built", "I've shipped"
  new RegExp(
    `\\bI(?:['’]ve|\\s+have)?\\s+(?:(?:also|previously|recently|personally|have|had|been)\\s+)*(?:${CLAIM_VERBS})\\b`,
    "i"
  ),
  // "I have 10 years", "I've got experience with", "I had a background in"
  /\bI(?:['’]ve|\s+have|\s+had)\s+(?:\w+\s+){0,3}?(?:\d|years?\b|experience|expertise|background)/i,
  // "my 10 years of ...", "my experience", "my time at"
  /\bmy\s+(?:[\w+-]+\s+)?(?:years?|experience|background|career|time\s+at|work(?:\s+at)?)\b/i,
  // resume-style fragment: "Led a team of 12."
  new RegExp(`^\\s*(?:${CLAIM_VERBS})\\b`, "i"),
];

// Does this sentence assert something about the candidate's own history? A
// deliberately simple first-person + experience/achievement-wording heuristic.
export function isCandidateClaim(sentence) {
  return CLAIM_PATTERNS.some((pattern) => pattern.test(sentence));
}

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function threadAllow(comm = {}) {
  const inbound = (Array.isArray(comm.messages) ? comm.messages : []).filter(
    (message) => message?.direction === "inbound"
  );
  return [
    comm.company,
    comm.role,
    comm.contact,
    comm.recipient,
    comm.sender,
    comm.participants,
    ...inbound.map((message) => message.from),
  ].filter(Boolean);
}

// "Re: <thread subject>" just echoes the thread title, which is not a claim.
function isThreadSubjectEcho(comm, subject) {
  const title = String(comm?.subject || "")
    .trim()
    .toLowerCase();
  if (!title) return false;
  const stripped = String(subject || "")
    .replace(/^\s*(?:(?:re|fwd?)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
  return stripped === title;
}

export function checkDraftFacts({
  repoRoot,
  env = process.env,
  comm,
  subject,
  body,
  extraAllow = [],
}) {
  const inbound = inboundText(comm);
  const context = {
    ...factContext({ repoRoot, env }),
    app: { company: comm?.company, role: comm?.role },
  };
  const claimSentences = [];
  const otherSentences = [];
  for (const text of [isThreadSubjectEcho(comm, subject) ? "" : subject, body]) {
    for (const sentence of splitSentences(stripQuotedInbound(inbound, text))) {
      (isCandidateClaim(sentence) ? claimSentences : otherSentences).push(sentence);
    }
  }
  const baseAllow = [...threadAllow(comm), ...extraAllow];
  const run = (texts, allow) =>
    checkArtifactFacts({
      texts,
      context,
      extraAllow: allow,
      label: "draft",
      scheduling: true,
    });
  const claims = run(claimSentences, baseAllow);
  const others = run(otherSentences, [...baseAllow, inbound]);
  const seen = new Set();
  const violations = [...claims.violations, ...others.violations].filter((violation) => {
    const key = `${violation.kind}:${violation.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const result = { ok: violations.length === 0, violations };
  return { ...result, messages: factViolationMessages(result) };
}

// Check a thread's saved draft as it would go out (legacy rows can hold a bare
// string). Returns null when there is nothing to check.
export function checkStoredDraftFacts({ repoRoot, env = process.env, comm }) {
  const draft = typeof comm?.draft === "string" ? { body: comm.draft } : comm?.draft;
  if (!draft?.body) return null;
  return checkDraftFacts({ repoRoot, env, comm, subject: draft.subject, body: draft.body });
}

export const DRAFT_FACTS_CODE = "COMMUNICATION_DRAFT_FACTS";
