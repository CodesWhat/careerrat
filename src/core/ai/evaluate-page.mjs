// evaluate-page.mjs — Productization Phase 0, P0-5: the headline slice's UI.
// A single self-contained page: paste a job URL/JD → POST /api/skill/run
// drives evaluate-job through the embedded runtime (P0-4) → the SSE stream
// renders live as a compact event feed, then a verdict card (fit score,
// GATE/FIT/COMP/ACTION, duration, usage, cost) once the `result` event lands.
//
// Deliberately a plain template-literal export (no server-side interpolation)
// mounted verbatim by tracker-dev.mjs at GET /evaluate — the allowlist for the
// three decision buttons (Apply/Save/Pass, which POST track-outcomes) is
// fetched client-side from GET /api/runtime/config rather than baked in at
// render time, so the page is byte-static and cacheable.
//
// EventSource can't POST, so the client hand-parses the `event: <type>\ndata:
// <json>\n\n` framing straight off a fetch() ReadableStream — mirrors
// skill-run-route.mjs's own emit() framing exactly (see MAX_BODY_BYTES/emit()
// there). Inline <script> is kept intentionally small and is syntax-checked
// (not executed) by tests/evaluate-page.test.mjs, the same `new Function()`
// guard client-script.test.mjs uses for DASHBOARD_SCRIPT.

export const EVALUATE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evaluate a job — Rolester</title>
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
  textarea {
    width: 100%;
    min-height: 9rem;
    padding: 0.75rem;
    font: inherit;
    font-size: 0.9rem;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    resize: vertical;
  }
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
  .feed-decision { color: var(--good); }
  .verdict {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
  }
  .verdict-head {
    display: flex;
    align-items: flex-start;
    gap: 1.25rem;
  }
  .fit-badge {
    font-size: 2.5rem;
    font-weight: 700;
    line-height: 1;
    min-width: 3ch;
    color: var(--muted);
  }
  .fit-badge.tier-high { color: var(--good); }
  .fit-badge.tier-med { color: var(--warn); }
  .fit-badge.tier-low { color: var(--bad); }
  .verdict-lines { flex: 1; }
  .verdict-lines p {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .verdict-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 1rem;
    padding-top: 0.85rem;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.82rem;
  }
  .decisions {
    display: flex;
    gap: 0.6rem;
    margin-top: 1.1rem;
  }
  .decisions button { background: var(--text); color: var(--bg); }
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
    <h1>Evaluate a job</h1>
    <p class="lede">Paste a job URL or the full JD text — evaluate-job runs live and reports GATE / FIT / COMP / ACTION.</p>
  </header>

  <section class="intake">
    <textarea id="jd-input" data-hook="jd-input" placeholder="Paste a job URL or the full JD text…"></textarea>
    <div class="actions">
      <button id="run-btn" data-hook="run-btn" type="button">Evaluate</button>
      <span id="run-status" data-hook="run-status" class="status"></span>
    </div>
  </section>

  <section id="feed-section" data-hook="feed-section" hidden>
    <h2>Live run</h2>
    <div id="event-feed" data-hook="event-feed" class="feed" aria-live="polite"></div>
  </section>

  <section id="error-box" data-hook="error-box" class="error" hidden></section>

  <section id="verdict-card" data-hook="verdict-card" class="verdict" hidden>
    <div class="verdict-head">
      <div id="fit-score" data-hook="fit-score" class="fit-badge tier-unknown">—</div>
      <div class="verdict-lines">
        <p id="gate-line" data-hook="gate-line" hidden></p>
        <p id="fit-line" data-hook="fit-line" hidden></p>
        <p id="comp-line" data-hook="comp-line" hidden></p>
        <p id="comp-anchor-line" data-hook="comp-anchor-line" hidden></p>
        <p id="action-line" data-hook="action-line" hidden></p>
      </div>
    </div>
    <div class="verdict-meta">
      <span id="meta-duration" data-hook="meta-duration"></span>
      <span id="meta-usage" data-hook="meta-usage"></span>
      <span id="meta-cost" data-hook="meta-cost"></span>
    </div>
    <div class="decisions">
      <button id="decision-apply" data-hook="decision-apply" data-decision="apply" type="button" disabled>Apply</button>
      <button id="decision-save" data-hook="decision-save" data-decision="save" type="button" disabled>Save</button>
      <button id="decision-pass" data-hook="decision-pass" data-decision="pass" type="button" disabled>Pass</button>
    </div>
  </section>
</main>
<script>
(function () {
  "use strict";

  var input = document.getElementById("jd-input");
  var runBtn = document.getElementById("run-btn");
  var runStatus = document.getElementById("run-status");
  var feedSection = document.getElementById("feed-section");
  var feed = document.getElementById("event-feed");
  var errorBox = document.getElementById("error-box");
  var verdictCard = document.getElementById("verdict-card");
  var fitScoreEl = document.getElementById("fit-score");
  var gateLineEl = document.getElementById("gate-line");
  var fitLineEl = document.getElementById("fit-line");
  var compLineEl = document.getElementById("comp-line");
  var compAnchorLineEl = document.getElementById("comp-anchor-line");
  var actionLineEl = document.getElementById("action-line");
  var metaDurationEl = document.getElementById("meta-duration");
  var metaUsageEl = document.getElementById("meta-usage");
  var metaCostEl = document.getElementById("meta-cost");
  var decisionButtons = {
    apply: document.getElementById("decision-apply"),
    save: document.getElementById("decision-save"),
    pass: document.getElementById("decision-pass")
  };

  var allowedSkills = [];
  var lastInput = "";
  var lastGateSummary = "";
  var accumulatedText = "";

  // M3 — /search rows link here as /evaluate?url=<encoded offer url> so a
  // scanner hit can go straight to the body-read gate. Prefill only: never
  // auto-run, since evaluate-job is a paid AI call the human should trigger
  // deliberately.
  function prefillFromQuery() {
    try {
      var params = new URLSearchParams(window.location.search);
      var url = params.get("url");
      if (url) {
        input.value = url;
        runBtn.focus();
      }
    } catch (err) {
      // best effort — no url param, or URLSearchParams unsupported
    }
  }

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

  // Pulls the LAST occurrence of each gate line out of the accumulated
  // assistant text — evaluate-job's SKILL.md emits these at fixed line starts
  // (GATE:/FIT:/COMP:/COMP ANCHOR:/ACTION:), see .agents/skills/evaluate-job.
  function extractGateLines(text) {
    var patterns = {
      gate: /^GATE:.*$/gm,
      fit: /^FIT:.*$/gm,
      comp: /^COMP:.*$/gm,
      compAnchor: /^COMP ANCHOR:.*$/gm,
      action: /^ACTION:.*$/gm
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

  function extractFitScore(fitLine) {
    if (!fitLine) return null;
    var m = /FIT:\\s*(?:high|med|stretch)\\s+(\\d+)/i.exec(fitLine);
    return m ? Number(m[1]) : null;
  }

  function fitTier(score) {
    if (score === null) return "unknown";
    if (score >= 85) return "high";
    if (score >= 65) return "med";
    return "low";
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

  function renderVerdict(result) {
    var gate = extractGateLines(accumulatedText);
    lastGateSummary = [gate.gate, gate.fit, gate.action].filter(Boolean).join(" | ");
    var score = extractFitScore(gate.fit);
    fitScoreEl.textContent = score === null ? "—" : String(score);
    fitScoreEl.className = "fit-badge tier-" + fitTier(score);
    setLine(gateLineEl, gate.gate);
    setLine(fitLineEl, gate.fit);
    setLine(compLineEl, gate.comp);
    setLine(compAnchorLineEl, gate.compAnchor);
    setLine(actionLineEl, gate.action);

    metaDurationEl.textContent = result && typeof result.durationMs === "number"
      ? "duration: " + formatDuration(result.durationMs)
      : "";
    var usage = (result && result.usage) || {};
    metaUsageEl.textContent = "tokens: " + (usage.tokensIn || 0) + " in / " + (usage.tokensOut || 0) + " out";
    metaCostEl.textContent = formatUsd(result && result.costUsd);

    verdictCard.hidden = false;
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
        renderVerdict(evt.data);
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

  function setRunning(isRunning) {
    runBtn.disabled = isRunning;
    runStatus.textContent = isRunning ? "Running…" : "";
  }

  runBtn.addEventListener("click", function () {
    var value = input.value.trim();
    if (!value) return;
    lastInput = value;
    accumulatedText = "";
    feed.textContent = "";
    feedSection.hidden = false;
    verdictCard.hidden = true;
    clearError();
    setRunning(true);
    runSkill("evaluate-job", value, function () {
      setRunning(false);
    });
  });

  function decisionsEnabled() {
    return allowedSkills.indexOf("track-outcomes") !== -1;
  }

  function wireDecision(name, btn) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      var instruction =
        "Record outcome \\"" + name + "\\" for the role just evaluated" +
        (lastGateSummary ? " (" + lastGateSummary + ")" : "") +
        ". Source input: " + truncate(lastInput, 200);
      btn.disabled = true;
      addFeedLine("decision: " + name, "decision");
      runSkill("track-outcomes", instruction, function () {
        btn.disabled = !decisionsEnabled();
      });
    });
  }

  wireDecision("apply", decisionButtons.apply);
  wireDecision("save", decisionButtons.save);
  wireDecision("pass", decisionButtons.pass);

  function applyAllowlist(skills) {
    allowedSkills = skills || [];
    var enabled = decisionsEnabled();
    var keys = Object.keys(decisionButtons);
    for (var i = 0; i < keys.length; i++) {
      var btn = decisionButtons[keys[i]];
      if (!btn) continue;
      btn.disabled = !enabled;
      btn.title = enabled ? "" : "enable track-outcomes in ROLESTER_RUNTIME_SKILLS";
    }
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

  prefillFromQuery();
})();
</script>
</body>
</html>
`;
