// tests/providers/mycareersfuture.test.mjs — new fixture authored 2026-08-23
// when mycareersfuture moved out of CAREER_OPS_DEFERRED_PROVIDER_IDS. Sample
// payloads below are invented and domain-neutral (no real employers, no real
// people) — this provider's own search API carries real third-party posting
// content, so nothing here is a captured live sample.

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider — mycareersfuture");

try {
  const mcfModule = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/mycareersfuture.mjs")).href
  );
  const mycareersfuture = mcfModule.default;
  const { parseConfig, cleanUrl, normalizeJob } = mcfModule;

  if (mycareersfuture.id === "mycareersfuture") pass('mycareersfuture.id is "mycareersfuture"');
  else fail(`mycareersfuture.id is ${JSON.stringify(mycareersfuture.id)}`);

  const hit = mycareersfuture.detect({ name: "MCF", provider: "mycareersfuture" });
  if (hit && hit.url === "https://api.mycareersfuture.gov.sg/v2/search") {
    pass("mycareersfuture.detect() claims explicit provider: mycareersfuture config");
  } else {
    fail(`mycareersfuture.detect() returned ${JSON.stringify(hit)}`);
  }
  if (mycareersfuture.detect({ name: "Other", provider: "vdab" }) === null) {
    pass("mycareersfuture.detect() ignores other provider ids");
  } else {
    fail("mycareersfuture.detect() should only claim provider: mycareersfuture");
  }

  // parseConfig — keyword sanitization and pacing/config metadata clamps.
  const kwCfg = parseConfig({
    mycareersfuture: { keywords: ["  warehouse supervisor  ", "nurse", "", 42] },
  });
  if (JSON.stringify(kwCfg.keywords) === JSON.stringify(["warehouse supervisor", "nurse"])) {
    pass("parseConfig trims keywords and drops blank/non-string entries");
  } else {
    fail(`parseConfig keywords = ${JSON.stringify(kwCfg.keywords)}`);
  }
  if (
    parseConfig({}).keywords.length === 0 &&
    parseConfig({ mycareersfuture: {} }).keywords.length === 0
  ) {
    pass("parseConfig defaults to no keywords when the block or array is absent");
  } else {
    fail("parseConfig should default to an empty keywords array");
  }
  if (parseConfig({ mycareersfuture: { size: 500 } }).size === 100) {
    pass("parseConfig clamps size down to the server-enforced 100 ceiling");
  } else {
    fail(
      `parseConfig({ size: 500 }).size = ${parseConfig({ mycareersfuture: { size: 500 } }).size}`
    );
  }
  if (parseConfig({}).size === 100) {
    pass("parseConfig defaults size to 100 (the max page size) when unset");
  } else {
    fail(`parseConfig({}).size = ${parseConfig({}).size} (expected 100)`);
  }
  if (parseConfig({ max_pages: 100 }).maxPages === 20) {
    pass("parseConfig clamps max_pages down to MAX_PAGES_CAP (20)");
  } else {
    fail(`parseConfig({ max_pages: 100 }).maxPages = ${parseConfig({ max_pages: 100 }).maxPages}`);
  }
  if (parseConfig({}).maxPages === 5) {
    pass("parseConfig defaults max_pages to 5 when unset");
  } else {
    fail(`parseConfig({}).maxPages = ${parseConfig({}).maxPages} (expected 5)`);
  }

  // cleanUrl — trusted-host guard, including the port/userinfo edge cases.
  const trustedUrl = "https://www.mycareersfuture.gov.sg/job/logistics/warehouse-supervisor-abc123";
  if (cleanUrl(trustedUrl) === trustedUrl) {
    pass("cleanUrl() returns a trusted https URL unchanged");
  } else {
    fail(`cleanUrl(trusted) = ${JSON.stringify(cleanUrl(trustedUrl))}`);
  }
  if (cleanUrl("https://evil.example.com/job/abc") === "") {
    pass("cleanUrl() rejects an untrusted hostname");
  } else {
    fail("cleanUrl() should reject an untrusted hostname");
  }
  if (cleanUrl("http://www.mycareersfuture.gov.sg/job/abc") === "") {
    pass("cleanUrl() rejects a non-HTTPS URL");
  } else {
    fail("cleanUrl() should reject a non-HTTPS URL");
  }
  if (cleanUrl("https://www.mycareersfuture.gov.sg:9999/job/evil") === "") {
    pass("cleanUrl() rejects a non-default port on the trusted host");
  } else {
    fail("cleanUrl() should reject a non-default port");
  }
  if (cleanUrl("https://user:pass@www.mycareersfuture.gov.sg/job/x") === "") {
    pass("cleanUrl() rejects embedded username:password credentials on the trusted host");
  } else {
    fail("cleanUrl() should reject embedded credentials");
  }
  if (
    cleanUrl("") === "" &&
    cleanUrl(null) === "" &&
    cleanUrl(undefined) === "" &&
    cleanUrl("not a url") === ""
  ) {
    pass('cleanUrl() returns "" for empty/non-string/unparseable input without throwing');
  } else {
    fail('cleanUrl() should return "" for empty/non-string/unparseable input');
  }

  // normalizeJob — offer mapping from an invented record: title/url/company/
  // location/postedAt, hiringCompany preferred over postedCompany, districts
  // joined, and the three drop cases (missing id/title/off-host url).
  const sampleRecord = {
    metadata: {
      jobPostId: "MCF-2026-000123",
      newPostingDate: "2026-08-21",
      jobDetailsUrl: "https://www.mycareersfuture.gov.sg/job/logistics/warehouse-supervisor-abc123",
    },
    address: { districts: [{ location: "Islandwide" }] },
    postedCompany: { name: "Meridian Staffing Pte Ltd" },
    hiringCompany: null,
    title: "Warehouse Supervisor",
  };
  const normalized = normalizeJob(sampleRecord);
  if (
    normalized &&
    normalized.title === "Warehouse Supervisor" &&
    normalized.url === sampleRecord.metadata.jobDetailsUrl &&
    normalized.company === "Meridian Staffing Pte Ltd" &&
    normalized.location === "Islandwide" &&
    normalized.postedAt === Date.parse("2026-08-21") &&
    normalized.id === "MCF-2026-000123"
  ) {
    pass("normalizeJob() maps title/url/company/location/postedAt/id (offer mapping)");
  } else {
    fail(`normalizeJob(sample) = ${JSON.stringify(normalized)}`);
  }

  const onBehalfRecord = {
    ...sampleRecord,
    postedCompany: { name: "Meridian Staffing Pte Ltd" },
    hiringCompany: { name: "Northbridge Logistics Pte Ltd" },
  };
  if (normalizeJob(onBehalfRecord)?.company === "Northbridge Logistics Pte Ltd") {
    pass("normalizeJob() prefers hiringCompany over postedCompany when both are present");
  } else {
    fail(
      `normalizeJob(onBehalf).company = ${JSON.stringify(normalizeJob(onBehalfRecord)?.company)}`
    );
  }

  const multiDistrictRecord = {
    ...sampleRecord,
    address: { districts: [{ location: "D01 Marina" }, { location: "D02 Tanjong Pagar" }] },
  };
  if (normalizeJob(multiDistrictRecord)?.location === "D01 Marina, D02 Tanjong Pagar") {
    pass("normalizeJob() joins multiple districts into one comma-separated location");
  } else {
    fail(
      `normalizeJob(multiDistrict).location = ${JSON.stringify(normalizeJob(multiDistrictRecord)?.location)}`
    );
  }

  if (
    normalizeJob({
      ...sampleRecord,
      metadata: { ...sampleRecord.metadata, jobPostId: undefined },
    }) === null
  ) {
    pass("normalizeJob() returns null when jobPostId is missing");
  } else {
    fail("normalizeJob() should return null when jobPostId is missing");
  }
  if (normalizeJob({ ...sampleRecord, title: "" }) === null) {
    pass("normalizeJob() returns null when title is blank");
  } else {
    fail("normalizeJob() should return null when title is blank");
  }
  if (
    normalizeJob({
      ...sampleRecord,
      metadata: { ...sampleRecord.metadata, jobDetailsUrl: "https://evil.example.com/job/1" },
    }) === null
  ) {
    pass("normalizeJob() returns null when jobDetailsUrl is off-host");
  } else {
    fail("normalizeJob() should return null when jobDetailsUrl is off-host");
  }

  // fetch() — pagination advances via the URL query string page param (not
  // the JSON body's page field), stops on a short page, dedups across
  // keywords, and sends the SSRF-guard request options.
  const record = (n) => ({
    metadata: {
      jobPostId: `id-${n}`,
      newPostingDate: "2026-08-20",
      jobDetailsUrl: `https://www.mycareersfuture.gov.sg/job/x/role-${n}`,
    },
    address: { districts: [{ location: "X" }] },
    postedCompany: { name: "Co" },
    title: `role ${n}`,
  });
  const fullPage = Array.from({ length: 100 }, (_, i) => record(i));
  const shortPage = [record(100)];

  const requestedUrls = [];
  let capturedOpts = null;
  const fetched = await mycareersfuture.fetch(
    {
      provider: "mycareersfuture",
      name: "Pagination test",
      mycareersfuture: { keywords: ["logistics"] },
    },
    {
      // sleep replaces the real backoff setTimeout fetchJsonWithRetry falls
      // back to (_http.mjs) so the suite doesn't wait — same convention as
      // ashby.conformance.mjs / jobvite.conformance.mjs.
      sleep: async () => {},
      fetchJson: async (url, opts) => {
        requestedUrls.push(url);
        capturedOpts = opts;
        const page = new URL(url).searchParams.get("page");
        return { results: page === "1" ? shortPage : fullPage };
      },
    }
  );
  if (requestedUrls.length === 2)
    pass("mycareersfuture.fetch() paginates: a full (100-entry) page requests the next one");
  else fail(`mycareersfuture.fetch() made ${requestedUrls.length} requests (expected 2)`);
  if (fetched.length === 101)
    pass("mycareersfuture.fetch() stops after a short page and returns all collected jobs");
  else fail(`mycareersfuture.fetch() returned ${fetched.length} jobs (expected 101)`);
  if (
    new URL(requestedUrls[0]).searchParams.get("page") === "0" &&
    new URL(requestedUrls[1]).searchParams.get("page") === "1"
  ) {
    pass("mycareersfuture.fetch() advances pages via the URL query string, not the JSON body");
  } else {
    fail(`mycareersfuture.fetch() request pages drifted: ${JSON.stringify(requestedUrls)}`);
  }
  if (
    capturedOpts?.redirect === "error" &&
    capturedOpts?.headers?.["content-type"] === "application/json"
  ) {
    pass("mycareersfuture.fetch() sends redirect:error and a JSON content-type header");
  } else {
    fail(`mycareersfuture.fetch() request hygiene: ${JSON.stringify(capturedOpts)}`);
  }

  // fetch() — recall-first + total outage.
  const okRecord = record("ok");
  const partial = await mycareersfuture.fetch(
    {
      provider: "mycareersfuture",
      name: "Partial failure",
      mycareersfuture: { keywords: ["bad", "good"] },
    },
    {
      sleep: async () => {},
      fetchJson: async (url, opts) => {
        if (JSON.parse(opts.body).search === "bad") throw new Error("network error");
        return { results: [okRecord] };
      },
    }
  );
  if (partial.length === 1) {
    pass("mycareersfuture.fetch(): a failed keyword does not abort keywords that still succeed");
  } else {
    fail(`mycareersfuture.fetch() with one failing keyword returned ${JSON.stringify(partial)}`);
  }

  try {
    await mycareersfuture.fetch(
      { provider: "mycareersfuture", name: "Outage", mycareersfuture: { keywords: ["a", "b"] } },
      {
        sleep: async () => {},
        fetchJson: async () => {
          throw new Error("boom");
        },
      }
    );
    fail("mycareersfuture.fetch() should throw when every keyword request fails");
  } catch (err) {
    if (/all 2 keyword request\(s\) failed/.test(err.message)) {
      pass("mycareersfuture.fetch() throws when every keyword fails (total outage)");
    } else {
      fail(`mycareersfuture.fetch() threw an unexpected error on total outage: ${err.message}`);
    }
  }
} catch (e) {
  fail(`mycareersfuture provider tests crashed: ${e.message}`);
}
