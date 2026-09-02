// tests/providers/careerviet.test.mjs: new fixture authored 2026-09-02 for
// the ffb49be1 vendor roll, when careerviet was added upstream. Sample HTML
// below is invented and domain-neutral (no real employers, no real people).

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider: careerviet");

try {
  const mod = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/careerviet.mjs")).href
  );
  const provider = mod.default;
  const {
    visibleText,
    citySegment,
    buildListUrl,
    parsePostedAt,
    parseListingPage,
    assertParsedSomething,
  } = mod;

  if (provider.id === "careerviet") pass('careerviet.id is "careerviet"');
  else fail(`careerviet.id is ${JSON.stringify(provider.id)}`);

  // visibleText strips tags/comments, decodes entities, collapses whitespace.
  const text = visibleText("  Ho&#x27;s   <b>team</b><!-- note -->  builds\nwidgets  ");
  if (text === "Ho's team builds widgets")
    pass("visibleText strips markup/comments and collapses whitespace");
  else fail(`visibleText result = ${JSON.stringify(text)}`);

  // citySegment recognizes aliases (own-property + substring match), unknown -> null,
  // and a prototype-pollution-shaped key must resolve to null, not an inherited member.
  const cities = [citySegment("hcm"), citySegment("Hồ Chí Minh"), citySegment(" HCM city ")];
  if (cities.every((c) => c === "tai-ho-chi-minh-kl8")) {
    pass("citySegment recognizes hcm / Hồ Chí Minh aliases (exact + substring)");
  } else {
    fail(`citySegment aliases = ${JSON.stringify(cities)}`);
  }
  if (citySegment("Hanoi") === null && citySegment("") === null) {
    pass("citySegment returns null for an unrecognized or empty location");
  } else {
    fail(`citySegment unknown = ${JSON.stringify([citySegment("Hanoi"), citySegment("")])}`);
  }
  if (citySegment("constructor") === null) {
    pass("citySegment guards against inherited Object.prototype members");
  } else {
    fail(`citySegment("constructor") = ${JSON.stringify(citySegment("constructor"))}`);
  }

  // buildListUrl builds the board default, keyword-only, keyword+city, and page > 1 suffix.
  const bare = buildListUrl(undefined, 1);
  const keywordOnly = buildListUrl({ searchKeywords: "Widget Engineer" }, 1);
  const keywordCity = buildListUrl({ searchKeywords: "Widget Engineer", searchLocation: "hcm" }, 1);
  const cityOnlyDropped = buildListUrl({ searchLocation: "hcm" }, 1);
  const page2 = buildListUrl(undefined, 2);
  if (
    bare === "https://careerviet.vn/viec-lam/tat-ca-viec-lam-vi.html" &&
    keywordOnly === "https://careerviet.vn/viec-lam/widget-engineer-k-vi.html" &&
    keywordCity === "https://careerviet.vn/viec-lam/widget-engineer-tai-ho-chi-minh-kl8-vi.html" &&
    cityOnlyDropped === "https://careerviet.vn/viec-lam/tat-ca-viec-lam-vi.html" &&
    page2 === "https://careerviet.vn/viec-lam/tat-ca-viec-lam-trang-2-vi.html"
  ) {
    pass(
      "buildListUrl builds board default / keyword / keyword+city URLs and drops a city with no keyword"
    );
  } else {
    fail(
      `buildListUrl = ${JSON.stringify({ bare, keywordOnly, keywordCity, cityOnlyDropped, page2 })}`
    );
  }

  // parsePostedAt parses careerviet's own DD-MM-YYYY format at UTC+7; unparseable -> undefined.
  const posted = parsePostedAt("15-08-2026");
  if (posted === Date.parse("2026-08-15T00:00:00+07:00")) {
    pass("parsePostedAt parses DD-MM-YYYY at Vietnam's UTC+7 offset");
  } else {
    fail(`parsePostedAt(15-08-2026) = ${posted}`);
  }
  if (parsePostedAt("not a date") === undefined) {
    pass("parsePostedAt returns undefined for an unparseable date rather than fabricating one");
  } else {
    fail(`parsePostedAt(not a date) = ${parsePostedAt("not a date")}`);
  }

  // parseListingPage: full card mapping, "first job_link anchor wins" (the
  // second identically-classed anchor further down the same card must not
  // override title/url), and a malformed card is dropped without throwing.
  const card = (id, extra = "") => `
    <div id="job-item-${id}" class="job-item">
      <a class="job_link" title="Widget Engineer" href="/viec-lam/widget-engineer-${id}-vi.html">Widget Engineer</a>
      <a class="company-name" title="Acme Vietnam">Acme Vietnam</a>
      <div class="location"><li>Hồ Chí Minh</li></div>
      <div class="time">Cập nhật: <time>15-08-2026</time></div>
      ${extra}
      <a class="job_link" title="Widget Engineer (salary block)" href="/viec-lam/widget-engineer-${id}-vi.html">1.000 - 2.000 USD</a>
    </div>`;
  const page = parseListingPage(card("1001") + card("1002"));
  if (
    page.length === 2 &&
    page[0].title === "Widget Engineer" &&
    page[0].url === "https://careerviet.vn/viec-lam/widget-engineer-1001-vi.html" &&
    page[0].company === "Acme Vietnam" &&
    page[0].location === "Hồ Chí Minh" &&
    page[0].postedAt === Date.parse("2026-08-15T00:00:00+07:00")
  ) {
    pass(
      "parseListingPage maps title/url/company/location/postedAt and uses the FIRST job_link anchor"
    );
  } else {
    fail(`parseListingPage full row = ${JSON.stringify(page[0])}`);
  }

  const droppedCard = `<div id="job-item-9001"></div>`;
  const droppedPage = parseListingPage(droppedCard);
  if (droppedPage.length === 0) pass("parseListingPage drops a card with no title/href match");
  else fail(`parseListingPage dropped-card result = ${JSON.stringify(droppedPage)}`);

  // assertParsedSomething throws only when card markers are present but
  // nothing parsed; a page with no markers at all (e.g. a "no results" page)
  // must not throw.
  let threwOnBrokenParser = false;
  try {
    assertParsedSomething(droppedCard, "https://careerviet.vn/viec-lam/tat-ca-viec-lam-vi.html");
  } catch {
    threwOnBrokenParser = true;
  }
  if (threwOnBrokenParser)
    pass("assertParsedSomething throws when card markers exist but nothing parsed");
  else
    fail("assertParsedSomething did not throw on a page with card markers but no parseable card");

  let threwOnEmptyBoard = false;
  try {
    assertParsedSomething("<html><body>no jobs today</body></html>", "https://careerviet.vn/x");
  } catch {
    threwOnEmptyBoard = true;
  }
  if (!threwOnEmptyBoard)
    pass("assertParsedSomething does not throw on a page with no card markers at all");
  else fail("assertParsedSomething incorrectly threw on a markerless page");

  // fetch() walks pages until an empty one, dedupes by url, pins redirect:error.
  const pages = {
    1: card("2001"),
    2: "",
  };
  const requested = [];
  const jobs = await provider.fetch(
    { name: "CareerViet Co" },
    {
      transport: "http",
      sleep: async () => {},
      fetchText: async (url, opts) => {
        requested.push({ url, redirect: opts?.redirect });
        const page = new URL(url).pathname.includes("trang-2") ? 2 : 1;
        return pages[page];
      },
    }
  );
  if (
    jobs.length === 1 &&
    jobs[0].url === "https://careerviet.vn/viec-lam/widget-engineer-2001-vi.html" &&
    requested.length === 2 &&
    requested.every((r) => r.redirect === "error")
  ) {
    pass('careerviet.fetch walks pages until an empty one and sends redirect:"error"');
  } else {
    fail(
      `careerviet.fetch pagination = ${JSON.stringify({ count: jobs.length, urls: requested.map((r) => r.url) })}`
    );
  }

  // A first page with card markers but nothing parseable must throw, not
  // silently return [].
  let threwOnFetch = false;
  try {
    await provider.fetch(
      { name: "CareerViet Co" },
      { transport: "http", sleep: async () => {}, fetchText: async () => droppedCard }
    );
  } catch {
    threwOnFetch = true;
  }
  if (threwOnFetch) pass("careerviet.fetch throws when page 1 has cards but none parse");
  else fail("careerviet.fetch did not throw on an unparseable first page");
} catch (e) {
  fail(`careerviet provider test crashed: ${e?.message}`);
}
