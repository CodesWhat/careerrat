export function trimEdgeCharacter(value, character) {
  const text = String(value || "");
  if (typeof character !== "string" || character.length !== 1) return text;
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === character) start += 1;
  while (end > start && text[end - 1] === character) end -= 1;
  return text.slice(start, end);
}
