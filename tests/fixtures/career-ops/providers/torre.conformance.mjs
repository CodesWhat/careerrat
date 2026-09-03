// tests/providers/torre.test.mjs: new fixture authored 2026-09-02 for the
// ffb49be1 vendor roll, when torre was added upstream. Sample payloads below
// are invented and domain-neutral (no real employers, no real people).

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider: torre");

try {
  const mod = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/torre.mjs")).href
  );
  const provider = mod.default;
  const { buildTorreQuery, normalizeTorreOpportunity } = mod;

  if (provider.id === "torre") pass('torre.id is "torre"');
  else fail(`torre.id is ${JSON.stringify(provider.id)}`);

  // buildTorreQuery: no filters by default, search pairs with a required
  // experience companion (defaulted when absent), remote_only is only ever
  // sent as the positive case, and an invalid experience throws.
  if (Object.keys(buildTorreQuery({})).length === 0) {
    pass("buildTorreQuery emits no filters for an entry with no search/remote_only");
  } else {
    fail(`buildTorreQuery({}) = ${JSON.stringify(buildTorreQuery({}))}`);
  }
  const withSearch = buildTorreQuery({ search: "engineering manager" });
  if (
    withSearch["skill/role"]?.text === "engineering manager" &&
    withSearch["skill/role"]?.experience === "1-plus-year"
  ) {
    pass('buildTorreQuery pairs "search" with the default experience companion');
  } else {
    fail(`buildTorreQuery(search only) = ${JSON.stringify(withSearch)}`);
  }
  const withExperience = buildTorreQuery({ search: "designer", experience: "5-plus-years" });
  if (withExperience["skill/role"]?.experience === "5-plus-years") {
    pass("buildTorreQuery honors an explicit valid experience level");
  } else {
    fail(`buildTorreQuery(explicit experience) = ${JSON.stringify(withExperience)}`);
  }
  const withRemote = buildTorreQuery({ remote_only: true });
  const withoutRemote = buildTorreQuery({ remote_only: false });
  if (withRemote.remote?.term === true && !("remote" in withoutRemote)) {
    pass(
      "buildTorreQuery sends remote:{term:true} only for remote_only:true, never a negative filter"
    );
  } else {
    fail(`buildTorreQuery remote = ${JSON.stringify({ withRemote, withoutRemote })}`);
  }
  let threwOnBadExperience = false;
  try {
    buildTorreQuery({ search: "x", experience: "not-a-level" });
  } catch {
    threwOnBadExperience = true;
  }
  if (threwOnBadExperience) pass("buildTorreQuery throws on an unrecognized experience level");
  else fail("buildTorreQuery did not throw on an invalid experience level");

  // normalizeTorreOpportunity: full mapping, remote location prefixing,
  // company/fallback chain, closed-status drop, and a malformed id drop.
  const full = normalizeTorreOpportunity(
    {
      objective: "  Widget Engineer  ",
      id: "NwBp2Axr",
      status: "open",
      organizations: [{ name: "  Acme  " }],
      locations: ["Colombia", "Mexico"],
      remote: false,
      created: "2026-07-01T12:00:00.000Z",
    },
    "Fallback"
  );
  if (
    full &&
    full.title === "Widget Engineer" &&
    full.url === "https://torre.ai/post/NwBp2Axr" &&
    full.company === "Acme" &&
    full.location === "Colombia, Mexico" &&
    full.postedAt === Date.parse("2026-07-01T12:00:00.000Z")
  ) {
    pass("normalizeTorreOpportunity maps objective/id/organizations/locations/created");
  } else {
    fail(`normalizeTorreOpportunity full row = ${JSON.stringify(full)}`);
  }

  const remoteWithCountries = normalizeTorreOpportunity({
    objective: "R",
    id: "abcd1234",
    remote: true,
    locations: ["Colombia"],
  });
  const remoteOnly = normalizeTorreOpportunity({
    objective: "R",
    id: "abcd5678",
    remote: true,
    locations: [],
  });
  if (remoteWithCountries?.location === "Remote — Colombia" && remoteOnly?.location === "Remote") {
    pass(
      'normalizeTorreOpportunity prefixes "Remote —" when countries are present, else plain "Remote"'
    );
  } else {
    fail(
      `normalizeTorreOpportunity remote = ${JSON.stringify({
        withCountries: remoteWithCountries?.location,
        only: remoteOnly?.location,
      })}`
    );
  }

  const noOrg = normalizeTorreOpportunity({ objective: "R", id: "abcd9999" }, "Entry Name");
  const noOrgNoFallback = normalizeTorreOpportunity({ objective: "R", id: "abcd0000" });
  if (noOrg?.company === "Entry Name" && noOrgNoFallback?.company === "Torre") {
    pass('normalizeTorreOpportunity falls back company -> entry name -> "Torre"');
  } else {
    fail(
      `normalizeTorreOpportunity company fallback = ${JSON.stringify({
        a: noOrg?.company,
        b: noOrgNoFallback?.company,
      })}`
    );
  }

  const drops = [
    normalizeTorreOpportunity({ objective: "", id: "abcd1111" }),
    normalizeTorreOpportunity({ objective: "R", id: "abcd2222", status: "closed" }),
    normalizeTorreOpportunity({ objective: "R", id: "not an id!" }),
    normalizeTorreOpportunity({ objective: "R" }),
    normalizeTorreOpportunity(null),
    normalizeTorreOpportunity("nope"),
  ];
  if (drops.every((r) => r === null)) {
    pass(
      "normalizeTorreOpportunity drops empty-title / closed / malformed-id / missing-id / non-object rows"
    );
  } else {
    fail(`normalizeTorreOpportunity drops = ${JSON.stringify(drops)}`);
  }

  // fetch() issues exactly ONE request (the endpoint cannot be paged), dedupes by
  // url, pins redirect:error, and passes the built query as the POST body.
  const requested = [];
  const jobs = await provider.fetch(
    { name: "Torre Co", search: "engineering manager" },
    {
      transport: "http",
      fetchJson: async (url, opts) => {
        requested.push({
          url,
          method: opts?.method,
          redirect: opts?.redirect,
          body: JSON.parse(opts.body),
        });
        return {
          results: [
            { objective: "Widget Engineer", id: "NwBp2Axr", status: "open" },
            { objective: "Widget Engineer", id: "NwBp2Axr", status: "open" }, // duplicate, must dedupe
            { objective: "", id: "abcd1111" }, // dropped
          ],
        };
      },
    }
  );
  if (
    jobs.length === 1 &&
    requested.length === 1 &&
    requested[0].method === "POST" &&
    requested[0].redirect === "error" &&
    requested[0].url === "https://search.torre.co/opportunities/_search?offset=0&size=20" &&
    requested[0].body["skill/role"]?.text === "engineering manager"
  ) {
    pass('torre.fetch issues exactly one POST, dedupes results, and sends redirect:"error"');
  } else {
    fail(
      `torre.fetch = ${JSON.stringify({ count: jobs.length, requests: requested.length, first: requested[0] })}`
    );
  }

  // A response without a results array must throw, not silently return [].
  let threwOnMalformed = false;
  try {
    await provider.fetch({ name: "Torre Co" }, { transport: "http", fetchJson: async () => ({}) });
  } catch {
    threwOnMalformed = true;
  }
  if (threwOnMalformed) pass("torre.fetch throws on a response without a results array");
  else fail("torre.fetch did not throw on a malformed response");
} catch (e) {
  fail(`torre provider test crashed: ${e?.message}`);
}
