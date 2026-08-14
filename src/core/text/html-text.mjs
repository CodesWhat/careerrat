import { Parser } from "htmlparser2";

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
const NON_TEXT_TAGS = new Set(["noscript", "script", "style", "template"]);

function safeWebHref(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function appendBoundary(parts, boundary) {
  if (!parts.length) return;
  const last = parts.at(-1);
  if (typeof last === "string" && /\s$/.test(last)) return;
  parts.push(boundary);
}

export function htmlToPlainText(html, { blockSeparator = " " } = {}) {
  const parts = [];
  let ignoredDepth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (ignoredDepth > 0) {
          ignoredDepth += 1;
          return;
        }
        if (NON_TEXT_TAGS.has(name)) {
          appendBoundary(parts, blockSeparator);
          ignoredDepth = 1;
          return;
        }
        if (BLOCK_TAGS.has(name)) appendBoundary(parts, blockSeparator);
      },
      ontext(text) {
        if (ignoredDepth === 0) parts.push(text);
      },
      onclosetag(name) {
        if (ignoredDepth > 0) {
          ignoredDepth -= 1;
          return;
        }
        if (BLOCK_TAGS.has(name)) appendBoundary(parts, blockSeparator);
      },
    },
    { decodeEntities: true }
  );
  parser.end(String(html || ""));
  return parts.join("");
}

export function htmlToMarkdownText(html) {
  const parts = [];
  let ignoredDepth = 0;
  let activeLink = null;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (ignoredDepth > 0) {
          ignoredDepth += 1;
          return;
        }
        if (NON_TEXT_TAGS.has(name)) {
          appendBoundary(parts, "\n");
          ignoredDepth = 1;
          return;
        }
        if (name === "a") {
          activeLink = { href: safeWebHref(attributes.href), text: "" };
          return;
        }
        if (BLOCK_TAGS.has(name)) appendBoundary(parts, "\n");
      },
      ontext(text) {
        if (ignoredDepth > 0) return;
        if (activeLink) activeLink.text += text;
        else parts.push(text);
      },
      onclosetag(name) {
        if (ignoredDepth > 0) {
          ignoredDepth -= 1;
          return;
        }
        if (name === "a" && activeLink) {
          const label = activeLink.text.trim();
          parts.push(activeLink.href ? `${label} (${activeLink.href})` : label);
          activeLink = null;
          return;
        }
        if (BLOCK_TAGS.has(name)) appendBoundary(parts, "\n");
      },
    },
    { decodeEntities: true }
  );
  parser.end(String(html || ""));
  return parts.join("");
}
