// onboard-page.mjs — M1 of the paid-POC journey: the non-AI onboarding
// wizard's UI. A single self-contained page: eight client-stepped panels that
// call src/cli/onboard-route.mjs's endpoints directly — no AI model is ever
// invoked by this page (that's the whole point of M1: get a candidate's
// workspace legible before any paid AI usage starts).
//
// Cloned structurally from evaluate-page.mjs/answer-page.mjs's exact pattern:
// a plain template-literal export (no server-side interpolation) mounted
// verbatim by tracker-dev.mjs at GET /onboard, byte-static and cacheable.
// Unlike those two pages there is no SSE stream here — every call is a plain
// POST/GET-then-JSON round trip, so the inline <script> is plainer: no SSE
// frame parsing, just fetch().then(json).
//
// Step state lives entirely client-side (a `currentStep` var + hidden
// attributes on eight `.step` sections) — nothing about wizard progress is
// persisted server-side. What IS persisted is candidate/*.yml state itself
// (via onboard-route.mjs), which is why GET /api/onboard/state is refetched
// on page load: a returning user's progress is inferred from which candidate
// files already validate, not from a separate "wizard progress" record.
//
// Inline <script> avoids template literals, backticks, and regex/backslash
// escapes entirely (string concatenation with + instead) so it can live
// inside this file's own outer template literal without any double-escaping
// bookkeeping. It is syntax-checked (not executed) by
// tests/onboard-page.test.mjs, the same `new Function()` guard
// client-script.test.mjs uses for DASHBOARD_SCRIPT.

export const ONBOARD_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up your workspace — Rolester</title>
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
  .lede { color: var(--muted); margin: 0 0 1.25rem; font-size: 0.95rem; }
  h2 { font-size: 1.05rem; margin: 0 0 0.6rem; }
  .hint { color: var(--muted); font-size: 0.82rem; margin: 0.35rem 0 0; }
  .progress {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--muted);
    font-size: 0.82rem;
    margin-bottom: 0.75rem;
  }
  .state-summary {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 0.9rem;
    font-size: 0.82rem;
    color: var(--muted);
    margin-bottom: 1.5rem;
  }
  .state-summary div { margin: 0.15rem 0; }
  .step {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
    margin-bottom: 1.25rem;
  }
  .field { margin-bottom: 0.85rem; }
  label {
    display: block;
    font-size: 0.8rem;
    color: var(--muted);
    margin: 0 0 0.3rem;
  }
  textarea, input[type="text"], input[type="password"], input[type="file"] {
    width: 100%;
    padding: 0.65rem;
    font: inherit;
    font-size: 0.9rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  textarea { min-height: 8rem; resize: vertical; }
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
  .actions { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.75rem; flex-wrap: wrap; }
  .nav { display: flex; justify-content: space-between; margin-top: 1.5rem; }
  .errors { color: var(--bad); font-size: 0.82rem; margin-top: 0.6rem; }
  .errors div { margin: 0.15rem 0; }
  .result { font-size: 0.85rem; color: var(--muted); margin-top: 0.75rem; }
  .result div { margin: 0.15rem 0; }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .row:last-child { border-bottom: none; }
  .row input[type="checkbox"] { margin-top: 0.6rem; }
  .row .row-fields { flex: 1; display: flex; flex-direction: column; gap: 0.35rem; }
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
    <h1>Set up your workspace</h1>
    <p class="lede">A few steps to seed your candidate files locally — nothing on this page calls an AI model.</p>
  </header>

  <div class="progress">
    <span id="progress-text" data-hook="progress-text">Step 1 of 8</span>
  </div>

  <section id="state-summary" data-hook="state-summary" class="state-summary"></section>

  <section id="step-1" data-hook="step-1" class="step">
    <h2>1. Initialize workspace</h2>
    <p class="hint">Copies starter templates into candidate/ — never overwrites a file that already exists.</p>
    <div class="actions">
      <button id="init-btn" data-hook="init-btn" type="button">Initialize workspace</button>
    </div>
    <div id="init-result" data-hook="init-result" class="result"></div>
  </section>

  <section id="step-2" data-hook="step-2" class="step" hidden>
    <h2>2. Resume</h2>
    <div class="field">
      <label for="resume-textarea">Paste resume text</label>
      <textarea id="resume-textarea" data-hook="resume-textarea" placeholder="Paste plain-text or markdown resume…"></textarea>
    </div>
    <div class="field">
      <label for="resume-file">Or load a file (.txt, .md, .markdown)</label>
      <input id="resume-file" data-hook="resume-file" type="file" accept=".txt,.md,.markdown">
      <p class="hint">PDF and DOCX aren't supported here — export your resume as plain text or markdown first.</p>
    </div>
    <div class="actions">
      <button id="resume-submit" data-hook="resume-submit" type="button">Parse resume</button>
      <button id="resume-use" data-hook="resume-use" type="button" class="secondary" disabled>Use these for step 3</button>
    </div>
    <div id="resume-errors" data-hook="resume-errors" class="errors" hidden></div>
    <div id="resume-result" data-hook="resume-result" class="result"></div>
  </section>

  <section id="step-3" data-hook="step-3" class="step" hidden>
    <h2>3. Profile</h2>
    <div class="field"><label for="profile-full-name">Full name</label><input id="profile-full-name" data-hook="profile-full-name" type="text"></div>
    <div class="field"><label for="profile-email">Email</label><input id="profile-email" data-hook="profile-email" type="text"></div>
    <div class="field"><label for="profile-phone">Phone</label><input id="profile-phone" data-hook="profile-phone" type="text"></div>
    <div class="field"><label for="profile-location">Location</label><input id="profile-location" data-hook="profile-location" type="text"></div>
    <div class="field"><label for="profile-linkedin">LinkedIn</label><input id="profile-linkedin" data-hook="profile-linkedin" type="text"></div>
    <div class="field"><label for="profile-github">GitHub</label><input id="profile-github" data-hook="profile-github" type="text"></div>
    <div class="field"><label for="profile-portfolio">Portfolio</label><input id="profile-portfolio" data-hook="profile-portfolio" type="text"></div>
    <div class="field"><label for="profile-domain">Domain / field</label><input id="profile-domain" data-hook="profile-domain" type="text"></div>
    <div class="actions">
      <button id="profile-submit" data-hook="profile-submit" type="button">Save profile</button>
    </div>
    <div id="profile-errors" data-hook="profile-errors" class="errors" hidden></div>
  </section>

  <section id="step-4" data-hook="step-4" class="step" hidden>
    <h2>4. Targeting</h2>
    <div class="field">
      <label for="targeting-titles">Target titles (comma-separated)</label>
      <input id="targeting-titles" data-hook="targeting-titles" type="text" placeholder="e.g. Forward Deployed Engineer, Applied AI Engineer">
    </div>
    <div class="field"><label for="targeting-keep">Keep signals (comma-separated)</label><input id="targeting-keep" data-hook="targeting-keep" type="text"></div>
    <div class="field"><label for="targeting-cut">Cut signals (comma-separated)</label><input id="targeting-cut" data-hook="targeting-cut" type="text"></div>
    <div class="actions">
      <button id="targeting-submit" data-hook="targeting-submit" type="button">Save targeting</button>
    </div>
    <div id="targeting-errors" data-hook="targeting-errors" class="errors" hidden></div>
  </section>

  <section id="step-5" data-hook="step-5" class="step" hidden>
    <h2>5. Form defaults</h2>
    <div class="field"><label for="form-work-auth">Work authorization</label><input id="form-work-auth" data-hook="form-work-auth" type="text" placeholder="Yes / No"></div>
    <div class="field"><label for="form-sponsorship">Requires sponsorship</label><input id="form-sponsorship" data-hook="form-sponsorship" type="text" placeholder="Yes / No"></div>
    <div class="field"><label for="form-eeo">EEO default answer</label><input id="form-eeo" data-hook="form-eeo" type="text"></div>
    <div class="field"><label for="form-linkedin">LinkedIn</label><input id="form-linkedin" data-hook="form-linkedin" type="text"></div>
    <div class="field"><label for="form-github">GitHub</label><input id="form-github" data-hook="form-github" type="text"></div>
    <div class="field"><label for="form-portfolio">Portfolio</label><input id="form-portfolio" data-hook="form-portfolio" type="text"></div>
    <div class="actions">
      <button id="form-defaults-submit" data-hook="form-defaults-submit" type="button">Save form defaults</button>
    </div>
    <div id="form-defaults-errors" data-hook="form-defaults-errors" class="errors" hidden></div>
  </section>

  <section id="step-6" data-hook="step-6" class="step" hidden>
    <h2>6. Evidence seed</h2>
    <p class="hint">Claims pulled from your resume in step 2 — the AI interview will deepen this later.</p>
    <div id="evidence-list" data-hook="evidence-list" class="result">No claims parsed yet — go back to step 2 and parse a resume.</div>
    <div class="actions">
      <button id="evidence-submit" data-hook="evidence-submit" type="button">Save selected claims</button>
    </div>
    <div id="evidence-errors" data-hook="evidence-errors" class="errors" hidden></div>
    <div id="evidence-status" data-hook="evidence-status" class="result"></div>
  </section>

  <section id="step-7" data-hook="step-7" class="step" hidden>
    <h2>7. AI key (BYOK)</h2>
    <p class="hint">Stored locally in .internal/ai.env (gitignored, file mode 0600) — it never leaves this machine.</p>
    <div class="field">
      <label for="ai-key-input">Anthropic API key</label>
      <input id="ai-key-input" data-hook="ai-key-input" type="password" placeholder="sk-ant-…">
    </div>
    <div class="actions">
      <button id="ai-key-submit" data-hook="ai-key-submit" type="button">Save key</button>
    </div>
    <div id="ai-key-status" data-hook="ai-key-status" class="result"></div>
  </section>

  <section id="step-8" data-hook="step-8" class="step" hidden>
    <h2>8. Finish</h2>
    <p class="hint">Generates config/search-sources.yml and candidate/AGENTS.md from your profile + targeting.</p>
    <div class="actions">
      <button id="finish-btn" data-hook="finish-btn" type="button">Write config</button>
    </div>
    <div id="finish-result" data-hook="finish-result" class="result"></div>
    <div id="finish-links" data-hook="finish-links" class="links" hidden>
      <a id="link-search" data-hook="link-search" href="/search">Search</a>
      <a id="link-evaluate" data-hook="link-evaluate" href="/evaluate">Evaluate a job</a>
      <a id="link-answer" data-hook="link-answer" href="/answer">Answer a question</a>
      <a id="link-tracker" data-hook="link-tracker" href="/tracker">Tracker</a>
    </div>
  </section>

  <div class="nav">
    <button id="back-btn" data-hook="back-btn" type="button" class="secondary">Back</button>
    <button id="next-btn" data-hook="next-btn" type="button" class="secondary">Next</button>
  </div>
</main>
<script>
(function () {
  "use strict";

  var TOTAL_STEPS = 8;
  var currentStep = 1;
  var lastResumeSeed = null;

  var progressText = document.getElementById("progress-text");
  var stateSummary = document.getElementById("state-summary");
  var backBtn = document.getElementById("back-btn");
  var nextBtn = document.getElementById("next-btn");

  function showStep(n) {
    currentStep = n;
    for (var i = 1; i <= TOTAL_STEPS; i++) {
      var el = document.getElementById("step-" + i);
      if (el) el.hidden = i !== n;
    }
    progressText.textContent = "Step " + n + " of " + TOTAL_STEPS;
    backBtn.disabled = n === 1;
    nextBtn.disabled = n === TOTAL_STEPS;
  }

  backBtn.addEventListener("click", function () {
    if (currentStep > 1) showStep(currentStep - 1);
  });
  nextBtn.addEventListener("click", function () {
    if (currentStep < TOTAL_STEPS) showStep(currentStep + 1);
  });

  function clearErrors(el) {
    el.textContent = "";
    el.hidden = true;
  }

  function renderErrors(el, errors) {
    el.textContent = "";
    el.hidden = false;
    var list = errors && errors.length ? errors : [{ path: "", message: "save failed" }];
    for (var i = 0; i < list.length; i++) {
      var line = document.createElement("div");
      var prefix = list[i].path ? list[i].path + ": " : "";
      line.textContent = prefix + list[i].message;
      el.appendChild(line);
    }
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
    });
  }

  function postCandidate(name, data, errorsEl, btn) {
    if (btn) btn.disabled = true;
    clearErrors(errorsEl);
    return postJson("/api/onboard/candidate/" + name, { data: data })
      .then(function (result) {
        if (btn) btn.disabled = false;
        if (!result.ok || (result.body && result.body.ok === false)) {
          renderErrors(errorsEl, result.body && result.body.errors);
          return false;
        }
        return true;
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        renderErrors(errorsEl, [{ path: "", message: String(err && err.message ? err.message : err) }]);
        return false;
      });
  }

  function addIfNonEmpty(target, key, rawValue) {
    var value = (rawValue || "").trim();
    if (value) target[key] = value;
  }

  function splitCsv(rawValue) {
    var parts = String(rawValue || "").split(",");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (t) out.push(t);
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // State summary — refetched on load so a returning user sees prior progress
  // ---------------------------------------------------------------------

  function renderStateSummary(state) {
    stateSummary.textContent = "";
    var files = (state && state.files) || [];
    var parts = [];
    for (var i = 0; i < files.length; i++) {
      var status = files[i].valid ? "ok" : files[i].exists ? "invalid" : "missing";
      parts.push(files[i].name + ": " + status);
    }
    var filesLine = document.createElement("div");
    filesLine.textContent = "Candidate files — " + (parts.join(", ") || "none checked yet");
    stateSummary.appendChild(filesLine);

    var otherLine = document.createElement("div");
    otherLine.textContent =
      "Resume: " + (state && state.sourceResumePresent ? "saved" : "not saved") +
      " | AI key: " + (state && state.keyConfigured ? "configured" : "not configured") +
      " | Search config: " + (state && state.searchSourcesPresent ? "written" : "not written");
    stateSummary.appendChild(otherLine);
  }

  function loadState() {
    fetch("/api/onboard/state")
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (state) {
        if (state) renderStateSummary(state);
      })
      .catch(function () {
        // best effort — the state summary just stays empty
      });
  }

  // ---------------------------------------------------------------------
  // Step 1 — initialize workspace
  // ---------------------------------------------------------------------

  var initBtn = document.getElementById("init-btn");
  var initResult = document.getElementById("init-result");

  initBtn.addEventListener("click", function () {
    initBtn.disabled = true;
    postJson("/api/onboard/init", {}).then(function (result) {
      initBtn.disabled = false;
      initResult.textContent = "";
      var created = (result.body && result.body.created) || [];
      var existing = (result.body && result.body.existing) || [];
      var createdLine = document.createElement("div");
      createdLine.textContent = "Created: " + (created.join(", ") || "none — already set up");
      initResult.appendChild(createdLine);
      var existingLine = document.createElement("div");
      existingLine.textContent = "Already present: " + (existing.join(", ") || "none");
      initResult.appendChild(existingLine);
    });
  });

  // ---------------------------------------------------------------------
  // Step 2 — resume
  // ---------------------------------------------------------------------

  var resumeTextarea = document.getElementById("resume-textarea");
  var resumeFile = document.getElementById("resume-file");
  var resumeSubmit = document.getElementById("resume-submit");
  var resumeUse = document.getElementById("resume-use");
  var resumeErrors = document.getElementById("resume-errors");
  var resumeResult = document.getElementById("resume-result");

  resumeFile.addEventListener("change", function () {
    var file = resumeFile.files && resumeFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      resumeTextarea.value = String(reader.result || "");
    };
    reader.readAsText(file);
  });

  function renderResumeResult(body) {
    resumeResult.textContent = "";
    var contact = (body.profileSeed && body.profileSeed.candidate) || {};
    var fields = ["full_name", "email", "phone", "location", "linkedin", "github", "portfolio"];
    for (var i = 0; i < fields.length; i++) {
      var key = fields[i];
      if (!contact[key]) continue;
      var line = document.createElement("div");
      line.textContent = key + ": " + contact[key];
      resumeResult.appendChild(line);
    }
    var claimCount = (body.evidenceSeed && body.evidenceSeed.claims && body.evidenceSeed.claims.length) || 0;
    var claimsLine = document.createElement("div");
    claimsLine.textContent = "Claims found: " + claimCount;
    resumeResult.appendChild(claimsLine);
  }

  resumeSubmit.addEventListener("click", function () {
    var text = resumeTextarea.value;
    if (!text || !text.trim()) return;
    resumeSubmit.disabled = true;
    clearErrors(resumeErrors);
    postJson("/api/onboard/resume", { text: text, save: true })
      .then(function (result) {
        resumeSubmit.disabled = false;
        if (!result.ok) {
          renderErrors(resumeErrors, [{ path: "", message: (result.body && result.body.error) || "resume parse failed" }]);
          resumeUse.disabled = true;
          return;
        }
        lastResumeSeed = result.body;
        resumeUse.disabled = false;
        renderResumeResult(result.body);
      })
      .catch(function (err) {
        resumeSubmit.disabled = false;
        renderErrors(resumeErrors, [{ path: "", message: String(err && err.message ? err.message : err) }]);
      });
  });

  resumeUse.addEventListener("click", function () {
    if (!lastResumeSeed) return;
    prefillProfile((lastResumeSeed.profileSeed && lastResumeSeed.profileSeed.candidate) || {});
    renderEvidenceChecklist((lastResumeSeed.evidenceSeed && lastResumeSeed.evidenceSeed.claims) || []);
    showStep(3);
  });

  // ---------------------------------------------------------------------
  // Step 3 — profile
  // ---------------------------------------------------------------------

  var profileFields = {
    full_name: document.getElementById("profile-full-name"),
    email: document.getElementById("profile-email"),
    phone: document.getElementById("profile-phone"),
    location: document.getElementById("profile-location"),
    linkedin: document.getElementById("profile-linkedin"),
    github: document.getElementById("profile-github"),
    portfolio: document.getElementById("profile-portfolio"),
    domain: document.getElementById("profile-domain")
  };
  var profileSubmit = document.getElementById("profile-submit");
  var profileErrors = document.getElementById("profile-errors");

  function prefillProfile(contact) {
    var keys = Object.keys(profileFields);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (contact[key] && profileFields[key]) profileFields[key].value = contact[key];
    }
  }

  profileSubmit.addEventListener("click", function () {
    var candidate = {};
    var keys = Object.keys(profileFields);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      addIfNonEmpty(candidate, key, profileFields[key].value);
    }
    postCandidate("profile", { candidate: candidate }, profileErrors, profileSubmit);
  });

  // ---------------------------------------------------------------------
  // Step 4 — targeting
  // ---------------------------------------------------------------------

  var targetingTitles = document.getElementById("targeting-titles");
  var targetingKeep = document.getElementById("targeting-keep");
  var targetingCut = document.getElementById("targeting-cut");
  var targetingSubmit = document.getElementById("targeting-submit");
  var targetingErrors = document.getElementById("targeting-errors");

  targetingSubmit.addEventListener("click", function () {
    var titles = splitCsv(targetingTitles.value);
    var data = {
      keep_signals: splitCsv(targetingKeep.value),
      cut_signals: splitCsv(targetingCut.value)
    };
    if (titles.length) {
      data.role_buckets = [{ name: "Primary", priority: "primary", titles: titles }];
    }
    postCandidate("targeting", data, targetingErrors, targetingSubmit);
  });

  // ---------------------------------------------------------------------
  // Step 5 — form defaults
  // ---------------------------------------------------------------------

  var formWorkAuth = document.getElementById("form-work-auth");
  var formSponsorship = document.getElementById("form-sponsorship");
  var formEeo = document.getElementById("form-eeo");
  var formLinkedin = document.getElementById("form-linkedin");
  var formGithub = document.getElementById("form-github");
  var formPortfolio = document.getElementById("form-portfolio");
  var formDefaultsSubmit = document.getElementById("form-defaults-submit");
  var formDefaultsErrors = document.getElementById("form-defaults-errors");

  formDefaultsSubmit.addEventListener("click", function () {
    var data = {};
    addIfNonEmpty(data, "work_authorization", formWorkAuth.value);
    addIfNonEmpty(data, "requires_sponsorship", formSponsorship.value);
    addIfNonEmpty(data, "eeo_default", formEeo.value);
    addIfNonEmpty(data, "linkedin", formLinkedin.value);
    addIfNonEmpty(data, "github", formGithub.value);
    addIfNonEmpty(data, "portfolio", formPortfolio.value);
    postCandidate("form-defaults", data, formDefaultsErrors, formDefaultsSubmit);
  });

  // ---------------------------------------------------------------------
  // Step 6 — evidence seed
  // ---------------------------------------------------------------------

  var evidenceList = document.getElementById("evidence-list");
  var evidenceSubmit = document.getElementById("evidence-submit");
  var evidenceErrors = document.getElementById("evidence-errors");
  var evidenceStatus = document.getElementById("evidence-status");

  function renderEvidenceChecklist(claims) {
    evidenceList.textContent = "";
    if (!claims || !claims.length) {
      evidenceList.textContent = "No claims parsed yet — go back to step 2 and parse a resume.";
      return;
    }
    for (var i = 0; i < claims.length; i++) {
      var claim = claims[i];
      var row = document.createElement("div");
      row.className = "row";
      row.setAttribute("data-row", "claim");

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.setAttribute("data-hook", "evidence-claim-checkbox");
      row.appendChild(checkbox);

      var fields = document.createElement("div");
      fields.className = "row-fields";

      var claimInput = document.createElement("input");
      claimInput.type = "text";
      claimInput.value = claim.claim || "";
      claimInput.setAttribute("data-field", "claim");
      claimInput.setAttribute("data-hook", "evidence-claim-text");
      fields.appendChild(claimInput);

      var evidenceInput = document.createElement("input");
      evidenceInput.type = "text";
      evidenceInput.value = claim.evidence || "";
      evidenceInput.setAttribute("data-field", "evidence");
      evidenceInput.setAttribute("data-hook", "evidence-evidence-text");
      fields.appendChild(evidenceInput);

      row.appendChild(fields);
      evidenceList.appendChild(row);
    }
  }

  evidenceSubmit.addEventListener("click", function () {
    var rows = evidenceList.querySelectorAll("[data-row='claim']");
    var claims = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var checkbox = row.querySelector("input[type='checkbox']");
      if (!checkbox || !checkbox.checked) continue;
      var claimInput = row.querySelector("[data-field='claim']");
      var evidenceInput = row.querySelector("[data-field='evidence']");
      var claimText = claimInput ? claimInput.value.trim() : "";
      var evidenceText = evidenceInput ? evidenceInput.value.trim() : "";
      if (!claimText) continue;
      claims.push({ claim: claimText, evidence: evidenceText });
    }
    if (!claims.length) {
      renderErrors(evidenceErrors, [{ path: "", message: "select at least one claim first" }]);
      return;
    }
    evidenceSubmit.disabled = true;
    clearErrors(evidenceErrors);
    postJson("/api/onboard/evidence-seed", { claims: claims })
      .then(function (result) {
        evidenceSubmit.disabled = false;
        if (!result.ok || (result.body && result.body.ok === false)) {
          renderErrors(evidenceErrors, result.body && result.body.errors);
          return;
        }
        evidenceStatus.textContent = "Saved " + result.body.added + " claim(s).";
      })
      .catch(function (err) {
        evidenceSubmit.disabled = false;
        renderErrors(evidenceErrors, [{ path: "", message: String(err && err.message ? err.message : err) }]);
      });
  });

  // ---------------------------------------------------------------------
  // Step 7 — AI key (BYOK)
  // ---------------------------------------------------------------------

  var aiKeyInput = document.getElementById("ai-key-input");
  var aiKeySubmit = document.getElementById("ai-key-submit");
  var aiKeyStatus = document.getElementById("ai-key-status");

  aiKeySubmit.addEventListener("click", function () {
    var key = aiKeyInput.value.trim();
    if (!key) return;
    aiKeySubmit.disabled = true;
    postJson("/api/settings/ai-key", { apiKey: key })
      .then(function (result) {
        if (!result.ok) {
          aiKeySubmit.disabled = false;
          aiKeyStatus.textContent = (result.body && result.body.error) || "Failed to save the key.";
          return undefined;
        }
        aiKeyInput.value = "";
        return fetch("/api/settings/ai")
          .then(function (res) {
            return res.json();
          })
          .then(function (cfg) {
            aiKeySubmit.disabled = false;
            aiKeyStatus.textContent = "Configured — route: " + cfg.route + ", key present: " + (cfg.keyPresent ? "yes" : "no");
          });
      })
      .catch(function (err) {
        aiKeySubmit.disabled = false;
        aiKeyStatus.textContent = String(err && err.message ? err.message : err);
      });
  });

  // ---------------------------------------------------------------------
  // Step 8 — finish
  // ---------------------------------------------------------------------

  var finishBtn = document.getElementById("finish-btn");
  var finishResult = document.getElementById("finish-result");
  var finishLinks = document.getElementById("finish-links");

  finishBtn.addEventListener("click", function () {
    finishBtn.disabled = true;
    postJson("/api/onboard/write-config", {})
      .then(function (result) {
        finishBtn.disabled = false;
        if (!result.ok) {
          finishResult.textContent = (result.body && result.body.error) || "write-config failed.";
          return;
        }
        var written = (result.body && result.body.written) || [];
        finishResult.textContent = "Wrote: " + written.join(", ");
        finishLinks.hidden = false;
      })
      .catch(function (err) {
        finishBtn.disabled = false;
        finishResult.textContent = String(err && err.message ? err.message : err);
      });
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  loadState();
  showStep(1);
})();
</script>
</body>
</html>
`;
