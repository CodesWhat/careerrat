// CR101: some application questions ask the applicant to vouch for something only they
// can vouch for: that their answers are true, or whether AI helped prepare the
// application. CareerRat never answers these for anyone. They always come back as
// NEEDS YOU so the person answers them themselves, even when a screening answer or an
// AI draft could produce text.

const AI_TERM = String.raw`(?:\bai\b|\ba\.i\.|artificial intelligence|chat\s?gpt|\bgpt\b|\bllms?\b|large language model|generative|copilot|claude|gemini)`;
const PREPARE_TERM = String.raw`(?:application|resume|résumé|cv\b|cover letter|responses?|answers?|assist|prepar|complet|generat|writ|draft|this form|submission)`;

const PATTERNS = [
  // AI-use disclosure or policy acknowledgement.
  new RegExp(`${AI_TERM}[^.?!]{0,80}${PREPARE_TERM}`, "i"),
  new RegExp(`${PREPARE_TERM}[^.?!]{0,80}${AI_TERM}`, "i"),
  /\b(?:use|usage) of (?:ai|artificial intelligence|a\.i\.)\b|\bai[- ](?:generated|assisted|policy|usage|disclosure)\b/i,
  // Truthfulness / accuracy certification.
  /\b(?:certify|attest|affirm|declare|swear|represent|warrant)\b[^.?!]{0,100}\b(?:true|accurate|correct|complete|truthful|knowledge|belief)\b/i,
  /\b(?:information|answers?|statements?|responses?|details|representations?)\b[^.?!]{0,60}\b(?:true|accurate|truthful|correct)\b[^.?!]{0,60}\b(?:best of my|knowledge|belief|understand|acknowledge)\b/i,
  /\b(?:false|misleading|falsified|inaccurate|misrepresentation)\b[^.?!]{0,80}\b(?:ground|cause|termination|disqualif|reject|dismiss)/i,
  /\b(?:i|we)\s+(?:understand|acknowledge|agree)\b[^.?!]{0,80}\b(?:false|misleading|falsif|misrepresent|truthful|accurate)/i,
];

// "Do you have experience building AI products?" is about the work, not the application.
const WORK_EXPERIENCE =
  /\b(?:experience|familiar(?:ity)?|skilled|proficien\w*|background|knowledge)\b[^.?!]{0,40}\b(?:with|in|of|building|using)\b/i;

export function isAttestationQuestion(label) {
  const text = String(label || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (WORK_EXPERIENCE.test(text) && !/\b(?:certify|attest|affirm|declare)\b/i.test(text)) {
    const aiAboutApplication = new RegExp(
      `${AI_TERM}[^.?!]{0,40}(?:to|when|while|in)\\s+(?:prepar|complet|writ|draft|fill)`,
      "i"
    );
    if (!aiAboutApplication.test(text)) return false;
  }
  return PATTERNS.some((pattern) => pattern.test(text));
}

export const ATTESTATION_NEEDS_YOU_REASON =
  "this asks you to vouch for your answers or disclose AI use. Answer it yourself; CareerRat never answers it for you.";
