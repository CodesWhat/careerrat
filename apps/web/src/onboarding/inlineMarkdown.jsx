// inlineMarkdown.jsx — a minimal, safe inline markdown renderer for assistant
// chat prose. The interview agent naturally writes **bold**/*italic*/`code`/
// [text](url) markdown, but the transcript rendered those characters
// literally to the user (visible asterisks/backticks). This renders a
// narrow, deliberately small subset — bold, italic, inline code, and links,
// nothing else (no headers, lists, block quotes, images, raw HTML) — as real
// React elements.
//
// The model's text is untrusted input: this NEVER uses
// dangerouslySetInnerHTML. Every span of plain text (including anything that
// looks like an HTML tag, e.g. "<script>") flows through as a React child
// string, which React escapes when it renders rather than parsing as markup —
// so raw HTML in model output can never inject a live element. Links are
// restricted to http(s) hrefs; a `javascript:`-scheme (or any other) link
// target renders as the original bracket/paren text instead of becoming a
// clickable anchor.

const INLINE_TOKEN_RE = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
const SAFE_LINK_RE = /^https?:\/\//i;

export function renderInlineMarkdown(text) {
  if (!text) return null;
  const nodes = [];
  let lastIndex = 0;
  let key = 0;
  INLINE_TOKEN_RE.lastIndex = 0;
  let match = INLINE_TOKEN_RE.exec(text);
  while (match) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [full, bold, italic, code, linkText, linkHref] = match;
    if (bold !== undefined) {
      nodes.push(<strong key={key++}>{bold}</strong>);
    } else if (italic !== undefined) {
      nodes.push(<em key={key++}>{italic}</em>);
    } else if (code !== undefined) {
      nodes.push(<code key={key++}>{code}</code>);
    } else if (linkText !== undefined && SAFE_LINK_RE.test(linkHref)) {
      nodes.push(
        <a key={key++} href={linkHref} target="_blank" rel="noopener noreferrer">
          {linkText}
        </a>
      );
    } else {
      // Either an unrecognized token or a link with an unsafe scheme — keep
      // the original text verbatim rather than dropping it or linkifying it.
      nodes.push(full);
    }
    lastIndex = match.index + full.length;
    match = INLINE_TOKEN_RE.exec(text);
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
