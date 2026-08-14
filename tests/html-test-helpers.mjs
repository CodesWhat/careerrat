export function extractInlineScript(html) {
  const source = String(html || "");
  const lower = source.toLowerCase();
  const openingStart = lower.indexOf("<script");
  if (openingStart === -1) return null;
  const openingEnd = lower.indexOf(">", openingStart + 7);
  if (openingEnd === -1) return null;
  const closingStart = lower.indexOf("</script", openingEnd + 1);
  if (closingStart === -1 || lower.indexOf(">", closingStart + 8) === -1) return null;
  return source.slice(openingEnd + 1, closingStart);
}
