// tests/providers/feishu-jobs.test.mjs: new fixture authored 2026-09-02 for
// the ffb49be1 vendor roll, when feishu-jobs was added upstream. Sample
// payloads below are invented and domain-neutral (no real employers, no real
// people). This provider's own API carries real third-party posting
// content, so nothing here is a captured live sample.

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider: feishu-jobs");

try {
  const mod = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/feishu-jobs.mjs")).href
  );
  const provider = mod.default;
  const { parseFeishuJobsResponse } = mod;

  if (provider.id === "feishu-jobs") pass('feishu-jobs.id is "feishu-jobs"');
  else fail(`feishu-jobs.id is ${JSON.stringify(provider.id)}`);

  // detect() accepts jobs.bytedance.com and *.jobs.feishu.cn, rejects
  // other hosts and non-https.
  const byteDance = provider.detect({ careers_url: "https://jobs.bytedance.com/careers" });
  const sharedTenant = provider.detect({ careers_url: "https://acme.jobs.feishu.cn/careers" });
  const rejected = [
    provider.detect({ careers_url: "http://jobs.bytedance.com" }),
    provider.detect({ careers_url: "https://evil.example/jobs.bytedance.com" }),
    provider.detect({ careers_url: "not a url" }),
    provider.detect({}),
  ];
  if (
    byteDance?.url === "https://jobs.bytedance.com" &&
    sharedTenant?.url === "https://acme.jobs.feishu.cn" &&
    rejected.every((r) => r === null)
  ) {
    pass(
      "detect() accepts jobs.bytedance.com and *.jobs.feishu.cn over https, rejects everything else"
    );
  } else {
    fail(`detect() = ${JSON.stringify({ byteDance, sharedTenant, rejected })}`);
  }

  // parseFeishuJobsResponse: ByteDance's own domain routes through
  // /experienced/position/, a shared tenant routes through /index/position/,
  // and rows missing title/id are dropped.
  const bdResponse = {
    data: {
      count: 2,
      job_post_list: [
        {
          id: 501,
          title: "Widget Engineer",
          city_list: [{ name: "Beijing" }, { name: "Shanghai" }],
          job_category: { name: "Engineering" },
          recruit_type: { name: "Experienced" },
          description: "Build widgets.",
          requirement: "Ship things.",
          publish_time: 1_700_000_000_000,
        },
        { title: "No id" },
      ],
    },
  };
  const bd = parseFeishuJobsResponse(bdResponse, "Acme", "https://jobs.bytedance.com");
  if (
    bd.jobs.length === 1 &&
    bd.jobs[0].title === "Widget Engineer" &&
    bd.jobs[0].url === "https://jobs.bytedance.com/experienced/position/501/detail" &&
    bd.jobs[0].company === "Acme" &&
    bd.jobs[0].location === "Beijing/Shanghai" &&
    bd.jobs[0].description.includes("类别: Engineering") &&
    bd.jobs[0].description.includes("类型: Experienced") &&
    bd.jobs[0].description.includes("Build widgets.") &&
    bd.jobs[0].postedAt === 1_700_000_000_000 &&
    bd.total === 2
  ) {
    pass(
      "parseFeishuJobsResponse maps ByteDance's own domain through /experienced/position/ and drops id-less rows"
    );
  } else {
    fail(`parseFeishuJobsResponse (bytedance) = ${JSON.stringify(bd)}`);
  }

  const sharedResponse = {
    data: {
      count: 1,
      job_post_list: [{ id: 77, title: "Widget Analyst", city_list: [] }],
    },
  };
  const shared = parseFeishuJobsResponse(sharedResponse, "Acme", "https://acme.jobs.feishu.cn");
  if (shared.jobs[0]?.url === "https://acme.jobs.feishu.cn/index/position/77/detail") {
    pass("parseFeishuJobsResponse routes a shared tenant through /index/position/");
  } else {
    fail(`parseFeishuJobsResponse (shared) url = ${JSON.stringify(shared.jobs[0]?.url)}`);
  }

  const malformed = parseFeishuJobsResponse({ data: {} }, "Acme", "https://jobs.bytedance.com");
  if (malformed.jobs.length === 0 && malformed.total === 0) {
    pass("parseFeishuJobsResponse returns an empty list for a payload without job_post_list");
  } else {
    fail(`parseFeishuJobsResponse malformed = ${JSON.stringify(malformed)}`);
  }

  // fetch() POSTs to /api/v1/search/job/posts, stops once an empty page
  // comes back, dedupes by url, and pins redirect:error + the macOS UA.
  // count is well above PAGE_SIZE (100) so the covered>=total early-exit does
  // not fire after page 1. The walk must instead reach the truly empty page.
  const page1 = {
    code: 0,
    data: {
      count: 150,
      job_post_list: [{ id: 1, title: "Widget Engineer I", city_list: [] }],
    },
  };
  const page2 = { code: 0, data: { count: 150, job_post_list: [] } };
  const requested = [];
  const jobs = await provider.fetch(
    { name: "Acme", careers_url: "https://jobs.bytedance.com" },
    {
      transport: "http",
      sleep: async () => {},
      fetchJson: async (url, opts) => {
        requested.push({ url, headers: opts?.headers, redirect: opts?.redirect });
        const body = JSON.parse(opts.body);
        return body.offset === 0 ? page1 : page2;
      },
    }
  );
  if (
    jobs.length === 1 &&
    new URL(jobs[0].url).hostname === "jobs.bytedance.com" &&
    requested.length === 2 &&
    requested.every((r) => r.url === "https://jobs.bytedance.com/api/v1/search/job/posts") &&
    requested.every((r) => r.redirect === "error") &&
    requested.every((r) => r.headers["user-agent"].includes("Macintosh"))
  ) {
    pass(
      'feishu-jobs.fetch paginates by offset, stops on an empty page, sends redirect:"error" + a macOS UA'
    );
  } else {
    fail(
      `feishu-jobs.fetch pagination = ${JSON.stringify({
        count: jobs.length,
        requests: requested.length,
      })}`
    );
  }

  // fetch() throws on an unrecognized careers_url.
  let threw = false;
  try {
    await provider.fetch({ careers_url: "https://evil.example" }, { transport: "http" });
  } catch {
    threw = true;
  }
  if (threw) pass("feishu-jobs.fetch throws for a careers_url outside the allowed hosts");
  else fail("feishu-jobs.fetch did not throw for a disallowed host");
} catch (e) {
  fail(`feishu-jobs provider test crashed: ${e?.message}`);
}
