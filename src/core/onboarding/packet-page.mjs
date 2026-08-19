// packet-page.mjs — M4 of the paid-POC journey: the /packet view's UI. A
// single self-contained page: pick a gated application from the list built by
// GET /api/packet/list, review its tailored resume / cover letter / answers
// (each rendered from markdown → HTML server-side via
// src/core/documents/export.mjs's markdownToHtml, see src/cli/packet-route.mjs),
// and - when any artifact is still missing - generate it through local packet
// APIs.
//
// Cloned structurally from evaluate-page.mjs's exact pattern: a plain
// template-literal export (no server-side interpolation) mounted verbatim by
// tracker-dev.mjs at GET /packet, byte-static and cacheable. The "Generate
// packet" button calls local JSON packet routes for question capture and packet
// generation. Inline <script> avoids template literals, backticks, and
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
<title>Packet: CareerRat</title>
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
    --pill-radius: 8px;
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
    border-radius: var(--pill-radius);
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .dot-yes { color: var(--good); border-color: var(--good); }
  .dot-no { color: var(--muted); }
  .badge-needs-you {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: var(--pill-radius);
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
  .question-panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.9rem 1rem;
    margin-top: 1rem;
  }
  .question-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.75rem;
  }
  .question-field { display: flex; flex-direction: column; gap: 0.35rem; }
  .question-field label { font-size: 0.82rem; color: var(--muted); }
  .question-field input,
  .question-field textarea {
    width: 100%;
    min-width: 0;
    font: inherit;
    font-size: 0.9rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.55rem 0.65rem;
  }
  .question-field textarea {
    min-height: 5.5rem;
    resize: vertical;
  }
  .question-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }
  .question-summary {
    color: var(--muted);
    font-size: 0.85rem;
    margin-top: 0.5rem;
  }
  @media (max-width: 720px) {
    .question-grid { grid-template-columns: 1fr; }
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
    <p class="lede">Review a tailored resume, cover letter, and short answers for a gated application, or generate them live.</p>
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

    <section class="question-panel" data-hook="question-panel">
      <div class="question-grid">
        <div class="question-field">
          <label for="question-url">Application form URL</label>
          <input id="question-url" data-hook="question-url" type="url" placeholder="https://...">
        </div>
        <div class="question-field">
          <label for="question-text">Application questions</label>
          <textarea id="question-text" data-hook="question-text" placeholder="Paste non-upload form questions here"></textarea>
        </div>
      </div>
      <div class="question-actions">
        <button id="capture-questions-btn" data-hook="capture-questions-btn" type="button">Capture questions</button>
        <span id="question-status" data-hook="question-status" class="status"></span>
      </div>
      <div id="question-summary" data-hook="question-summary" class="question-summary" aria-live="polite"></div>
    </section>

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
  var questionUrlInput = document.getElementById("question-url");
  var questionTextInput = document.getElementById("question-text");
  var captureQuestionsBtn = document.getElementById("capture-questions-btn");
  var questionStatus = document.getElementById("question-status");
  var questionSummary = document.getElementById("question-summary");
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

  var selectedId = null;
  var selectedRowEl = null;
  var currentPacket = null;
  var activeTab = "resume";
  var questionCaptureState = null;

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

  function setRunning(isRunning, label) {
    generateBtn.disabled = !!isRunning;
    captureQuestionsBtn.disabled = !!isRunning || !selectedId;
    runStatus.textContent = isRunning ? label || "Working..." : "";
  }

  function truncate(text, max) {
    var t = String(text || "").replace(/\\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  function renderQuestionCaptureSummary(capture) {
    var data = capture || questionCaptureState;
    if (!data) {
      questionSummary.textContent = "";
      questionStatus.textContent = "";
      return;
    }
    var artifacts = data.artifacts || {};
    var answerable = Array.isArray(data.questions) ? data.questions.length : artifacts.packetQuestionCount || 0;
    var skipped = Array.isArray(data.excluded) ? data.excluded.length : artifacts.packetQuestionExcludedCount || 0;
    var excludedQuestionIds = Array.isArray(data.excluded)
      ? data.excluded.map(function (q) { return String(q.id); })
      : [];
    questionStatus.textContent = answerable + " answerable, " + skipped + " skipped";
    questionSummary.textContent = "Captured " + answerable + " answerable question" +
      (answerable === 1 ? "" : "s") + "; skipped " + skipped + " self-identification question" +
      (skipped === 1 ? "" : "s") +
      (excludedQuestionIds.length ? " (" + excludedQuestionIds.join(", ") + ")" : "") + ".";
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
    title.textContent = (row.company || "Unknown company") + ", " + (row.role || "Unknown role");
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
      empty.textContent = "No gated applications yet.";
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
    pathLine.textContent = artifact.path || "(inline text, no file path)";
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

  function renderDetail(data) {
    currentPacket = data;
    detailSection.hidden = false;
    detailTitle.textContent = (data.company || "Unknown company") + ", " + (data.role || "Unknown role");
    var artifacts = data.artifacts || {};
    renderPane("resume", artifacts.resume);
    renderPane("coverLetter", artifacts.coverLetter);
    renderPane("answers", artifacts.answers);
    setActiveTab(activeTab);
    generateBtn.hidden = !needsGenerate(data);
    generateBtn.disabled = false;
    captureQuestionsBtn.disabled = !selectedId;
    generateBtn.title = "";
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
  // Local packet APIs
  // -------------------------------------------------------------------

  function messageFromBody(body, fallback) {
    return (body && body.error && body.error.message) ||
      (body && body.error) ||
      (body && body.message) ||
      fallback;
  }

  function requestOptions(payload) {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    };
  }

  function readJsonResult(res) {
    return res.json()
      .catch(function () {
        return {};
      })
      .then(function (body) {
        if (!res.ok || body.ok === false) {
          throw new Error(messageFromBody(body, "Request failed with status " + res.status));
        }
        return body.data || body;
      });
  }

  function postPacketQuestions(payload) {
    return fetch("/api/packet/questions", requestOptions(payload)).then(function (res) {
      return readJsonResult(res);
    });
  }

  function postPacketGenerate(payload) {
    return fetch("/api/packet/generate", requestOptions(payload)).then(function (res) {
      return readJsonResult(res);
    });
  }

  function hasQuestionInput() {
    return Boolean(questionUrlInput.value.trim() || questionTextInput.value.trim());
  }

  function captureQuestions() {
    if (!selectedId) return Promise.resolve(null);
    var url = questionUrlInput.value.trim();
    var manualText = questionTextInput.value.trim();
    if (!url && !manualText) {
      questionStatus.textContent = "No questions supplied";
      return Promise.resolve(null);
    }
    setRunning(true, "Capturing...");
    return postPacketQuestions({
      appId: selectedId,
      source: url ? "url" : "paste",
      url: url,
      manualText: manualText
    }).then(function (data) {
      questionCaptureState = data;
      renderQuestionCaptureSummary(data);
      addFeedLine("questions: captured " + data.questions.length + " answerable, " +
        data.excluded.length + " skipped", "tool-result");
      return data;
    }).catch(function (err) {
      showError("Could not capture questions: " + (err && err.message ? err.message : String(err)));
      throw err;
    }).then(function (data) {
      setRunning(false);
      return data;
    }, function (err) {
      setRunning(false);
      throw err;
    });
  }

  function generatePacketFromPage() {
    if (!currentPacket || generateBtn.disabled) return Promise.resolve(null);
    setRunning(true, "Generating...");
    return postPacketGenerate({
      appId: selectedId,
      applyIntent: true,
      formats: ["pdf"],
      questionCapture: questionCaptureState
    }).then(function (data) {
      var manifest = data.manifest || {};
      var gapCount = Array.isArray(data.gaps) ? data.gaps.length : manifest.gapCount || 0;
      var excludedQuestionIds = manifest.answerLineage && Array.isArray(manifest.answerLineage.excludedQuestionIds)
        ? manifest.answerLineage.excludedQuestionIds
        : [];
      addFeedLine("packet: " + (data.status || "generated") + ", " + gapCount + " gap" +
        (gapCount === 1 ? "" : "s") + ", " + excludedQuestionIds.length + " skipped", "tool-result");
      if (selectedId) loadDetail(selectedId);
      loadList();
      return data;
    }).catch(function (err) {
      showError("Could not generate packet: " + (err && err.message ? err.message : String(err)));
      throw err;
    }).then(function (data) {
      setRunning(false);
      return data;
    }, function (err) {
      setRunning(false);
      throw err;
    });
  }

  captureQuestionsBtn.addEventListener("click", function () {
    feed.textContent = "";
    feedSection.hidden = false;
    clearError();
    captureQuestions().catch(function () {});
  });

  generateBtn.addEventListener("click", function () {
    if (!currentPacket || generateBtn.disabled) return;
    feed.textContent = "";
    feedSection.hidden = false;
    clearError();
    var first = hasQuestionInput() ? captureQuestions() : Promise.resolve(questionCaptureState);
    first.then(function () {
      return generatePacketFromPage();
    }).catch(function () {});
  });

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------

  loadList();
})();
</script>
</body>
</html>
`;
