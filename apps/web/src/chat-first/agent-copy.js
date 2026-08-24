export function cleanAgentCopy(value) {
  let text = String(value || "").trim();
  if (text.startsWith("{")) {
    try {
      const structured = JSON.parse(text);
      if (typeof structured?.reply === "string") text = structured.reply;
    } catch {
      // Ordinary copy may contain braces. Only valid structured replies unwrap.
    }
  }
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n(?:\s*\n)+/g, "\n")
    .trim();
}
