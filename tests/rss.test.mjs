import assert from "node:assert/strict";
import test from "node:test";

import {
  feedItemsToOffers,
  parseFeed,
  remoteVibeCodingJobsFeedUrl,
} from "../src/core/providers/rss.mjs";

// ---------------------------------------------------------------------------
// RSS 2.0 fixture
// ---------------------------------------------------------------------------

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Remote Vibe Coding Jobs</title>
    <link>https://remotevibecodingjobs.com</link>
    <description>The best remote coding jobs</description>
    <item>
      <title><![CDATA[Acme Corp — Senior AI Engineer (Remote)]]></title>
      <link>https://remotevibecodingjobs.com/jobs/123</link>
      <guid isPermaLink="true">https://remotevibecodingjobs.com/jobs/123</guid>
      <pubDate>Mon, 09 Jun 2026 12:00:00 +0000</pubDate>
      <description><![CDATA[<p>Build &amp; deploy AI agents. It&#39;s exciting work.</p>]]></description>
      <category>Engineering</category>
      <category>AI</category>
    </item>
    <item>
      <title>Staff Engineer at Widgets &amp; Co</title>
      <link>https://remotevibecodingjobs.com/jobs/456</link>
      <guid>https://remotevibecodingjobs.com/jobs/456</guid>
      <pubDate>Tue, 10 Jun 2026 08:30:00 +0000</pubDate>
      <description>Work on widgets &amp; more. Great role.</description>
    </item>
  </channel>
</rss>`;

// ---------------------------------------------------------------------------
// Atom 1.0 fixture
// ---------------------------------------------------------------------------

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Dev Jobs Feed</title>
  <id>https://example.com/feed</id>
  <updated>2026-06-10T00:00:00Z</updated>
  <entry>
    <title>Forward Deployed Engineer at Palantir</title>
    <link href="https://example.com/jobs/789" rel="alternate"/>
    <id>https://example.com/jobs/789</id>
    <published>2026-06-08T09:00:00Z</published>
    <summary>Deploy <b>AI</b> systems to customers. &amp; partner closely with clients.</summary>
  </entry>
</feed>`;

// ---------------------------------------------------------------------------
// RSS 2.0 tests
// ---------------------------------------------------------------------------

test("RSS 2.0: kind is rss and feed title parsed", () => {
  const result = parseFeed(RSS_FIXTURE);
  assert.equal(result.kind, "rss");
  assert.equal(result.title, "Remote Vibe Coding Jobs");
});

test("RSS 2.0: two items parsed", () => {
  const result = parseFeed(RSS_FIXTURE);
  assert.equal(result.items.length, 2);
});

test("RSS 2.0: CDATA title stripped and entity decoded in description", () => {
  const result = parseFeed(RSS_FIXTURE);
  const [first] = result.items;
  assert.equal(first.title, "Acme Corp — Senior AI Engineer (Remote)");
  // &amp; and &#39; decoded, HTML tags stripped
  assert.ok(first.description.includes("Build & deploy AI agents"));
  assert.ok(first.description.includes("It's exciting work"));
  assert.ok(!first.description.includes("<p>"), "HTML tags should be stripped");
});

test("RSS 2.0: &amp; entity decoded in plain-text title and description", () => {
  const result = parseFeed(RSS_FIXTURE);
  const [, second] = result.items;
  assert.equal(second.title, "Staff Engineer at Widgets & Co");
  assert.ok(second.description.includes("widgets &"));
});

test("RSS 2.0: isoDate is a valid ISO string", () => {
  const result = parseFeed(RSS_FIXTURE);
  const [first] = result.items;
  assert.ok(typeof first.isoDate === "string", "isoDate should be a string");
  assert.ok(!Number.isNaN(new Date(first.isoDate).getTime()), "isoDate should be parseable");
  assert.ok(first.isoDate.includes("T"), "isoDate should be ISO format");
});

test("RSS 2.0: categories array populated for item with category tags", () => {
  const result = parseFeed(RSS_FIXTURE);
  const [first, second] = result.items;
  assert.deepEqual(first.categories, ["Engineering", "AI"]);
  assert.deepEqual(second.categories, []);
});

test("RSS 2.0: link extracted correctly", () => {
  const result = parseFeed(RSS_FIXTURE);
  assert.equal(result.items[0].link, "https://remotevibecodingjobs.com/jobs/123");
  assert.equal(result.items[1].link, "https://remotevibecodingjobs.com/jobs/456");
});

// ---------------------------------------------------------------------------
// Atom 1.0 tests
// ---------------------------------------------------------------------------

test("Atom 1.0: kind is atom and feed title parsed", () => {
  const result = parseFeed(ATOM_FIXTURE);
  assert.equal(result.kind, "atom");
  assert.equal(result.title, "Dev Jobs Feed");
});

test("Atom 1.0: link href extracted from rel=alternate", () => {
  const result = parseFeed(ATOM_FIXTURE);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].link, "https://example.com/jobs/789");
});

test("Atom 1.0: guid extracted from <id>", () => {
  const result = parseFeed(ATOM_FIXTURE);
  assert.equal(result.items[0].guid, "https://example.com/jobs/789");
});

test("Atom 1.0: isoDate valid from <published>", () => {
  const result = parseFeed(ATOM_FIXTURE);
  const item = result.items[0];
  assert.ok(typeof item.isoDate === "string");
  assert.ok(!Number.isNaN(new Date(item.isoDate).getTime()));
});

test("Atom 1.0: summary stripped of HTML tags and entities decoded", () => {
  const result = parseFeed(ATOM_FIXTURE);
  const item = result.items[0];
  assert.ok(!item.description.includes("<b>"), "HTML bold tags should be stripped");
  assert.ok(item.description.includes("AI"), "text content preserved");
  assert.ok(item.description.includes("&"), "entities decoded");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("Zero-item RSS feed returns items: []", () => {
  const xml = `<rss><channel><title>Empty Feed</title></channel></rss>`;
  const result = parseFeed(xml);
  assert.deepEqual(result.items, []);
  assert.equal(result.kind, "rss");
});

test("Zero-item Atom feed returns items: []", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>`;
  const result = parseFeed(xml);
  assert.deepEqual(result.items, []);
  assert.equal(result.kind, "atom");
});

test("Malformed/truncated XML does not throw and returns items array", () => {
  const malformed = `<rss><channel><title>Broken</title><item><title>Truncated`;
  let result;
  assert.doesNotThrow(() => {
    result = parseFeed(malformed);
  });
  assert.ok(Array.isArray(result.items), "items should be an array");
});

test("Null/empty input does not throw", () => {
  assert.doesNotThrow(() => parseFeed(null));
  assert.doesNotThrow(() => parseFeed(""));
  assert.doesNotThrow(() => parseFeed(undefined));
  const r = parseFeed(null);
  assert.deepEqual(r.items, []);
});

// ---------------------------------------------------------------------------
// feedItemsToOffers tests
// ---------------------------------------------------------------------------

test("feedItemsToOffers: maps the parsed role, url, and postedAt from items", () => {
  const items = [
    {
      title: "Senior Engineer at Acme",
      link: "https://example.com/job/1",
      guid: null,
      isoDate: "2026-06-09T12:00:00.000Z",
      description: "A great role",
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items, {
    source: { provider: "RemoteVibeCodingJobs", label: "Remote Vibe Coding Jobs" },
  });
  assert.equal(offers[0].title, "Senior Engineer");
  assert.equal(offers[0].url, "https://example.com/job/1");
  assert.equal(offers[0].postedAt, "2026-06-09T12:00:00.000Z");
  assert.equal(
    offers[0].bodyPartial,
    true,
    "feed descriptions are previews until the posting page is resolved"
  );
});

test("feedItemsToOffers: company is null when title has no recognizable pattern", () => {
  const items = [
    {
      title: "Exciting job opportunity available now",
      link: "https://example.com/job/2",
      guid: null,
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items);
  assert.equal(offers[0].company, null);
});

test("feedItemsToOffers: company parsed from 'Acme — Senior Engineer' pattern", () => {
  const items = [
    {
      title: "Acme — Senior Engineer",
      link: "https://example.com/job/3",
      guid: null,
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items);
  assert.equal(offers[0].company, "Acme");
});

test("feedItemsToOffers: company parsed from 'Senior Engineer at Acme' pattern", () => {
  const items = [
    {
      title: "Senior Engineer at Acme",
      link: "https://example.com/job/4",
      guid: null,
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items);
  assert.equal(offers[0].company, "Acme");
});

test("feedItemsToOffers: ids are stable/deterministic for same input", () => {
  const items = [
    {
      title: "Engineer at Foo",
      link: "https://example.com/job/5",
      guid: "guid-abc-123",
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const [a] = feedItemsToOffers(items);
  const [b] = feedItemsToOffers(items);
  assert.equal(a.id, b.id, "id must be deterministic");
  assert.ok(typeof a.id === "string" && a.id.length > 0);
});

test("feedItemsToOffers: different guids produce different ids", () => {
  const makeItem = (guid) => ({
    title: "T",
    link: null,
    guid,
    isoDate: null,
    description: null,
    categories: [],
  });
  const [a] = feedItemsToOffers([makeItem("guid-1")]);
  const [b] = feedItemsToOffers([makeItem("guid-2")]);
  assert.notEqual(a.id, b.id);
});

test("feedItemsToOffers: source.label flows to source field", () => {
  const items = [
    {
      title: "T",
      link: "https://x.com/1",
      guid: null,
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items, {
    source: { label: "remote-vibe-coding-jobs", id: "rvcj" },
  });
  assert.equal(offers[0].source, "remote-vibe-coding-jobs");
});

test("feedItemsToOffers: falls back to source.id when no label", () => {
  const items = [
    {
      title: "T",
      link: "https://x.com/1",
      guid: null,
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items, { source: { id: "rvcj" } });
  assert.equal(offers[0].source, "rvcj");
});

test("feedItemsToOffers: defaults source to 'rss' when no source provided", () => {
  const items = [
    {
      title: "T",
      link: "https://x.com/1",
      guid: null,
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items);
  assert.equal(offers[0].source, "rss");
});

test("feedItemsToOffers: location extracted from parenthetical in title", () => {
  const items = [
    {
      title: "Engineer at Foo (Remote)",
      link: "https://x.com/1",
      guid: null,
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items);
  assert.equal(offers[0].location, "Remote");
});

test("feedItemsToOffers: location is null when no parenthetical", () => {
  const items = [
    {
      title: "Engineer at Foo",
      link: "https://x.com/1",
      guid: null,
      isoDate: null,
      description: null,
      categories: [],
    },
  ];
  const offers = feedItemsToOffers(items);
  assert.equal(offers[0].location, null);
});

test("feedItemsToOffers: uses the structured Location line from the description", () => {
  const items = [
    {
      title: "Staff Backend Engineer at Grafana Labs",
      link: "https://x.com/1",
      guid: null,
      isoDate: null,
      description:
        "Company: Grafana Labs\nLocation: Canada (Remote)\nType: Full-time\nApplicants must be in Canada.",
      categories: [],
    },
  ];

  const offers = feedItemsToOffers(items);
  assert.equal(offers[0].location, "Canada (Remote)");
});

test("feedItemsToOffers: preserves remote-only source posture when a posting says only USA", () => {
  const items = [
    {
      title: "Senior Software Engineer, Platform at Qventus",
      link: "https://remotevibecodingjobs.com/jobs/qventus-platform",
      guid: null,
      isoDate: null,
      description: "Company: Qventus\nLocation: USA\nType: Full-time",
      categories: [],
    },
  ];

  const offers = feedItemsToOffers(items, {
    source: {
      provider: "RemoteVibeCodingJobs",
      label: "Remote Vibe Coding Jobs",
      rssUrl: "https://remotevibecodingjobs.com/feed.xml",
    },
  });

  assert.equal(offers[0].location, "USA (Remote)");
});

test("feedItemsToOffers: empty array input returns empty array", () => {
  assert.deepEqual(feedItemsToOffers([]), []);
});

// ---------------------------------------------------------------------------
// remoteVibeCodingJobsFeedUrl tests
// ---------------------------------------------------------------------------

test("remoteVibeCodingJobsFeedUrl: returns rssUrl directly when set", () => {
  const url = remoteVibeCodingJobsFeedUrl({ rssUrl: "https://x/feed.xml" });
  assert.equal(url, "https://x/feed.xml");
});

test("remoteVibeCodingJobsFeedUrl: derives /feed path from buildRemoteVibeCodingJobsUrl when no rssUrl", () => {
  const url = remoteVibeCodingJobsFeedUrl({ query: "AI engineer" });
  assert.ok(url.includes("remotevibecodingjobs.com"), "should include the domain");
  assert.ok(url.includes("/feed"), "should include /feed path");
});

test("remoteVibeCodingJobsFeedUrl: falls back to default constant for empty source", () => {
  const url = remoteVibeCodingJobsFeedUrl({});
  assert.ok(url.startsWith("https://remotevibecodingjobs.com"), "should be the RVCJ domain");
});
