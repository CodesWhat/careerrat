// tests/providers/mokahr.test.mjs: new fixture authored 2026-09-02 for the
// ffb49be1 vendor roll, when mokahr was added upstream. Sample payloads below
// are invented and domain-neutral (no real employers, no real people). This
// provider's own API carries real third-party posting content, so nothing
// here is a captured live sample. The AES envelope is built in-test with
// Node's own crypto (the same IV the provider hardcodes) rather than a
// captured ciphertext, since decryptMokaHrEnvelope's inverse is trivial and
// self-documenting here.

import { createCipheriv } from "crypto";
import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider: mokahr");

const AES_IV = Buffer.from("de7c21ed8d6f50fe", "utf8");

function encryptEnvelope(payload, key = "abcd1234wxyz5678") {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), AES_IV);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { data: data.toString("base64"), necromancer: key };
}

try {
  const mod = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/mokahr.mjs")).href
  );
  const provider = mod.default;
  const { decryptMokaHrEnvelope, parseMokaHrJobs } = mod;

  if (provider.id === "mokahr") pass('mokahr.id is "mokahr"');
  else fail(`mokahr.id is ${JSON.stringify(provider.id)}`);

  // detect() accepts the three known tenant path prefixes on
  // app.mokahr.com with a positive numeric site id, rejects everything else.
  const social = provider.detect({
    careers_url: "https://app.mokahr.com/social-recruitment/acme/140576",
  });
  const apply = provider.detect({ careers_url: "https://app.mokahr.com/apply/acme/140576" });
  const rejected = [
    provider.detect({ careers_url: "http://app.mokahr.com/apply/acme/140576" }),
    provider.detect({ careers_url: "https://app.mokahr.com/apply/acme/0" }),
    provider.detect({ careers_url: "https://evil.example/apply/acme/140576" }),
    provider.detect({ careers_url: "not a url" }),
    provider.detect({}),
  ];
  if (
    social?.url === "https://app.mokahr.com/social-recruitment/acme/140576" &&
    apply?.url === "https://app.mokahr.com/apply/acme/140576" &&
    rejected.every((r) => r === null)
  ) {
    pass(
      "detect() accepts recognized app.mokahr.com tenant paths with a positive site id, rejects the rest"
    );
  } else {
    fail(`detect() = ${JSON.stringify({ social, apply, rejected })}`);
  }

  // decryptMokaHrEnvelope round-trips a real aes-128-cbc envelope, and
  // rejects a malformed one instead of silently returning garbage.
  const payload = { code: 0, success: true, data: { jobs: [] } };
  const decrypted = decryptMokaHrEnvelope(encryptEnvelope(payload));
  if (decrypted?.success === true && Array.isArray(decrypted?.data?.jobs)) {
    pass("decryptMokaHrEnvelope round-trips a real aes-128-cbc envelope with the pinned IV");
  } else {
    fail(`decryptMokaHrEnvelope round-trip = ${JSON.stringify(decrypted)}`);
  }
  let threwOnMissing = false;
  try {
    decryptMokaHrEnvelope({ data: "x" });
  } catch {
    threwOnMissing = true;
  }
  let threwOnShortKey = false;
  try {
    decryptMokaHrEnvelope({ data: "eA==", necromancer: "short" });
  } catch {
    threwOnShortKey = true;
  }
  if (threwOnMissing && threwOnShortKey) {
    pass("decryptMokaHrEnvelope throws on a missing necromancer key and on a non-16-byte key");
  } else {
    fail(`decryptMokaHrEnvelope guard = ${JSON.stringify({ threwOnMissing, threwOnShortKey })}`);
  }

  // parseMokaHrJobs: province+city join (not city alone, so a downstream
  // location_filter has a province/country substring to match), commitment +
  // department prefixed onto the HTML-stripped description, and a
  // non-timezone-qualified createdAt is dropped rather than fabricated.
  const decryptedList = {
    data: {
      jobs: [
        {
          id: 501,
          title: "Widget Engineer",
          locations: [{ provinceName: "北京市", cityName: "海淀区" }],
          department: { name: "Engineering" },
          commitment: "Full-time",
          jobDescription: "<p>Build widgets.</p>",
          createdAt: "2026-08-15T00:00:00Z",
        },
        {
          id: 502,
          title: "Naive Date Row",
          locations: [],
          jobDescription: "No offset here.",
          createdAt: "2026-08-15 00:00:00",
        },
        { title: "No id" },
      ],
    },
  };
  const jobs = parseMokaHrJobs(decryptedList, "Acme", "https://app.mokahr.com/apply/acme/140576");
  const full = jobs.find((j) => j.title === "Widget Engineer");
  if (
    full &&
    full.url === "https://app.mokahr.com/apply/acme/140576#/job/501" &&
    full.company === "Acme" &&
    full.location === "北京市 海淀区" &&
    full.description.includes("类型: Full-time") &&
    full.description.includes("部门: Engineering") &&
    full.description.includes("Build widgets.") &&
    full.postedAt === Date.parse("2026-08-15T00:00:00Z")
  ) {
    pass(
      "parseMokaHrJobs maps province+city location, prefixes commitment/department, strips description HTML"
    );
  } else {
    fail(`parseMokaHrJobs full row = ${JSON.stringify(full)}`);
  }
  const naive = jobs.find((j) => j.title === "Naive Date Row");
  if (naive && naive.postedAt === undefined) {
    pass("parseMokaHrJobs omits postedAt for a createdAt with no explicit timezone offset");
  } else {
    fail(`parseMokaHrJobs naive-date row = ${JSON.stringify(naive)}`);
  }
  if (jobs.length === 2) pass("parseMokaHrJobs drops rows with no id");
  else fail(`parseMokaHrJobs row count = ${jobs.length}`);

  // fetch() decrypts each page, stops when a page returns fewer than the
  // 50-row ceiling, dedupes by url, and always requests limit:50.
  const page1Jobs = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    title: `Widget Role ${i + 1}`,
    locations: [{ provinceName: "浙江", cityName: "拱墅区" }],
  }));
  const page2Jobs = [{ id: 51, title: "Widget Role 51", locations: [] }];
  const requestedBodies = [];
  const jobsFetched = await provider.fetch(
    { name: "Acme", careers_url: "https://app.mokahr.com/apply/acme/140576" },
    {
      transport: "http",
      sleep: async () => {},
      fetchJson: async (url, opts) => {
        const body = JSON.parse(opts.body);
        requestedBodies.push(body);
        const rows = body.offset === 0 ? page1Jobs : page2Jobs;
        return encryptEnvelope({ code: 0, success: true, data: { jobs: rows } });
      },
    }
  );
  if (
    jobsFetched.length === 51 &&
    requestedBodies.length === 2 &&
    requestedBodies.every((b) => b.limit === 50) &&
    requestedBodies[0].offset === 0 &&
    requestedBodies[1].offset === 50
  ) {
    pass("mokahr.fetch decrypts each page, requests limit:50, and stops once a page is short");
  } else {
    fail(
      `mokahr.fetch pagination = ${JSON.stringify({ count: jobsFetched.length, requests: requestedBodies.length })}`
    );
  }

  // fetch() throws for a careers_url outside the recognized tenant shape.
  let threw = false;
  try {
    await provider.fetch({ careers_url: "https://evil.example" }, { transport: "http" });
  } catch {
    threw = true;
  }
  if (threw) pass("mokahr.fetch throws for a careers_url outside the allowed tenant shape");
  else fail("mokahr.fetch did not throw for a disallowed tenant URL");
} catch (e) {
  fail(`mokahr provider test crashed: ${e?.message}`);
}
