import assert from "node:assert/strict";
import test from "node:test";

import { fetchRemoteOk } from "../src/core/providers/remoteok.mjs";
import { fetchRemotive } from "../src/core/providers/remotive.mjs";
import { fetchWorkingNomads } from "../src/core/providers/workingnomads.mjs";

test("fetchRemoteOk drops metadata and invalid rows while mapping valid postings", async () => {
  const epoch = 1_720_000_000;
  const offers = await fetchRemoteOk({ label: "Board Label" }, async (url) => {
    assert.equal(url, "https://remoteok.com/api");
    return [
      { last_updated: 1_720_000_001, legal: "metadata" },
      {
        position: "  Applied AI Engineer  ",
        url: " https://jobs.example.test/applied-ai ",
        company: "  Example Labs  ",
        location: "  Remote, US  ",
        epoch,
        date: "2020-01-01T00:00:00Z",
      },
      {
        position: "Solutions Engineer",
        url: "http://jobs.example.test/solutions",
        company: "",
        date: "2026-07-12T14:30:00-04:00",
      },
      {
        position: "Platform Engineer",
        url: "https://jobs.example.test/platform",
        date: "not-a-date",
      },
      { position: " ", url: "https://jobs.example.test/blank" },
      { url: "https://jobs.example.test/missing-title" },
      { position: "Sales Engineer", url: "ftp://jobs.example.test/sales" },
    ];
  });

  assert.deepEqual(offers, [
    {
      title: "Applied AI Engineer",
      url: "https://jobs.example.test/applied-ai",
      company: "Example Labs",
      location: "Remote, US",
      postedAt: new Date(epoch * 1000).toISOString(),
    },
    {
      title: "Solutions Engineer",
      url: "http://jobs.example.test/solutions",
      company: "Board Label",
      location: "",
      postedAt: "2026-07-12T18:30:00.000Z",
    },
    {
      title: "Platform Engineer",
      url: "https://jobs.example.test/platform",
      company: "Board Label",
      location: "",
      postedAt: null,
    },
  ]);
});

test("fetchRemoteOk applies name and default company fallbacks", async () => {
  const row = { position: "Engineer", url: "https://jobs.example.test/engineer" };

  const named = await fetchRemoteOk({ name: "Named Board" }, async () => [row]);
  const defaulted = await fetchRemoteOk({}, async () => [row]);

  assert.equal(named[0].company, "Named Board");
  assert.equal(defaulted[0].company, "RemoteOK");
});

test("fetchRemoteOk parses JSON strings and Response-like json bodies", async () => {
  const row = {
    position: "AI Engineer",
    url: "https://jobs.example.test/ai",
    company: "Example Systems",
  };

  const fromString = await fetchRemoteOk({}, async () => JSON.stringify([row]));
  const fromResponseLike = await fetchRemoteOk({}, async () => ({
    async json() {
      return [row];
    },
  }));

  assert.deepEqual(fromString, fromResponseLike);
  assert.equal(fromString[0].title, "AI Engineer");
});

test("fetchRemoteOk rejects non-array responses", async () => {
  await assert.rejects(
    fetchRemoteOk({}, async () => ({ jobs: [] })),
    /expected a JSON array/i
  );
});

test("fetchRemotive maps its jobs envelope", async () => {
  const offers = await fetchRemotive({ label: "Remotive Label" }, async (url) => {
    assert.equal(url, "https://remotive.com/api/remote-jobs");
    return {
      jobs: [
        {
          title: "  Solutions Architect  ",
          url: " https://jobs.example.test/architect ",
          company_name: "  Example Cloud  ",
          candidate_required_location: "  Americas  ",
          publication_date: "2026-07-14T09:15:00Z",
        },
      ],
    };
  });

  assert.deepEqual(offers, [
    {
      title: "Solutions Architect",
      url: "https://jobs.example.test/architect",
      company: "Example Cloud",
      location: "Americas",
      postedAt: "2026-07-14T09:15:00.000Z",
    },
  ]);
});

test("fetchRemotive rejects responses without a jobs array", async () => {
  await assert.rejects(
    fetchRemotive({}, async () => ({})),
    /expected \{ jobs: \[\.\.\.\] \}/i
  );
});

test("fetchWorkingNomads maps array postings", async () => {
  const offers = await fetchWorkingNomads({}, async (url) => {
    assert.equal(url, "https://www.workingnomads.com/api/exposed_jobs/");
    return [
      {
        title: "  Forward Deployed Engineer  ",
        url: " https://jobs.example.test/fde ",
        company_name: "  Example Robotics  ",
        location: "  Remote  ",
        pub_date: "2026-07-15T12:00:00Z",
      },
    ];
  });

  assert.deepEqual(offers, [
    {
      title: "Forward Deployed Engineer",
      url: "https://jobs.example.test/fde",
      company: "Example Robotics",
      location: "Remote",
      postedAt: "2026-07-15T12:00:00.000Z",
    },
  ]);
});

test("fetchWorkingNomads rejects non-array responses", async () => {
  await assert.rejects(
    fetchWorkingNomads({}, async () => ({ jobs: [] })),
    /expected a JSON array/i
  );
});
