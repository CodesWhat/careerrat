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
// and 10 years" does not make "I have 10 years of Kubernetes" true. So inbound
// text is never a general allow-list. Only identity fields (company, role,
// contact, participants, sender) and spans the draft explicitly quotes back from
// an inbound message are allowed. Everything else the draft asserts has to come
// from the candidate's own résumé, profile, evidence and confirmed stories.
function inboundText(comm = {}) {
  const messages = Array.isArray(comm.messages) ? comm.messages : [];
  return messages
    .filter((message) => message?.direction === "inbound")
    .flatMap((message) => [message.summary, message.subject, message.body])
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function quotedInboundSpans(comm, texts) {
  const inbound = inboundText(comm);
  if (!inbound) return [];
  const spans = [];
  for (const text of texts) {
    for (const match of String(text || "").matchAll(/["“]([^"“”]{3,200})["”]/g)) {
      const span = match[1].trim();
      if (inbound.includes(span.toLowerCase().replace(/\s+/g, " "))) spans.push(span);
    }
  }
  return spans;
}

function threadAllow(comm = {}, texts = []) {
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
    ...quotedInboundSpans(comm, texts),
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
  const texts = [isThreadSubjectEcho(comm, subject) ? "" : subject, body];
  const result = checkArtifactFacts({
    texts,
    context: {
      ...factContext({ repoRoot, env }),
      app: { company: comm?.company, role: comm?.role },
    },
    extraAllow: [...threadAllow(comm, texts), ...extraAllow],
    label: "draft",
    scheduling: true,
  });
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
