// The open "needs your answer" questions in a packet manifest's gap list: one
// entry per unanswered required application question. This is the flag the
// job thread and Today show. It never stops a run, it only keeps that one job
// from submitting until the operator answers.
//
// Kept dependency-free so both the DB verbs and the agent can import it.
export function openAnswerNeedsFromGaps(gaps) {
  const seen = new Set();
  const needs = [];
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    if (
      String(gap?.kind || "").toLowerCase() !== "answers" ||
      String(gap?.code || "").toUpperCase() !== "ANSWER_CONFIRMATION_REQUIRED"
    ) {
      continue;
    }
    const questionId = String(gap?.questionId || "").trim() || null;
    const message = String(gap?.message || "").trim();
    const quoted = message.match(/^Answer\s+[“"](.+?)[”"]\.?$/i);
    const question = quoted ? quoted[1] : message;
    const key = questionId || question.toLowerCase();
    if (!question || seen.has(key)) continue;
    seen.add(key);
    needs.push({ questionId, question });
  }
  return needs;
}
