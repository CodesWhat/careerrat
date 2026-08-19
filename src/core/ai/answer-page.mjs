// answer-page.mjs — POC apply-packet item 3: the Interactive Q&A slice's UI.
// A single self-contained page: paste an application-form/screening question
// (optionally with company/role context) and draft through local packet APIs.
//
// Cloned from evaluate-page.mjs's exact pattern: a plain template-literal
// export (no server-side interpolation) mounted verbatim by tracker-dev.mjs
// at GET /answer, byte-static and cacheable. Inline <script> is kept
// intentionally small and is syntax-checked (not executed) by
// tests/answer-page.test.mjs, the same `new Function()` guard
// client-script.test.mjs uses for DASHBOARD_SCRIPT.

export const ANSWER_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Answer a question: CareerRat</title>
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
    max-width: 720px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.35rem; }
  .lede { color: var(--muted); margin: 0 0 1.75rem; font-size: 0.95rem; }
  h2 { font-size: 1rem; margin: 0 0 0.6rem; color: var(--muted); }
  label {
    display: block;
    font-size: 0.8rem;
    color: var(--muted);
    margin: 0 0 0.3rem;
  }
  textarea, input[type="text"] {
    width: 100%;
    padding: 0.75rem;
    font: inherit;
    font-size: 0.9rem;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  textarea {
    min-height: 9rem;
    resize: vertical;
  }
  .field { margin-bottom: 0.9rem; }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }
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
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .status { color: var(--muted); font-size: 0.85rem; }
  section { margin-top: 2rem; }
  .feed {
    max-height: 16rem;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .feed-line { white-space: pre-wrap; word-break: break-word; }
  .feed-system { color: var(--muted); }
  .feed-tool { color: var(--accent); }
  .feed-tool-result { color: var(--muted); }
  .feed-assistant { color: var(--text); }
  .feed-error { color: var(--bad); }
  .answer-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
  }
  .answer-text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.92rem;
    line-height: 1.55;
    margin: 0;
  }
  .answer-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 1rem;
    padding-top: 0.85rem;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.82rem;
  }
  .answer-source {
    margin-top: 0.85rem;
    padding-top: 0.85rem;
    border-top: 1px solid var(--border);
  }
  .answer-source p {
    margin: 0 0 0.3rem;
    font-size: 0.85rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: var(--muted);
  }
  .error {
    background: var(--panel);
    border: 1px solid var(--bad);
    color: var(--bad);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    font-size: 0.9rem;
  }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Answer a question</h1>
    <p class="lede">Paste an application-form or screening question and draft a grounded, first-person answer.</p>
  </header>

  <section class="intake">
    <div class="field">
      <label for="question-input">Question(s)</label>
      <textarea id="question-input" data-hook="question-input" placeholder="paste the form/screening question(s)…"></textarea>
    </div>
    <div class="field">
      <label for="context-input">Company, Role (optional)</label>
      <input id="context-input" data-hook="context-input" type="text" placeholder="Company, Role (optional)">
    </div>
    <div class="actions">
      <button id="run-btn" data-hook="run-btn" type="button">Draft answer</button>
      <span id="run-status" data-hook="run-status" class="status"></span>
    </div>
  </section>

  <section id="feed-section" data-hook="feed-section" hidden>
    <h2>Live run</h2>
    <div id="event-feed" data-hook="event-feed" class="feed" aria-live="polite"></div>
  </section>

  <section id="error-box" data-hook="error-box" class="error" hidden></section>

  <section id="answer-card" data-hook="answer-card" class="answer-card" hidden>
    <p id="answer-text" data-hook="answer-text" class="answer-text"></p>
    <div class="answer-meta">
      <span id="meta-duration" data-hook="meta-duration"></span>
      <span id="meta-usage" data-hook="meta-usage"></span>
      <span id="meta-cost" data-hook="meta-cost"></span>
    </div>
    <div class="answer-source">
      <p id="source-line" data-hook="source-line" hidden></p>
      <p id="durable-line" data-hook="durable-line" hidden></p>
      <p id="persisted-line" data-hook="persisted-line" hidden></p>
      <p id="excluded-line" data-hook="excluded-line" hidden></p>
    </div>
  </section>
</main>
<script>
(function () {
  "use strict";

  var questionInput = document.getElementById("question-input");
  var contextInput = document.getElementById("context-input");
  var runBtn = document.getElementById("run-btn");
  var runStatus = document.getElementById("run-status");
  var feedSection = document.getElementById("feed-section");
  var feed = document.getElementById("event-feed");
  var errorBox = document.getElementById("error-box");
  var answerCard = document.getElementById("answer-card");
  var answerTextEl = document.getElementById("answer-text");
  var metaDurationEl = document.getElementById("meta-duration");
  var metaUsageEl = document.getElementById("meta-usage");
  var metaCostEl = document.getElementById("meta-cost");
  var sourceLineEl = document.getElementById("source-line");
  var durableLineEl = document.getElementById("durable-line");
  var persistedLineEl = document.getElementById("persisted-line");
  var excludedLineEl = document.getElementById("excluded-line");

  function addFeedLine(text, kind) {
    feedSection.hidden = false;
    var line = document.createElement("div");
    line.className = "feed-line" + (kind ? " feed-" + kind : "");
    line.textContent = text;
    feed.appendChild(line);
    feed.scrollTop = feed.scrollHeight;
  }

  function showError(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function setLine(el, text) {
    el.textContent = text || "";
    el.hidden = !text;
  }

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

  function captureQuestions(questionText) {
    return fetch("/api/packet/questions", requestOptions({
      source: "paste",
      manualText: questionText
    })).then(function (res) {
      return readJsonResult(res);
    });
  }

  function contextFromInput(value) {
    var text = String(value || "").trim();
    if (!text) return {};
    var parts = text.split(", ");
    if (parts.length < 2) parts = text.split(" — ");
    if (parts.length < 2) parts = text.split(" - ");
    if (parts.length < 2) parts = text.split(" -- ");
    return {
      application: {
        company: (parts[0] || text).trim(),
        role: (parts.slice(1).join(" - ") || "").trim()
      },
      evidence: { claims: [] },
      honesty: {}
    };
  }

  function draftAnswers(capture, context) {
    return fetch("/api/packet/answers", requestOptions({
      context: context,
      questions: capture
    })).then(function (res) {
      return readJsonResult(res);
    });
  }

  function answerBody(answers) {
    if (!answers.length) return "NEEDS YOU: add an answerable application question.";
    if (answers.length === 1) return answers[0].answer || "";
    var lines = [];
    for (var i = 0; i < answers.length; i++) {
      lines.push("Q: " + (answers[i].question || answers[i].questionId));
      lines.push("A: " + (answers[i].answer || ""));
      if (i < answers.length - 1) lines.push("");
    }
    return lines.join("\\n");
  }

  function renderAnswer(result, capture) {
    var answers = Array.isArray(result && result.answers) ? result.answers : [];
    var excludedQuestionIds = Array.isArray(result && result.excludedQuestionIds)
      ? result.excludedQuestionIds
      : [];
    if (!excludedQuestionIds.length && capture && Array.isArray(capture.excluded)) {
      excludedQuestionIds = capture.excluded.map(function (q) { return String(q.id); });
    }
    answerTextEl.textContent = answerBody(answers);

    setLine(sourceLineEl, "SOURCE: local packet answers (" + answers.length + ")");
    setLine(durableLineEl, result && result.manual && result.manual.required
      ? "DURABLE: review required"
      : "DURABLE: upload-ready");
    setLine(persistedLineEl, "PERSISTED: one-off draft only");
    setLine(excludedLineEl, excludedQuestionIds.length
      ? "SKIPPED: " + excludedQuestionIds.length + " self-identification question" +
        (excludedQuestionIds.length === 1 ? "" : "s") + " (" + excludedQuestionIds.join(", ") + ")"
      : "");

    var ai = (result && result.ai) || {};
    metaDurationEl.textContent = "";
    metaUsageEl.textContent = ai.used ? "ai: " + (ai.mode || "used") : "ai: not used";
    metaCostEl.textContent = result && result.uploadReady ? "upload-ready" : "review";

    answerCard.hidden = false;
  }

  function updateRunAvailability(isRunning) {
    runBtn.disabled = !!isRunning;
    runStatus.textContent = isRunning ? "Drafting..." : "";
  }

  runBtn.addEventListener("click", function () {
    var question = questionInput.value.trim();
    if (!question) return;
    var context = contextFromInput(contextInput.value);
    feed.textContent = "";
    feedSection.hidden = false;
    answerCard.hidden = true;
    clearError();
    updateRunAvailability(true);
    addFeedLine("questions: capturing", "system");
    captureQuestions(question).then(function (capture) {
      var answerable = Array.isArray(capture.questions) ? capture.questions.length : 0;
      var skipped = Array.isArray(capture.excluded) ? capture.excluded.length : 0;
      addFeedLine("questions: " + answerable + " answerable, " + skipped + " skipped", "tool-result");
      if (!answerable) {
        return {
          answers: [],
          excludedQuestionIds: capture.excluded.map(function (q) { return String(q.id); }),
          uploadReady: false,
          manual: { required: true },
          ai: { used: false },
          capture: capture
        };
      }
      addFeedLine("answers: drafting", "system");
      return draftAnswers(capture, context).then(function (result) {
        result.capture = capture;
        return result;
      });
    }).catch(function (err) {
      showError("Could not draft answer: " + (err && err.message ? err.message : String(err)));
      throw err;
    }).then(function (result) {
      renderAnswer(result, result.capture);
      updateRunAvailability(false);
    }, function () {
      updateRunAvailability(false);
    });
  });
})();
</script>
</body>
</html>
`;
