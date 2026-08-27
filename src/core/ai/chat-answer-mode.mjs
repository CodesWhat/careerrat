const YES_NO_FENCE = /(?:^|\r?\n)```careerrat:answer[ \t]*\r?\n([^\r\n]+)\r?\n```[ \t]*$/;
const BINARY_QUESTION_START =
  /^(?:do|does|did|is|are|was|were|can|could|will|would|should|have|has|had|may|might|must)\b/i;
const OPEN_QUESTION_WORD = /\b(?:what|which|who|whom|whose|where|when|why|how)\b/i;
const CHOICE_QUESTION =
  /^(?:would you rather|do you (?:prefer|want)\b.*\bor\b|should (?:i|we|you)\b.*\bor\b)/i;
const COMPOUND_BINARY_CLAUSE =
  /\b(?:and|or)\s+(?:do|does|did|is|are|was|were|can|could|will|would|should|have|has|had|may|might|must)\b/i;

export const CHAT_ANSWER_MODE_GUIDANCE =
  "When your response ends with exactly one genuine binary question that is genuinely answerable with Yes or No, append this exact fenced UI marker after the question:\n" +
  "```careerrat:answer\n" +
  '{"mode":"yes-no"}\n' +
  "```\n" +
  "Use it only for a real question awaiting the user's answer. Never use it for open-ended, " +
  "multiple-choice, rhetorical, or multi-part questions, and never use it for a confirm/save " +
  "action that already has its own controls. Do not mention or explain the marker in prose.";

export function stripChatConfirmationBlocks(value) {
  return String(value || "")
    .replace(/```(?:careerrat:confirm|confirm)[ \t]*\r?\n[\s\S]*?\r?\n```/gi, "")
    .replace(/\n(?:\s*\n)+/g, "\n")
    .trim();
}

export function isPlainYesNoQuestion(value) {
  const source = stripChatConfirmationBlocks(value);
  if (!source.endsWith("?") || (source.match(/\?/g) || []).length !== 1) return false;
  const question =
    source.match(
      /(?:^|[.!:]\s+|\r?\n+|,\s+)((?:do|does|did|is|are|was|were|can|could|will|would|should|have|has|had|may|might|must)\b[^.!?]*\?)$/i
    )?.[1] || source;
  const normalized = question.trim();
  return (
    BINARY_QUESTION_START.test(normalized) &&
    !OPEN_QUESTION_WORD.test(normalized) &&
    !CHOICE_QUESTION.test(normalized) &&
    !COMPOUND_BINARY_CLAUSE.test(normalized)
  );
}

export function parseChatAnswerMode(value) {
  const source = String(value || "");
  const match = YES_NO_FENCE.exec(source);
  if (!match) {
    return {
      text: source.trim(),
      answerMode: isPlainYesNoQuestion(source) ? "yes-no" : null,
    };
  }

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return { text: source.trim(), answerMode: null };
  }
  if (
    !payload ||
    Array.isArray(payload) ||
    payload.mode !== "yes-no" ||
    Object.keys(payload).length !== 1
  ) {
    return { text: source.trim(), answerMode: null };
  }
  const text = source.slice(0, match.index).trim();
  return { text, answerMode: isPlainYesNoQuestion(text) ? "yes-no" : null };
}
