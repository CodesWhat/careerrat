// Read-only reviewer pass (CR106).
//
// A second model pass reads a finished draft next to the candidate's source
// material and proposes small exact-substring edits (tighter wording, a
// clearer claim, a weak opener). It has no tools: the call goes through
// runBoundedAI, a one-shot structured completion with no file, shell or
// network access, and REVIEWER_TOOLS pins that as data so a test can fail the
// day anyone adds one. The reviewer never writes. This module applies an edit
// only after the edit passes the CR103 fact check on its own, so a reviewer
// cannot sneak in a number, tool, employer or name the candidate never had.

import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { aiTellMessages, findAiTells } from "./ai-tells.mjs";
import { checkArtifactFacts, factViolationMessages } from "./fact-check.mjs";
import { buildPromptVisibleSources } from "./generate.mjs";
import { packetReviewProposalSchema } from "./schemas/packet-schemas.mjs";

export const REVIEWER_TOOLS = Object.freeze([]);

const REVIEW_LABELS = Object.freeze({
  skill: "packet-engine",
  action: "review-artifact",
  operation: "packet:review",
});

const REVIEW_SYSTEM =
  "You are a read-only reviewer of a job-application draft. Propose at most 20 small edits that make the draft clearer, tighter and more specific to the target role. Each edit is an exact substring of the draft to find, its replacement, and a one-sentence reason. Use ONLY facts already in the draft or in sourceResume.text, candidateProfile and confirmedEvidence.claims. Never add a number, tool, employer, name or claim that is not in those sources; an edit that does will be rejected by code. Never touch placeholders or NEEDS YOU markers. Return no edits when the draft is already good. If styleGoals is present, make it read like a person wrote it: fix each listed phrase with the plainer wording, by rewording only, never by adding a fact.";

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// Pure. Applies the edits that survive: the find must occur exactly once, the
// replacement must pass CR103 against the candidate's sources, and so must the
// whole edited text. Everything else comes back in `rejected` with the reason.
export function applyReviewEdits({ text, edits = [], context = {} } = {}) {
  let current = String(text || "");
  const accepted = [];
  const rejected = [];
  for (const edit of Array.isArray(edits) ? edits : []) {
    const find = String(edit?.find ?? "");
    const replace = String(edit?.replace ?? "");
    const reject = (reasons) => rejected.push({ edit, reasons });
    if (!find || find === replace) {
      reject(["edit changes nothing"]);
      continue;
    }
    if (/NEEDS YOU/.test(find) || /NEEDS YOU/.test(replace)) {
      reject(["edits may not touch NEEDS YOU markers"]);
      continue;
    }
    const occurrences = countOccurrences(current, find);
    if (occurrences !== 1) {
      reject([
        occurrences === 0 ? "text to replace was not found" : "text to replace is not unique",
      ]);
      continue;
    }
    // A style fix must not introduce a new tell of its own.
    if (findAiTells(replace).length > findAiTells(find).length) {
      reject(["edit adds AI-sounding phrasing"]);
      continue;
    }
    const facts = checkArtifactFacts({ texts: replace, context });
    if (!facts.ok) {
      reject(factViolationMessages(facts));
      continue;
    }
    const next = current.replace(find, () => replace);
    const whole = checkArtifactFacts({ texts: next, context, extraAllow: [text] });
    if (!whole.ok) {
      reject(factViolationMessages(whole));
      continue;
    }
    current = next;
    accepted.push(edit);
  }
  return { text: current, accepted, rejected };
}

export async function reviewArtifact({
  repoRoot,
  env = process.env,
  context = {},
  kind = "artifact",
  text,
  runAI = runBoundedAI,
  call,
  executionPlan,
  signal,
} = {}) {
  const draft = String(text || "");
  if (!draft.trim()) {
    return { ok: true, text: draft, accepted: [], rejected: [], ai: { used: false } };
  }
  const styleGoals = aiTellMessages(findAiTells(draft));
  const result = await runAI({
    labels: REVIEW_LABELS,
    schema: packetReviewProposalSchema,
    manual: {
      available: true,
      reason: "packet-review",
      action: "Review the draft manually.",
    },
    structuredMode: "native-preferred",
    call,
    messages: [
      {
        role: "user",
        content: [
          `Review this ${kind} draft against the sources.`,
          "",
          JSON.stringify(
            {
              sources: buildPromptVisibleSources(context, null, { purpose: "resume" }),
              draft,
              ...(styleGoals.length ? { styleGoals } : {}),
            },
            null,
            2
          ),
        ].join("\n"),
      },
    ],
    system: REVIEW_SYSTEM,
    outputName: "packet_review_edits",
    maxTokens: 3000,
    root: repoRoot,
    env,
    executionPlan,
    signal,
  });
  if (!result?.body?.ok) {
    // A failed review leaves the draft exactly as it was.
    return {
      ok: false,
      text: draft,
      accepted: [],
      rejected: [],
      ai: result?.body?.ai || { used: false },
      error: result?.body?.error?.message || result?.body?.code || "review unavailable",
    };
  }
  const applied = applyReviewEdits({
    text: draft,
    edits: result.body.data?.edits || [],
    context,
  });
  return { ok: true, ...applied, ai: result.body.ai };
}
