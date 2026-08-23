// tests/providers/senjob.test.mjs — new fixture authored 2026-08-23 when
// senjob moved out of CAREER_OPS_DEFERRED_PROVIDER_IDS. The listing markup
// below is invented and domain-neutral (no real employers, no real people) —
// this provider parses HTML from a live board, so nothing here is a captured
// live sample. Structure (sibling-row date, comment-before-tag anchor body,
// hidden ISO date span) mirrors the shapes the provider's own header
// documents as measured on the live board.

import { join } from "path";
import { pathToFileURL } from "url";
import { fail, pass, ROOT } from "../helpers.mjs";

console.log("\nProvider — senjob");

// One posting: title anchor in its own row, place + hidden date in the
// sibling row that follows.
const ROW_WITH_SIBLING_DATE = `
<tr style="height:70px;">
  <td align=center><div align=left>
    <a href="https://senjob.com/jobseekers/assistant-administratif_e_200001.html" style="font-size:18px; color:#222;">
      Assistant Administratif
      <!-- d ico postulez -->
      <img src="images/blank.gif">
      <!-- f ico postulez -->
    </a>
  </div></td>
  <td align=left valign=middle>Dakar</td>
</tr>
<tr>
  <td><a href="https://senjob.com/jobseekers/assistant-administratif_e_200001.html">&nbsp;</a>
    <span style='color:#999;'> Publi&eacute;: </span>
    <span style="display:none;">2026-08-14</span>14&nbsp;Aou.
  </td>
</tr>`;

// A second, self-contained posting whose place cell precedes the "Publié:"
// label inside the SAME row.
const ROW_INLINE = `
<tr>
  <td><div align=left>
    <a href="https://senjob.com/jobseekers/charge-de-clientele_e_200002.html" style="color:#222;">Chargé de Clientèle</a>
  </div></td>
  <td>Dakar <span style='color:#999;'> Publi&eacute;: </span><span style="display:none;">2026-08-12</span>12&nbsp;Aou.</td>
</tr>`;

const PAGE = `<html><body><table>${ROW_WITH_SIBLING_DATE}${ROW_INLINE}</table></body></html>`;

try {
  const senjobModule = await import(
    pathToFileURL(join(ROOT, "src/core/providers/career-ops/vendor/senjob.mjs")).href
  );
  const senjob = senjobModule.default;
  const { parseListingPage, buildListUrl, visibleText, assertParsedSomething } = senjobModule;

  if (senjob.id === "senjob") pass('senjob.id is "senjob"');
  else fail(`senjob.id is ${JSON.stringify(senjob.id)}`);

  // detect(): explicit selection only, like every board-wide provider.
  const hit = senjob.detect({ name: "Senjob", provider: "senjob" });
  if (hit && hit.url === "https://senjob.com/offres-d-emploi.php") {
    pass("detect() resolves provider:senjob -> the listing URL");
  } else {
    fail(`detect() returned ${JSON.stringify(hit)}`);
  }
  if (senjob.detect({ name: "Senjob" }) === null)
    pass("detect() returns null without provider:senjob");
  else fail("detect() must require provider:senjob");

  // buildListUrl(): page 1 is the bare path the board itself links.
  if (
    buildListUrl(1) === "https://senjob.com/offres-d-emploi.php" &&
    buildListUrl(3) === "https://senjob.com/offres-d-emploi.php?page=3"
  ) {
    pass("buildListUrl(): page 1 bare, later pages carry ?page=N");
  } else {
    fail(`buildListUrl drift: ${buildListUrl(1)} / ${buildListUrl(3)}`);
  }

  // visibleText(): comments stripped BEFORE tags, entities decoded once.
  const titleFragment = 'Assistant Administratif <!-- d ico postulez --> <img src="x.gif">';
  if (visibleText(titleFragment) === "Assistant Administratif") {
    pass("visibleText() drops HTML comments, not just tags");
  } else {
    fail(`visibleText() => ${JSON.stringify(visibleText(titleFragment))}`);
  }
  if (visibleText("&amp;quot;") === "&quot;" && visibleText("&amp;amp;") === "&amp;") {
    pass("visibleText() decodes entities once — &amp;quot; stays literal (no double-unescape)");
  } else {
    fail(`double-unescape: &amp;quot; => ${JSON.stringify(visibleText("&amp;quot;"))}`);
  }
  if (
    visibleText("R&amp;D") === "R&D" &&
    visibleText("Charg&eacute; de projet") === "Chargé de projet" &&
    visibleText("D&#233;veloppeur") === "Développeur"
  ) {
    pass("visibleText() decodes named, accented and numeric entities");
  } else {
    fail(
      `entity decoding drift: ${JSON.stringify([visibleText("R&amp;D"), visibleText("Charg&eacute; de projet")])}`
    );
  }
  if (visibleText("&unknown; &fakeent; net") === "&unknown; &fakeent; net") {
    pass("visibleText() leaves an unknown entity untouched");
  } else {
    fail(`unknown entity mangled: ${JSON.stringify(visibleText("&unknown; &fakeent; net"))}`);
  }

  // parseListingPage(): offer mapping from the two invented rows.
  const jobs = parseListingPage(PAGE);
  if (jobs.length === 2)
    pass("parseListingPage() returns one job per posting id, sticky rows merged");
  else fail(`parseListingPage() returned ${jobs.length} jobs: ${JSON.stringify(jobs)}`);

  const admin = jobs.find((j) => /Administratif/.test(j.title));
  if (admin && admin.title === "Assistant Administratif") {
    pass("title comes from the anchor body, comment and spacer image removed");
  } else {
    fail(`title drift: ${JSON.stringify(admin)}`);
  }
  if (
    admin &&
    admin.url === "https://senjob.com/jobseekers/assistant-administratif_e_200001.html"
  ) {
    pass("url is the absolute posting link");
  } else {
    fail(`url drift: ${JSON.stringify(admin && admin.url)}`);
  }
  if (admin && admin.location === "Dakar") {
    pass("location is read from the cell after the title");
  } else {
    fail(`location drift: ${JSON.stringify(admin && admin.location)}`);
  }
  // The date lives in a DIFFERENT row than the title — the case that motivates
  // merging by id instead of windowing around the link.
  if (admin && admin.postedAt === Date.parse("2026-08-14T00:00:00Z")) {
    pass("postedAt is picked up from the sibling row, not lost");
  } else {
    fail(`postedAt drift: ${JSON.stringify(admin && admin.postedAt)}`);
  }

  const clientele = jobs.find((j) => /Client/.test(j.title));
  if (
    clientele &&
    clientele.location === "Dakar" &&
    clientele.postedAt === Date.parse("2026-08-12T00:00:00Z")
  ) {
    pass("a posting whose place and date share one row parses too");
  } else {
    fail(`inline row drift: ${JSON.stringify(clientele)}`);
  }
  if (jobs.every((j) => j.company === "")) {
    pass("company is left empty rather than invented from the slug");
  } else {
    fail(`company was populated: ${JSON.stringify(jobs.map((j) => j.company))}`);
  }

  // The silent-zero guard.
  let threw = false;
  try {
    assertParsedSomething(PAGE, "https://senjob.com/offres-d-emploi.php");
  } catch {
    threw = true;
  }
  if (threw) pass("assertParsedSomething() throws when posting links are present but unparsed");
  else fail("a page still full of posting links must not be reported as empty");

  let threwOnEmpty = false;
  try {
    assertParsedSomething(
      "<html><body>No results.</body></html>",
      "https://senjob.com/offres-d-emploi.php"
    );
  } catch {
    threwOnEmpty = true;
  }
  if (!threwOnEmpty) pass("a genuinely empty page does not throw — only an unparsed one does");
  else fail("an empty listing page must be allowed, or a quiet board reads as broken");

  // fetch(): pagination, dedup, pacing, and pinned request options.
  const pages = new Map([
    ["https://senjob.com/offres-d-emploi.php", PAGE],
    ["https://senjob.com/offres-d-emploi.php?page=2", ROW_INLINE], // only a sticky repeat
  ]);
  const requested = [];
  let slept = 0;
  const opts = [];
  const ctx = {
    maxPages: 5,
    sleep: async (ms) => {
      slept += ms;
    },
    fetchText: async (url, o) => {
      requested.push(url);
      opts.push(o);
      return pages.get(url) ?? "<html><body>No results.</body></html>";
    },
  };

  const fetched = await senjob.fetch({ provider: "senjob" }, ctx);
  if (fetched.length === 2) pass("fetch() dedups a sticky posting repeated on the next page");
  else fail(`fetch() returned ${fetched.length}: ${JSON.stringify(fetched.map((j) => j.url))}`);
  if (requested.length === 2) pass("fetch() stops once a page contributes no new posting");
  else fail(`fetch() requested ${requested.length} pages: ${JSON.stringify(requested)}`);
  if (slept >= 250) pass("fetch() paces between pages of the same board");
  else fail(`fetch() slept ${slept}ms between pages`);
  const pinned =
    opts.length > 0 &&
    opts.every(
      (o) =>
        o?.redirect === "error" &&
        typeof o.headers?.["User-Agent"] === "string" &&
        o.headers["User-Agent"].length > 0
    );
  if (pinned) pass("fetch() sends redirect:error and a browser-like User-Agent on every request");
  else fail(`request options drift: ${JSON.stringify(opts)}`);

  // fetch(): a broken page 1 is an error, never an empty board — the markup
  // change surfaces as postings still on the page but off the parsed shape.
  let fetchThrew = false;
  try {
    await senjob.fetch(
      { provider: "senjob" },
      {
        sleep: async () => {},
        fetchText: async () => '<div data-url="https://senjob.com/jobseekers/x_e_1.html">x</div>',
      }
    );
  } catch (err) {
    fetchThrew = /markup changed/.test(String(err && err.message));
  }
  if (fetchThrew) pass("fetch() throws when page 1 has postings it cannot parse");
  else fail("a markup change must surface as an error, not as a board with no jobs");
} catch (error) {
  fail(`senjob provider tests could not run: ${error.message}`);
}
