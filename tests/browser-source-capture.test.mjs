import assert from "node:assert/strict";
import test from "node:test";

import { createPlaywrightOps } from "../src/core/apply/playwright-ops.mjs";
import { captureBrowserSearchSource } from "../src/core/search/browser-source-capture.mjs";

const resolvePublic = async (rawUrl) => ({ ok: true, url: new URL(rawUrl).toString() });

function source(overrides = {}) {
  return {
    provider: "linkedin",
    platform: "linkedin",
    source_type: "browser",
    auth: true,
    label: "LinkedIn NYC",
    url: "https://www.linkedin.com/jobs/search/?keywords=bar%20manager",
    enabled: true,
    ...overrides,
  };
}

test("captureBrowserSearchSource captures an already-authenticated source through the app session", async () => {
  const calls = [];
  const jobBody =
    "Lead the full beverage program, coach the bar team, own inventory, and deliver polished guest service in New York City. ".repeat(
      8
    );
  const session = {
    available: true,
    async open(url) {
      calls.push(["open", url]);
      return url.includes("/jobs/view/")
        ? { url, title: "Bar Manager", text: jobBody }
        : { url, title: "Bar manager jobs", text: "Jobs matching your search" };
    },
    async extractRows(input) {
      calls.push(["extractRows", input]);
      return {
        rows: [
          {
            title: "Bar Manager",
            company: "Example Hospitality",
            location: "New York, NY",
            url: "https://www.linkedin.com/jobs/view/bar-manager-1234567890",
          },
        ],
      };
    },
    async extractText(input) {
      calls.push(["extractText", input]);
      return { selector: ".jobs-description__content", text: jobBody };
    },
  };

  const result = await captureBrowserSearchSource({
    source: source(),
    session,
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.equal(result.needsLogin, null);
  assert.deepEqual(result.errors, []);
  assert.equal(result.offers.length, 1);
  assert.deepEqual(
    {
      company: result.offers[0].company,
      title: result.offers[0].title,
      url: result.offers[0].url,
      location: result.offers[0].location,
      source: result.offers[0].source,
      sourceProvider: result.offers[0].sourceProvider,
      bodyCapture: result.offers[0].bodyCapture,
      bodyText: result.offers[0].bodyText,
      bodyPartial: result.offers[0].bodyPartial,
    },
    {
      company: "Example Hospitality",
      title: "Bar Manager",
      url: "https://www.linkedin.com/jobs/view/bar-manager-1234567890",
      location: "New York, NY",
      source: "linkedin-browser",
      sourceProvider: "linkedin",
      bodyCapture: "session-browser",
      bodyText: jobBody.trim(),
      bodyPartial: false,
    }
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ["open", "extractRows", "open", "extractText"]
  );
});

test("captureBrowserSearchSource uses the Indeed result-card contract and captures its full posting body", async () => {
  const jobUrl = "https://www.indeed.com/viewjob?jk=indeed-123";
  const jobBody =
    "Manage the cocktail program, hiring, training, inventory, and nightly service for a busy Manhattan venue. ".repeat(
      8
    );
  let rowContract;
  const result = await captureBrowserSearchSource({
    source: source({
      provider: "indeed",
      platform: "indeed",
      label: "Indeed bar leadership",
      url: "https://www.indeed.com/jobs?q=bar+manager&l=New+York%2C+NY",
    }),
    session: {
      available: true,
      async open(url) {
        return url === jobUrl
          ? { url, title: "Bar Manager", text: jobBody }
          : { url, title: "Bar manager jobs", text: "Results for bar manager" };
      },
      async extractRows(input) {
        rowContract = input;
        return {
          rows: [
            {
              title: "Bar Manager",
              company: "Example Dining Group",
              location: "New York, NY",
              url: jobUrl,
            },
          ],
        };
      },
      async extractText() {
        return { selector: "#jobDescriptionText", text: jobBody };
      },
    },
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.ok(rowContract.rowSelectors.includes("[data-jk]"));
  assert.ok(rowContract.fields.title.selectors.includes("h2.jobTitle a"));
  assert.ok(rowContract.fields.company.selectors.includes("[data-testid='company-name']"));
  assert.ok(rowContract.fields.location.selectors.includes("[data-testid='text-location']"));
  assert.ok(rowContract.fields.url.selectors.includes("a[data-jk][href]"));
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].source, "indeed-browser");
  assert.equal(result.offers[0].sourceProvider, "indeed");
  assert.equal(result.offers[0].bodyText, jobBody.trim());
  assert.equal(result.offers[0].bodyPartial, false);
});

test("captureBrowserSearchSource uses the Glassdoor result-card contract and captures its full posting body", async () => {
  const jobUrl =
    "https://www.glassdoor.com/job-listing/venue-operations-manager-example-JV_IC1132348_KO0,32_KE33,40.htm?jl=100123";
  const jobBody =
    "Own venue operations, guest experience, staffing, safety, and event execution for this New York location. ".repeat(
      8
    );
  let rowContract;
  const result = await captureBrowserSearchSource({
    source: source({
      provider: "glassdoor",
      platform: "glassdoor",
      label: "Glassdoor venue operations",
      url: "https://www.glassdoor.com/Job/new-york-venue-operations-jobs-SRCH_IL.0,8_IC1132348_KO9,25.htm",
    }),
    session: {
      available: true,
      async open(url) {
        return url === jobUrl
          ? { url, title: "Venue Operations Manager", text: jobBody }
          : { url, title: "Venue operations jobs", text: "Matching jobs" };
      },
      async extractRows(input) {
        rowContract = input;
        return {
          rows: [
            {
              title: "Venue Operations Manager",
              company: "Example Events",
              location: "New York, NY",
              url: jobUrl,
            },
          ],
        };
      },
      async extractText() {
        return { selector: "[data-test='jobDescriptionContent']", text: jobBody };
      },
    },
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.ok(rowContract.rowSelectors.includes("[data-test='jobListing']"));
  assert.ok(rowContract.fields.title.selectors.includes("[data-test='job-title']"));
  assert.ok(rowContract.fields.company.selectors.includes("[data-test='employer-name']"));
  assert.ok(rowContract.fields.location.selectors.includes("[data-test='emp-location']"));
  assert.ok(rowContract.fields.url.selectors.includes("a[href*='/job-listing/']"));
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].source, "glassdoor-browser");
  assert.equal(result.offers[0].sourceProvider, "glassdoor");
  assert.equal(result.offers[0].bodyText, jobBody.trim());
  assert.equal(result.offers[0].bodyPartial, false);
});

test("captureBrowserSearchSource rejects a login-backed posting redirected to a private host", async () => {
  const jobUrl = "https://www.linkedin.com/jobs/view/bar-manager-1234567890";
  let extractedBody = false;
  const result = await captureBrowserSearchSource({
    source: source(),
    session: {
      available: true,
      async open(url) {
        if (url === jobUrl) {
          return { url: "http://127.0.0.1:7777/private", title: "Private", text: "private" };
        }
        return { url, title: "Bar manager jobs", text: "Jobs matching your search" };
      },
      async extractRows() {
        return {
          rows: [
            {
              title: "Bar Manager",
              company: "Example Hospitality",
              location: "New York, NY",
              url: jobUrl,
            },
          ],
        };
      },
      async extractText() {
        extractedBody = true;
        return { text: "should not be read" };
      },
    },
    resolvePublicTargetImpl: async (rawUrl) =>
      String(rawUrl).includes("127.0.0.1")
        ? { ok: false, reason: "private or local host is not fetchable" }
        : resolvePublic(rawUrl),
  });

  assert.equal(extractedBody, false);
  assert.equal(result.offers.length, 0);
  assert.match(result.errors[0].error, /private|local/i);
});

test("captureBrowserSearchSource returns one contextual login handoff instead of a permission error", async () => {
  let extracted = false;
  const session = {
    available: true,
    async open(_url) {
      return {
        url: "https://www.linkedin.com/login",
        title: "Sign in",
        text: "Email address Password Sign in",
      };
    },
    async extractRows() {
      extracted = true;
      return { rows: [] };
    },
  };

  const result = await captureBrowserSearchSource({
    source: source(),
    session,
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.equal(extracted, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.needsLogin, {
    platform: "linkedin",
    label: "LinkedIn",
    sourceLabel: "LinkedIn NYC",
    url: "https://www.linkedin.com/jobs/search/?keywords=bar%20manager",
    prompt: "Do you want to log into LinkedIn so I can use it?",
  });
});

test("captureBrowserSearchSource rejects a known platform on another hostname before opening it", async () => {
  let opened = false;
  const result = await captureBrowserSearchSource({
    source: source({
      provider: "jobs.example.com",
      platform: "linkedin",
      label: "LinkedIn saved search",
      url: "https://jobs.example.com/search",
    }),
    session: {
      available: true,
      async open() {
        opened = true;
        return { url: "https://jobs.example.com/search", text: "Jobs" };
      },
    },
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.equal(opened, false);
  assert.deepEqual(result.offers, []);
  assert.equal(result.needsLogin, null);
  assert.match(result.errors[0].error, /does not match.*hostname/i);
});

test("captureBrowserSearchSource captures posting-shaped rows from an arbitrary enabled source", async () => {
  const jobBody =
    "Run venue operations, staff events, coordinate vendors, and deliver a safe guest experience in New York City. ".repeat(
      8
    );
  const session = {
    available: true,
    async open(url) {
      return url.includes("/openings/")
        ? { url, title: "Venue Operations Manager", text: jobBody }
        : { url, title: "Open roles", text: "Venue Operations Manager" };
    },
    async extractRows() {
      return {
        rows: [
          {
            title: "Venue Operations Manager",
            company: "Example Venue",
            location: "New York, NY",
            url: "https://jobs.example.com/openings/venue-operations-manager",
          },
          { title: "Browse jobs", company: "", location: "", url: "https://jobs.example.com" },
        ],
      };
    },
    async extractText() {
      return { selector: "main", text: jobBody };
    },
  };

  const result = await captureBrowserSearchSource({
    source: source({
      provider: "jobs.example.com",
      platform: undefined,
      auth: false,
      source_type: "url-query",
      label: "Example Venue jobs",
      url: "https://jobs.example.com/search?q=operations",
    }),
    session,
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].company, "Example Venue");
  assert.equal(result.offers[0].title, "Venue Operations Manager");
  assert.equal(result.offers[0].bodyText, jobBody.trim());
  assert.equal(result.offers[0].bodyPartial, false);
});

test("captureBrowserSearchSource captures a session JD when legacy source auth metadata is absent", async () => {
  const jobUrl = "https://www.linkedin.com/jobs/view/bar-manager-1234567890";
  const jobBody =
    "Lead a high-volume bar team, training, inventory, service standards, and the cocktail program in New York City. ".repeat(
      8
    );
  const result = await captureBrowserSearchSource({
    source: source({ auth: undefined }),
    session: {
      available: true,
      async open(url) {
        return url === jobUrl
          ? { url, title: "Bar Manager", text: jobBody }
          : { url, title: "Bar manager jobs", text: "Jobs matching your search" };
      },
      async extractRows() {
        return {
          rows: [
            {
              title: "Bar Manager",
              company: "Example Hospitality",
              location: "New York, NY",
              url: jobUrl,
            },
          ],
        };
      },
      async extractText() {
        return { selector: ".jobs-description__content", text: jobBody };
      },
    },
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].bodyText, jobBody.trim());
  assert.equal(result.offers[0].bodyPartial, false);
});

test("captureBrowserSearchSource keeps a safe posting partial when its session body is unreadable", async () => {
  const jobUrl = "https://www.linkedin.com/jobs/view/bar-manager-1234567890";
  const result = await captureBrowserSearchSource({
    source: source(),
    session: {
      available: true,
      async open(url) {
        return url === jobUrl
          ? { url, title: "Bar Manager", text: "Bar Manager" }
          : { url, title: "Bar manager jobs", text: "Jobs matching your search" };
      },
      async extractRows() {
        return {
          rows: [
            {
              title: "Bar Manager",
              company: "Example Hospitality",
              location: "New York, NY",
              url: jobUrl,
            },
          ],
        };
      },
      async extractText() {
        return { selector: null, text: "" };
      },
    },
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].url, jobUrl);
  assert.equal(result.offers[0].bodyText, "");
  assert.equal(result.offers[0].bodyPartial, true);
  assert.equal(result.offers[0].bodyCapture, "session-browser");
  assert.match(result.errors[0].error, /could not read the full job description/i);
});

test("captureBrowserSearchSource stops the source when an exact posting reaches an auth challenge", async () => {
  const firstJobUrl = "https://www.linkedin.com/jobs/view/bar-manager-1234567890";
  const secondJobUrl = "https://www.linkedin.com/jobs/view/bar-manager-9876543210";
  const opened = [];
  const result = await captureBrowserSearchSource({
    source: source(),
    session: {
      available: true,
      async open(url) {
        opened.push(url);
        return url === firstJobUrl
          ? {
              url: "https://www.linkedin.com/checkpoint/challenge/",
              title: "Security verification",
              text: "Enter the security code to verify your account",
            }
          : { url, title: "Bar manager jobs", text: "Jobs matching your search" };
      },
      async extractRows() {
        return {
          rows: [
            {
              title: "Bar Manager",
              company: "Example Hospitality",
              location: "New York, NY",
              url: firstJobUrl,
            },
            {
              title: "Bar Manager",
              company: "Second Hospitality",
              location: "New York, NY",
              url: secondJobUrl,
            },
          ],
        };
      },
      async extractText() {
        assert.fail("an auth challenge must stop before body extraction");
      },
    },
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.deepEqual(opened, [source().url, firstJobUrl]);
  assert.equal(result.offers.length, 0);
  assert.equal(result.needsLogin.platform, "linkedin");
});

test("captureBrowserSearchSource drops a posting when the real Playwright route guard blocks its private redirect", async () => {
  const searchUrl = "https://www.linkedin.com/jobs/search/?keywords=bar%20manager";
  const jobUrl = "https://www.linkedin.com/jobs/view/bar-manager-1234567890";
  const frame = {};
  let routeHandler;
  let currentUrl = "about:blank";
  let pageId;
  const page = {
    async goto(url) {
      currentUrl = url;
      await routeHandler({
        request: () => ({
          url: () => url,
          isNavigationRequest: () => true,
          frame: () => frame,
        }),
        continue: async () => {},
        abort: async () => assert.fail("the public request must not be blocked"),
      });
      if (url !== jobUrl) return;
      let blocked = false;
      await routeHandler({
        request: () => ({
          url: () => "http://127.0.0.1:7777/private",
          isNavigationRequest: () => true,
          frame: () => frame,
        }),
        continue: async () => assert.fail("the private redirect must not be sent"),
        abort: async () => {
          blocked = true;
        },
      });
      if (blocked) throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
    },
    mainFrame: () => frame,
    url: () => currentUrl,
    title: async () => (currentUrl === searchUrl ? "Bar manager jobs" : ""),
    locator: () => ({ innerText: async () => "Jobs matching your search" }),
    close: async () => {},
  };
  const resolveTarget = async (rawUrl) =>
    String(rawUrl).includes("127.0.0.1")
      ? { ok: false, reason: "private or local host is not fetchable" }
      : resolvePublic(rawUrl);
  const ops = createPlaywrightOps({
    profileDir: "/tmp/careerrat-browser-source-test",
    launchImpl: async () => ({
      async route(_pattern, handler) {
        routeHandler = handler;
      },
      async newPage() {
        return page;
      },
      async close() {},
    }),
    resolvePublicTargetImpl: resolveTarget,
  });
  const session = {
    available: true,
    async open(url) {
      if (pageId) await ops.navigate({ pageId, url });
      else ({ pageId } = await ops.openTab({ url }));
      return ops.pageContent({ pageId });
    },
    async extractRows() {
      return {
        rows: [
          {
            title: "Bar Manager",
            company: "Example Hospitality",
            location: "New York, NY",
            url: jobUrl,
          },
        ],
      };
    },
  };

  const result = await captureBrowserSearchSource({
    source: source({ url: searchUrl }),
    session,
    resolvePublicTargetImpl: resolveTarget,
  });

  assert.equal(result.offers.length, 0);
  assert.match(result.errors[0].error, /private|public-network|unsafe/i);
  await ops.close();
});

test("captureBrowserSearchSource reports unavailable app browser without consent-matrix language", async () => {
  const result = await captureBrowserSearchSource({
    source: source(),
    session: { available: false, reason: "No callable browser surface is installed." },
  });

  assert.equal(result.offers.length, 0);
  assert.equal(result.needsLogin, null);
  assert.deepEqual(result.errors, [
    {
      company: "LinkedIn NYC",
      error: "No callable browser surface is installed.",
    },
  ]);
  assert.doesNotMatch(result.errors[0].error, /consent|permission|automation/i);
});

test("captureBrowserSearchSource rejects a source whose hostname resolves to a private address", async () => {
  let opened = false;
  const result = await captureBrowserSearchSource({
    source: source({
      provider: "jobs.example.test",
      platform: "jobs.example.test",
      label: "Example Jobs",
      url: "https://jobs.example.test/search",
    }),
    session: {
      available: true,
      async open() {
        opened = true;
        return {};
      },
    },
    resolvePublicTargetImpl: async () => ({
      ok: false,
      reason: "host resolved to a private, local, or non-public address",
    }),
  });

  assert.equal(opened, false);
  assert.equal(result.offers.length, 0);
  assert.match(result.errors[0].error, /private|non-public/i);
});

test("captureBrowserSearchSource rejects a redirect that lands on a private address before extraction", async () => {
  let extracted = false;
  const result = await captureBrowserSearchSource({
    source: source({
      provider: "jobs.example.test",
      platform: "jobs.example.test",
      label: "Example Jobs",
      url: "https://jobs.example.test/search",
    }),
    session: {
      available: true,
      async open() {
        return { url: "http://127.0.0.1:7777/admin", title: "Admin", text: "private" };
      },
      async extractRows() {
        extracted = true;
        return { rows: [] };
      },
    },
    resolvePublicTargetImpl: async (rawUrl) =>
      String(rawUrl).includes("127.0.0.1")
        ? { ok: false, reason: "private or local host is not fetchable" }
        : { ok: true, url: new URL(rawUrl).toString() },
  });

  assert.equal(extracted, false);
  assert.equal(result.offers.length, 0);
  assert.match(result.errors[0].error, /private|local/i);
});
