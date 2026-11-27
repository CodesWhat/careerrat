import assert from "node:assert/strict";
import test from "node:test";

import {
  checkUrlLiveness,
  extractApplyControlsFromHtml,
  htmlToText,
  isUnreachable,
} from "../src/core/liveness/job-link-checker.mjs";

const SPA_RESPONSE = async () =>
  new Response("<html><body>Loading</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("recommendation-card apply links are not primary posting controls", () => {
  const controls = extractApplyControlsFromHtml(`
    <main><h1>Staff Platform Engineer</h1><p>This role has been removed.</p></main>
    <aside><h2>Similar Jobs</h2><a>Easy Apply</a></aside>
  `);

  assert.deepEqual(controls, []);
});

test("prose containing apply is not an interactive apply control", () => {
  const controls = extractApplyControlsFromHtml(`
    <main>
      <h1>Staff Platform Engineer</h1>
      <p>Apply systems thinking to reliable distributed infrastructure.</p>
    </main>
  `);

  assert.deepEqual(controls, []);
});

test("real apply links and buttons are detected from their accessible labels", () => {
  for (const html of [
    `<a href="/jobs/123/apply"><span>Apply now</span></a>`,
    `<button type="button" aria-label="Submit application"></button>`,
    `<input type="submit" value="Start application">`,
    `<div role="button" title="Easy Apply"></div>`,
  ]) {
    assert.equal(extractApplyControlsFromHtml(html).length, 1, html);
  }
});

test("a real apply button after a long primary description remains detectable", () => {
  const html = `<main><h1>Staff Platform Engineer</h1><p>${"Detailed responsibility. ".repeat(110)}</p><button>Apply now</button></main>`;

  assert.deepEqual(extractApplyControlsFromHtml(html), ["Apply now"]);
});

test("a recommendation boundary after a long description excludes its apply controls", () => {
  const html = `<main><h1>Staff Platform Engineer</h1><p>${"Detailed responsibility. ".repeat(110)}</p></main><aside><h2>Similar Jobs</h2><a href="/jobs/other">Easy Apply</a></aside>`;

  assert.deepEqual(extractApplyControlsFromHtml(html), []);
});

test("liveness stays active when the primary apply button follows a long job description", async () => {
  const html = `<html><body><main><h1>Staff Platform Engineer</h1><p>${"Detailed responsibility. ".repeat(110)}</p><button>Apply now</button></main></body></html>`;
  const result = await checkUrlLiveness("https://jobs.example.com/staff-platform-engineer", {
    fetchImpl: async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    resolveHost: publicResolver,
  });

  assert.equal(result.result, "active");
  assert.equal(result.code, "apply_control_visible");
});

test("short Ashby SPA shell is uncertain rather than expired", async () => {
  const result = await checkUrlLiveness("https://jobs.ashbyhq.com/acme/123", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });

  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "spa_shell");
  assert.equal(result.escalationHint, "browser-evaluate");
  assert.equal("escalationUrl" in result, false);
});

test("Lever SPA shell returns lever-json escalation hint with escalationUrl", async () => {
  const result = await checkUrlLiveness("https://jobs.lever.co/acme/abc-123", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });

  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "spa_shell");
  assert.equal(result.escalationHint, "lever-json");
  assert.equal(result.escalationUrl, "https://api.lever.co/v0/postings/acme?mode=json");
});

test("Lever SPA shell with no path company sets escalationUrl to null", async () => {
  const result = await checkUrlLiveness("https://jobs.lever.co/", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });

  assert.equal(result.escalationHint, "lever-json");
  assert.equal(result.escalationUrl, null);
});

test("Wellfound SPA shell returns browser-evaluate escalation hint", async () => {
  const result = await checkUrlLiveness("https://wellfound.com/company/acme/jobs", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });

  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "spa_shell");
  assert.equal(result.escalationHint, "browser-evaluate");
  assert.equal("escalationUrl" in result, false);
});

test("liveness rejects a DNS name resolving to loopback before fetch", async () => {
  let called = false;
  const result = await checkUrlLiveness("https://attacker.example.test/job", {
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    fetchImpl: async () => {
      called = true;
      throw new Error("unsafe URL must not be fetched");
    },
  });

  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "unsafe_url");
  assert.equal(called, false);
});

test("a network failure is reported as unreachable, a read page is not", async () => {
  const down = await checkUrlLiveness("https://jobs.example.com/1", {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    resolveHost: publicResolver,
  });
  assert.equal(down.result, "uncertain");
  assert.equal(isUnreachable(down), true);
  const read = await checkUrlLiveness("https://jobs.example.com/1", {
    fetchImpl: SPA_RESPONSE,
    resolveHost: publicResolver,
  });
  assert.equal(isUnreachable(read), false);
});

test("checkUrlLiveness: a thin 403 page is uncertain, not expired", async () => {
  const result = await checkUrlLiveness("https://jobs.example.com/role", {
    fetchImpl: async () => new Response("Forbidden", { status: 403 }),
    resolveHost: publicResolver,
  });
  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "http_error");
});

test("checkUrlLiveness: a thin 200 page is uncertain, not expired", async () => {
  const result = await checkUrlLiveness("https://jobs.example.com/role", {
    fetchImpl: async () =>
      new Response("<html><body>Careers</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    resolveHost: publicResolver,
  });
  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "thin_content");
});

test("checkUrlLiveness: network failure keeps the underlying cause in the reason", async () => {
  const result = await checkUrlLiveness("https://jobs.example.com/role", {
    fetchImpl: async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }),
      });
    },
    resolveHost: publicResolver,
  });
  assert.equal(result.code, "fetch_failed");
  assert.match(result.reason, /ENOTFOUND/);
});

// Reference copy of the pre-18583e1f implementation, for differential checks.
function referenceHtmlToText(html = "") {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DIFFERENTIAL_CASES = [
  "<!-- <script> -->Keep me<script>code</script>After",
  "<!-- <style> -->x<style>p{}</style>y",
  "<script>a</script><script>b</script>c",
  "<SCRIPT>x</SCRIPT>y<StYlE>z</sTyLe>w",
  "<script <script>x</script>y",
  "<script><script>x</script>y</script>z",
  "<style><style>x</style>y</style>z",
  '<a title=">">link</a>',
  '<script type="a>b">x</script>after',
  "<script>x</script",
  "<script>x</script >y",
  "<script>x</scr</script>y",
  "<script>never closed",
  "<style>never closed",
  "<script>x</script<b>y",
  "a <> b < c",
  "x <a <b> y",
  "< a>b",
  "<scripts>keep</scripts><styles>k</styles>",
  "<script_x>keep</script_x>",
  "&amp; &lt;b&gt; &#39;x&#39; &nbsp;",
  "a<b",
  "text with a stray > and <",
  "<style>a</style><script>b</style></script>c",
  "<script>a<style>b</script>c</style>d",
];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("htmlToText matches the old regex chain on hand cases", () => {
  for (const html of DIFFERENTIAL_CASES) {
    assert.equal(htmlToText(html), referenceHtmlToText(html), JSON.stringify(html));
  }
  assert.equal(htmlToText("<!-- <script> -->Keep me<script>code</script>After"), "<!-- After");
});

test("htmlToText matches the old regex chain on seeded random HTML", () => {
  const tokens = [
    "<",
    ">",
    "</",
    "/",
    "<script",
    "<SCRIPT",
    "</script",
    "</SCRIPT",
    "<style",
    "<STYLE",
    "</style",
    "</STYLE",
    "<scripts",
    "<a",
    "<b>",
    "</b>",
    '"',
    "'",
    "=",
    "&amp;",
    "&lt;",
    "<!--",
    "-->",
    " ",
    "\n",
    "x",
    "word",
    "_",
    "1",
    "\u017f",
    "\u212a",
  ];
  const random = seededRandom(0xc0ffee);
  for (let n = 0; n < 4000; n += 1) {
    const length = 1 + Math.floor(random() * 14);
    let html = "";
    for (let k = 0; k < length; k += 1) html += tokens[Math.floor(random() * tokens.length)];
    assert.equal(htmlToText(html), referenceHtmlToText(html), JSON.stringify(html));
  }
});

test("htmlToText does a bounded amount of scanning on adversarial input", () => {
  const units = [
    "<script>x ",
    "<style>x ",
    "<a ",
    "</script x ",
    "<script>x</scr ",
    "<style>x</sty ",
    "<script></scr<script></scr",
    "<script>x</script",
    "<",
  ];
  for (const unit of units) {
    for (const n of [2000, 20000]) {
      const html = unit.repeat(n);
      const probe = { steps: 0 };
      htmlToText(html, probe);
      // Three forward-only passes, each touching an index a small constant
      // number of times. Quadratic input would be in the millions here.
      assert.ok(
        probe.steps <= 12 * html.length,
        `${JSON.stringify(unit)} x${n} took ${probe.steps} steps for ${html.length} chars`
      );
    }
  }
});

test("htmlToText wall-clock smoke check on adversarial input", () => {
  const html = "<script>x</scr ".repeat(100000);
  const start = process.hrtime.bigint();
  htmlToText(html);
  assert.ok(Number(process.hrtime.bigint() - start) < 2e9);
});

test("htmlToText keeps its existing behavior", () => {
  assert.equal(htmlToText("<p>Hello <b>world</b></p>"), "Hello world");
  assert.equal(htmlToText("a<script>var x=1;</script>b<style>p{}</STYLE >c"), "a b c");
  assert.equal(htmlToText("a<script>never closed b"), "a never closed b");
  assert.equal(htmlToText("a <> b < c"), "a <> b < c");
  assert.equal(htmlToText("x <a <b> y"), "x y");
  assert.equal(htmlToText("<scripts>keep</scripts>"), "keep");
  assert.equal(htmlToText("a<script>1</script x>b"), "a b");
  assert.equal(htmlToText("no tags   here\n now"), "no tags here now");
});
