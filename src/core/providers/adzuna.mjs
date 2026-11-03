// Adzuna job search API (https://developer.adzuna.com/). Needs a paid (25 trial calls)
// application id and key: ADZUNA_APP_ID and ADZUNA_APP_KEY. See
// keyed-credentials.mjs.
//
// Wire in via a config/search-sources.yml entry:
//   { source_type: "board", provider: "adzuna", enabled: true, label: "Adzuna",
//     query: "<title>", country: "us", location: "<optional place>", max_pages: 1 }
// `country` is Adzuna's two-letter market code and is required: Adzuna searches
// one country per request, and CareerRat doesn't assume one.

import { feedBody } from "./board-feed.mjs";
import { createContext } from "./career-ops-registry.mjs";
import { requireCredentials } from "./keyed-credentials.mjs";

const API_ROOT = "https://api.adzuna.com/v1/api/jobs";
const RESULTS_PER_PAGE = 50;
const MAX_PAGES_CAP = 5;

export const ADZUNA_COUNTRIES = Object.freeze([
  "at",
  "au",
  "be",
  "br",
  "ca",
  "ch",
  "de",
  "es",
  "fr",
  "gb",
  "in",
  "it",
  "mx",
  "nl",
  "nz",
  "pl",
  "sg",
  "us",
  "za",
]);

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const COUNTRY_CURRENCY = {
  us: "USD",
  gb: "GBP",
  ca: "CAD",
  au: "AUD",
  nz: "NZD",
  sg: "SGD",
  in: "INR",
  br: "BRL",
  mx: "MXN",
  pl: "PLN",
  za: "ZAR",
  ch: "CHF",
};

function compText(job, currency) {
  // Adzuna fills in estimated pay when a posting has none. Only a stated figure
  // is comp; an estimate would read as a posted number.
  if (String(job.salary_is_predicted) === "1") return "";
  const min = Number(job.salary_min);
  const max = Number(job.salary_max);
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  if (!hasMin && !hasMax) return "";
  const range =
    hasMin && hasMax && min !== max
      ? `${Math.round(min)}-${Math.round(max)}`
      : String(Math.round(hasMin ? min : max));
  return `${currency} ${range}`.trim();
}

// Exported for tests: map one Adzuna search response to scanner offers.
export function parseAdzunaResponse(json, entry = {}, country = "") {
  if (!json || !Array.isArray(json.results)) {
    throw new Error(
      `adzuna: unexpected API response: expected { results: [...] }, got keys: [${
        json && typeof json === "object" ? Object.keys(json).join(", ") : "null"
      }]`
    );
  }
  const currency = COUNTRY_CURRENCY[country] || (ADZUNA_COUNTRIES.includes(country) ? "EUR" : "");
  const offers = [];
  for (const job of json.results) {
    const title = typeof job?.title === "string" ? job.title.trim() : "";
    const url = String(job?.redirect_url || "").trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    offers.push({
      title,
      url,
      company: String(job.company?.display_name || "").trim() || entry.label || "Adzuna",
      location: String(job.location?.display_name || "").trim(),
      comp: compText(job, currency),
      postedAt: toIsoDate(job.created),
      // The search API returns a snippet, not the full posting.
      ...feedBody(job.description),
      bodyPartial: true,
    });
  }
  return offers;
}

export async function fetchAdzuna(entry = {}, options = {}) {
  const creds = requireCredentials("adzuna", options.env);
  const country = String(entry.country || "")
    .trim()
    .toLowerCase();
  if (!ADZUNA_COUNTRIES.includes(country)) {
    throw new Error(
      `adzuna: set country to one of ${ADZUNA_COUNTRIES.join(", ")} on the source (got ${country || "nothing"})`
    );
  }
  const what = String(entry.query || entry.keywords?.join?.(" ") || "").trim();
  if (!what) throw new Error("adzuna: the source needs a query (a job title or keyword)");
  const pages = Math.min(Math.max(Number(entry.max_pages) || 1, 1), MAX_PAGES_CAP);
  const ctx = createContext(options.fetchImpl || fetch, options);
  const offers = [];
  for (let page = 1; page <= pages; page += 1) {
    const params = new URLSearchParams({
      app_id: creds.ADZUNA_APP_ID,
      app_key: creds.ADZUNA_APP_KEY,
      results_per_page: String(RESULTS_PER_PAGE),
      what,
      sort_by: "date",
    });
    if (entry.location) params.set("where", String(entry.location));
    const json = await ctx.fetchJson(`${API_ROOT}/${country}/search/${page}?${params}`, {
      redirect: "error",
    });
    const rows = parseAdzunaResponse(json, entry, country);
    offers.push(...rows);
    if (json.results.length < RESULTS_PER_PAGE) break;
  }
  return offers;
}
