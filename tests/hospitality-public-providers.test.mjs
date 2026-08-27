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
