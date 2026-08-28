import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchHcareers,
  fetchHospitalityOnline,
  fetchIHireHospitality,
  fetchOysterLink,
} from "../src/core/providers/hospitality-public.mjs";
import {
  detailHtmlByProvider,
  detailUrlByProvider,
  listHtmlByProvider,
  listUrlByProvider,
} from "./fixtures/hospitality-public.mjs";

const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 }];

function requestOptions(provider) {
  const calls = [];
  return {
    calls,
    options: {
      fetchImpl: async (url, init) => {
        calls.push({ url, redirect: init.redirect });
        if (url === listUrlByProvider[provider]) {
          return new Response(listHtmlByProvider[provider], {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url === detailUrlByProvider[provider]) {
          return new Response(detailHtmlByProvider[provider], {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
      resolveHost: async () => PUBLIC_ADDRESS,
      dispatcherFactory: () => ({ close: async () => {} }),
      now: new Date("2026-08-27T12:00:00Z"),
    },
  };
}

const cases = [
  ["oysterlink", fetchOysterLink],
  ["hcareers", fetchHcareers],
  ["hospitalityonline", fetchHospitalityOnline],
  ["ihirehospitality", fetchIHireHospitality],
];

const expectedComp = Object.freeze({
  oysterlink: "$18 to $24 per hour",
  hcareers: "$20 to $28 per hour",
  hospitalityonline: "$21 to $29 per hour",
  ihirehospitality: "$60,000 to $70,000 per year",
});

test("culinaryagents reads its current public search and posting paths", async () => {
  const providers = await import("../src/core/providers/hospitality-public.mjs");
  assert.equal(typeof providers.fetchCulinaryAgents, "function");
  const { calls, options } = requestOptions("culinaryagents");

  const offers = await providers.fetchCulinaryAgents(
    { url: listUrlByProvider.culinaryagents },
    options
  );

  assert.deepEqual(
    calls.map((call) => call.url),
    [listUrlByProvider.culinaryagents, detailUrlByProvider.culinaryagents]
  );
  assert.deepEqual(
    offers.map(({ title, company, location, comp, bodyPartial, provider }) => ({
      title,
      company,
      location,
      comp,
      bodyPartial,
      provider,
    })),
    [
      {
        title: "Head Bartender",
        company: "SelaV Hotel",
        location: "Brooklyn, NY, US",
        comp: "$27 to $32 per hour",
        bodyPartial: false,
        provider: "culinaryagents",
      },
    ]
  );
});

test("culinaryagents rejects off-host and non-search listing paths before fetch", async () => {
  const { fetchCulinaryAgents } = await import("../src/core/providers/hospitality-public.mjs");
  assert.equal(typeof fetchCulinaryAgents, "function");
  let called = false;
  const options = {
    fetchImpl: async () => {
      called = true;
      return new Response("");
    },
  };

  for (const url of [
    "https://example.com/search/jobs?search[name]=Head+Bartender",
    "https://culinaryagents.com/jobs/719098-Head-Bartender",
  ]) {
    await assert.rejects(fetchCulinaryAgents({ url }, options), /untrusted listing URL/i);
  }
  assert.equal(called, false);
});

test("culinaryagents accepts a same-host posting with an encoded slug", async () => {
  const { fetchCulinaryAgents } = await import("../src/core/providers/hospitality-public.mjs");
  const detailUrl = "https://culinaryagents.com/jobs/719135-Servers-%2526-Hosts";
  const calls = [];
  const offers = await fetchCulinaryAgents(
    { url: listUrlByProvider.culinaryagents },
    {
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(
          url === listUrlByProvider.culinaryagents
            ? '<a href="/jobs/719135-Servers-%2526-Hosts">Servers &amp; Hosts</a>'
            : detailHtmlByProvider.culinaryagents,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      },
      resolveHost: async () => PUBLIC_ADDRESS,
      dispatcherFactory: () => ({ close: async () => {} }),
      now: new Date("2026-08-27T12:00:00Z"),
    }
  );

  assert.deepEqual(calls, [listUrlByProvider.culinaryagents, detailUrl]);
  assert.equal(offers.length, 1);
});

for (const [provider, fetchProvider] of cases) {
  test(`${provider} reads public listing links and normalizes full schema.org job bodies`, async () => {
    const { calls, options } = requestOptions(provider);
    const offers = await fetchProvider({ url: listUrlByProvider[provider] }, options);

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.url),
      [listUrlByProvider[provider], detailUrlByProvider[provider]]
    );
    assert.equal(offers.length, 1);
    assert.equal(offers[0].provider, provider);
    assert.equal(offers[0].url, detailUrlByProvider[provider]);
    assert.match(offers[0].title, /Bartender|Food and Beverage Supervisor/);
    assert.match(offers[0].company, /Hotel/);
    assert.equal(offers[0].location, "New York, NY, US");
    assert.equal(offers[0].comp, expectedComp[provider]);
    assert.match(offers[0].bodyText, /Serve guests in a high-volume New York bar/);
    assert.equal(offers[0].bodyPartial, false);
    assert.match(offers[0].postedAt, /^2026-08-2/);
  });
}

test("hospitality public providers reject an off-host configured listing URL before fetch", async () => {
  let called = false;
  const options = {
    fetchImpl: async () => {
      called = true;
      return new Response("");
    },
  };

  await assert.rejects(
    fetchOysterLink({ url: "https://example.com/jobs/bartender/new-york-ny/" }, options),
    /untrusted listing URL/i
  );
  assert.equal(called, false);
});

test("hospitality public providers drop expired detail pages", async () => {
  const { options } = requestOptions("oysterlink");
  const expired = detailHtmlByProvider.oysterlink.replace(
    "2027-12-31T23:59:59Z",
    "2026-08-26T23:59:59Z"
  );
  options.fetchImpl = async (url) =>
    new Response(url === listUrlByProvider.oysterlink ? listHtmlByProvider.oysterlink : expired, {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  const offers = await fetchOysterLink({ url: listUrlByProvider.oysterlink }, options);
  assert.deepEqual(offers, []);
});

test("hcareers emits its single safe apply destination without losing board provenance", async () => {
  const applyUrl =
    "https://careers.hireology.com/arlo-williamsburg/2838889/description?source=hcareers&utm_source=hcareers";
  const { options } = requestOptions("hcareers");
  options.fetchImpl = async (url) =>
    new Response(
      url === listUrlByProvider.hcareers
        ? listHtmlByProvider.hcareers
        : detailHtmlByProvider.hcareers.replace(
            "</body>",
            `<a data-track="apply-click" href="${applyUrl.replaceAll("&", "&amp;")}">Apply</a></body>`
          ),
      { status: 200, headers: { "content-type": "text/html" } }
    );

  const offers = await fetchHcareers({ url: listUrlByProvider.hcareers }, options);

  assert.equal(offers.length, 1);
  assert.equal(offers[0].url, applyUrl);
  assert.equal(offers[0].capturedUrl, detailUrlByProvider.hcareers);
  assert.equal(offers[0].provider, "hcareers");
  assert.equal(offers[0].bodyPartial, false);
  assert.match(offers[0].bodyText, /Serve guests in a high-volume New York bar/);
});

test("hcareers falls back to its detail page for unsafe or ambiguous apply destinations", async () => {
  const cases = [
    '<a data-track="apply-click" href="http://careers.hireology.com/acme/123/description">Apply</a>',
    '<a data-track="apply-click" href="https://user:pass@careers.hireology.com/acme/123/description">Apply</a>',
    '<a data-track="apply-click" href="https://127.0.0.1/acme/123/description">Apply</a>',
    '<a data-track="apply-click" href="javascript:alert(1)">Apply</a>',
    [
      '<a data-track="apply-click" href="https://careers.hireology.com/acme/123/description">Apply</a>',
      '<a data-track="apply-click" href="https://jobs.example.com/acme/456">Apply</a>',
    ].join(""),
  ];

  for (const applyMarkup of cases) {
    const { options } = requestOptions("hcareers");
    options.fetchImpl = async (url) =>
      new Response(
        url === listUrlByProvider.hcareers
          ? listHtmlByProvider.hcareers
          : detailHtmlByProvider.hcareers.replace("</body>", `${applyMarkup}</body>`),
        { status: 200, headers: { "content-type": "text/html" } }
      );

    const offers = await fetchHcareers({ url: listUrlByProvider.hcareers }, options);

    assert.equal(offers.length, 1);
    assert.equal(offers[0].url, detailUrlByProvider.hcareers);
    assert.equal(offers[0].capturedUrl, undefined);
  }
});
