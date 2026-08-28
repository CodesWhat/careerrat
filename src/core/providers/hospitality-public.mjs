import { Parser } from "htmlparser2";

import { fetchPublicHttpText } from "../net/public-http-fetch.mjs";
import { htmlToPlainText } from "../text/html-text.mjs";

const MAX_DETAIL_LINKS = 50;
const DEFAULT_DETAIL_LINKS = 25;
const DETAIL_CONCURRENCY = 4;
const MIN_BODY_CHARS = 40;

const PROVIDERS = Object.freeze({
  culinaryagents: {
    host: "culinaryagents.com",
    listPath: /^\/search\/jobs\/?$/,
    detailPath: /^\/jobs\/\d+-(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+\/?$/,
  },
  oysterlink: {
    host: "oysterlink.com",
    listPath: /^\/jobs\/[a-z0-9-]+\/[a-z0-9-]+\/?$/,
    detailPath: /^\/job-posting\/[a-z0-9-]+\/?$/,
  },
  hcareers: {
    host: "www.hcareers.com",
    listPath: /^\/jobs(?:\/search\/where\/[A-Za-z]{2})?\/?$/,
    detailPath: /^\/jobs\/\d+-[a-z0-9-]+\/?$/,
  },
  hospitalityonline: {
    host: "www.hospitalityonline.com",
    listPath: /^\/jobs(?:\/search\/where\/[A-Za-z]{2})?\/?$/,
    detailPath: /^\/jobs\/\d+-[a-z0-9-]+\/?$/,
  },
  ihirehospitality: {
    host: "www.ihirehospitality.com",
    listPath: /^\/t-[a-z0-9-]+-s-[a-z0-9-]+-jobs\.html$/,
    detailPath: /^\/jobs\/view\/\d+\/?$/,
  },
});

function parseTrustedUrl(rawUrl, provider, kind) {
  const definition = PROVIDERS[provider];
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw new Error(`${provider}: untrusted ${kind} URL`);
  }
  const pathRule = kind === "listing" ? definition.listPath : definition.detailPath;
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.toLowerCase() !== definition.host ||
    !pathRule.test(parsed.pathname)
  ) {
    throw new Error(`${provider}: untrusted ${kind} URL: ${rawUrl}`);
  }
  parsed.hash = "";
  return parsed.toString();
}

function extractDetailLinks(html, listUrl, provider) {
  const links = [];
  const seen = new Set();
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name !== "a" || !attributes.href) return;
        let candidate;
        try {
          candidate = new URL(String(attributes.href), listUrl).toString();
          candidate = parseTrustedUrl(candidate, provider, "detail");
        } catch {
          return;
        }
        if (seen.has(candidate)) return;
        seen.add(candidate);
        links.push(candidate);
      },
    },
    { decodeEntities: true }
  );
  parser.end(String(html || ""));
  return links;
}

function collectJsonLd(html) {
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

function jobPostingNodes(value, output = []) {
  if (Array.isArray(value)) {
    for (const child of value) jobPostingNodes(child, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => String(type || "").toLowerCase() === "jobposting")) {
    output.push(value);
  }
  if (value["@graph"]) jobPostingNodes(value["@graph"], output);
  return output;
}

function structuredPostings(html) {
  const postings = [];
  for (const block of collectJsonLd(html)) {
    try {
      jobPostingNodes(JSON.parse(block.trim()), postings);
    } catch {
      // A page may contain unrelated malformed analytics JSON. Another valid
      // schema.org block can still describe the posting.
    }
  }
  return postings;
}

function cleanText(value) {
  return htmlToPlainText(String(value || ""), { blockSeparator: "\n" })
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/u)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function locationText(jobLocation) {
  const locations = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
  for (const location of locations) {
    const address = location?.address;
    if (typeof address === "string" && address.trim()) return address.trim();
    if (!address || typeof address !== "object") continue;
    const locality = String(address.addressLocality || "").trim();
    if (locality.includes(",")) return locality;
    const parts = [locality, address.addressRegion, address.postalCode, address.addressCountry]
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

function compensationFromDescription(bodyText) {
  const match = String(bodyText || "").match(
    /\$\s*([0-9][0-9,]*(?:\.\d+)?)\s*(?:(?:-|–|—|to)\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)\s*)?(?:per|\/)\s*(hour|hr|year|yr)\b/i
  );
  if (!match) return "";
  const min = numberText(match[1].replace(/,/g, ""));
  const max = numberText(String(match[2] || "").replace(/,/g, ""));
  if (!min) return "";
  const unit = /^h/i.test(match[3]) ? "hour" : "year";
  return max ? `$${min} to $${max} per ${unit}` : `$${min} per ${unit}`;
}

function parsedDate(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizePosting(posting, { url, provider, now, html }) {
  const validThrough = Date.parse(String(posting?.validThrough || ""));
  if (Number.isFinite(validThrough) && validThrough < now.getTime()) {
    return { status: "expired" };
  }
  const title = String(posting?.title || "").trim();
  const company = String(posting?.hiringOrganization?.name || "").trim();
  const bodyText = cleanText(posting?.description);
  if (!title || !company || bodyText.length < MIN_BODY_CHARS) return { status: "invalid" };
  return {
    status: "live",
    offer: {
      title,
      url,
      company,
      location: locationText(posting.jobLocation),
      comp:
        compensationText(posting.baseSalary) ||
        compensationFromDescription(bodyText) ||
        compensationFromDescription(cleanText(html)),
      bodyText,
      bodyPartial: false,
      ...(parsedDate(posting.datePosted) ? { postedAt: parsedDate(posting.datePosted) } : {}),
      provider,
    },
  };
}

async function fetchText(url, provider, kind, options) {
  const fetched = await fetchPublicHttpText(url, {
    fetchImpl: options.fetchImpl || fetch,
    resolveHost: options.resolveHost,
    dispatcherFactory: options.dispatcherFactory,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
  });
  if (!fetched.ok) throw new Error(`${provider}: ${kind} fetch failed: ${fetched.reason}`);
  if (fetched.status < 200 || fetched.status >= 300) {
    throw new Error(`${provider}: ${kind} returned HTTP ${fetched.status}`);
  }
  parseTrustedUrl(fetched.finalUrl || url, provider, kind);
  return fetched.rawText;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    })
  );
  return results;
}

async function fetchHospitalityBoard(provider, entry = {}, options = {}) {
  const listUrl = parseTrustedUrl(entry.url, provider, "listing");
  const listHtml = await fetchText(listUrl, provider, "listing", options);
  const requestedLimit = Number(entry.max_results);
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_DETAIL_LINKS)
      : DEFAULT_DETAIL_LINKS;
  const detailUrls = extractDetailLinks(listHtml, listUrl, provider).slice(0, limit);
  if (detailUrls.length === 0) return [];

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const outcomes = await mapWithConcurrency(detailUrls, DETAIL_CONCURRENCY, async (url) => {
    try {
      const html = await fetchText(url, provider, "detail", options);
      const postings = structuredPostings(html);
      if (postings.length === 0) return { status: "invalid" };
      return normalizePosting(postings[0], { url, provider, now, html });
    } catch (error) {
      return { status: "error", error };
    }
  });
  const offers = outcomes
    .filter((outcome) => outcome.status === "live")
    .map((outcome) => outcome.offer);
  if (
    offers.length === 0 &&
    outcomes.every((outcome) => outcome.status === "invalid" || outcome.status === "error")
  ) {
    const firstError = outcomes.find((outcome) => outcome.error)?.error;
    throw firstError || new Error(`${provider}: detail pages did not expose valid JobPosting data`);
  }
  return offers;
}

export function fetchOysterLink(entry, options) {
  return fetchHospitalityBoard("oysterlink", entry, options);
}

export function fetchCulinaryAgents(entry, options) {
  return fetchHospitalityBoard("culinaryagents", entry, options);
}

export function fetchHcareers(entry, options) {
  return fetchHospitalityBoard("hcareers", entry, options);
}

export function fetchHospitalityOnline(entry, options) {
  return fetchHospitalityBoard("hospitalityonline", entry, options);
}

export function fetchIHireHospitality(entry, options) {
  return fetchHospitalityBoard("ihirehospitality", entry, options);
}
