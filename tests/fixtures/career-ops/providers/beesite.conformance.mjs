// tests/providers/beesite.test.mjs — moved verbatim from test-all.mjs (#1440).

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider — beesite (milch & zucker GJB search API)");
try {
  const beesiteModule = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/beesite.mjs")).href
  );
  const beesite = beesiteModule.default;
  const {
    resolveConfig: beeConfig,
    buildSearchUrl,
    parseBeesiteDate,
    parseSearchResult,
  } = beesiteModule;

  if (beesite.id === "beesite") pass('beesite.id is "beesite"');
  else fail(`beesite.id is ${JSON.stringify(beesite.id)}`);

  // resolveConfig — host-anchored, config block passthrough.
  const bCfg = beeConfig({
    api: "https://mercedes-benz-beesite-production-gjb.app.beesite.de",
    beesite: {
      languageCode: "DE",
      searchCriteria: [{ CriterionName: "PositionLocation.Country", CriterionValue: [329] }],
    },
  });
  if (
    bCfg &&
    bCfg.searchApi === "https://mercedes-benz-beesite-production-gjb.app.beesite.de/search" &&
    bCfg.languageCode === "DE" &&
    bCfg.searchCriteria.length === 1
  ) {
    pass("beesite.resolveConfig() parses host and passes the beesite config block through");
  } else {
    fail(`beesite.resolveConfig() wrong: ${JSON.stringify(bCfg)}`);
  }
  if (
    beesite.detect({ careers_url: "https://evil.com/x.beesite.de" }) === null &&
    beesite.detect({ careers_url: "https://beesite.de.evil.com/x" }) === null
  ) {
    pass("beesite.detect() rejects path- and suffix-spoofed hosts");
  } else {
    fail("beesite.detect() should reject spoofed hosts");
  }

  // buildSearchUrl — FirstItem lands in the encoded payload.
  const bUrl = buildSearchUrl(bCfg, 101);
  if (
    bUrl.startsWith(bCfg.searchApi + "?data=") &&
    decodeURIComponent(bUrl).includes('"FirstItem":101') &&
    decodeURIComponent(bUrl).includes('"CriterionValue":[329]')
  ) {
    pass("beesite.buildSearchUrl() encodes FirstItem and the pinned criteria");
  } else {
    fail(`beesite.buildSearchUrl() wrong: ${bUrl.slice(0, 140)}`);
  }

  if (
    parseBeesiteDate("2026-07-04") === Date.UTC(2026, 6, 4) &&
    parseBeesiteDate("junk") === undefined
  )
    pass("beesite.parseBeesiteDate() reads YYYY-MM-DD, rejects junk");
  else fail("beesite.parseBeesiteDate() wrong");

  // parseSearchResult — id/title/absolute-URL required, cities joined.
  const mkItem = (id, title, uri) => ({
    MatchedObjectId: String(id),
    MatchedObjectDescriptor: {
      PositionID: `x${id}`,
      PositionTitle: title,
      PositionURI: uri,
      PositionLocation: [{ CityName: "Bremen" }, { CityName: "Berlin" }],
      PublicationStartDate: "2026-07-04",
    },
  });
  const beeJson = {
    SearchResult: {
      SearchResultCount: 2,
      SearchResultCountAll: 42,
      SearchResultItems: [
        mkItem(1, "IT Architect", "https://jobs.example.com/a-1"),
        {
          MatchedObjectId: "2",
          MatchedObjectDescriptor: { PositionTitle: "No URI — dropped", PositionURI: "/relative" },
        },
      ],
    },
  };
  const { total: beeTotal, rows: beeRows } = parseSearchResult(beeJson);
  if (
    beeTotal === 42 &&
    beeRows.length === 1 &&
    beeRows[0].location === "Bremen / Berlin" &&
    beeRows[0].postedAt === Date.UTC(2026, 6, 4)
  ) {
    pass("beesite.parseSearchResult() maps items, joins cities, drops non-absolute URIs");
  } else {
    fail(`beesite.parseSearchResult() wrong: total=${beeTotal} rows=${JSON.stringify(beeRows)}`);
  }

  // fetch — paginates by FirstItem until SearchResultCountAll, dedups.
  const beePage = (ids) => ({
    SearchResult: {
      SearchResultCount: ids.length,
      SearchResultCountAll: 150,
      SearchResultItems: ids.map((i) => mkItem(i, `Job ${i}`, `https://jobs.example.com/j-${i}`)),
    },
  });
  const beePages = [
    beePage(Array.from({ length: 100 }, (_, i) => i + 1)),
    beePage([100, 101, 102]),
  ];
  let beeCalls = 0;
  const beeSeen = [];
  const beeCtx = {
    sleep: async () => {},
    fetchJson: async (url) => {
      beeSeen.push(decodeURIComponent(url));
      return beePages[beeCalls++] ?? beePage([]);
    },
  };
  const beeJobs = await beesite.fetch({ name: "MB", api: "https://x.app.beesite.de" }, beeCtx);
  if (beeJobs.length === 102 && beeCalls === 2 && beeSeen[1].includes('"FirstItem":101'))
    pass("beesite.fetch() paginates via FirstItem and dedups across pages");
  else fail(`beesite.fetch() returned ${beeJobs.length} jobs after ${beeCalls} calls`);

  // Title entity decoding (#2921) — an undecoded "R&amp;D Engineer" fails a
  // user's positive title_filter keyword "r&d" and the posting is silently
  // dropped, and a negative filter's veto never fires. Numeric entities matter
  // as much as &amp; here: beesite points at DACH postings where accented
  // characters via numeric refs are routine.
  const beeEntityJson = {
    SearchResult: {
      SearchResultCount: 1,
      SearchResultCountAll: 1,
      SearchResultItems: [
        {
          MatchedObjectId: "1",
          MatchedObjectDescriptor: {
            PositionID: "x1",
            PositionTitle: "R&amp;D Engineer",
            PositionURI: "https://jobs.example.com/a-1",
            PositionLocation: [{ CityName: "Bremen" }],
            PublicationStartDate: "2026-07-04",
          },
        },
      ],
    },
  };
  const { rows: beeEntityRows } = parseSearchResult(beeEntityJson);
  if (beeEntityRows[0]?.title === "R&D Engineer")
    pass("beesite parseSearchResult() decodes &amp; in the title (#2921)");
  else fail(`beesite title decode = ${JSON.stringify(beeEntityRows[0]?.title)}`);

  // Named Latin-1 letter entities, not just &amp; and numeric refs. The
  // expanded shared decoder handles these too, and case-sensitively
  // (&Eacute; is É, not é). PositionTitle is the field decodeEntities()
  // actually runs on (PositionLocation.CityName is not decoded).
  const beeNamedEntityJson = {
    SearchResult: {
      SearchResultCount: 1,
      SearchResultCountAll: 1,
      SearchResultItems: [
        {
          MatchedObjectId: "2",
          MatchedObjectDescriptor: {
            PositionID: "x2",
            PositionTitle: "Caf&eacute; Gen&egrave;ve vs CAF&Eacute; GEN&Egrave;VE",
            PositionURI: "https://jobs.example.com/a-2",
            PositionLocation: [{ CityName: "Geneva" }],
            PublicationStartDate: "2026-07-04",
          },
        },
      ],
    },
  };
  const { rows: beeNamedEntityRows } = parseSearchResult(beeNamedEntityJson);
  if (beeNamedEntityRows[0]?.title === "Café Genève vs CAFÉ GENÈVE")
    pass(
      "beesite parseSearchResult() decodes named Latin-1 entities case-sensitively (eacute/Eacute/egrave)"
    );
  else fail(`beesite named entity title decode = ${JSON.stringify(beeNamedEntityRows[0]?.title)}`);
} catch (e) {
  fail(`beesite provider tests crashed: ${e.message}`);
}
