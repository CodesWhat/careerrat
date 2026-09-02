// tests/providers/itviec.test.mjs: new fixture authored 2026-09-02 for the
// ffb49be1 vendor roll, when itviec was added upstream. Sample HTML below is
// invented and domain-neutral (no real employers, no real people).

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider: itviec");

try {
  const mod = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/itviec.mjs")).href
  );
  const provider = mod.default;
  const {
    visibleText,
    cityPath,
    buildListUrl,
    parsePostedAt,
    parseListingPage,
    assertParsedSomething,
  } = mod;

  if (provider.id === "itviec") pass('itviec.id is "itviec"');
  else fail(`itviec.id is ${JSON.stringify(provider.id)}`);

  // visibleText strips tags/comments, decodes entities, collapses whitespace.
  const text = visibleText("  We&#x27;re <b>hiring</b><!-- note --> \n engineers  ");
  if (text === "We're hiring engineers")
    pass("visibleText strips markup/comments and collapses whitespace");
  else fail(`visibleText result = ${JSON.stringify(text)}`);

  // cityPath recognizes aliases (exact + substring), unknown -> null, and a
  // prototype-pollution-shaped key must resolve to null.
  if (cityPath("hcm") === "ho-chi-minh-hcm" && cityPath("Hà Nội") === "ha-noi") {
    pass("cityPath resolves recognized city aliases");
  } else {
    fail(`cityPath aliases = ${JSON.stringify([cityPath("hcm"), cityPath("Hà Nội")])}`);
  }
  if (cityPath("Singapore") === null && cityPath("toString") === null) {
    pass(
      "cityPath returns null for an unrecognized city and guards inherited Object.prototype members"
    );
  } else {
    fail(`cityPath unknown = ${JSON.stringify([cityPath("Singapore"), cityPath("toString")])}`);
  }

  // buildListUrl builds the board default, keyword, keyword+city, page > 1.
  const bare = buildListUrl(undefined, 1);
  const keywordOnly = buildListUrl({ searchKeywords: "Widget Engineer" }, 1);
  const keywordCity = buildListUrl({ searchKeywords: "Widget Engineer", searchLocation: "hcm" }, 1);
  const page2 = buildListUrl(undefined, 2);
  if (
    bare === "https://itviec.com/it-jobs" &&
    keywordOnly === "https://itviec.com/it-jobs/widget-engineer" &&
    keywordCity === "https://itviec.com/it-jobs/widget-engineer/ho-chi-minh-hcm" &&
    page2 === "https://itviec.com/it-jobs?page=2"
  ) {
    pass(
      "buildListUrl builds board default / keyword / keyword+city URLs and appends ?page for page > 1"
    );
  } else {
    fail(`buildListUrl = ${JSON.stringify({ bare, keywordOnly, keywordCity, page2 })}`);
  }

  // parsePostedAt maps relative labels, pinned to a fixed "now" for determinism.
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  if (
    parsePostedAt("today", now) === now &&
    parsePostedAt("2 days ago", now) === now - 2 * 86_400_000 &&
    parsePostedAt("1 week ago", now) === now - 7 * 86_400_000 &&
    parsePostedAt("unrecognized", now) === undefined
  ) {
    pass(
      "parsePostedAt maps today/day/week labels relative to now and returns undefined when unparseable"
    );
  } else {
    fail(
      `parsePostedAt = ${JSON.stringify({
        today: parsePostedAt("today", now),
        days: parsePostedAt("2 days ago", now),
        weeks: parsePostedAt("1 week ago", now),
        unknown: parsePostedAt("unrecognized", now),
      })}`
    );
  }

  // parseListingPage: full card mapping; the FIRST /companies/ link with text
  // wins (a leading logo-only link with no text must be skipped, not picked).
  const card = (slug) => `
    <div data-search--job-selection-job-slug-value="${slug}">
      <h3 data-search--job-selection-target="jobTitle"><a href="/it-jobs/${slug}">Widget Engineer</a></h3>
      <a href="/companies/logo/${slug}"></a>
      <a href="/companies/acme-vietnam">Acme Vietnam</a>
      <svg><use href="#map-pin"></use></svg><div title="Ho Chi Minh"></div>
      <span>Posted: 2 days ago</span>
    </div>`;
  const page = parseListingPage(card("widget-engineer-2001"));
  if (
    page.length === 1 &&
    page[0].title === "Widget Engineer" &&
    page[0].url === "https://itviec.com/it-jobs/widget-engineer-2001" &&
    page[0].company === "Acme Vietnam" &&
    page[0].location === "Ho Chi Minh"
  ) {
    pass(
      "parseListingPage maps title/url/company/location and skips the text-less logo anchor for company"
    );
  } else {
    fail(`parseListingPage full row = ${JSON.stringify(page[0])}`);
  }

  const droppedCard = `<div data-search--job-selection-job-slug-value="empty-9001"></div>`;
  const droppedPage = parseListingPage(droppedCard);
  if (droppedPage.length === 0) pass("parseListingPage drops a card with no title anchor");
  else fail(`parseListingPage dropped-card result = ${JSON.stringify(droppedPage)}`);

  // assertParsedSomething throws only when card-shaped hrefs exist but
  // nothing parsed; a page with none at all must not throw.
  let threwOnBrokenParser = false;
  try {
    assertParsedSomething(droppedCard, "https://itviec.com/it-jobs");
  } catch {
    threwOnBrokenParser = true;
  }
  if (!threwOnBrokenParser)
    pass("assertParsedSomething does not throw when no card-shaped href is present");
  else fail("assertParsedSomething incorrectly threw on a page with no card markers");

  let threwOnMarkupChange = false;
  try {
    assertParsedSomething(
      `<a href="/it-jobs/widget-engineer-2001">x</a>`,
      "https://itviec.com/it-jobs"
    );
  } catch {
    threwOnMarkupChange = true;
  }
  if (threwOnMarkupChange) {
    pass(
      "assertParsedSomething throws when a card-shaped href exists but the card parser found nothing"
    );
  } else {
    fail(
      "assertParsedSomething did not throw on markup carrying a card-shaped href with nothing parsed"
    );
  }

  // fetch() walks pages until an empty one, dedupes by url, pins redirect:error.
  const pages = { 1: card("widget-engineer-3001"), 2: "" };
  const requested = [];
  const jobs = await provider.fetch(
    { name: "ITviec Co" },
    {
      transport: "http",
      sleep: async () => {},
      fetchText: async (url, opts) => {
        requested.push({ url, redirect: opts?.redirect });
        const page = new URL(url).searchParams.get("page") === "2" ? 2 : 1;
        return pages[page];
      },
    }
  );
  if (
    jobs.length === 1 &&
    jobs[0].url === "https://itviec.com/it-jobs/widget-engineer-3001" &&
    requested.length === 2 &&
    requested.every((r) => r.redirect === "error")
  ) {
    pass('itviec.fetch walks pages until an empty one and sends redirect:"error"');
  } else {
    fail(
      `itviec.fetch pagination = ${JSON.stringify({ count: jobs.length, urls: requested.map((r) => r.url) })}`
    );
  }

  // A first page carrying card-shaped hrefs but nothing parseable must throw.
  let threwOnFetch = false;
  try {
    await provider.fetch(
      { name: "ITviec Co" },
      {
        transport: "http",
        sleep: async () => {},
        fetchText: async () => `<a href="/it-jobs/widget-engineer-2001">x</a>`,
      }
    );
  } catch {
    threwOnFetch = true;
  }
  if (threwOnFetch) pass("itviec.fetch throws when page 1 has card-shaped markup but none parse");
  else fail("itviec.fetch did not throw on an unparseable first page");
} catch (e) {
  fail(`itviec provider test crashed: ${e?.message}`);
}
