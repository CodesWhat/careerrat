import { dbExists } from "../db/connection.mjs";
import {
  candidateArtifactGet,
  candidateConfigGet,
  deepIngestConfirmedForGeneration,
} from "../db/verbs.mjs";
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

// A reply legitimately echoes the thread it answers: the company, role, contact
// and whatever the other side wrote. Those are allowed; the candidate's own
// claims still have to come from their material.
function threadAllow(comm = {}) {
  const messages = Array.isArray(comm.messages) ? comm.messages : [];
  return [
    comm.company,
    comm.role,
    comm.contact,
    comm.recipient,
    comm.subject,
    comm.sender,
    comm.participants,
    ...messages
      .filter((message) => message?.direction === "inbound")
      .flatMap((message) => [message.summary, message.subject, message.body, message.from]),
  ].filter(Boolean);
}

export function checkDraftFacts({ repoRoot, env = process.env, comm, subject, body }) {
  const result = checkArtifactFacts({
    texts: [subject, body],
    context: {
      ...factContext({ repoRoot, env }),
      app: { company: comm?.company, role: comm?.role },
    },
    extraAllow: threadAllow(comm),
    label: "draft",
  });
  return { ...result, messages: factViolationMessages(result) };
}
