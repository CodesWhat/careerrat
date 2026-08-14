const REGEXP_ESCAPES = new Map([
  ["\\", "\\\\"],
  ["^", "\\^"],
  ["$", "\\$"],
  [".", "\\."],
  ["+", "\\+"],
  ["?", "\\?"],
  ["(", "\\("],
  [")", "\\)"],
  ["[", "\\["],
  ["]", "\\]"],
  ["{", "\\{"],
  ["}", "\\}"],
  ["|", "\\|"],
  ["/", "\\/"],
]);

export function compileSingleStarGlob(value) {
  let source = "^";
  for (const char of String(value || "")) {
    source += char === "*" ? ".*" : REGEXP_ESCAPES.get(char) || char;
  }
  return new RegExp(`${source}$`);
}
