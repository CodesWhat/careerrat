#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

import { chromium as defaultChromium } from "playwright";

import { defaultProfileRoot } from "../src/core/automation/session.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { captureAndPersistOffersIfDb } from "../src/core/scoring/sourced-persistence.mjs";
import { extractReqId } from "../src/core/scoring/sourced-scanner.mjs";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function defaultUrl(providerName) {
  if (providerName === "hiringcafe") return "https://hiring.cafe/";
  if (providerName === "linkedin") return "https://www.linkedin.com/jobs/";
  return "about:blank";
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

// Prints a bounded failed-id list and exits nonzero without touching the
// snapshot file or any row captureAndPersistOffersIfDb already committed
// (CR-29 round 6): a JD artifact-write failure aborts only the offers it
// touched before the DB transaction ever opens, so the snapshot above and
// every successfully persisted row stay intact for a rerun.
export function reportIngestFailure(result) {
  const shown = (result.failedIds || []).slice(0, 10);
  console.error(
    `Failed to persist ${result.failed} offer(s): ${shown.join(", ")}${
      result.failedIds.length > shown.length ? ", ..." : ""
    }`
  );
  console.error(
    "The snapshot file above and every successfully committed row are still intact; rerun with --ingest once the failure is fixed."
  );
  process.exitCode = 1;
}

function helpText(profileRoot) {
  return `Usage:
  npm run capture:board -- --provider hiringcafe --url "https://hiring.cafe/..." --login --browser chrome
  npm run capture:board -- --provider linkedin --url "https://www.linkedin.com/jobs/search/?keywords=..." --login --browser chrome

Options:
  --provider hiringcafe|linkedin|generic
  --url URL             Saved-search or search-results URL to open.
  --login              Open headed browser and wait for you to log in / set filters.
  --manual             Same as --login.
  --no-manual          Do not pause for login/filter adjustment.
  --limit N            Max offers to keep. Default: 250.
  --browser NAME       Playwright browser channel. Use "chrome" for Google OAuth. Default: chromium.
  --profile-root DIR   Persistent browser profile root. Default: ${profileRoot}
  --out FILE           Output JSON file. Default: scan-results/<provider>-browser-<timestamp>.json.
  --ingest             After capture, write offers to SQLite sourced rows and JD artifacts.

Workflow:
  1. Run with --login the first time for each provider.
  2. Log in and select the saved search / last-24-hours filters in the opened browser.
  3. Press Enter in this terminal when the results list is ready.
  4. Use --ingest in DB workspaces so captured offers become sourced rows immediately.
     In legacy workspaces, commit the generated scan-results JSON if it should become the next delta baseline.
`;
}

export async function runCli(
  argv = process.argv.slice(2),
  { chromiumModule = defaultChromium } = {}
) {
  const args = argv;
  const provider = (valueAfter(args, "--provider") || "generic").toLowerCase();
  const url = valueAfter(args, "--url") || defaultUrl(provider);
  const waitForUser =
    args.includes("--login") || args.includes("--manual") || !args.includes("--no-manual");
  const limit = Number(valueAfter(args, "--limit") || 250);
  const outPath = valueAfter(args, "--out");
  const ingest = args.includes("--ingest");
  const profileRoot =
    valueAfter(args, "--profile-root") || defaultProfileRoot({ repoRoot: ROOT, env: process.env });
  const browserChannel = (
    valueAfter(args, "--browser") ||
    valueAfter(args, "--channel") ||
    process.env.BOARD_BROWSER ||
    "chromium"
  ).toLowerCase();

  if (args.includes("--help")) {
    console.log(helpText(profileRoot));
    return;
  }

  const scanResultsDir = userPath({ repoRoot: ROOT }, "workspace/scan-results");
  mkdirSync(scanResultsDir, { recursive: true });
  mkdirSync(profileRoot, { recursive: true });

  const userDataDir = join(profileRoot, provider);
  const launchOptions = {
    headless: false,
    viewport: { width: 1440, height: 1100 },
  };
  if (browserChannel !== "chromium") {
    launchOptions.channel = browserChannel;
  }
  const context = await chromiumModule.launchPersistentContext(userDataDir, {
    ...launchOptions,
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    if (waitForUser) {
      const rl = createInterface({ input, output });
      await rl.question(
        `Log in / choose saved search / set last-24h filters for ${provider}, then press Enter here to capture...`
      );
      rl.close();
    }

    await settle(page);
    const offers = await extractOffers(page, provider);
    const now = new Date();
    const snapshot = {
      source: `${provider}-playwright`,
      provider,
      generatedAt: now.toISOString(),
      url: page.url(),
      scanned: offers.length,
      offers: offers.slice(0, limit).map((offer) => {
        const req = extractReqId(offer.url || offer.hiringCafeUrl || "");
        return {
          ...offer,
          source: `${provider}-playwright`,
          reqId: offer.reqId || req.id || "",
        };
      }),
    };

    const out = outPath || join(scanResultsDir, `${provider}-browser-${timestamp(now)}.json`);
    writeFileSync(out, JSON.stringify(snapshot, null, 2));
    console.log(`Wrote ${out}`);
    console.log(`Captured ${snapshot.offers.length} offers from ${provider}`);
    if (ingest) {
      const result = captureAndPersistOffersIfDb({
        repoRoot: ROOT,
        offers: snapshot.offers,
        savedAt: now,
        dedupeCanonical: true,
      });
      if (!result) throw new Error("capture ingest requires a CareerRat SQLite database");
      console.log(`Ingested ${result.persistedRows} captured offers into SQLite sourced rows`);
      if (!result.ok) reportIngestFailure(result);
    }
  } finally {
    await context.close();
  }
}

// NOTE: The DOM extractors below (extractLinkedIn, extractHiringCafe, extractGeneric) have
// counterparts in capture-search-sources.mjs. They cannot be shared as an import because
// page.evaluate() requires inline serializable functions. Keep both files in sync manually.
async function extractOffers(page, providerName) {
  if (providerName === "linkedin") return page.evaluate(extractLinkedIn);
  if (providerName === "hiringcafe") return page.evaluate(extractHiringCafe);
  return page.evaluate(extractGeneric);
}

async function settle(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch {}
  await page.waitForTimeout(800);
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
      .split(/ (?=[A-Z][A-Za-z0-9&.,'’()/+-]*(?:\s|$))/)
      .map((line) => line.trim())
      .filter(Boolean);
    const heading = text(card?.querySelector('h1,h2,h3,[role="heading"]')) || text(anchor);
    const external = card?.querySelector('a[href^="http"]:not([href*="hiring.cafe"])');
    offers.push({
      company: bestCompany(card, heading),
      title: bestTitle(card, heading),
      url: external ? abs(external.href) : hiringCafeUrl,
      hiringCafeUrl,
      location: bestLine(
        lines,
        /\b(remote|united states|new york|nyc|san francisco|austin|seattle|hybrid)\b/i
      ),
      comp: bestLine(lines, /\$\s?\d|\b\d{3},000\b/),
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
  const anchors = [...document.querySelectorAll("a[href]")].filter((a) =>
    /job|career|position|opening/i.test(`${a.href} ${text(a)}`)
  );
  const seen = new Set();
  const offers = [];
  for (const anchor of anchors) {
    const url = abs(anchor.href).replace(/#.*$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    const card = closestCard(anchor);
    const title = text(anchor) || text(card?.querySelector('h1,h2,h3,[role="heading"]'));
    offers.push({ company: "", title, url, location: "", rawText: text(card).slice(0, 500) });
  }
  return offers.filter((offer) => offer.url && offer.title);
}

function closestCard(anchor) {
  let node = anchor;
  for (let i = 0; node && i < 8; i++, node = node.parentElement) {
    const t = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > 80 && t.length < 3000) return node;
  }
  return anchor.closest("article,li,[role='listitem']") || anchor.parentElement;
}

function bestTitle(card, fallback) {
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  return text(card?.querySelector('h1,h2,h3,[role="heading"]')) || fallback || "";
}

function bestCompany(card, _fallback) {
  const _text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const labelled = [...(card?.querySelectorAll("[aria-label], [title]") || [])]
    .map((node) => node.getAttribute("aria-label") || node.getAttribute("title") || "")
    .find((value) => value && !/job|apply|save|share/i.test(value));
  return labelled || "";
}

function bestLine(lines, pattern) {
  return lines.find((line) => pattern.test(line)) || "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
