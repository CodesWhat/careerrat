import { Parser } from "htmlparser2";
import { htmlToPlainText } from "../text/html-text.mjs";

function jsonLdBlocks(html) {
  const blocks = [];
  let active = null;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (
          name === "script" &&
          String(attributes.type || "")
            .trim()
            .toLowerCase() === "application/ld+json"
        ) {
          active = "";
        }
      },
      ontext(text) {
        if (active !== null) active += text;
      },
      onclosetag(name) {
        if (name !== "script" || active === null) return;
        blocks.push(active);
        active = null;
      },
    },
    { decodeEntities: true }
  );
  parser.end(String(html || ""));
  return blocks;
}

function isJobPosting(value) {
  const types = Array.isArray(value?.["@type"]) ? value["@type"] : [value?.["@type"]];
  return types.some((type) => String(type || "").toLowerCase() === "jobposting");
}

function collectJobPostings(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectJobPostings(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (isJobPosting(value)) output.push(value);
  if (Array.isArray(value["@graph"])) collectJobPostings(value["@graph"], output);
}

function normalizeDescription(value) {
  return htmlToPlainText(String(value || ""), { blockSeparator: "\n" })
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/u)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractStructuredJobDescription(html = "") {
  const descriptions = [];
  for (const block of jsonLdBlocks(html)) {
    let parsed;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const postings = [];
    collectJobPostings(parsed, postings);
    for (const posting of postings) {
      const description = normalizeDescription(posting.description);
      if (description) descriptions.push(description);
    }
  }
  descriptions.sort((a, b) => b.length - a.length);
  return descriptions[0] || "";
}
