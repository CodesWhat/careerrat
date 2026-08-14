import assert from "node:assert/strict";
import test from "node:test";

import { fetchProvider, inferProvider } from "../src/core/scoring/sourced-scanner.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("inferProvider recognizes Recruitee and Workday URLs while preserving explicit providers", () => {
  assert.equal(
    inferProvider({ careers_url: "https://Acme.RECRUITEE.com/o/platform-engineer" }),
    "recruitee"
  );
  assert.equal(
    inferProvider({ careers_url: "https://acme.wd5.myworkdayjobs.com/careers" }),
    "workday"
  );
  assert.equal(
    inferProvider({ careers_url: "https://acme.wd5.myworkdayjobs.com/en-US/careers" }),
    "workday"
  );
  assert.equal(
    inferProvider({
      provider: "manual-provider",
      careers_url: "https://acme.recruitee.com/careers",
    }),
    "manual-provider"
  );
  assert.equal(inferProvider({ careers_url: "https://careers.example.test/jobs" }), null);
});

test("inferProvider and fetchProvider route newly supported Career Ops adapters", async () => {
  assert.equal(inferProvider({ careers_url: "https://acme.bamboohr.com/careers" }), "bamboohr");
  assert.equal(inferProvider({ careers_url: "https://acme.pinpointhq.com/postings" }), "pinpoint");
  assert.equal(inferProvider({ provider: "PHENOM" }), "phenom");
  assert.equal(inferProvider({ provider: "local-parser" }), null);

  const offers = await fetchProvider(
    "bamboohr",
    { name: "Acme", careers_url: "https://acme.bamboohr.com/careers" },
    async () =>
      jsonResponse({
        result: [{ id: "42", jobOpeningName: "Staff Engineer", location: { city: "Denver" } }],
      })
  );

  assert.deepEqual(offers, [
    {
      title: "Staff Engineer",
      url: "https://acme.bamboohr.com/careers/42",
      company: "Acme",
      location: "Denver",
      comp: "",
      bodyText: "",
      bodyPartial: true,
      provider: "bamboohr",
    },
  ]);
});

test("fetchProvider maps Recruitee offers and validates returned offer URLs", async () => {
  const calls = [];
  const offers = await fetchProvider(
    "recruitee",
    { name: "Acme Systems", careers_url: "https://acme.recruitee.com/careers" },
    async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        offers: [
          {
            title: "Platform Engineer",
            careers_url: "https://acme.recruitee.com/o/platform-engineer",
            location: "Anywhere in the US",
            city: "Ignored City",
            country: "Ignored Country",
            remote: true,
            description: "<p>Build &amp; operate systems.</p>",
          },
          {
            title: "Solutions Engineer",
            url: "https://acme.recruitee.com/o/solutions-engineer",
            city: "Boston",
            country: "US",
            remote: true,
          },
          {
            title: "Security Engineer",
            careers_url: "https://jobs.example.test/security-engineer",
            country: "Canada",
          },
          {
            title: "Data Engineer",
            careers_url: "not a URL",
            remote: true,
          },
        ],
      });
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://acme.recruitee.com/api/offers/");
  assert.equal(Object.hasOwn(calls[0].init, "method"), false);
  assert.deepEqual(offers, [
    {
      title: "Platform Engineer",
      url: "https://acme.recruitee.com/o/platform-engineer",
      company: "Acme Systems",
      location: "Anywhere in the US",
      comp: "",
      bodyText: "Build & operate systems.",
    },
    {
      title: "Solutions Engineer",
      url: "https://acme.recruitee.com/o/solutions-engineer",
      company: "Acme Systems",
      location: "Boston, US, Remote",
      comp: "",
      bodyText: "",
    },
    {
      title: "Security Engineer",
      url: "",
      company: "Acme Systems",
      location: "Canada",
      comp: "",
      bodyText: "",
    },
    {
      title: "Data Engineer",
      url: "",
      company: "Acme Systems",
      location: "Remote",
      comp: "",
      bodyText: "",
    },
  ]);
});

test("fetchProvider returns no Recruitee offers for missing or invalid envelopes", async () => {
  for (const payload of [{}, { offers: null }, { offers: {} }]) {
    const offers = await fetchProvider(
      "recruitee",
      { name: "Acme Systems", careers_url: "https://acme.recruitee.com" },
      async () => jsonResponse(payload)
    );
    assert.deepEqual(offers, []);
  }
});

test("fetchProvider rejects untrusted Recruitee careers URLs before fetching", async () => {
  for (const careers_url of [
    "https://careers.example.test/jobs",
    "http://acme.recruitee.com/careers",
  ]) {
    let fetched = false;
    await assert.rejects(
      fetchProvider("recruitee", { name: "Acme Systems", careers_url }, async () => {
        fetched = true;
        return jsonResponse({ offers: [] });
      }),
      /untrusted hostname/
    );
    assert.equal(fetched, false);
  }
});

test("fetchProvider paginates Workday with POST requests and maps posting dates", async (t) => {
  const now = Date.parse("2026-07-17T16:00:00.000Z");
  t.mock.method(Date, "now", () => now);

  const firstPage = Array.from({ length: 20 }, (_, index) => ({
    title: `Engineer ${index + 1}`,
    externalPath: index === 7 ? "" : `/job/engineer-${index + 1}`,
    locationsText: index % 2 === 0 ? "Remote" : "New York, NY",
    postedOn: index === 0 ? undefined : "Posted Yesterday",
  }));
  const secondPage = [
    {
      title: "Staff Engineer",
      externalPath: "/job/staff-engineer",
      locationsText: "Remote",
      postedOn: "Posted Today",
    },
    {
      title: "Principal Engineer",
      externalPath: "/job/principal-engineer",
      locationsText: "Boston, MA",
      postedOn: "Posted 5 Days Ago",
    },
    {
      title: "Engineering Manager",
      externalPath: "/job/engineering-manager",
      locationsText: "Chicago, IL",
      postedOn: "Posted 30+ Days Ago",
    },
  ];
  const calls = [];

  const offers = await fetchProvider(
    "workday",
    {
      name: "Acme Systems",
      careers_url: "https://acme.wd5.myworkdayjobs.com/en-US/careers",
    },
    async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      return jsonResponse({ jobPostings: body.offset === 0 ? firstPage : secondPage });
    }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    })),
    [0, 20].map((offset) => ({
      url: "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/jobs",
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: { limit: 20, offset, searchText: "", appliedFacets: {} },
    }))
  );
  assert.equal(offers.length, 22);
  assert.equal(
    offers.some((offer) => offer.title === "Engineer 8"),
    false
  );
  assert.deepEqual(offers.at(-3), {
    title: "Staff Engineer",
    url: "https://acme.wd5.myworkdayjobs.com/careers/job/staff-engineer",
    company: "Acme Systems",
    location: "Remote",
    comp: "",
    postedAt: new Date(now).toISOString(),
  });
  assert.equal(offers.at(-2).postedAt, new Date(now - 5 * 86_400_000).toISOString());
  assert.equal(offers.at(-1).postedAt, null);
  assert.equal(offers[0].postedAt, null);
});

test("fetchProvider rejects Workday URLs that cannot derive a CXS endpoint", async () => {
  await assert.rejects(
    fetchProvider(
      "workday",
      { name: "Acme Systems", careers_url: "https://careers.example.test/jobs" },
      async () => jsonResponse({ jobPostings: [] })
    ),
    /cannot derive CXS endpoint/
  );
});

test("plain GET providers do not receive method, body, or headers fetch options", async () => {
  let receivedInit;
  await fetchProvider(
    "lever",
    { name: "Acme Systems", careers_url: "https://jobs.lever.co/acme" },
    async (_url, init) => {
      receivedInit = init;
      return jsonResponse([]);
    }
  );

  assert.equal(Object.hasOwn(receivedInit, "method"), false);
  assert.equal(Object.hasOwn(receivedInit, "body"), false);
  assert.equal(Object.hasOwn(receivedInit, "headers"), false);
});
