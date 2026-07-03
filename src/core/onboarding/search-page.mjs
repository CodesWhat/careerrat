// search-page.mjs — M3 of the paid-POC journey: the /search surface's UI. A
// single self-contained page over the existing deterministic (non-AI)
// ATS-board sweep: a header strip reports the configured source counts and a
// "Run sweep" button POSTs /api/search/scan (src/cli/search-route.mjs, which
// drives scripts/scan-sourced.mjs's runSourcedScan() in-process); results
// render as glanceable rows (never a giant dense table — see the repo's
// no-giant-tables convention), each with an "Evaluate" link that hands the
// posting URL straight to /evaluate?url=… for the body-read gate.
//
// Cloned structurally from onboard-page.mjs's exact pattern: a plain
// template-literal export (no server-side interpolation) mounted verbatim by
// tracker-dev.mjs at GET /search, byte-static and cacheable. No SSE here —
// every call is a plain fetch()-then-JSON round trip (POST /api/search/scan
// runs to completion before responding; it is not streamed). Inline <script>
// avoids template literals, backticks, and regex/backslash escapes entirely
// (string concatenation with + instead), same as onboard-page.mjs, so it can
// live inside this file's own outer template literal without any
// double-escaping bookkeeping. It is syntax-checked (not executed) by
// tests/search-page.test.mjs, the same `new Function()` guard
// client-script.test.mjs uses for DASHBOARD_SCRIPT.

export const SEARCH_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Search — Rolester</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --panel: #f6f7f9;
    --text: #1c1f24;
    --muted: #5b6270;
    --border: #dde1e7;
    --accent: #2f5fda;
    --good: #1a7f4e;
    --warn: #a86400;
    --bad: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --panel: #1d2025;
      --text: #e9ebef;
      --muted: #9aa2b1;
      --border: #2c3038;
      --accent: #7fa1ff;
      --good: #4fd48d;
      --warn: #e0a944;
      --bad: #ff8a80;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  main {
    max-width: 820px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.35rem; }
  .lede { color: var(--muted); margin: 0 0 1.5rem; font-size: 0.95rem; }
  h2 { font-size: 1rem; margin: 0 0 0.6rem; color: var(--muted); }
  .header-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    margin-bottom: 1.75rem;
  }
  .sources-summary { font-size: 0.88rem; color: var(--muted); }
  .header-actions { display: flex; align-items: center; gap: 0.75rem; }
  button {
    font: inherit;
    font-size: 0.9rem;
    padding: 0.55rem 1.1rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .scan-status { color: var(--muted); font-size: 0.85rem; }
  .results-summary {
    font-size: 0.85rem;
    color: var(--muted);
    margin-bottom: 1rem;
  }
  .results-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .offer-row {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.15rem;
  }
  .offer-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .offer-title { font-size: 1rem; font-weight: 600; }
  .offer-title a { color: var(--text); text-decoration: none; }
  .offer-title a:hover { text-decoration: underline; }
  .offer-meta { color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem; }
  .offer-reason { color: var(--muted); font-size: 0.8rem; margin-top: 0.4rem; }
  .offer-badges { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
  .badge {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
    white-space: nowrap;
  }
  .badge-fit-high { color: var(--good); border-color: var(--good); }
  .badge-fit-med { color: var(--warn); border-color: var(--warn); }
  .badge-fit-stretch { color: var(--bad); border-color: var(--bad); }
  .badge-gate-likely-keep { color: var(--good); border-color: var(--good); }
  .badge-gate-review { color: var(--warn); border-color: var(--warn); }
  .badge-gate-likely-cut { color: var(--bad); border-color: var(--bad); }
  .badge-dup { color: var(--muted); }
  .offer-actions { margin-top: 0.65rem; }
  .offer-actions a {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.85rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.4rem 0.8rem;
  }
  .offer-actions a:hover { text-decoration: underline; }
  .empty-state { color: var(--muted); font-size: 0.9rem; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Search</h1>
    <p class="lede">Run the deterministic ATS-board sweep across your tracked companies and search sources — no AI model is called by this page.</p>
  </header>

  <section id="header-strip" class="header-strip">
    <div id="sources-summary" data-hook="sources-summary" class="sources-summary">Loading source config…</div>
    <div class="header-actions">
      <span id="scan-status" data-hook="scan-status" class="scan-status"></span>
      <button id="scan-btn" data-hook="scan-btn" type="button">Run sweep</button>
    </div>
  </section>

  <section id="results-section">
    <h2>Results</h2>
    <div id="results-summary" data-hook="results-summary" class="results-summary" hidden></div>
    <div id="results-list" data-hook="results-list" class="results-list">
      <p class="empty-state">No results yet — run a sweep to fetch the latest postings.</p>
    </div>
  </section>
</main>
<script>
(function () {
  "use strict";

  var sourcesSummary = document.getElementById("sources-summary");
  var scanBtn = document.getElementById("scan-btn");
  var scanStatus = document.getElementById("scan-status");
  var resultsSummary = document.getElementById("results-summary");
  var resultsList = document.getElementById("results-list");

  function fitBadgeClass(fit) {
    if (fit === "high") return "badge badge-fit-high";
    if (fit === "med") return "badge badge-fit-med";
    if (fit === "stretch") return "badge badge-fit-stretch";
    return "badge";
  }

  function gateBadgeClass(gate) {
    if (gate === "likely-keep") return "badge badge-gate-likely-keep";
    if (gate === "likely-cut") return "badge badge-gate-likely-cut";
    return "badge badge-gate-review";
  }

  function metaLine(offer) {
    var parts = [];
    parts.push(offer.company || "Unknown company");
    parts.push(offer.location || "Location n/a");
    if (offer.comp) parts.push(offer.comp);
    return parts.join(" \\u00b7 ");
  }

  function buildRow(offer) {
    var row = document.createElement("div");
    row.className = "offer-row";
    row.setAttribute("data-hook", "offer-row");

    var head = document.createElement("div");
    head.className = "offer-head";

    var titleWrap = document.createElement("div");
    var title = document.createElement("div");
    title.className = "offer-title";
    var titleLink = document.createElement("a");
    titleLink.href = offer.url || "#";
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer";
    titleLink.textContent = offer.title || "Untitled role";
    title.appendChild(titleLink);
    titleWrap.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "offer-meta";
    meta.textContent = metaLine(offer);
    titleWrap.appendChild(meta);

    if (offer.ratingReason) {
      var reason = document.createElement("div");
      reason.className = "offer-reason";
      reason.textContent = offer.ratingReason;
      titleWrap.appendChild(reason);
    }

    head.appendChild(titleWrap);

    var badges = document.createElement("div");
    badges.className = "offer-badges";

    var scoreBadge = document.createElement("span");
    scoreBadge.className = fitBadgeClass(offer.fit);
    var scoreText = (offer.score === undefined || offer.score === null) ? "?" : String(offer.score);
    scoreText += "% " + (offer.fit || "unscored");
    scoreBadge.textContent = scoreText;
    badges.appendChild(scoreBadge);

    var gateBadge = document.createElement("span");
    gateBadge.className = gateBadgeClass(offer.gate);
    gateBadge.textContent = offer.gate || "review";
    badges.appendChild(gateBadge);

    if (offer.possibleDuplicate) {
      var dupBadge = document.createElement("span");
      dupBadge.className = "badge badge-dup";
      dupBadge.textContent = "already tracked?";
      badges.appendChild(dupBadge);
    }

    head.appendChild(badges);
    row.appendChild(head);

    var actions = document.createElement("div");
    actions.className = "offer-actions";
    var evalLink = document.createElement("a");
    evalLink.setAttribute("data-hook", "offer-evaluate");
    evalLink.href = "/evaluate?url=" + encodeURIComponent(offer.url || "");
    evalLink.textContent = "Evaluate";
    actions.appendChild(evalLink);
    row.appendChild(actions);

    return row;
  }

  function renderSummaryLine(summary) {
    resultsSummary.hidden = false;
    var text = "Scanned " + (summary.scanned || 0) +
      " | new " + (summary.new || 0) +
      " | filtered by title " + (summary.filteredTitle || 0) +
      " | filtered by location " + (summary.filteredLocation || 0) +
      " | duplicates " + (summary.duplicates || 0);
    if (summary.date) text = summary.date + " — " + text;
    resultsSummary.textContent = text;
  }

  function renderResults(summary) {
    var offers = (summary && summary.offers) || [];
    resultsList.textContent = "";

    if (summary) renderSummaryLine(summary);

    if (!offers.length) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No results yet — run a sweep to fetch the latest postings.";
      resultsList.appendChild(empty);
      return;
    }

    var sorted = offers.slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    });
    for (var i = 0; i < sorted.length; i++) {
      resultsList.appendChild(buildRow(sorted[i]));
    }
  }

  function loadSources() {
    fetch("/api/search/sources")
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data) {
          sourcesSummary.textContent = "Source config unavailable.";
          return;
        }
        var searches = data.searches || { enabled: 0, total: 0 };
        var text = searches.enabled + "/" + searches.total + " searches enabled";
        text += " \\u00b7 " + (data.trackedCompanies || 0) + " companies tracked";
        sourcesSummary.textContent = text;
      })
      .catch(function () {
        sourcesSummary.textContent = "Source config unavailable.";
      });
  }

  function loadResults() {
    fetch("/api/search/results")
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (data) renderResults(data);
      })
      .catch(function () {
        // best effort — the empty state stays as-is
      });
  }

  scanBtn.addEventListener("click", function () {
    scanBtn.disabled = true;
    scanStatus.textContent = "Running sweep\\u2026";
    fetch("/api/search/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { ok: res.ok, status: res.status, body: body };
          });
      })
      .then(function (result) {
        scanBtn.disabled = false;
        if (!result.ok) {
          scanStatus.textContent = (result.body && result.body.error) ||
            ("Sweep failed (status " + result.status + ").");
          return;
        }
        scanStatus.textContent = "Sweep complete \\u2014 " + result.body.new + " new of " + result.body.scanned + " scanned.";
        renderResults(result.body);
        loadSources();
      })
      .catch(function (err) {
        scanBtn.disabled = false;
        scanStatus.textContent = "Network error: " + (err && err.message ? err.message : String(err));
      });
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  loadSources();
  loadResults();
})();
</script>
</body>
</html>
`;
