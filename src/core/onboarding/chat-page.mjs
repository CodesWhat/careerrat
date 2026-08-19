// chat-page.mjs — M2 of the paid-POC journey: the browser front end for the
// conversational skill runtime (src/core/ai/chat-runtime.mjs +
// src/cli/chat-route.mjs), mounted verbatim at GET /chat by tracker-dev.mjs.
// Runs ingest-profile's interview turn-by-turn from a page instead of a
// terminal session.
//
// Cloned structurally from evaluate-page.mjs/onboard-page.mjs's exact
// pattern: a plain template-literal export (no server-side interpolation),
// byte-static and cacheable. Inline <script> avoids backticks/template
// literals entirely (string concatenation with + instead) for the same
// reason onboard-page.mjs's does — this file's own content IS a template
// literal, so a literal backtick in the script would terminate it early. It
// is syntax-checked (not executed) by tests/chat-page.test.mjs, the same
// `new Function()` guard client-script.test.mjs uses for DASHBOARD_SCRIPT.
//
// Unlike evaluate-page.mjs/answer-page.mjs (which POST to a one-shot SSE
// route and hand-parse the `event:`/`data:` framing off a fetch() stream,
// because EventSource can't POST), GET /api/chat/events is a plain GET —
// so this page uses the browser's native EventSource. That also gets
// Last-Event-ID reconnection semantics for free on a transient drop, which
// matches chat-route.mjs's own replay contract.
//
// GOTCHA (documented, not guessed at): the server emits an SSE frame typed
// `event: error` for in-band model/tool errors (mapSdkMessage's own "error"
// event type). EventSource dispatches ANY same-named custom event straight
// into `addEventListener("error", ...)` — the exact same event name it uses
// for a real connection failure. The handler below tells the two apart by
// checking `evt.data`: a genuine connection error is a plain Event with no
// `.data`; our custom SSE frame is a MessageEvent that always has one.
//
// Completion is read from the persisted GET /api/onboard/state route (files
// validity + searchSourcesPresent) — never from parsing the assistant's own
// prose — because that state is what's actually true regardless of how the
// model phrased its last message.

export const CHAT_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Interview: CareerRat</title>
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
  h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
  .lede { color: var(--muted); margin: 0 0 1.75rem; font-size: 0.95rem; }
  .hint { color: var(--muted); font-size: 0.82rem; margin: 0.35rem 0 0; }
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
  button.secondary { background: var(--bg); color: var(--text); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  #chat-status { color: var(--muted); font-size: 0.85rem; }
  .transcript {
    max-height: 28rem;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .bubble {
    border-radius: 10px;
    padding: 0.55rem 0.8rem;
    font-size: 0.9rem;
    line-height: 1.45;
    max-width: 88%;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .bubble-assistant {
    background: var(--bg);
    border: 1px solid var(--border);
    align-self: flex-start;
  }
  .bubble-user {
    background: var(--accent);
    color: #fff;
    align-self: flex-end;
  }
  .activity-line {
    color: var(--muted);
    font-size: 0.78rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    align-self: flex-start;
  }
  .banner {
    background: var(--panel);
    border: 1px solid var(--bad);
    color: var(--bad);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    font-size: 0.9rem;
    margin-top: 0.75rem;
  }
  .input-row {
    display: flex;
    gap: 0.6rem;
    margin-top: 0.85rem;
    align-items: flex-end;
  }
  textarea#chat-input {
    flex: 1;
    min-height: 3.2rem;
    max-height: 9rem;
    padding: 0.65rem;
    font: inherit;
    font-size: 0.9rem;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    resize: vertical;
  }
  .setup-progress {
    color: var(--muted);
    font-size: 0.82rem;
    margin-top: 1rem;
  }
  .done-panel {
    margin-top: 1.5rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
  }
  .links { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.75rem; }
  .links a {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.88rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.45rem 0.85rem;
  }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Interview</h1>
    <p class="lede">A conversational interview seeds your profile, targets, evidence, and search config, one question at a time.</p>
  </header>

  <section id="start-section" data-hook="start-section">
    <button id="start-btn" data-hook="start-btn" type="button">Start interview</button>
    <p class="hint">Runs ingest-profile live. You can leave and come back. The session keeps going.</p>
  </section>

  <section id="chat-section" data-hook="chat-section" hidden>
    <div class="status-row">
      <span id="chat-status" data-hook="chat-status" class="hint"></span>
      <button id="end-btn" data-hook="end-btn" type="button" class="secondary">End session</button>
    </div>
    <div id="chat-transcript" data-hook="chat-transcript" class="transcript" aria-live="polite"></div>
    <div id="chat-banner" data-hook="chat-banner" class="banner" hidden></div>
    <div class="input-row">
      <textarea id="chat-input" data-hook="chat-input" placeholder="Type your reply… (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="chat-send" data-hook="chat-send" type="button">Send</button>
    </div>
    <div id="setup-progress" data-hook="setup-progress" class="setup-progress"></div>
  </section>

  <section id="chat-done" data-hook="chat-done" class="done-panel" hidden>
    <h2>Setup looks complete</h2>
    <p class="hint">Where to next:</p>
    <div class="links">
      <a id="link-onboard" data-hook="link-onboard" href="/onboard">Onboarding wizard</a>
      <a id="link-search" data-hook="link-search" href="/search">Search</a>
      <a id="link-evaluate" data-hook="link-evaluate" href="/evaluate">Evaluate a job</a>
      <a id="link-packet" data-hook="link-packet" href="/packet">Packet</a>
      <a id="link-tracker" data-hook="link-tracker" href="/tracker">Tracker</a>
    </div>
  </section>
</main>
<script>
(function () {
  "use strict";

  var STORAGE_KEY = "careerrat_chat_ingest_profile";
  var SKILL_NAME = "ingest-profile";

  var startSection = document.getElementById("start-section");
  var startBtn = document.getElementById("start-btn");
  var chatSection = document.getElementById("chat-section");
  var statusEl = document.getElementById("chat-status");
  var endBtn = document.getElementById("end-btn");
  var transcript = document.getElementById("chat-transcript");
  var bannerEl = document.getElementById("chat-banner");
  var inputEl = document.getElementById("chat-input");
  var sendBtn = document.getElementById("chat-send");
  var progressEl = document.getElementById("setup-progress");
  var doneEl = document.getElementById("chat-done");

  var currentChatId = null;
  var currentEventSource = null;

  function clearBanner() {
    bannerEl.hidden = true;
    bannerEl.textContent = "";
  }

  function showBanner(message) {
    bannerEl.hidden = false;
    bannerEl.textContent = message;
  }

  function addBubble(text, role) {
    var el = document.createElement("div");
    el.className = "bubble bubble-" + role;
    el.textContent = text;
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function addActivityLine(text) {
    var el = document.createElement("div");
    el.className = "activity-line";
    el.textContent = text;
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function parseJson(raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function extractAssistantText(msg) {
    var content = msg && msg.message && msg.message.content;
    if (!content || !content.length) return "";
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      if (content[i] && content[i].type === "text" && content[i].text) {
        parts.push(content[i].text);
      }
    }
    return parts.join("\\n");
  }

  // ---------------------------------------------------------------------
  // Setup-progress strip + completion panel — derived from the persisted
  // GET /api/onboard/state route, never from assistant prose.
  // ---------------------------------------------------------------------

  function computeSetupComplete(state) {
    if (!state || !state.files || !state.files.length) return false;
    for (var i = 0; i < state.files.length; i++) {
      if (!state.files[i].valid) return false;
    }
    return !!state.searchSourcesPresent;
  }

  function renderProgress(state) {
    progressEl.textContent = "";
    var files = state.files || [];
    var parts = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      parts.push(f.name + ": " + (f.valid ? "ok" : f.exists ? "invalid" : "missing"));
    }
    var line = document.createElement("div");
    line.textContent = "Setup progress: " + (parts.join(", ") || "not started yet");
    progressEl.appendChild(line);
  }

  function checkProgress() {
    fetch("/api/onboard/state")
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (state) {
        if (!state) return;
        renderProgress(state);
        if (computeSetupComplete(state)) doneEl.hidden = false;
      })
      .catch(function () {
        // best effort — the progress strip just stays empty
      });
  }

  // ---------------------------------------------------------------------
  // Session state -> UI
  // ---------------------------------------------------------------------

  function applyState(state) {
    var running = state === "running";
    var closed = state === "closed";
    statusEl.textContent = running
      ? "Thinking…"
      : closed
        ? "Session ended"
        : state === "idle"
          ? "Waiting for your reply"
          : "";
    inputEl.disabled = running || closed;
    sendBtn.disabled = running || closed;
    if (closed) localStorage.removeItem(STORAGE_KEY);
    if (state === "idle") checkProgress();
  }

  // ---------------------------------------------------------------------
  // SSE wiring
  // ---------------------------------------------------------------------

  function handleAssistant(evt) {
    var data = parseJson(evt.data);
    var text = extractAssistantText(data);
    if (text) addBubble(text, "assistant");
  }

  function handleToolUse(evt) {
    var data = parseJson(evt.data);
    addActivityLine("tool: " + (data && data.name ? data.name : "unknown"));
  }

  function handleToolResult(evt) {
    var data = parseJson(evt.data);
    addActivityLine("result: " + (data && data.isError ? "error" : "ok"));
  }

  function handleChatState(evt) {
    var data = parseJson(evt.data);
    if (data && data.state) applyState(data.state);
  }

  function handleErrorFrame(evt) {
    var data = parseJson(evt.data);
    showBanner((data && data.message) || "The session reported an error.");
  }

  function wireEvents(es) {
    es.addEventListener("assistant", handleAssistant);
    es.addEventListener("tool_use", handleToolUse);
    es.addEventListener("tool_result", handleToolResult);
    es.addEventListener("chat_state", handleChatState);
    // See this file's header comment: the server's custom "error" SSE frame
    // and EventSource's own connection-error event share a name. A
    // MessageEvent (our frame) always has string .data; a real connection
    // failure is a plain Event and does not.
    es.addEventListener("error", function (evt) {
      if (evt && typeof evt.data === "string") {
        handleErrorFrame(evt);
        return;
      }
      if (es.readyState === EventSource.CLOSED) {
        showBanner("Connection to the interview lost. Reload the page to reconnect.");
      }
    });
  }

  function activate(chatId, es) {
    currentChatId = chatId;
    currentEventSource = es;
    localStorage.setItem(STORAGE_KEY, chatId);
    startSection.hidden = true;
    chatSection.hidden = false;
    clearBanner();
    wireEvents(es);
  }

  function showStart() {
    startSection.hidden = false;
    chatSection.hidden = true;
    startBtn.disabled = false;
  }

  function connect(chatId) {
    if (currentEventSource) {
      try {
        currentEventSource.close();
      } catch (e) {
        // ignore
      }
    }
    var es = new EventSource("/api/chat/events?id=" + encodeURIComponent(chatId));
    var opened = false;
    es.addEventListener("open", function () {
      opened = true;
      activate(chatId, es);
    });
    es.addEventListener("error", function () {
      if (!opened) {
        es.close();
        localStorage.removeItem(STORAGE_KEY);
        showStart();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Start / send / end
  // ---------------------------------------------------------------------

  startBtn.addEventListener("click", function () {
    startBtn.disabled = true;
    clearBanner();
    fetch("/api/chat/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: SKILL_NAME })
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
        if (result.body && result.body.chatId && (result.ok || result.status === 409)) {
          connect(result.body.chatId);
          return;
        }
        startBtn.disabled = false;
        showBanner((result.body && result.body.error) || "Could not start the interview.");
      })
      .catch(function (err) {
        startBtn.disabled = false;
        showBanner(String(err && err.message ? err.message : err));
      });
  });

  function sendCurrentInput() {
    var text = inputEl.value;
    if (!text || !text.trim() || !currentChatId) return;
    addBubble(text, "user");
    inputEl.value = "";
    fetch("/api/chat/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: currentChatId, text: text })
    })
      .then(function (res) {
        if (res.ok) return undefined;
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            showBanner((body && body.error) || "Message failed to send.");
          });
      })
      .catch(function (err) {
        showBanner(String(err && err.message ? err.message : err));
      });
  }

  sendBtn.addEventListener("click", sendCurrentInput);
  inputEl.addEventListener("keydown", function (evt) {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      sendCurrentInput();
    }
  });

  endBtn.addEventListener("click", function () {
    if (!currentChatId) return;
    endBtn.disabled = true;
    fetch("/api/chat/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: currentChatId })
    })
      .then(function () {
        endBtn.disabled = false;
        if (currentEventSource) {
          try {
            currentEventSource.close();
          } catch (e) {
            // ignore
          }
        }
        localStorage.removeItem(STORAGE_KEY);
        currentChatId = null;
        currentEventSource = null;
        showStart();
      })
      .catch(function () {
        endBtn.disabled = false;
      });
  });

  // ---------------------------------------------------------------------
  // Boot — resume a live session for ingest-profile, else fall back to a
  // stored chatId that still connects, else show "Start interview".
  // ---------------------------------------------------------------------

  function boot() {
    fetch("/api/chat/by-skill?skill=" + encodeURIComponent(SKILL_NAME))
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (session) {
        if (session && session.chatId) {
          connect(session.chatId);
          return;
        }
        var stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          connect(stored);
          return;
        }
        showStart();
      })
      .catch(function () {
        showStart();
      });
  }

  boot();
})();
</script>
</body>
</html>
`;
