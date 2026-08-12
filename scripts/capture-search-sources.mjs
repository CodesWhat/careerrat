#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

import { defaultProfileRoot } from "../src/core/automation/session.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";
import { captureAndPersistOffersIfDb } from "../src/core/scoring/sourced-persistence.mjs";
import { extractReqId } from "../src/core/scoring/sourced-scanner.mjs";

const pathCtx = { repoRoot: ROOT };
const DEFAULT_CONFIG = userPath(pathCtx, "config/search-sources.yml");
const DEFAULT_PROFILE_ROOT = defaultProfileRoot();

export function hiringCafeSearchUrl(searchQuery, searchState = {}) {
  const url = new URL("https://hiring.cafe/");
  const state = {
    searchQuery,
    dateFetchedPastNDays: 2,
    sortBy: "date",
    ...searchState,
  };
  url.searchParams.set("searchState", JSON.stringify(state));
  return url.toString();
}

export function selectSearchSources(
  config,
  { provider = "", ids = [], includeDisabled = false } = {}
) {
  const wantedProvider = provider.toLowerCase();
  const wantedIds = new Set(normalizeList(ids));
  const sources = Array.isArray(config) ? config : config?.searches || config?.sources || [];

  return sources
    .map(normalizeSearchSource)
    .filter((source) => includeDisabled || source.enabled !== false)
    .filter((source) => !wantedProvider || source.provider === wantedProvider)
    .filter((source) => wantedIds.size === 0 || wantedIds.has(source.id));
}

export function buildSearchSnapshotPath({
  source = "search-sources",
  date = new Date(),
  dir = "scan-results",
} = {}) {
  return join(dir, `${slug(source)}-browser-${timestamp(date)}.json`);
}

export function stampSourceOffers({ provider, source, searchUrl, capturedUrl, offers = [] }) {
  const providerName = (provider || source?.provider || "generic").toLowerCase();
  return offers.map((offer) => {
    const reqId =
      offer.reqId ||
      extractReqId(offer.hiringCafeUrl || "").id ||
      extractReqId(offer.url || "").id ||
      "";
    return {
      ...offer,
      source: `${providerName}-browser`,
      sourceId: source?.id || "",
      sourceLabel: source?.label || source?.term || source?.id || "",
      sourceProvider: providerName,
      searchUrl,
      capturedUrl,
      reqId,
    };
  });
}

export function loadSearchSourceConfig(path = DEFAULT_CONFIG) {
  const raw = readFileSync(path, "utf8");
  return /\.(ya?ml)$/i.test(path) ? parseYaml(raw) : JSON.parse(raw);
}

export function searchSourceUrl(source) {
  if (source.url) return source.url;
  if (source.provider === "hiringcafe" && source.term)
    return hiringCafeSearchUrl(source.term, source.searchState || {});
  throw new Error(`Search source ${source.id || "(missing id)"} needs a url, or a HiringCafe term`);
}

export async function captureSearchSources({
  sources,
  sourceName = "search-sources",
  browserChannel = "chromium",
  profileRoot = DEFAULT_PROFILE_ROOT,
  headless = false,
  login = false,
  manualEach = false,
  limit = 0,
  perSourceLimit = 250,
  scrollPages = 0,
  waitMs = 800,
  now = new Date(),
  chromium,
} = {}) {
  if (!chromium) throw new Error("captureSearchSources requires a Playwright chromium instance");
  if (!Array.isArray(sources) || sources.length === 0)
    throw new Error("No search sources selected");

  mkdirSync(profileRoot, { recursive: true });

  const normalizedSources = sources.map(normalizeSearchSource);
  const offers = [];
  const errors = [];
  const sourceResults = [];

  // Lever sources are fetched via the public JSON API — no browser needed.
  const leverSources = normalizedSources.filter((s) => s.provider === "lever");
  const browserSources = normalizedSources.filter((s) => s.provider !== "lever");
  for (const source of leverSources) {
    try {
      const company = leverCompanySlug(source);
      const result = await fetchLeverPostings(company, source);
      offers.push(...result.offers);
      sourceResults.push(result.sourceResult);
    } catch (error) {
      errors.push({
        id: source.id,
        label: source.label || source.id,
        provider: "lever",
        error: error?.message || String(error),
      });
    }
  }

  for (const [provider, providerSources] of groupByProvider(browserSources)) {
    const context = await launchContext({
      chromium,
      provider,
      browserChannel,
      profileRoot,
      headless,
    });
    let loginPaused = false;
    try {
      const page = context.pages()[0] || (await context.newPage());
      for (const source of providerSources) {
        try {
          const searchUrl = searchSourceUrl(source);
          await page.bringToFront();
          await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

          if (login && !loginPaused) {
            await promptUser(
              `Log in / verify ${provider} filters, then press Enter to continue batch capture...`
            );
            loginPaused = true;
          }
          if (manualEach) {
            await promptUser(
              `Verify source "${source.label || source.id}" is ready, then press Enter to capture...`
            );
          }

          await settle(page, waitMs);
          if (scrollPages > 0) await scrollPage(page, scrollPages, waitMs);
          await settle(page, waitMs);

          const blocker = await detectCaptureBlocker(page);
          if (blocker) throw new Error(blocker);

          const rawOffers = await extractOffers(page, provider);
          const cappedRawOffers =
            perSourceLimit > 0 ? rawOffers.slice(0, perSourceLimit) : rawOffers;
          const capturedUrl = page.url();
          const stamped = stampSourceOffers({
            provider,
            source,
            searchUrl,
            capturedUrl,
            offers: cappedRawOffers,
          });
          offers.push(...stamped);
          sourceResults.push({
            id: source.id,
            label: source.label || source.term || source.id,
            provider,
            searchUrl,
            capturedUrl,
            scanned: rawOffers.length,
            kept: stamped.length,
          });
        } catch (error) {
          errors.push({
            id: source.id,
            label: source.label || source.term || source.id,
            provider,
            error: error?.message || String(error),
          });
        }
      }
    } finally {
      await context.close();
    }
  }

  const outputOffers = limit > 0 ? offers.slice(0, limit) : offers;
  return {
    source: `${slug(sourceName)}-browser`,
    provider: "batch",
    generatedAt: now.toISOString(),
    sourceCount: normalizedSources.length,
    capturedSourceCount: sourceResults.length,
    scanned: offers.length,
    sources: sourceResults,
    errors,
    offers: outputOffers,
  };
}

export function ingestCapturedSnapshot({
  repoRoot = ROOT,
  env = process.env,
  snapshot,
  now = new Date(),
} = {}) {
  const result = captureAndPersistOffersIfDb({
    repoRoot,
    env,
    offers: snapshot?.offers || [],
    savedAt: now,
  });
  if (!result) {
    throw new Error("capture ingest requires a CareerRat SQLite database");
  }
  return result;
}

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    console.log(helpText());
    return;
  }

  const options = parseArgs(argv);
  const sources = options.url
    ? [
        normalizeSearchSource({
          id: options.ids[0] || "explicit-url",
          label: options.label || options.ids[0] || "Explicit URL",
          provider: options.provider || inferProviderFromUrl(options.url),
          url: options.url,
          enabled: true,
        }),
      ]
    : selectSearchSources(loadSearchSourceConfig(options.configPath), options);

  if (sources.length === 0) {
    throw new Error(
      "No search sources matched. Check --provider, --id/--source-id, or --include-disabled."
    );
  }

  const sourceName = options.sourceName || options.provider || "search-sources";
  const { chromium } = await import("playwright");
  const snapshot = await captureSearchSources({
    sources,
    sourceName,
    browserChannel: options.browserChannel,
    profileRoot: options.profileRoot,
    headless: options.headless,
    login: options.login,
    manualEach: options.manualEach,
    limit: options.limit,
    perSourceLimit: options.perSourceLimit,
    scrollPages: options.scrollPages,
    waitMs: options.waitMs,
    chromium,
  });

  const scanResultsDir = userPath(pathCtx, "workspace/scan-results");
  mkdirSync(scanResultsDir, { recursive: true });
  const out =
    options.outPath || buildSearchSnapshotPath({ source: sourceName, dir: scanResultsDir });
  writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote ${out}`);
  console.log(
    `Captured ${snapshot.offers.length} offers from ${snapshot.capturedSourceCount}/${snapshot.sourceCount} sources`
  );
  if (options.ingest) {
    const ingest = ingestCapturedSnapshot({ repoRoot: ROOT, snapshot });
    console.log(`Ingested ${ingest.persistedRows} captured offers into SQLite sourced rows`);
  }
  if (snapshot.errors.length > 0) {
    console.log("Errors:");
    for (const error of snapshot.errors) console.log(`- ${error.id}: ${error.error}`);
  }
}

function parseArgs(args) {
  return {
    configPath: valueAfter(args, "--config") || DEFAULT_CONFIG,
    provider: (valueAfter(args, "--provider") || "").toLowerCase(),
    ids: collectValues(args, ["--id", "--source-id"]),
    includeDisabled: args.includes("--include-disabled"),
    sourceName: valueAfter(args, "--source"),
    url: valueAfter(args, "--url"),
    label: valueAfter(args, "--label"),
    outPath: valueAfter(args, "--out"),
    browserChannel: (
      valueAfter(args, "--browser") ||
      valueAfter(args, "--channel") ||
      process.env.BOARD_BROWSER ||
      "chromium"
    ).toLowerCase(),
    profileRoot: valueAfter(args, "--profile-root") || DEFAULT_PROFILE_ROOT,
    headless: args.includes("--headless"),
    login: args.includes("--login"),
    manualEach: args.includes("--manual") || args.includes("--manual-each"),
    limit: Number(valueAfter(args, "--limit") || 0),
    perSourceLimit: Number(valueAfter(args, "--per-source-limit") || 250),
    scrollPages: Number(valueAfter(args, "--scroll-pages") || 0),
    waitMs: Number(valueAfter(args, "--wait-ms") || 800),
    ingest: args.includes("--ingest"),
  };
}

function normalizeSearchSource(source = {}) {
  const provider = String(
    source.provider || inferProviderFromUrl(source.url) || "generic"
  ).toLowerCase();
  const term = source.term || source.query || "";
  const label = source.label || term || source.id || source.url || provider;
  return {
    ...source,
    id: String(source.id || slug(`${provider}-${label}`)),
    provider,
    label,
    term,
  };
}

function inferProviderFromUrl(url = "") {
  let hostname;
  try {
    hostname = new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "generic";
  }
  if (hostname === "hiring.cafe" || hostname.endsWith(".hiring.cafe")) return "hiringcafe";
  if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) return "linkedin";
  if (hostname === "wellfound.com" || hostname.endsWith(".wellfound.com")) return "wellfound";
  if (hostname === "jobs.lever.co" || hostname === "lever.co" || hostname.endsWith(".lever.co"))
    return "lever";
  return "generic";
}

async function launchContext({ chromium, provider, browserChannel, profileRoot, headless }) {
  const launchOptions = {
    headless,
    viewport: { width: 1440, height: 1100 },
  };
  if (browserChannel !== "chromium") launchOptions.channel = browserChannel;
  return chromium.launchPersistentContext(join(profileRoot, provider), launchOptions);
}

// NOTE: The DOM extractors below (extractLinkedIn, extractHiringCafe, extractGeneric) have
// counterparts in capture-board-snapshot.mjs. They cannot be shared as an import because
// page.evaluate() requires inline serializable functions. Keep both files in sync manually.
async function extractOffers(page, provider) {
  if (provider === "linkedin") return page.evaluate(extractLinkedIn);
  if (provider === "hiringcafe") return page.evaluate(extractHiringCafe);
  if (provider === "wellfound") return page.evaluate(extractWellfound);
  return page.evaluate(extractGeneric);
}

async function settle(page, waitMs) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch {}
  if (waitMs > 0) await page.waitForTimeout(waitMs);
}

async function scrollPage(page, pages, waitMs) {
  for (let index = 0; index < pages; index += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.85)));
    if (waitMs > 0) await page.waitForTimeout(waitMs);
  }
}

async function detectCaptureBlocker(page) {
  const state = await page.evaluate(() => ({
    title: document.title || "",
    text: (document.body?.innerText || "").slice(0, 1000),
  }));
  const haystack = `${state.title}\n${state.text}`;
  if (/vercel security checkpoint|failed to verify your browser|code 21/i.test(haystack)) {
    return "browser capture blocked by Vercel Security Checkpoint; rerun headed with the session browser or omit --headless";
  }
  return "";
}

async function promptUser(message) {
  const rl = createInterface({ input, output });
  await rl.question(message);
  rl.close();
}

function groupByProvider(sources) {
  const groups = new Map();
  for (const source of sources) {
    if (!groups.has(source.provider)) groups.set(source.provider, []);
    groups.get(source.provider).push(source);
  }
  return groups;
}

function extractLinkedIn() {
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const abs = (href) => {
    try {
      return new URL(href, location.href).toString();
    } catch {
      return href || "";
    }
  };
  const cards = [...document.querySelectorAll("[data-job-id], .job-card-container, li")];
  const seen = new Set();
  const offers = [];
  for (const card of cards) {
    const anchor = card.querySelector('a[href*="/jobs/view/"]');
    if (!anchor) continue;
    const url = abs(anchor.href).replace(/\?.*$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    const title =
      text(anchor) || text(card.querySelector(".job-card-list__title, .job-card-container__link"));
    const company = text(
      card.querySelector(
        ".artdeco-entity-lockup__subtitle, .job-card-container__primary-description"
      )
    );
    const locationText = text(
      card.querySelector(".job-card-container__metadata-item, .artdeco-entity-lockup__caption")
    );
    const listed = text(card.querySelector("time, .job-card-container__listed-time"));
    offers.push({ company, title, url, location: locationText, posted: listed });
  }
  return offers.filter((offer) => offer.url && offer.title);
}

function extractHiringCafe() {
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const abs = (href) => {
    try {
      return new URL(href, location.href).toString();
    } catch {
      return href || "";
    }
  };
  const closestCard = (anchor) => {
    let node = anchor;
    for (let index = 0; node && index < 8; index += 1, node = node.parentElement) {
      const content = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (content.length > 80 && content.length < 3000) return node;
    }
    return anchor.closest("article,li,[role='listitem']") || anchor.parentElement;
  };
  const bestTitle = (card, fallback) =>
    text(card?.querySelector("h1,h2,h3,[role='heading']")) || fallback || "";
  const bestCompany = (card) => {
    const labelled = [...(card?.querySelectorAll("[aria-label], [title]") || [])]
      .map((node) => node.getAttribute("aria-label") || node.getAttribute("title") || "")
      .find((value) => value && !/job|apply|save|share/i.test(value));
    return labelled || "";
  };
  const hiringCafeFields = (card, fallbackTitle) => {
    const spans = [...(card?.querySelectorAll("span") || [])];
    const spanText = spans.map(text).filter(Boolean);
    const titleNode = card?.querySelector("span.w-full.font-bold, span.text-start.font-bold");
    const title = text(titleNode) || bestTitle(card, fallbackTitle);
    const boldText = [...(card?.querySelectorAll("span.font-bold") || [])]
      .map(text)
      .filter(Boolean);
    const companyFromBold = boldText.find((value) => value && value !== title) || "";
    const companySummary =
      spanText.find((value) => value.includes(":") && value.length < 220) || "";
    const company =
      companyFromBold || companySummary.replace(/:.+$/, "").trim() || bestCompany(card);
    const location =
      spanText.find(
        (value) =>
          value !== title &&
          value !== company &&
          !value.includes(":") &&
          /\b(remote|united states|new york|nyc|san francisco|austin|seattle|chicago|denver|miami|boston|washington|california|field|hybrid|onsite)\b/i.test(
            value
          ) &&
          !/^(remote|hybrid|onsite|field|full time)$/i.test(value)
      ) || "";
    const comp = spanText.find((value) => /\$\s?\d|\b\d{3},000\b/i.test(value)) || "";
    return { title, company, location, comp };
  };
  const bestLine = (lines, pattern) => lines.find((line) => pattern.test(line)) || "";
  const anchors = [...document.querySelectorAll('a[href*="/job/"], a[href*="hiring.cafe/job/"]')];
  const seen = new Set();
  const offers = [];
  for (const anchor of anchors) {
    const hiringCafeUrl = abs(anchor.href).replace(/\?.*$/, "");
    const match = hiringCafeUrl.match(/\/job\/([a-z0-9_-]+)/i);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    const card = closestCard(anchor);
    const lines = text(card || anchor)
      .split(/ (?=[A-Z][A-Za-z0-9&.,'()/+-]*(?:\s|$))/)
      .map((line) => line.trim())
      .filter(Boolean);
    const heading = text(card?.querySelector("h1,h2,h3,[role='heading']")) || text(anchor);
    const fields = hiringCafeFields(card, heading);
    const external = card?.querySelector('a[href^="http"]:not([href*="hiring.cafe"])');
    offers.push({
      company: fields.company,
      title: fields.title,
      url: external ? abs(external.href) : hiringCafeUrl,
      hiringCafeUrl,
      location:
        fields.location ||
        bestLine(
          lines,
          /\b(remote|united states|new york|nyc|san francisco|austin|seattle|hybrid)\b/i
        ),
      comp: fields.comp || bestLine(lines, /\$\s?\d|\b\d{3},000\b/),
      reqId: `hiringcafe:${match[1].toLowerCase()}`,
    });
  }
  return offers.filter((offer) => offer.hiringCafeUrl);
}

function extractGeneric() {
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const abs = (href) => {
    try {
      return new URL(href, location.href).toString();
    } catch {
      return href || "";
    }
  };
  const closestCard = (anchor) => {
    let node = anchor;
    for (let index = 0; node && index < 8; index += 1, node = node.parentElement) {
      const content = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (content.length > 80 && content.length < 3000) return node;
    }
    return anchor.closest("article,li,[role='listitem']") || anchor.parentElement;
  };
  const anchors = [...document.querySelectorAll("a[href]")].filter((anchor) =>
    /job|career|position|opening/i.test(`${anchor.href} ${text(anchor)}`)
  );
  const seen = new Set();
  const offers = [];
  for (const anchor of anchors) {
    const url = abs(anchor.href).replace(/#.*$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    const card = closestCard(anchor);
    const title = text(anchor) || text(card?.querySelector("h1,h2,h3,[role='heading']"));
    offers.push({ company: "", title, url, location: "", rawText: text(card).slice(0, 500) });
  }
  return offers.filter((offer) => offer.url && offer.title);
}

// Wellfound role-card extractor. Runs inside page.evaluate() — no imports or closures.
// Role cards link to /role/r/{slug}, /role/l/{slug}/{loc}, /role/{slug}, or /jobs/{slug}.
// See capture-board-snapshot.mjs for the canonical board-snapshot sibling of this file.
function extractWellfound() {
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const abs = (href) => {
    try {
      return new URL(href, location.href).toString();
    } catch {
      return href || "";
    }
  };
  const anchors = [...document.querySelectorAll("a[href]")].filter((a) => {
    const href = a.getAttribute("href") || "";
    return /\/role\/|\/jobs\//.test(href) && !/(wellfound\.com\/jobs\/?$|\/jobs\/?#)/.test(href);
  });
  const seen = new Set();
  const offers = [];
  for (const anchor of anchors) {
    const url = abs(anchor.href).replace(/\?.*$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    // Walk up to find the card container.
    let card = anchor;
    for (let i = 0; card && i < 8; i += 1, card = card.parentElement) {
      const len = (card.textContent || "").replace(/\s+/g, " ").trim().length;
      if (len > 60 && len < 3000) break;
    }
    const title =
      text(card?.querySelector("h1,h2,h3,[role='heading'],span.font-semibold,span.font-bold")) ||
      text(anchor);
    const company =
      text(
        card?.querySelector("[data-test='company-name'], .company-name, span.text-neutral-500")
      ) || "";
    const location =
      text(card?.querySelector("[data-test='location'], .location, span[class*='location']")) || "";
    if (!title) continue;
    offers.push({ company, title, url, location });
  }
  return offers;
}

// Fetches Lever public postings JSON for a company slug and maps to the standard offer shape.
// API: https://api.lever.co/v0/postings/{company}?mode=json (returns [] for unknown slugs).
async function fetchLeverPostings(company, source, fetchImpl = fetch) {
  const apiUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
  const response = await fetchImpl(apiUrl);
  if (!response.ok) throw new Error(`Lever API ${response.status} for ${company}`);
  const postings = await response.json();
  if (!Array.isArray(postings))
    throw new Error(`Lever API unexpected response shape for ${company}`);
  const offers = postings
    .map((posting) => ({
      company: posting.company || company,
      title: posting.text || "",
      url: posting.hostedUrl || posting.applyUrl || "",
      location: posting.categories?.location || posting.categories?.allLocations?.[0] || "",
      source: "lever-api",
      sourceId: source?.id || "",
      sourceLabel: source?.label || source?.id || "",
      sourceProvider: "lever",
      searchUrl: apiUrl,
      capturedUrl: apiUrl,
      reqId: posting.id ? `lever:${posting.id}` : "",
    }))
    .filter((o) => o.url && o.title);
  return {
    offers,
    sourceResult: {
      id: source?.id || company,
      label: source?.label || company,
      provider: "lever",
      searchUrl: apiUrl,
      capturedUrl: apiUrl,
      scanned: postings.length,
      kept: offers.length,
    },
  };
}

// Derive the Lever company slug from a source entry.
// Accepts source.company, or extracts the first path segment from source.url
// (e.g. https://jobs.lever.co/acmecorp → "acmecorp").
function leverCompanySlug(source) {
  if (source.company) {
    return String(source.company)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
  if (source.url) {
    try {
      const pathname = new URL(source.url).pathname;
      const segment = pathname.split("/").filter(Boolean)[0];
      if (segment) return segment;
    } catch {}
  }
  throw new Error(
    `lever source "${source.id || "(no id)"}" requires source.company or a jobs.lever.co URL`
  );
}

function _closestCard(anchor) {
  let node = anchor;
  for (let index = 0; node && index < 8; index += 1, node = node.parentElement) {
    const content = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (content.length > 80 && content.length < 3000) return node;
  }
  return anchor.closest("article,li,[role='listitem']") || anchor.parentElement;
}

function _bestTitle(card, fallback) {
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  return text(card?.querySelector("h1,h2,h3,[role='heading']")) || fallback || "";
}

function _bestCompany(card) {
  const labelled = [...(card?.querySelectorAll("[aria-label], [title]") || [])]
    .map((node) => node.getAttribute("aria-label") || node.getAttribute("title") || "")
    .find((value) => value && !/job|apply|save|share/i.test(value));
  return labelled || "";
}

function _bestLine(lines, pattern) {
  return lines.find((line) => pattern.test(line)) || "";
}

function collectValues(args, flags) {
  const values = [];
  for (const flag of flags) {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === flag && args[index + 1]) values.push(...normalizeList(args[index + 1]));
    }
  }
  return values;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function normalizeList(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function slug(value) {
  return (
    String(value || "search-sources")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "search-sources"
  );
}

function helpText() {
  return `Usage:
  npm run capture:search-sources -- --provider hiringcafe --source hiringcafe --login --browser chrome
  npm run capture:search-sources -- --url "https://hiring.cafe/..." --provider hiringcafe --source hiringcafe

Options:
  --config FILE          Search source config. Default: config/search-sources.yml.
  --provider NAME        Only capture sources from hiringcafe, linkedin, or generic.
  --id ID                Only capture a configured source id. Repeat or comma-separate.
  --source-id ID         Alias for --id.
  --include-disabled     Include disabled configured sources, useful for LinkedIn.
  --source NAME          Output source label. Default: provider filter, else search-sources.
  --url URL              Capture one explicit URL instead of config.
  --label TEXT           Label for --url captures.
  --login                Pause once per provider so you can log in / verify filters.
  --manual               Pause before every configured source capture.
  --browser NAME         Playwright channel. Use chrome for saved auth. Default: chromium.
  --headless             Run without a visible browser.
  --profile-root DIR     Persistent profile root. Default: ~/.careerrat/board-profiles
                         (falls back to ~/.rolester/board-profiles if that's where your
                         signed-in profiles already live).
  --per-source-limit N   Max offers per source. Default: 250.
  --limit N              Max offers in the combined snapshot. Default: unlimited.
  --scroll-pages N       Scroll result pages before extraction. Default: 0.
  --out FILE             Output JSON file. Default: scan-results/<source>-browser-<timestamp>.json.
  --ingest               After capture, write offers to SQLite sourced rows and JD artifacts.

After capture:
  DB workspaces: use --ingest so captured offers become sourced rows immediately.
  Legacy workspaces: npm run delta:sourced -- --source <source>-browser --repo-new-only --write
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
