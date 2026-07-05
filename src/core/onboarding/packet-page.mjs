// packet-page.mjs — M4 of the paid-POC journey: the /packet view's UI. A
// single self-contained page: pick a gated application from the list built by
// GET /api/packet/list, review its tailored resume / cover letter / answers
// (each rendered from markdown → HTML server-side via
// src/core/documents/export.mjs's markdownToHtml, see src/cli/packet-route.mjs),
// and — when any artifact is still missing — run tailor-application live via
// POST /api/skill/run to generate it.
//
// Cloned structurally from evaluate-page.mjs's exact pattern: a plain
// template-literal export (no server-side interpolation) mounted verbatim by
// tracker-dev.mjs at GET /packet, byte-static and cacheable. The "Generate
// packet" button reuses the SAME SSE client pattern evaluate-page.mjs uses for
// POST /api/skill/run (EventSource can't POST, so the client hand-parses the
// `event: <type>\ndata: <json>\n\n` framing off a fetch() ReadableStream —
// mirrors skill-run-route.mjs's own emit() framing exactly) and is gated on
// GET /api/runtime/config the same way evaluate-page.mjs's decision buttons
// are. Inline <script> avoids template literals, backticks, and
// regex/backslash escapes entirely (string concatenation with + instead, and
// single-quoted HTML attribute values in the one place raw HTML is injected —
// see highlightNeedsYou() below), same as search-page.mjs/onboard-page.mjs, so
// it can live inside this file's own outer template literal without any
// double-escaping bookkeeping. It is syntax-checked (not executed) by
// tests/packet-page.test.mjs, the same `new Function()` guard
// client-script.test.mjs uses for DASHBOARD_SCRIPT.
//
// NEEDS YOU highlighting happens client-side (see highlightNeedsYou()): the
// server already returns escaped HTML (markdownToHtml escapes <, >, &, " in
// text content before any inline parsing), so a plain string-replace of the
// literal "NEEDS YOU:" marker text can only ever match text between tags —
// it cannot corrupt markup.

export const PACKET_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Packet — Rolester</title>
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
    max-width: 920px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.35rem; }
  .lede { color: var(--muted); margin: 0 0 1.75rem; font-size: 0.95rem; }
  h2 { font-size: 1.1rem; margin: 0 0 0.6rem; }
  h3 { font-size: 0.95rem; margin: 0 0 0.5rem; color: var(--muted); }
  section { margin-top: 2rem; }
  .empty-state { color: var(--muted); font-size: 0.9rem; }
  .status { color: var(--muted); font-size: 0.85rem; margin-right: 0.6rem; }
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
  .picker-list { display: flex; flex-direction: column; gap: 0.6rem; }
  .packet-row {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.75rem 1rem;
    cursor: pointer;
  }
  .packet-row:hover { border-color: var(--accent); }
  .packet-row.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .packet-row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .packet-row-title { font-weight: 600; font-size: 0.95rem; }
  .packet-row-dots { display: flex; gap: 0.35rem; }
  .dot {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.12rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .dot-yes { color: var(--good); border-color: var(--good); }
  .dot-no { color: var(--muted); }
  .badge-needs-you {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--warn);
    color: var(--warn);
  }
  .packet-row-status { color: var(--muted); font-size: 0.82rem; margin-top: 0.3rem; }
  .detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .feed {
    max-height: 14rem;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.8rem;
    line-height: 1.5;
    margin-top: 0.75rem;
  }
  .feed-line { white-space: pre-wrap; word-break: break-word; }
  .feed-system { color: var(--muted); }
  .feed-tool { color: var(--accent); }
  .feed-tool-result { color: var(--muted); }
  .feed-assistant { color: var(--text); }
  .feed-error { color: var(--bad); }
  .error {
    background: var(--panel);
    border: 1px solid var(--bad);
    color: var(--bad);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    font-size: 0.9rem;
    margin-top: 0.75rem;
  }
  .tabs {
    display: flex;
    gap: 0.5rem;
    margin-top: 1.25rem;
    border-bottom: 1px solid var(--border);
  }
  .tab-btn {
    background: transparent;
    color: var(--muted);
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 0.5rem 0.2rem;
  }
  .tab-btn-active { color: var(--text); border-bottom-color: var(--accent); }
  .pane-wrap { margin-top: 1rem; }
  .pane {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.1rem 1.25rem;
    max-height: 32rem;
    overflow-y: auto;
  }
  .artifact-path {
    color: var(--muted);
    font-size: 0.78rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    margin-bottom: 0.75rem;
    word-break: break-all;
  }
  .artifact-body { font-size: 0.92rem; line-height: 1.55; }
  .artifact-body :first-child { margin-top: 0; }
  .artifact-link {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.9rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.45rem 0.8rem;
    display: inline-block;
  }
  .artifact-link:hover { text-decoration: underline; }
  mark.needs-you {
    background: var(--warn);
    color: #1c1f24;
    padding: 0 0.15em;
    border-radius: 3px;
  }
  .needs-you-link {
    display: inline-block;
    margin-top: 0.85rem;
    color: var(--accent);
    text-decoration: none;
    font-size: 0.85rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.4rem 0.8rem;
  }
  .needs-you-link:hover { text-decoration: underline; }
  .links { display: flex; gap: 0.75rem; margin-top: 2.5rem; }
  .links a {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.88rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 1rem;
  }
  .links a:hover { text-decoration: underline; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Packet</h1>
    <p class="lede">Review a tailored resume, cover letter, and short answers for a gated application — or generate them live.</p>
  </header>

  <section id="picker-section">
    <h2>Applications</h2>
    <div id="packet-picker" data-hook="packet-picker" class="picker-list">
      <p class="empty-state">Loading…</p>
    </div>
  </section>

  <section id="detail-section" data-hook="detail-section" hidden>
    <div class="detail-head">
      <h2 id="detail-title" data-hook="detail-title"></h2>
      <div>
        <span id="run-status" data-hook="run-status" class="status"></span>
        <button id="generate-btn" data-hook="generate-btn" type="button" hidden>Generate packet</button>
      </div>
    </div>

    <section id="feed-section" data-hook="feed-section" hidden>
      <h3>Live run</h3>
      <div id="generate-feed" data-hook="generate-feed" class="feed" aria-live="polite"></div>
    </section>

    <div id="error-box" data-hook="error-box" class="error" hidden></div>

    <div id="packet-tabs" data-hook="packet-tabs" class="tabs">
      <button id="tab-btn-resume" data-hook="tab-btn-resume" class="tab-btn tab-btn-active" data-tab="resume" type="button">Resume</button>
      <button id="tab-btn-coverLetter" data-hook="tab-btn-coverLetter" class="tab-btn" data-tab="coverLetter" type="button">Cover letter</button>
      <button id="tab-btn-answers" data-hook="tab-btn-answers" class="tab-btn" data-tab="answers" type="button">Answers</button>
    </div>

    <div class="pane-wrap">
      <div id="pane-resume" data-hook="pane-resume" class="pane"></div>
      <div id="pane-coverLetter" data-hook="pane-coverLetter" class="pane" hidden></div>
      <div id="pane-answers" data-hook="pane-answers" class="pane" hidden></div>
    </div>
  </section>

  <section class="links">
    <a id="link-answer" data-hook="link-answer" href="/answer">Answer a question</a>
    <a id="link-tracker" data-hook="link-tracker" href="/tracker">Tracker</a>
  </section>
</main>
<script>
(function () {
  "use strict";

  var pickerEl = document.getElementById("packet-picker");
  var detailSection = document.getElementById("detail-section");
  var detailTitle = document.getElementById("detail-title");
  var generateBtn = document.getElementById("generate-btn");
  var runStatus = document.getElementById("run-status");
  var feedSection = document.getElementById("feed-section");
  var feed = document.getElementById("generate-feed");
  var errorBox = document.getElementById("error-box");
  var panes = {
    resume: document.getElementById("pane-resume"),
    coverLetter: document.getElementById("pane-coverLetter"),
    answers: document.getElementById("pane-answers")
  };
  var tabButtons = {
    resume: document.getElementById("tab-btn-resume"),
    coverLetter: document.getElementById("tab-btn-coverLetter"),
    answers: document.getElementById("tab-btn-answers")
  };

  var allowedSkills = [];
  var selectedId = null;
  var selectedRowEl = null;
  var currentPacket = null;
  var activeTab = "resume";

  function showError(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function addFeedLine(text, kind) {
    feedSection.hidden = false;
    var line = document.createElement("div");
    line.className = "feed-line" + (kind ? " feed-" + kind : "");
    line.textContent = text;
    feed.appendChild(line);
    feed.scrollTop = feed.scrollHeight;
  }

  function truncate(text, max) {
    var t = String(text || "").replace(/\\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  // -------------------------------------------------------------------
  // Picker — GET /api/packet/list
  // -------------------------------------------------------------------

  function presenceDot(hasIt, label) {
    var span = document.createElement("span");
    span.className = "dot " + (hasIt ? "dot-yes" : "dot-no");
    span.textContent = label;
    span.title = label + (hasIt ? " ready" : " not generated");
    return span;
  }

  function buildRow(row) {
    var el = document.createElement("div");
    el.className = "packet-row";
    el.setAttribute("data-hook", "packet-row");
    el.setAttribute("data-id", String(row.id));

    var head = document.createElement("div");
    head.className = "packet-row-head";

    var title = document.createElement("span");
    title.className = "packet-row-title";
    title.textContent = (row.company || "Unknown company") + " — " + (row.role || "Unknown role");
    head.appendChild(title);

    var dots = document.createElement("span");
    dots.className = "packet-row-dots";
    dots.appendChild(presenceDot(row.hasResume, "R"));
    dots.appendChild(presenceDot(row.hasCoverLetter, "CL"));
    dots.appendChild(presenceDot(row.hasAnswers, "A"));
    head.appendChild(dots);

    if (row.needsYouCount > 0) {
      var badge = document.createElement("span");
      badge.className = "badge-needs-you";
      badge.textContent = row.needsYouCount + " NEEDS YOU";
      head.appendChild(badge);
    }

    el.appendChild(head);

    var statusLine = document.createElement("div");
    statusLine.className = "packet-row-status";
    statusLine.textContent = row.status || "";
    el.appendChild(statusLine);

    el.addEventListener("click", function () {
      selectApp(row.id, el);
    });

    return el;
  }

  function renderList(rows) {
    pickerEl.textContent = "";
    if (!rows || !rows.length) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No gated applications yet — run evaluate-job first.";
      pickerEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      pickerEl.appendChild(buildRow(rows[i]));
    }
  }

  function loadList() {
    fetch("/api/packet/list")
      .then(function (res) {
        return res.ok ? res.json() : [];
      })
      .then(function (rows) {
        renderList(rows || []);
      })
      .catch(function () {
        renderList([]);
      });
  }

  // -------------------------------------------------------------------
  // Detail view — tabs + panes, GET /api/packet?id=
  // -------------------------------------------------------------------

  function setActiveTab(tab) {
    activeTab = tab;
    var keys = ["resume", "coverLetter", "answers"];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      panes[key].hidden = key !== tab;
      tabButtons[key].className = key === tab ? "tab-btn tab-btn-active" : "tab-btn";
    }
  }

  tabButtons.resume.addEventListener("click", function () { setActiveTab("resume"); });
  tabButtons.coverLetter.addEventListener("click", function () { setActiveTab("coverLetter"); });
  tabButtons.answers.addEventListener("click", function () { setActiveTab("answers"); });

  // Client-side highlight of the literal NEEDS YOU marker inside already-
  // escaped HTML text (see this file's header comment) — a plain text
  // replace can only ever match text between tags, never markup.
  function highlightNeedsYou(html) {
    return html.replace(/NEEDS YOU:[^<]*/g, function (match) {
      return "<mark class='needs-you'>" + match + "</mark>";
    });
  }

  function renderPane(kind, artifact) {
    var pane = panes[kind];
    pane.textContent = "";
    if (!artifact) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Not generated yet.";
      pane.appendChild(empty);
      return;
    }

    var pathLine = document.createElement("div");
    pathLine.className = "artifact-path";
    pathLine.setAttribute("data-hook", "artifact-path");
    pathLine.textContent = artifact.path || "(inline text — no file path)";
    pane.appendChild(pathLine);

    if (artifact.binary) {
      var linkWrap = document.createElement("div");
      linkWrap.className = "artifact-body";
      var openLink = document.createElement("a");
      openLink.className = "artifact-link";
      openLink.setAttribute("data-hook", "artifact-open-link");
      openLink.href = artifact.url || "#";
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openLink.textContent = "Open " + String(artifact.kind || "file").toUpperCase() + " artifact";
      linkWrap.appendChild(openLink);
      pane.appendChild(linkWrap);
      return;
    }

    var body = document.createElement("div");
    body.className = "artifact-body";
    var html = artifact.html || "";
    if (kind === "answers") html = highlightNeedsYou(html);
    body.innerHTML = html;
    pane.appendChild(body);

    if (kind === "answers" && artifact.needsYou && artifact.needsYou.length) {
      var link = document.createElement("a");
      link.setAttribute("data-hook", "needs-you-link");
      link.className = "needs-you-link";
      link.href = "/answer";
      link.textContent = "Resolve " + artifact.needsYou.length +
        (artifact.needsYou.length === 1 ? " NEEDS YOU item" : " NEEDS YOU items") + " in /answer";
      pane.appendChild(link);
    }
  }

  function needsGenerate(data) {
    var a = (data && data.artifacts) || {};
    return !a.resume || !a.coverLetter || !a.answers;
  }

  function tailorAllowed() {
    return allowedSkills.indexOf("tailor-application") !== -1;
  }

  function updateGenerateAvailability() {
    var allowed = tailorAllowed();
    generateBtn.disabled = !allowed;
    generateBtn.title = allowed ? "" : "enable tailor-application in ROLESTER_RUNTIME_SKILLS";
  }

  function renderDetail(data) {
    currentPacket = data;
    detailSection.hidden = false;
    detailTitle.textContent = (data.company || "Unknown company") + " — " + (data.role || "Unknown role");
    var artifacts = data.artifacts || {};
    renderPane("resume", artifacts.resume);
    renderPane("coverLetter", artifacts.coverLetter);
    renderPane("answers", artifacts.answers);
    setActiveTab(activeTab);
    generateBtn.hidden = !needsGenerate(data);
    updateGenerateAvailability();
  }

  function loadDetail(id) {
    fetch("/api/packet?id=" + encodeURIComponent(id))
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed with status " + res.status);
        return res.json();
      })
      .then(function (data) {
        clearError();
        renderDetail(data);
      })
      .catch(function (err) {
        showError("Could not load packet: " + (err && err.message ? err.message : String(err)));
      });
  }

  function selectApp(id, rowEl) {
    selectedId = id;
    if (selectedRowEl) selectedRowEl.className = "packet-row";
    selectedRowEl = rowEl || null;
    if (selectedRowEl) selectedRowEl.className = "packet-row selected";
    feed.textContent = "";
    feedSection.hidden = true;
    clearError();
    loadDetail(id);
  }

  // -------------------------------------------------------------------
  // Generate packet — same SSE client pattern as evaluate-page.mjs
  // -------------------------------------------------------------------

  // Mirrors skill-run-route.mjs's emit(): "event: <type>\\ndata: <json>\\n\\n",
  // plus bare ": heartbeat" comment lines every 15s — skipped here.
  function parseSseBlock(raw) {
    var lines = raw.split("\\n");
    var type = null;
    var dataLines = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.charAt(0) === ":") continue;
      if (line.indexOf("event:") === 0) type = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).trim());
    }
    if (!type) return null;
    var payload = dataLines.join("\\n");
    var data;
    try {
      data = JSON.parse(payload);
    } catch (e) {
      data = payload;
    }
    return { type: type, data: data };
  }

  function extractAssistantText(msg) {
    var content = msg && msg.message && msg.message.content;
    if (!Array.isArray(content)) return "";
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      if (content[i] && content[i].type === "text" && content[i].text) {
        parts.push(content[i].text);
      }
    }
    return parts.join("\\n");
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case "system":
        addFeedLine("system: " + (evt.data && evt.data.subtype ? evt.data.subtype : "event"), "system");
        break;
      case "assistant": {
        var text = extractAssistantText(evt.data);
        if (text) addFeedLine("assistant: " + truncate(text, 140), "assistant");
        break;
      }
      case "tool_use":
        addFeedLine("tool: " + (evt.data && evt.data.name ? evt.data.name : "unknown"), "tool");
        break;
      case "tool_result":
        addFeedLine(
          "result: " + (evt.data && evt.data.isError ? "error" : "ok"),
          evt.data && evt.data.isError ? "error" : "tool-result"
        );
        break;
      case "error": {
        var message = (evt.data && evt.data.message) || "The run reported an error.";
        addFeedLine("error: " + message, "error");
        showError(message);
        break;
      }
      case "result":
        // Refetch — the run either produced new artifacts or failed; either
        // way the server's tracker state is the source of truth now.
        if (selectedId) loadDetail(selectedId);
        loadList();
        break;
      default:
        break;
    }
  }

  function runSkill(skill, skillInput, onDone) {
    return fetch("/api/skill/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: skill, input: skillInput })
    }).then(function (res) {
      if (!res.ok) {
        return res
          .json()
          .catch(function () {
            return { error: "Request failed with status " + res.status };
          })
          .then(function (body) {
            var message = (body && body.error) || "Request failed with status " + res.status;
            if (res.status === 501) {
              message += " — install the @anthropic-ai/claude-agent-sdk devDependency to enable this.";
            }
            showError(message);
            if (onDone) onDone();
          });
      }
      clearError();
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";

      function pump() {
        return reader.read().then(function (step) {
          if (step.done) {
            if (onDone) onDone();
            return undefined;
          }
          buffer += decoder.decode(step.value, { stream: true });
          var idx;
          while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
            var raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            var evt = parseSseBlock(raw);
            if (evt) handleEvent(evt);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      showError("Network error: " + (err && err.message ? err.message : String(err)));
      if (onDone) onDone();
    });
  }

  generateBtn.addEventListener("click", function () {
    if (!currentPacket || generateBtn.disabled) return;
    var input = (currentPacket.company || "") + " — " + (currentPacket.role || "");
    feed.textContent = "";
    feedSection.hidden = false;
    clearError();
    generateBtn.disabled = true;
    runStatus.textContent = "Running…";
    runSkill("tailor-application", input, function () {
      runStatus.textContent = "";
      updateGenerateAvailability();
    });
  });

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------

  function applyAllowlist(skills) {
    allowedSkills = skills || [];
    updateGenerateAvailability();
  }

  fetch("/api/runtime/config")
    .then(function (res) {
      return res.ok ? res.json() : { skills: [] };
    })
    .then(function (config) {
      applyAllowlist(config && config.skills);
    })
    .catch(function () {
      applyAllowlist([]);
    });

  loadList();
})();
</script>
</body>
</html>
`;
