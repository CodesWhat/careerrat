import { buildRemoteVibeCodingJobsUrl } from "./source-url.mjs";

// ---------------------------------------------------------------------------
// Entity / CDATA helpers
// ---------------------------------------------------------------------------

const ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&mdash;": "—",
  "&ndash;": "–",
  "&nbsp;": " ",
};

function decodeEntities(value) {
  if (!value) return "";
  let s = String(value);
  // Named entities
  s = s.replace(/&[a-zA-Z]+;/g, (match) => ENTITY_MAP[match] ?? match);
  // Decimal numeric entities &#39;
  s = s.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  // Hex numeric entities &#x27; &#X1F600;
  s = s.replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return s;
}

function stripCdata(value) {
  if (!value) return "";
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner);
}

function stripHtml(value) {
  if (!value) return "";
  let s = String(value);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|section|tr)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n\s+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function cleanText(raw) {
  return decodeEntities(stripHtml(decodeEntities(stripCdata(raw || ""))));
}

// ---------------------------------------------------------------------------
// Low-level XML extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content of the FIRST occurrence of a tag.
 * Handles CDATA, nested content, and self-closing (returns null for self-closing).
 */
function extractTagText(xml, tagName) {
  // Try paired tag first
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = xml.match(re);
  if (m) return m[1];
  return null;
}

/**
 * Extract all occurrences of a tag's text content.
 */
function extractAllTagText(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const results = [];
  for (const m of xml.matchAll(re)) {
    results.push(m[1]);
  }
  return results;
}

/**
 * Extract an attribute value from a tag (first occurrence).
 */
function extractAttr(tag, attrName) {
  const re = new RegExp(`${attrName}\\s*=\\s*(?:"([^"]*?)"|'([^']*?)')`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/**
 * Find all self-closing or opening tags matching tagName.
 */
function extractAllTags(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?/?>`, "gi");
  return [...xml.matchAll(re)].map((m) => m[0]);
}

/**
 * Split XML into item/entry chunks.
 */
function splitBlocks(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const blocks = [];
  for (const m of xml.matchAll(re)) {
    blocks.push(m[1]);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseIsoDate(raw) {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;
  try {
    const d = new Date(cleaned);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RSS 2.0 parser
// ---------------------------------------------------------------------------

function parseRssChannel(channelXml) {
  // Title is first <title> not inside an <item>
  const title = cleanText(extractTagText(channelXml, "title") || "");
  const itemBlocks = splitBlocks(channelXml, "item");
  const items = itemBlocks.map(parseRssItem);
  return { kind: "rss", title, items };
}

function parseRssItem(block) {
  // title
  const rawTitle = extractTagText(block, "title");
  const title = rawTitle != null ? cleanText(rawTitle) : null;

  // link — RSS link is a text node (not an attribute)
  const rawLink = extractTagText(block, "link");
  const link = rawLink ? rawLink.trim() : null;

  // guid
  const rawGuid = extractTagText(block, "guid");
  const guid = rawGuid ? stripCdata(rawGuid).trim() : null;

  // pubDate / dc:date
  const rawPubDate = extractTagText(block, "pubDate") || extractTagText(block, "dc:date");
  const pubDate = rawPubDate ? rawPubDate.trim() : null;
  const isoDate = parseIsoDate(pubDate);

  // description
  const rawDesc = extractTagText(block, "description");
  const description = rawDesc != null ? cleanText(rawDesc) : null;

  // categories
  const categories = extractAllTagText(block, "category")
    .map((c) => cleanText(c))
    .filter(Boolean);

  return { title, link, guid, pubDate, isoDate, description, categories };
}

// ---------------------------------------------------------------------------
// Atom 1.0 parser
// ---------------------------------------------------------------------------

function parseAtomFeed(feedXml) {
  // Feed title — first <title> at feed level (before first <entry>)
  const beforeFirst = feedXml.split(/<entry[\s>]/i)[0];
  const rawTitle = extractTagText(beforeFirst, "title");
  const title = rawTitle != null ? cleanText(rawTitle) : "";

  const entryBlocks = splitBlocks(feedXml, "entry");
  const items = entryBlocks.map(parseAtomEntry);
  return { kind: "atom", title, items };
}

function parseAtomEntry(block) {
  // title
  const rawTitle = extractTagText(block, "title");
  const title = rawTitle != null ? cleanText(rawTitle) : null;

  // link — prefer rel="alternate" or first link without rel, else first href
  const linkTags = extractAllTags(block, "link");
  let link = null;
  for (const tag of linkTags) {
    const rel = extractAttr(tag, "rel");
    if (rel === "alternate" || !rel) {
      link = extractAttr(tag, "href");
      if (link) break;
    }
  }
  if (!link && linkTags.length > 0) {
    link = extractAttr(linkTags[0], "href");
  }

  // guid → <id>
  const rawId = extractTagText(block, "id");
  const guid = rawId ? stripCdata(rawId).trim() : null;

  // pubDate → <published> or <updated>
  const rawPubDate = extractTagText(block, "published") || extractTagText(block, "updated");
  const pubDate = rawPubDate ? rawPubDate.trim() : null;
  const isoDate = parseIsoDate(pubDate);

  // description → <summary> or <content>
  const rawDesc = extractTagText(block, "summary") || extractTagText(block, "content");
  const description = rawDesc != null ? cleanText(rawDesc) : null;

  // categories — Atom uses <category term="..."/>
  const categoryTags = extractAllTags(block, "category");
  const categories = categoryTags
    .map((tag) => extractAttr(tag, "term") || cleanText(extractTagText(tag, "") || ""))
    .filter(Boolean);

  return { title, link, guid, pubDate, isoDate, description, categories };
}

// ---------------------------------------------------------------------------
// Public: parseFeed
// ---------------------------------------------------------------------------

/**
 * Parse an RSS 2.0 or Atom 1.0 feed XML string.
 * Returns { kind: "rss"|"atom", title, items: [...] }.
 * Never throws — returns { kind: "unknown", title: "", items: [] } on bad input.
 */
export function parseFeed(xml) {
  try {
    if (!xml || typeof xml !== "string") return { kind: "unknown", title: "", items: [] };

    // Strip BOM and leading whitespace/XML declaration
    const s = xml
      .replace(/^﻿/, "")
      .replace(/^<\?xml[^?]*\?>\s*/i, "")
      .trim();

    // Detect Atom by <feed or <entry
    if (/^<feed[\s>]/i.test(s) || /<feed[\s>]/i.test(s)) {
      return parseAtomFeed(s);
    }

    // Detect RSS by <rss or <channel or <item
    if (/^<rss[\s>]/i.test(s) || /<rss[\s>]/i.test(s) || /<channel[\s>]/i.test(s)) {
      // Find the channel block; fall back to using whole string
      const channelMatch = s.match(/<channel(?:\s[^>]*)?>[\s\S]*?<\/channel>/i);
      return parseRssChannel(channelMatch ? channelMatch[0] : s);
    }

    // Last-ditch: try to find items/entries
    if (/<item[\s>]/i.test(s)) return parseRssChannel(s);
    if (/<entry[\s>]/i.test(s)) return parseAtomFeed(s);

    return { kind: "unknown", title: "", items: [] };
  } catch {
    return { kind: "unknown", title: "", items: [] };
  }
}

// ---------------------------------------------------------------------------
// Company/location extraction from title
// ---------------------------------------------------------------------------

/**
 * Attempt to parse "Company — Role" or "Role at Company" from a title.
 * Returns { company, title: rolePart } or { company: null, title: original }.
 */
function parseCompanyFromTitle(rawTitle) {
  if (!rawTitle) return { company: null, role: rawTitle };

  // Pattern 1: "Company — Role" or "Company - Role" (em-dash, en-dash, or plain hyphen with spaces)
  // The em-dash pattern: company is before the dash, role is after
  const emDash = rawTitle.match(/^(.+?)\s+[—–]\s+(.+)$/);
  if (emDash) {
    return { company: emDash[1].trim(), role: emDash[2].trim() };
  }

  // Pattern 2: "Role at Company" — "at" preceded by a word, followed by Company
  // Be careful not to match "Senior at Scale" (where "Scale" looks like company)
  // We require "at" to be surrounded by spaces and Company to start with uppercase
  const atPattern = rawTitle.match(/^(.+?)\s+at\s+([A-Z].*)$/);
  if (atPattern) {
    return { company: atPattern[2].trim(), role: atPattern[1].trim() };
  }

  return { company: null, role: rawTitle };
}

/**
 * Extract location from a parenthetical like "(Remote)" or "(Berlin, DE)" in a title.
 */
function parseLocationFromTitle(rawTitle) {
  if (!rawTitle) return null;
  const m = rawTitle.match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : null;
}

function parseLocationFromDescription(description) {
  if (!description) return null;
  const match = String(description).match(/^\s*Location:\s*([^\n\r]+)$/im);
  return match ? match[1].trim() : null;
}

function isRemoteVibeSource(source = {}) {
  const identity = [source.provider, source.label, source.id, source.rssUrl, source.url]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return identity.includes("remotevibecodingjobs") || identity.includes("remote vibe coding jobs");
}

// ---------------------------------------------------------------------------
// Stable slug/id generator
// ---------------------------------------------------------------------------

/**
 * Simple deterministic hash → stable id string.
 * djb2-style, returns a hex string.
 */
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // Keep as unsigned 32-bit
  }
  return hash.toString(16).padStart(8, "0");
}

function slug(value) {
  if (!value) return "unknown";
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function stableId(item) {
  const base = item.guid || item.link || `${item.title || ""}`;
  return `rss-${simpleHash(base)}-${slug(base)}`;
}

// ---------------------------------------------------------------------------
// Public: feedItemsToOffers
// ---------------------------------------------------------------------------

/**
 * Convert parsed feed items into normalized offer records for the pipeline.
 *
 * Field name choices:
 *   - title, url, company, location, description → camelCase, matching all provider outputs
 *   - postedAt → camelCase (scoreSourcedOffer / filterAndDedupeOffers don't consume it,
 *     but the rest of the pipeline uses camelCase conventions)
 *   - source → string label (matches how scanCompanies sets source: `${provider}-api`)
 *   - bodyText → not set (description serves that role; scoreSourcedOffer checks bodyText||description)
 *
 * Note: offers where company is null will be marked "invalid" by filterAndDedupeOffers
 * (which requires url+title+company). That is intentional — we never fabricate a company.
 */
export function feedItemsToOffers(items, { source } = {}) {
  const sourceLabel = source?.label || source?.id || "rss";
  const remoteOnly = isRemoteVibeSource(source);
  const bodyPartial = remoteOnly;
  return (Array.isArray(items) ? items : []).map((item) => {
    const url = item.link || item.guid || null;
    const rawTitle = item.title || "";
    const { company, role } = parseCompanyFromTitle(rawTitle);
    const parsedLocation =
      parseLocationFromDescription(item.description) || parseLocationFromTitle(rawTitle);
    const location = remoteOnly
      ? /\bremote\b/i.test(String(parsedLocation || ""))
        ? parsedLocation
        : parsedLocation
          ? `${parsedLocation} (Remote)`
          : "Remote"
      : parsedLocation;

    return {
      title: role,
      url,
      company,
      location,
      description: item.description || null,
      bodyPartial,
      postedAt: item.isoDate || null,
      source: sourceLabel,
      id: stableId(item),
    };
  });
}

// ---------------------------------------------------------------------------
// Public: remoteVibeCodingJobsFeedUrl
// ---------------------------------------------------------------------------

const DEFAULT_RVCJ_FEED_URL = "https://remotevibecodingjobs.com/feed.xml";

/**
 * Return the RSS feed URL for a Remote Vibe Coding Jobs source config.
 * Priority: source.rssUrl → derived from buildRemoteVibeCodingJobsUrl → default constant.
 */
export function remoteVibeCodingJobsFeedUrl(source = {}) {
  if (source.rssUrl) return source.rssUrl;
  try {
    const base = buildRemoteVibeCodingJobsUrl(source);
    if (base) {
      const url = new URL(base);
      url.pathname = "/feed";
      return url.toString();
    }
  } catch {
    // fall through
  }
  return DEFAULT_RVCJ_FEED_URL;
}
