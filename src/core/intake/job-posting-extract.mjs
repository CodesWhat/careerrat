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

function structuredIdentifier(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.value || value["@id"] || "").trim();
}

function sameStructuredPosting(left, right) {
  const sameContent =
    left.title === right.title &&
    left.description === right.description &&
    left.url === right.url &&
    left.company === right.company &&
    left.location === right.location &&
    left.comp === right.comp &&
    left.postedAt === right.postedAt;
  if (!sameContent) return false;
  return !left.identifier || !right.identifier || left.identifier === right.identifier;
}

function locationText(jobLocation) {
  const locations = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
  for (const location of locations) {
    const address = location?.address;
    if (typeof address === "string" && address.trim()) return address.trim();
    if (!address || typeof address !== "object") continue;
    const locality = String(address.addressLocality || "").trim();
    if (locality.includes(",")) return locality;
    const country =
      typeof address.addressCountry === "object"
        ? address.addressCountry.name
        : address.addressCountry;
    const parts = [locality, address.addressRegion, address.postalCode, country]
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    if (parts.length > 0) return [...new Set(parts)].join(", ");
  }
  return "";
}

function numberText(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(number);
}

function compensationText(baseSalary) {
  if (!baseSalary || typeof baseSalary !== "object") return "";
  const currency = String(baseSalary.currency || "").toUpperCase();
  const prefix = currency === "USD" ? "$" : currency ? `${currency} ` : "";
  const value = baseSalary.value;
  if (typeof value === "number" || typeof value === "string") {
    const amount = numberText(value);
    return amount ? `${prefix}${amount}` : "";
  }
  if (!value || typeof value !== "object") return "";
  const min = numberText(value.minValue);
  const max = numberText(value.maxValue);
  const exact = numberText(value.value);
  const amount =
    min && max ? `${prefix}${min} to ${prefix}${max}` : `${prefix}${min || max || exact}`;
  if (!min && !max && !exact) return "";
  const unit = String(value.unitText || "")
    .trim()
    .toLowerCase();
  return unit ? `${amount} per ${unit}` : amount;
}

function parsedDate(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function extractStructuredJobPostings(html = "") {
  const normalized = [];
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
      const entry = {
        title: String(posting.title || "").trim(),
        description: normalizeDescription(posting.description),
        url: String(posting.url || posting["@id"] || "").trim(),
        identifier: structuredIdentifier(posting.identifier),
        company: String(posting.hiringOrganization?.name || "").trim(),
        location: locationText(posting.jobLocation),
        comp: compensationText(posting.baseSalary),
        postedAt: parsedDate(posting.datePosted),
      };
      if (!entry.title || (!entry.description && !entry.url && !entry.identifier)) continue;
      if (normalized.some((existing) => sameStructuredPosting(existing, entry))) continue;
      normalized.push(entry);
    }
  }
  return normalized;
}

function normalizeIdentityText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractJobPageIdentity(html = "") {
  let active = null;
  let pageTitle = "";
  const headings = [];
  const parser = new Parser(
    {
      onopentag(name) {
        if (active || (name !== "title" && name !== "h1")) return;
        active = { name, text: "" };
      },
      ontext(text) {
        if (active) active.text += text;
      },
      onclosetag(name) {
        if (!active || name !== active.name) return;
        const text = normalizeIdentityText(active.text);
        if (text) {
          if (name === "title" && !pageTitle) pageTitle = text;
          if (name === "h1") headings.push(text);
        }
        active = null;
      },
    },
    { decodeEntities: true }
  );
  parser.end(String(html || ""));
  return { pageTitle, headings };
}
