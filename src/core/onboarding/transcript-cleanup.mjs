const PROMPT_FILLER_WORDS = new Set([
  "a",
  "an",
  "are",
  "can",
  "could",
  "do",
  "does",
  "have",
  "has",
  "if",
  "is",
  "it",
  "me",
  "my",
  "one",
  "please",
  "s",
  "share",
  "tell",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "would",
  "you",
  "your",
]);
const PROMPT_NEGATION_WORDS = new Set(["avoid", "exclude", "never", "no", "not", "without"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedPromptText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
}

function trailingPromptQuestion(value) {
  const text = String(value || "")
    .replaceAll(/```[\s\S]*?```/g, " ")
    .trim();
  const questionEnd = text.lastIndexOf("?");
  if (questionEnd < 0) return text;
  const throughQuestion = text.slice(0, questionEnd + 1);
  const previousSentenceEnd = Math.max(
    throughQuestion.lastIndexOf(".", questionEnd - 1),
    throughQuestion.lastIndexOf("!", questionEnd - 1),
    throughQuestion.lastIndexOf("?", questionEnd - 1),
    throughQuestion.lastIndexOf("\n", questionEnd - 1)
  );
  return throughQuestion.slice(previousSentenceEnd + 1).trim();
}

function promptTerms(value) {
  return new Set(
    normalizedPromptText(value)
      .split(" ")
      .filter((word) => word && !PROMPT_FILLER_WORDS.has(word))
      .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
  );
}

function promptHasNegation(value) {
  return normalizedPromptText(value)
    .split(" ")
    .some((word) => PROMPT_NEGATION_WORDS.has(word));
}

function onboardingPromptsAreNearDuplicates(left, right) {
  const leftText = normalizedPromptText(trailingPromptQuestion(left?.text));
  const rightText = normalizedPromptText(trailingPromptQuestion(right?.text));
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  if (promptHasNegation(leftText) !== promptHasNegation(rightText)) return false;
  const leftTerms = promptTerms(leftText);
  const rightTerms = promptTerms(rightText);
  if (!leftTerms.size || !rightTerms.size) return false;
  const sharedCount = [...leftTerms].filter((word) => rightTerms.has(word)).length;
  return sharedCount / Math.max(leftTerms.size, rightTerms.size) >= 0.6;
}

export function onboardingMessageIsInternal(message) {
  return (
    message?.visibility === "internal" ||
    /^\s*\[system\](?:\s|$)/i.test(String(message?.text || ""))
  );
}

function onboardingAssistantPromptsUser(message) {
  if (
    message?.metadata?.choicePrompt?.mode === "binary" &&
    message.metadata.choicePrompt.state === "pending"
  )
    return true;
  if (message?.answerMode === "yes-no" || message?.metadata?.answerMode === "yes-no") return true;
  const text = String(message?.text || "").trim();
  if (/\?\s*$/.test(text)) return true;
  const questionAt = text.lastIndexOf("?");
  if (questionAt < 0) return false;
  const trailingInstruction = text.slice(questionAt + 1).trim();
  return (
    trailingInstruction.length <= 360 &&
    (/^(?:for example|for instance|examples?\b|e\.g\.|such as)\b/i.test(trailingInstruction) ||
      /^i(?:['’]ll| will)\s+skip\b/i.test(trailingInstruction) ||
      (trailingInstruction.length <= 200 &&
        /^(?:(?:this|that|it)(?:['’]s|\s+(?:is|was|will|won['’]t|does|can|should|must)(?:n['’]t)?)|the\s+(?:answer|amount|number|value)\s+(?:is|was|will|won['’]t|does|can|should|must)(?:n['’]t)?)\b/i.test(
          trailingInstruction
        )) ||
      /\b(?:answer|choose|include|paste|pick|reply|select|send|share|say|tell|type|use)\b/i.test(
        trailingInstruction
      ))
  );
}

function onboardingAssistantHasUnresolvedAction(message) {
  return list(message?.blocks).some(
    (block) => block?.hidden !== true && block?.status !== "resolved"
  );
}

function onboardingMessageAnswersPrompt(message) {
  if (message?.role !== "user") return false;
  const text = String(message?.text || "").trim();
  if (!text) return false;
  if (/^dropped resume\s*:/i.test(text)) return false;
  if (/^\[system\](?:\s|$)/i.test(text)) return false;
  return message?.metadata?.answersPrompt !== false;
}

function onboardingAssistantWaitsForUser(message) {
  return (
    message?.role === "assistant" &&
    (onboardingAssistantPromptsUser(message) || onboardingAssistantHasUnresolvedAction(message))
  );
}

export function onboardingHasUnansweredTurn(messages) {
  for (let index = list(messages).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (onboardingMessageIsInternal(message)) continue;
    if (onboardingMessageAnswersPrompt(message)) return false;
    if (message?.role === "assistant") return onboardingAssistantWaitsForUser(message);
  }
  return false;
}

export function collapseUnansweredOnboardingPrompts(messages) {
  const source = list(messages).filter((message) => !onboardingMessageIsInternal(message));
  const repeatedStackedPromptIndexes = new Set();
  const stackedPrompts = [];
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    const isPlainPrompt =
      message?.role === "assistant" &&
      onboardingAssistantPromptsUser(message) &&
      !onboardingAssistantHasUnresolvedAction(message);
    if (!isPlainPrompt) continue;
    for (const earlier of stackedPrompts) {
      if (index - earlier.index > 6) continue;
      if (onboardingPromptsAreNearDuplicates(earlier.message, message)) {
        repeatedStackedPromptIndexes.add(earlier.index);
      }
    }
    const previous = source[index - 1];
    if (onboardingAssistantWaitsForUser(previous)) stackedPrompts.push({ index, message });
  }

  const collapsed = [];
  let unansweredPromptIndex = null;
  for (const [sourceIndex, message] of source.entries()) {
    if (repeatedStackedPromptIndexes.has(sourceIndex)) continue;
    if (message?.role === "user") {
      if (onboardingMessageAnswersPrompt(message)) unansweredPromptIndex = null;
      collapsed.push(message);
      continue;
    }
    const isPlainPrompt =
      message?.role === "assistant" &&
      onboardingAssistantPromptsUser(message) &&
      !onboardingAssistantHasUnresolvedAction(message);
    if (
      isPlainPrompt &&
      unansweredPromptIndex !== null &&
      onboardingPromptsAreNearDuplicates(collapsed[unansweredPromptIndex], message)
    ) {
      collapsed.splice(unansweredPromptIndex, 1);
      collapsed.push(message);
      unansweredPromptIndex = collapsed.length - 1;
      continue;
    }
    collapsed.push(message);
    unansweredPromptIndex = isPlainPrompt ? collapsed.length - 1 : null;
  }
  return collapsed;
}
