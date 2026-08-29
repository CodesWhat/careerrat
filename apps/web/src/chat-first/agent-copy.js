import { stripChatConfirmationBlocks } from "../../../../src/core/ai/chat-answer-mode.mjs";

const UNCLEAR_REPLY = "I couldn't turn that into a clear answer. Please try again.";
const STRUCTURED_COPY_FIELDS = ["reply", "message", "answer", "text", "summary", "question"];
const INTERNAL_REPORT_LINE =
  /^\s*(?:status(?:[_ -]?code)?|error(?:[_ -]?code)?|schema(?:[_ -]?error)?|operation|intent|diagnostics?|cli(?: command)?)\s*[:=].*$/i;
const TOOL_NARRATION_LINE =
  /^\s*(?:(?:i(?:'ll| will|'m| am)\s+)?(?:use|using|run|running|call|calling|invoke|invoking)\b.*\b(?:tool|skill|cli|command)\b.*)$/i;
const CANNED_HEADING_LINE =
  /^\s*(?:status update|workflow|what i did|here(?:'s| is) what i did|next steps)\s*:\s*$/i;

function unwrapStructuredCopy(text) {
  if (!/^[{[]/.test(text)) return { text, structured: false };
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const copy = STRUCTURED_COPY_FIELDS.map((field) => value[field]).find(
        (candidate) => typeof candidate === "string" && candidate.trim()
      );
      if (copy) return { text: copy, structured: true };
    }
    return { text: UNCLEAR_REPLY, structured: true };
  } catch {
    return { text, structured: false };
  }
}

export function cleanAgentCopy(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = unwrapStructuredCopy(text).text;
  text = stripChatConfirmationBlocks(text);
  text = text.replace(/```careerrat:answer[ \t]*\r?\n[\s\S]*?\r?\n```/gi, "");
  text = text.replace(/```json\s*\n[\s\S]*?\n```/gi, "");
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .split("\n")
    .filter(
      (line) =>
        !INTERNAL_REPORT_LINE.test(line) &&
        !TOOL_NARRATION_LINE.test(line) &&
        !CANNED_HEADING_LINE.test(line)
    )
    .join("\n")
    .replace(/\n(?:\s*\n)+/g, "\n")
    .trim();
  return text || UNCLEAR_REPLY;
}
