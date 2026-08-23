// tests/providers/jobbankca.test.mjs — new fixture authored 2026-08-23 when
// jobbankca moved out of CAREER_OPS_DEFERRED_PROVIDER_IDS. Sample payloads
// below are invented and domain-neutral (no real employers, no real people) —
// this provider's own Atom feed carries real third-party posting content, so
// nothing here is a captured live sample.

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider — jobbankca");

try {
  const jobbankcaModule = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/jobbankca.mjs")).href
  );
  const jobbankca = jobbankcaModule.default;
  const { parseJobBankConfig, buildFeedUrl, assertJobBankUrl, parseJobBankFeed } = jobbankcaModule;

  if (jobbankca.id === "jobbankca") pass('jobbankca.id is "jobbankca"');
  else fail(`jobbankca.id is ${JSON.stringify(jobbankca.id)}`);

  // detect(): explicit provider selection only, like every board-wide provider.
  const hit = jobbankca.detect({ name: "Job Bank", provider: "jobbankca" });
  if (hit && hit.url === "https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed") {
    pass("jobbankca.detect() claims explicit provider: jobbankca config");
  } else {
    fail(`jobbankca.detect() returned ${JSON.stringify(hit)}`);
  }
  if (jobbankca.detect({ name: "Other", provider: "vdab" }) === null) {
    pass("jobbankca.detect() ignores other provider ids");
  } else {
    fail("jobbankca.detect() should only claim provider: jobbankca");
  }

  // parseJobBankConfig — sanitizes keywords.
  const cfg = parseJobBankConfig({
    jobbankca: { keywords: ["  logistics coordinator  ", "nurse", "", 42] },
  });
  if (JSON.stringify(cfg.keywords) === JSON.stringify(["logistics coordinator", "nurse"])) {
    pass("parseJobBankConfig trims keywords and drops blank/non-string entries");
  } else {
    fail(`parseJobBankConfig returned ${JSON.stringify(cfg)}`);
  }
  if (
    parseJobBankConfig({}).keywords.length === 0 &&
    parseJobBankConfig({ jobbankca: {} }).keywords.length === 0
  ) {
    pass("parseJobBankConfig defaults to no keywords when the block or array is absent");
  } else {
    fail("parseJobBankConfig should default to an empty keywords array");
  }

  // buildFeedUrl — searchstring/page/locationstring shape.
  const built = new URL(buildFeedUrl("warehouse supervisor", 2));
  if (
    built.origin + built.pathname === "https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed" &&
    built.searchParams.get("searchstring") === "warehouse supervisor" &&
    built.searchParams.get("page") === "2" &&
    built.searchParams.get("locationstring") === ""
  ) {
    pass("buildFeedUrl builds the pinned feed URL with searchstring/page/locationstring");
  } else {
    fail(`buildFeedUrl returned ${built.href}`);
  }

  // assertJobBankUrl — host guard.
  try {
    assertJobBankUrl("https://evil.example.com/jobsearch/feed/jobSearchRSSfeed");
    fail("assertJobBankUrl() should throw for a non-jobbank.gc.ca host");
  } catch (err) {
    if (/untrusted hostname/.test(err.message))
      pass("assertJobBankUrl() throws for an untrusted hostname");
    else fail(`assertJobBankUrl() threw an unexpected error: ${err.message}`);
  }
  try {
    assertJobBankUrl("http://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed");
    fail("assertJobBankUrl() should throw for a non-HTTPS URL");
  } catch (err) {
    if (/must use HTTPS/.test(err.message)) pass("assertJobBankUrl() throws for a non-HTTPS URL");
    else fail(`assertJobBankUrl() threw an unexpected error: ${err.message}`);
  }

  // parseJobBankFeed — invented Atom sample, domain-neutral (logistics/health
  // roles rather than a tech default), covering: entity decoding in the
  // title, Employer/Location extracted from the summary CDATA labels,
  // postedAt from <updated>, and the three drop cases (no link, no title,
  // off-host link).
  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <title><![CDATA[logistics - Job Bank]]></title>
  <entry>
    <title type="html"><![CDATA[warehouse supervisor]]></title>
    <link rel="alternate" type="text/html" href="https://www.jobbank.gc.ca/jobsearch/jobposting/50123456"/>
    <id>https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed?id=1</id>
    <updated>2026-08-20T17:00:00Z</updated>
    <summary type="html"><![CDATA[<strong>Job number:</strong> 1<br /><strong>Location:</strong> Toronto (ON)  <br /><strong>Employer:</strong> Harborview Logistics Ltd<br /><strong>Salary:</strong> $55,000.00 to $65,000.00 annually]]></summary>
  </entry>
  <entry>
    <title type="html">registered nurse, R&amp;D clinic</title>
    <link rel="alternate" type="text/html" href="https://www.jobbank.gc.ca/jobsearch/jobposting/50120001"/>
    <id>https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed?id=2</id>
    <updated>2026-08-20T09:00:00Z</updated>
    <summary type="html"><![CDATA[<strong>Job number:</strong> 2<br /><strong>Location:</strong> Montréal (QC)  <br /><strong>Employer:</strong> Meridian Health Services]]></summary>
  </entry>
  <entry>
    <title type="html"><![CDATA[dropped: no link]]></title>
    <id>https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed?id=3</id>
    <updated>2026-08-20T08:00:00Z</updated>
    <summary type="html"><![CDATA[<strong>Location:</strong> Nowhere]]></summary>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://www.jobbank.gc.ca/jobsearch/jobposting/50120002"/>
    <id>https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed?id=4</id>
    <updated>2026-08-20T08:00:00Z</updated>
    <summary type="html"><![CDATA[dropped: no title]]></summary>
  </entry>
  <entry>
    <title type="html"><![CDATA[dropped: off-host link]]></title>
    <link rel="alternate" type="text/html" href="https://example.com/jobsearch/jobposting/1"/>
    <id>https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed?id=5</id>
    <updated>2026-08-20T08:00:00Z</updated>
    <summary type="html"><![CDATA[<strong>Location:</strong> Elsewhere]]></summary>
  </entry>
</feed>`;

  const jobs = parseJobBankFeed(sample);
  if (jobs.length === 2)
    pass("parseJobBankFeed keeps 2 entries (drops missing-link/title/off-host)");
  else fail(`parseJobBankFeed returned ${jobs.length} jobs (expected 2): ${JSON.stringify(jobs)}`);

  if (
    jobs[0]?.title === "warehouse supervisor" &&
    jobs[0]?.company === "Harborview Logistics Ltd" &&
    jobs[0]?.location === "Toronto (ON)" &&
    jobs[0]?.url === "https://www.jobbank.gc.ca/jobsearch/jobposting/50123456"
  ) {
    pass("parseJobBankFeed maps title/company/location/url from the entry (offer mapping)");
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }
  if (jobs[0]?.postedAt === Date.parse("2026-08-20T17:00:00Z")) {
    pass("parseJobBankFeed parses <updated> to postedAt");
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }
  if (jobs[1]?.title === "registered nurse, R&D clinic") {
    pass("parseJobBankFeed decodes entities in the title (R&amp;D -> R&D)");
  } else {
    fail(`row 1 title = ${JSON.stringify(jobs[1]?.title)}`);
  }
  if (jobs[1]?.location === "Montréal (QC)" && jobs[1]?.company === "Meridian Health Services") {
    pass(
      "parseJobBankFeed extracts fields correctly when Salary is absent (label order preserved)"
    );
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  // fetch() — pagination, pacing, dedup, SSRF-guard headers.
  const fullPage = Array.from(
    { length: 100 },
    (_, i) =>
      `<entry><title><![CDATA[role ${i}]]></title><link rel="alternate" href="https://www.jobbank.gc.ca/jobsearch/jobposting/${i}"/><id>id-${i}</id><updated>2026-08-20T08:00:00Z</updated><summary><![CDATA[<strong>Location:</strong> X]]></summary></entry>`
  ).join("");
  const shortPage =
    '<entry><title><![CDATA[role 100]]></title><link rel="alternate" href="https://www.jobbank.gc.ca/jobsearch/jobposting/100"/><id>id-100</id><updated>2026-08-20T08:00:00Z</updated><summary><![CDATA[<strong>Location:</strong> X]]></summary></entry>';
  const feed = (body) => `<?xml version="1.0"?><feed>${body}</feed>`;

  const requested = [];
  let slept = 0;
  let capturedOpts = null;
  const fetched = await jobbankca.fetch(
    { provider: "jobbankca", name: "Pagination test", jobbankca: { keywords: ["logistics"] } },
    {
      sleep: async (ms) => {
        slept += ms;
      },
      fetchText: async (url, opts) => {
        requested.push(url);
        capturedOpts = opts;
        const page = new URL(url).searchParams.get("page");
        return page === "1" ? feed(fullPage) : feed(shortPage);
      },
    }
  );
  if (requested.length === 2)
    pass("jobbankca.fetch() paginates: a full (100-entry) page requests the next one");
  else fail(`jobbankca.fetch() made ${requested.length} requests (expected 2)`);
  if (fetched.length === 101)
    pass("jobbankca.fetch() stops after a short page and returns all collected jobs");
  else fail(`jobbankca.fetch() returned ${fetched.length} jobs (expected 101)`);
  if (slept >= 2 * 5000)
    pass("jobbankca.fetch() sleeps at least 5000ms (robots.txt Crawl-delay) before each request");
  else fail(`jobbankca.fetch() only slept ${slept}ms total for 2 requests`);
  if (capturedOpts?.redirect === "error" && capturedOpts?.headers?.["User-Agent"]) {
    pass(
      "jobbankca.fetch() sends redirect:error and a User-Agent header (SSRF-via-redirect guard)"
    );
  } else {
    fail(`jobbankca.fetch() request hygiene: ${JSON.stringify(capturedOpts)}`);
  }

  // fetch() — recall-first: one failed keyword does not abort the others.
  const okFeed = feed(
    '<entry><title><![CDATA[ok]]></title><link rel="alternate" href="https://www.jobbank.gc.ca/jobsearch/jobposting/1"/><id>1</id><updated>2026-08-20T08:00:00Z</updated><summary><![CDATA[x]]></summary></entry>'
  );
  const partial = await jobbankca.fetch(
    { provider: "jobbankca", name: "Partial failure", jobbankca: { keywords: ["bad", "good"] } },
    {
      sleep: async () => {},
      fetchText: async (url) => {
        if (url.includes("searchstring=bad")) throw new Error("network error");
        return okFeed;
      },
    }
  );
  if (partial.length === 1 && partial[0].title === "ok") {
    pass("jobbankca.fetch(): a failed keyword does not abort keywords that still succeed");
  } else {
    fail(`jobbankca.fetch() with one failing keyword returned ${JSON.stringify(partial)}`);
  }

  // fetch() — total outage throws.
  try {
    await jobbankca.fetch(
      { provider: "jobbankca", name: "Outage", jobbankca: { keywords: ["a", "b"] } },
      {
        sleep: async () => {},
        fetchText: async () => {
          throw new Error("boom");
        },
      }
    );
    fail("jobbankca.fetch() should throw when every keyword request fails");
  } catch (err) {
    if (/all 2 keyword request\(s\) failed/.test(err.message)) {
      pass("jobbankca.fetch() throws when every keyword fails (total outage)");
    } else {
      fail(`jobbankca.fetch() threw an unexpected error on total outage: ${err.message}`);
    }
  }
} catch (e) {
  fail(`jobbankca provider tests crashed: ${e.message}`);
}
