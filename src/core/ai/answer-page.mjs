// answer-page.mjs — POC apply-packet item 3: the Interactive Q&A slice's UI.
// A single self-contained page: paste an application-form/screening question
// (optionally with company/role context) → POST /api/skill/run drives
// answer-question through the embedded runtime (P0-4) → the SSE stream
// renders live as a compact event feed, then an answer card (drafted text,
// SOURCE/DURABLE/PERSISTED markers, duration, usage, cost) once the `result`
// event lands.
//
// Cloned from evaluate-page.mjs's exact pattern: a plain template-literal
// export (no server-side interpolation) mounted verbatim by tracker-dev.mjs
// at GET /answer, byte-static and cacheable. EventSource can't POST, so the
// client hand-parses the `event: <type>\ndata: <json>\n\n` framing straight
// off a fetch() ReadableStream — mirrors skill-run-route.mjs's own emit()
// framing exactly (see MAX_BODY_BYTES/emit() there). Inline <script> is kept
// intentionally small and is syntax-checked (not executed) by
// tests/answer-page.test.mjs, the same `new Function()` guard
// client-script.test.mjs uses for DASHBOARD_SCRIPT.
//
// answer-question's SKILL.md "Output contract" fixes the assistant's final
// text to end with exactly three trailing marker lines (SOURCE:/DURABLE:/
// PERSISTED:) — this page's client pulls those off the tail of the
// accumulated assistant text, strips them from the rendered answer body, and
// shows them in a dedicated footer instead. See extractMarkers()/
// stripMarkers() below.

export const ANSWER_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Answer a question — Rolester</title>
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
    <p class="lede">Paste an application-form or screening question — answer-question runs live and drafts a grounded, first-person answer.</p>
  </header>

  <section class="intake">
    <div class="field">
      <label for="question-input">Question(s)</label>
      <textarea id="question-input" data-hook="question-input" placeholder="paste the form/screening question(s)…"></textarea>
    </div>
    <div class="field">
      <label for="context-input">Company — Role (optional)</label>
      <input id="context-input" data-hook="context-input" type="text" placeholder="Company — Role (optional)">
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

  var allowedSkills = [];
  var accumulatedText = "";

  function truncate(text, max) {
    var t = String(text || "").replace(/\\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

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

  // Pulls the LAST occurrence of each trailing marker line out of the
  // accumulated assistant text — answer-question's SKILL.md "Output contract"
  // fixes SOURCE:/DURABLE:/PERSISTED: as the final lines of the reply, see
  // .agents/skills/answer-question. Same last-occurrence technique
  // evaluate-page.mjs's extractGateLines() uses, so a retried/streamed
  // duplicate never confuses the extraction.
  function extractMarkers(text) {
    var patterns = {
      source: /^SOURCE:.*$/gm,
      durable: /^DURABLE:.*$/gm,
      persisted: /^PERSISTED:.*$/gm
    };
    var out = {};
    var keys = Object.keys(patterns);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var re = patterns[key];
      var m;
      var last = null;
      while ((m = re.exec(text))) last = m[0];
      if (last) out[key] = last.trim();
    }
    return out;
  }

  // Strips every SOURCE:/DURABLE:/PERSISTED: line out of the body (they only
  // ever appear once, at the tail, per the Output contract) and collapses the
  // blank lines left behind so the rendered answer doesn't end in a gap.
  function stripMarkers(text) {
    var body = String(text || "");
    body = body.replace(/^SOURCE:.*$/gm, "");
    body = body.replace(/^DURABLE:.*$/gm, "");
    body = body.replace(/^PERSISTED:.*$/gm, "");
    return body.replace(/\\n{3,}/g, "\\n\\n").trim();
  }

  function formatUsd(costUsd) {
    if (costUsd === null || costUsd === undefined) return "cost n/a";
    return "$" + Number(costUsd).toFixed(4);
  }

  function formatDuration(ms) {
    if (typeof ms !== "number") return "";
    return (ms / 1000).toFixed(1) + "s";
  }

  function setLine(el, text) {
    el.textContent = text || "";
    el.hidden = !text;
  }

  function renderAnswer(result) {
    var markers = extractMarkers(accumulatedText);
    answerTextEl.textContent = stripMarkers(accumulatedText);

    setLine(sourceLineEl, markers.source);
    setLine(durableLineEl, markers.durable);
    setLine(persistedLineEl, markers.persisted);

    metaDurationEl.textContent = result && typeof result.durationMs === "number"
      ? "duration: " + formatDuration(result.durationMs)
      : "";
    var usage = (result && result.usage) || {};
    metaUsageEl.textContent = "tokens: " + (usage.tokensIn || 0) + " in / " + (usage.tokensOut || 0) + " out";
    metaCostEl.textContent = formatUsd(result && result.costUsd);

    answerCard.hidden = false;
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case "system":
        addFeedLine("system: " + (evt.data && evt.data.subtype ? evt.data.subtype : "event"), "system");
        break;
      case "assistant": {
        var text = extractAssistantText(evt.data);
        if (text) {
          accumulatedText += (accumulatedText ? "\\n" : "") + text;
          addFeedLine("assistant: " + truncate(text, 140), "assistant");
        }
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
        renderAnswer(evt.data);
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

  function answerQuestionAllowed() {
    return allowedSkills.indexOf("answer-question") !== -1;
  }

  function updateRunAvailability(isRunning) {
    var allowed = answerQuestionAllowed();
    runBtn.disabled = isRunning || !allowed;
    runBtn.title = allowed ? "" : "enable answer-question in ROLESTER_RUNTIME_SKILLS";
    runStatus.textContent = isRunning
      ? "Running…"
      : allowed
        ? ""
        : "answer-question is not enabled in ROLESTER_RUNTIME_SKILLS";
  }

  function composeInput(context, question) {
    var parts = [];
    if (context) parts.push("Company/Role context: " + context);
    parts.push("Question(s):\\n" + question);
    return parts.join("\\n\\n");
  }

  runBtn.addEventListener("click", function () {
    var question = questionInput.value.trim();
    if (!question) return;
    var context = contextInput.value.trim();
    accumulatedText = "";
    feed.textContent = "";
    feedSection.hidden = false;
    answerCard.hidden = true;
    clearError();
    updateRunAvailability(true);
    runSkill("answer-question", composeInput(context, question), function () {
      updateRunAvailability(false);
    });
  });

  function applyAllowlist(skills) {
    allowedSkills = skills || [];
    updateRunAvailability(false);
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
})();
</script>
</body>
</html>
`;
