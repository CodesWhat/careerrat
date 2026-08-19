// Tracker dashboard client script (theme toggle, count-up, relative time,
// row tooltips). Extracted from dashboard.mjs. Vanilla JS, no deps.
export const DASHBOARD_SCRIPT = `
  (function () {
    // ── Theme toggle ──────────────────────────────────────────────────────
    // Two dimensions: the dropdown picks a palette FAMILY, the ☀/☾ button picks
    // the MODE (light/dark) within it. data-theme holds the resolved
    // "<family>-<mode>" palette key (CSS), data-mode holds just the mode (drives
    // the toggle icon). "original" maps to the base :root / [data-theme="dark"].
    var root = document.documentElement;
    var KEY_THEME = "careerrat-theme";  // family
    var KEY_MODE = "careerrat-mode";    // light | dark
    var VALID_FAMILY = { original: 1, spinel: 1, slate: 1, box: 1, tokyonight: 1, gruvbox: 1 };
    var themeSelect = document.getElementById("theme-select");
    var family = "original", mode = "light";
    try {
      var sf = localStorage.getItem(KEY_THEME);
      if (sf && VALID_FAMILY[sf]) family = sf;
      if (localStorage.getItem(KEY_MODE) === "dark") mode = "dark";
    } catch (e) {}
    function variantFor(f, m) {
      return f === "original" ? (m === "dark" ? "dark" : "light") : (f + "-" + m);
    }
    function applyTheme() {
      root.setAttribute("data-theme", variantFor(family, mode));
      root.setAttribute("data-mode", mode);
      if (themeSelect) themeSelect.value = family;
    }
    // Initial paint. (Gradient stops are patched by the setTimeout below, which
    // runs after CSS_VAR_MAP is defined further down — don't patch here.)
    applyTheme();
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        mode = (mode === "dark") ? "light" : "dark";
        try { localStorage.setItem(KEY_MODE, mode); } catch (e) {}
        applyTheme();
        patchGradientStops();
      });
    }
    if (themeSelect) {
      themeSelect.addEventListener("change", function () {
        family = VALID_FAMILY[themeSelect.value] ? themeSelect.value : "original";
        try { localStorage.setItem(KEY_THEME, family); } catch (e) {}
        applyTheme();
        patchGradientStops();
      });
    }

    // ── Count-up animation (respects prefers-reduced-motion) ──────────────
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.querySelectorAll(".stat-n[data-to]").forEach(function (node) {
      var to = +node.dataset.to, sfx = node.dataset.sfx || "";
      if (reduce) { node.textContent = to + sfx; return; }
      var t0 = null;
      requestAnimationFrame(function tick(now) {
        if (t0 == null) t0 = now;
        var p = Math.min((now - t0) / 700, 1), e = 1 - Math.pow(1 - p, 3);
        node.textContent = Math.round(to * e) + sfx;
        if (p < 1) requestAnimationFrame(tick);
      });
    });

    // ── Friendly "Updated N ago" timestamp (recomputed from data-iso) ─────
    var updatedEl = document.getElementById("updated");
    if (updatedEl && updatedEl.dataset.iso) {
      var relTime = function (iso) {
        var then = new Date(iso).getTime();
        if (isNaN(then)) return "just now";
        var s = Math.max(0, Math.round((Date.now() - then) / 1000));
        if (s < 45) return "just now";
        var mins = Math.round(s / 60);
        if (mins < 60) return mins + " minute" + (mins === 1 ? "" : "s") + " ago";
        var hrs = Math.round(mins / 60);
        if (hrs < 24) return hrs + " hour" + (hrs === 1 ? "" : "s") + " ago";
        var days = Math.round(hrs / 24);
        if (days < 30) return days + " day" + (days === 1 ? "" : "s") + " ago";
        var mos = Math.round(days / 30);
        if (mos < 12) return mos + " month" + (mos === 1 ? "" : "s") + " ago";
        var yrs = Math.round(mos / 12);
        return yrs + " year" + (yrs === 1 ? "" : "s") + " ago";
      };
      var refreshUpdated = function () {
        updatedEl.textContent = "Updated " + relTime(updatedEl.dataset.iso);
      };
      refreshUpdated();
      setInterval(refreshUpdated, 60000);
    }

    // ── Needs Attention live countdown timers ─────────────────────────────
    function refreshAttentionCountdowns() {
      var now = Date.now();
      document.querySelectorAll(".att-when[data-due]").forEach(function (el) {
        var dueStr = el.dataset.due;
        if (!dueStr) return;
        var dueMs;
        try { dueMs = new Date(dueStr).getTime(); } catch (e) { return; }
        if (isNaN(dueMs)) return;
        var diffMs = now - dueMs;
        var text;
        if (diffMs >= 0) {
          var diffDays = Math.floor(diffMs / 86400000);
          if (diffDays >= 1) {
            text = diffDays + "d overdue";
          } else {
            var diffHours = Math.floor(diffMs / 3600000);
            text = diffHours >= 1 ? (diffHours + "h overdue") : "just due";
          }
        } else {
          var aheadDays = Math.ceil(-diffMs / 86400000);
          text = aheadDays <= 0 ? "due today" : ("in " + aheadDays + "d");
        }
        el.textContent = text;
      });
    }
    refreshAttentionCountdowns();
    setInterval(refreshAttentionCountdowns, 60000);

    // ── Gradient stop patching (make SVG linearGradient stops use CSS tokens) ──
    // SVG stop-color can't reference CSS variables in all browsers, so we read
    // the computed value and set it directly. Called on init + theme change.
    var CSS_VAR_MAP = {
      "accent": "--accent", "green": "--green", "red": "--red",
      "orange": "--orange", "purple": "--purple", "cyan": "--cyan",
      "text-muted": "--text-muted"
    };
    function resolveVar(varName) {
      return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    }
    function patchGradientStops() {
      document.querySelectorAll("stop[class]").forEach(function (stop) {
        var cls = stop.getAttribute("class") || "";
        var m = cls.match(/gs-(?:src|tgt)-([a-z-]+)/);
        if (!m) return;
        var varKey = m[1];
        var cssVar = CSS_VAR_MAP[varKey];
        if (!cssVar) return;
        var color = resolveVar(cssVar);
        if (color) stop.setAttribute("stop-color", color);
      });
    }
    // Patch after a short delay to ensure CSS has been parsed
    setTimeout(patchGradientStops, 0);

    // ── Funnel interactivity ───────────────────────────────────────────────
    var svg = document.getElementById("sankey");
    var tip = document.getElementById("funnel-tip");
    if (!svg || !tip) return;

    var ribbons = Array.from(svg.querySelectorAll(".ribbon"));

    function setOn(onRibbon, onId) {
      svg.classList.add("focus");
      ribbons.forEach(function (r) { r.classList.toggle("on", onRibbon(r)); });
      svg.querySelectorAll(".node").forEach(function (n) { n.classList.toggle("on", onId(n.dataset.id)); });
      svg.querySelectorAll(".lbl").forEach(function (l) { l.classList.toggle("on", onId(l.dataset.id)); });
    }
    function clearOn() { svg.classList.remove("focus"); tip.style.display = "none"; }
    function placeTip(e) {
      var pad = 15, r = tip.getBoundingClientRect();
      var x = e.clientX + pad, y = e.clientY + pad;
      if (x + r.width > window.innerWidth - 10) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 10) y = e.clientY - r.height - pad;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    }

    svg.addEventListener("mouseover", function (e) {
      var r = e.target.closest(".ribbon");
      if (r) {
        var d = r.dataset;
        setOn(function (x) { return x === r; }, function (id) { return id === d.s || id === d.t; });
        var colorVal = resolveVar(d.colorvar || "--accent");
        tip.innerHTML =
          "<div class='ft-flow'><span class='ft-swatch' style='background:" + colorVal + "'></span>"
          + d.from + " → " + d.to + "</div>"
          + "<div class='ft-n'>" + d.val + "<small>" + d.pct + "% of " + d.from + "</small></div>";
        tip.style.display = "block"; placeTip(e);
        return;
      }
      var nd = e.target.closest(".node,.lbl");
      if (nd && nd.dataset.id) {
        var id = nd.dataset.id, touch = new Set([id]);
        ribbons.forEach(function (rb) {
          if (rb.dataset.s === id || rb.dataset.t === id) { touch.add(rb.dataset.s); touch.add(rb.dataset.t); }
        });
        setOn(function (rb) { return rb.dataset.s === id || rb.dataset.t === id; }, function (x) { return touch.has(x); });
        tip.style.display = "none";
        return;
      }
      clearOn();
    });
    svg.addEventListener("mousemove", function (e) {
      if (tip.style.display === "block" && e.target.closest(".ribbon")) placeTip(e);
    });
    svg.addEventListener("mouseleave", clearOn);

    // ── Funnel click → filter applications table ───────────────────────────
    var activeStage = null;
    var filterBar = document.getElementById("funnel-filter-bar");
    var appsTable = document.getElementById("apps-table");

    function applyFilter(stageId) {
      if (!appsTable) return;
      activeStage = stageId;
      var rows = appsTable.querySelectorAll("tbody tr[data-stage]");
      rows.forEach(function (row) {
        row.classList.toggle("hidden", row.dataset.stage !== stageId);
      });
      // Show filter chip
      if (filterBar) {
        filterBar.innerHTML = stageId
          ? "<span class='funnel-chip'>" + stageId + " <span class='x' id='clear-filter'>&#x2715;</span></span>"
          : "";
        var clrBtn = document.getElementById("clear-filter");
        if (clrBtn) clrBtn.addEventListener("click", function () { applyFilter(null); clearOn(); });
      }
    }

    window.applyFunnelView = applyFilter;

    svg.addEventListener("click", function (e) {
      var nd = e.target.closest(".node,.lbl");
      if (nd && nd.dataset.id) applyFilter(nd.dataset.id);
    });

    // ── Applications + sourced row hover tooltip (.jobtip) ───────────────
    var jobTip = document.getElementById("job-tip");

    function placeJobTip(e) {
      var pad = 15, r = jobTip.getBoundingClientRect();
      var x = e.clientX + pad, y = e.clientY + pad;
      if (x + r.width > window.innerWidth - 10) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 10) y = e.clientY - r.height - pad;
      jobTip.style.left = x + "px"; jobTip.style.top = y + "px";
    }

    function buildJobTipHtml(d) {
      var gridItems = [
        ["Fit",      d.fit || "N/A"],
        ["Applied",  d.applied || "N/A"],
        ["Base",     d.base || "N/A"],
        ["TC",       d.tc || "N/A"],
        ["Location", d.loc || "N/A"],
        ["Mode",     d.mode || "N/A"],
        ["Channel",  d.channel || "N/A"],
        ["Status",   d.status || "N/A"],
      ].map(function (pair) {
        return "<div><div class=\\"jt-k\\">" + tipEsc(pair[0]) + "</div><div class=\\"jt-v\\">" + tipEsc(pair[1]) + "</div></div>";
      }).join("");

      var warn = d.warn ? "<div class=\\"jt-warn\\">" + tipEsc(d.warn) + "</div>" : "";
      var note = d.note ? "<div class=\\"jt-note\\"><div class=\\"jt-note-label\\">Notes</div>" + tipEsc(d.note) + "</div>" : "";
      var badge = d.status ? "<span class=\\"badge badge-" + d.status.replace(/[^a-z0-9-]/g, "") + "\\">" + tipEsc(d.status) + "</span>" : "";

      return "<div class=\\"jt-head\\"><span class=\\"jt-company\\">" + tipEsc(d.company) + "</span>" + badge + "</div>"
        + "<div style=\\"font-size:12px;color:var(--text-muted);margin-bottom:8px\\">" + tipEsc(d.role) + "</div>"
        + "<div class=\\"jt-grid\\">" + gridItems + "</div>"
        + warn + note;
    }

    function tipEsc(v) {
      return String(v == null ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Hover tooltip for the All Jobs table (and any legacy tables).
    var tipBodies = document.querySelectorAll("#jobs-table tbody, #apps-table tbody, #sourced-table tbody");
    if (jobTip && tipBodies.length) {
      tipBodies.forEach(function (tbodyEl) {
      tbodyEl.addEventListener("mousemove", function (e) {
        var tr = e.target.closest("tr[data-tip]");
        if (!tr) { jobTip.style.display = "none"; return; }
        try {
          var d = JSON.parse(tr.dataset.tip);
          jobTip.innerHTML = buildJobTipHtml(d);
          jobTip.style.display = "block";
          placeJobTip(e);
        } catch (ex) {
          jobTip.style.display = "none";
        }
      });
      tbodyEl.addEventListener("mouseleave", function () {
        jobTip.style.display = "none";
      });
      });
    }
    // ── All Jobs table: search + per-column filter + sort ───────────────────
    (function () {
      var jobsTable = document.getElementById("jobs-table");
      if (!jobsTable) return;

      var tbody = document.getElementById("jobsbody");
      var thead = document.getElementById("jobshead");
      var countEl = document.getElementById("jobcount");
      var searchEl = document.getElementById("jobsearch");
      var resetBtn = document.getElementById("jobreset");
      var chipsEl = document.getElementById("colfilters");

      // Column definitions — must match server-rendered data-* attributes and colgroup order.
      var COLS = [
        { k: "company", label: "Company",    type: "text",   dataAttr: "company",  align: "left"   },
        { k: "role",    label: "Role",       type: "text",   dataAttr: "role",     align: "left"   },
        { k: "base",    label: "Base Ask",   type: "num",    dataAttr: "base",     align: "right",  ph: "min $K" },
        { k: "mode",    label: "Mode",       type: "select", dataAttr: "mode",     align: "center", thClass: "th-mode" },
        { k: "fit",     label: "Fit",        type: "num",    dataAttr: "fit",      align: "right",  ph: "min",   thClass: "th-fit" },
        { k: "status",  label: "Status",     type: "select", dataAttr: "status",   align: "center", thClass: "th-status" },
      ];

      // Gather all rows once (they are server-rendered and will not change count).
      var allRows = Array.from(tbody.querySelectorAll("tr"));
      var totalCount = allRows.length;

      // Rejected/withdrawn rows (data-terminal="1") are hidden unless the
      // "Show rejected" toolbar toggle adds .show-rejected to #jobs-section.
      var jobsSection = document.getElementById("jobs-section");
      function showRejected() { return !!(jobsSection && jobsSection.classList.contains("show-rejected")); }
      var nonTerminalTotal = allRows.filter(function (tr) { return tr.dataset.terminal !== "1"; }).length;

      // Sort state: default FIT descending.
      var sortK = "fit";
      var sortDir = -1; // -1 = descending

      // Per-column filter state.
      var F = {};

      // Global free-text search.
      var GQ = "";

      // Build unique option lists for select columns from the rendered data.
      function uniqVals(attr) {
        var seen = {};
        var out = [];
        allRows.forEach(function (tr) {
          var v = tr.dataset[attr] || "";
          if (v && !seen[v]) { seen[v] = true; out.push(v); }
        });
        return out.sort();
      }

      var SELECT_OPTS = {
        mode:   uniqVals("mode"),
        status: uniqVals("status"),
      };

      // Numeric row value for a given column key.
      function numVal(tr, k) {
        var v = tr.dataset[k];
        var n = parseFloat(v);
        return isNaN(n) ? -1 : n;
      }

      // String row value for a given column key.
      function strVal(tr, k) {
        return tr.dataset[k] || "";
      }

      // Returns true if a row passes all active filters + global search.
      function rowVisible(tr) {
        if (tr.dataset.terminal === "1" && !showRejected()) return false;
        if (GQ) {
          var hay = tr.dataset.search || "";
          if (hay.indexOf(GQ) === -1) return false;
        }
        for (var i = 0; i < COLS.length; i++) {
          var c = COLS[i];
          var f = F[c.k];
          if (f == null || f === "") continue;
          if (c.type === "num") {
            if (numVal(tr, c.dataAttr) < parseFloat(f)) return false;
          } else if (c.type === "select") {
            if (strVal(tr, c.dataAttr) !== f) return false;
          } else {
            if (strVal(tr, c.dataAttr).indexOf(f.toLowerCase()) === -1) return false;
          }
        }
        return true;
      }

      // Apply search filter to board cards (mirrors table filter — text search only,
      // since board doesn't have column-specific selects). Called from renderBody.
      function filterBoardCards() {
        var boardEl = document.getElementById("jobs-board");
        if (!boardEl) return;
        var cards = Array.from(boardEl.querySelectorAll(".card[data-search]"));
        cards.forEach(function (card) {
          var show = true;
          if (GQ) {
            var hay = card.dataset.search || "";
            if (hay.indexOf(GQ) === -1) show = false;
          }
          card.classList.toggle("hidden", !show);
        });
        // Show/hide empty stage groups (all cards hidden) to avoid ghost headers
        var groups = Array.from(boardEl.querySelectorAll(".stage-group"));
        groups.forEach(function (g) {
          var anyVisible = Array.from(g.querySelectorAll(".card")).some(function (c) {
            return !c.classList.contains("hidden");
          });
          g.classList.toggle("hidden", !anyVisible);
        });
      }

      // Re-sort and re-show rows, update count.
      function renderBody() {
        var col = COLS.find(function (c) { return c.k === sortK; }) || COLS[6];
        var visible = allRows.filter(rowVisible);
        var hidden = allRows.filter(function (tr) { return !rowVisible(tr); });

        // Sort visible rows.
        visible.sort(function (a, b) {
          var av, bv;
          if (col.type === "num") {
            av = numVal(a, col.dataAttr);
            bv = numVal(b, col.dataAttr);
            return (av - bv) * sortDir;
          }
          av = strVal(a, col.dataAttr);
          bv = strVal(b, col.dataAttr);
          return av.localeCompare(bv) * sortDir;
        });

        // Re-attach rows in sorted order; hidden rows go to the end (display:none).
        visible.forEach(function (tr) {
          tr.classList.remove("hidden");
          tbody.appendChild(tr);
        });
        hidden.forEach(function (tr) {
          tr.classList.add("hidden");
          tbody.appendChild(tr);
        });

        var denom = showRejected() ? totalCount : nonTerminalTotal;
        if (countEl) countEl.textContent = visible.length + " of " + denom + " jobs";
        filterBoardCards();
        updateChips();
      }

      // Chip text for a column's active filter.
      function chipText(c) {
        var v = F[c.k];
        if (c.type === "num") {
          return c.label + " ≥ " + v + (c.k === "fit" ? "%" : "K");
        }
        // Capitalise first letter for display.
        var display = String(v).charAt(0).toUpperCase() + String(v).slice(1);
        return c.label + ": " + display;
      }

      // Render active-filter chips.
      function updateChips() {
        if (!chipsEl) return;
        var active = COLS.filter(function (c) { return F[c.k] != null && F[c.k] !== ""; });
        chipsEl.innerHTML = active.map(function (c) {
          // chipText() embeds the active filter VALUE, which is populated from
          // scraped status/company/location text — escape it before innerHTML.
          // c.k is an internal column key from COLS (never user data).
          return "<span class=\\"fchip\\" data-k=\\"" + c.k + "\\">" + tipEsc(chipText(c)) + " <span class=\\"x\\" aria-label=\\"Remove filter\\">✕</span></span>";
        }).join("");
        chipsEl.querySelectorAll(".fchip .x").forEach(function (x) {
          x.addEventListener("click", function () {
            var k = x.parentNode.dataset.k;
            delete F[k];
            // Also clear the corresponding input/select in the filter row.
            var el = thead.querySelector("tr.filt [data-col=\\"" + k + "\\"]");
            if (el) el.value = "";
            buildHead();
            renderBody();
          });
        });
      }

      // Build the sticky header + filter row.
      function buildHead() {
        var hr = document.createElement("tr");
        COLS.forEach(function (c) {
          var th = document.createElement("th");
          th.style.textAlign = c.align || "left";
          if (c.thClass) th.className = c.thClass;
          var arrow = (sortK === c.k) ? (sortDir > 0 ? "▲" : "▼") : "";
          th.innerHTML = c.label + " <span class=\\"arr\\">" + arrow + "</span>";
          th.addEventListener("click", function () {
            if (sortK === c.k) {
              sortDir *= -1;
            } else {
              sortK = c.k;
              sortDir = c.type === "num" ? -1 : 1;
            }
            buildHead();
            renderBody();
          });
          hr.appendChild(th);
        });

        var fr = document.createElement("tr");
        fr.className = "filt";
        COLS.forEach(function (c) {
          var th = document.createElement("th");
          th.style.textAlign = c.align || "left";
          if (c.type === "text") {
            var inp = document.createElement("input");
            inp.placeholder = "filter…";
            inp.value = F[c.k] || "";
            inp.dataset.col = c.k;
            inp.addEventListener("input", function (e) { F[c.k] = e.target.value; renderBody(); });
            th.appendChild(inp);
          } else if (c.type === "num") {
            var inp = document.createElement("input");
            inp.type = "number";
            inp.placeholder = c.ph || "min";
            inp.value = F[c.k] != null ? F[c.k] : "";
            inp.dataset.col = c.k;
            inp.addEventListener("input", function (e) { F[c.k] = e.target.value; renderBody(); });
            th.appendChild(inp);
          } else if (c.type === "select") {
            var sel = document.createElement("select");
            sel.dataset.col = c.k;
            var opts = SELECT_OPTS[c.k] || [];
            sel.innerHTML = "<option value=\\"\\">All</option>" + opts.map(function (v) {
              var label = v.charAt(0).toUpperCase() + v.slice(1);
              return "<option value=\\"" + v + "\\"" + (F[c.k] === v ? " selected" : "") + ">" + label + "</option>";
            }).join("");
            sel.addEventListener("change", function (e) { F[c.k] = e.target.value; renderBody(); });
            th.appendChild(sel);
          }
          fr.appendChild(th);
        });

        thead.innerHTML = "";
        thead.appendChild(hr);
        thead.appendChild(fr);
      }

      // Clear all filters + search.
      function clearAll() {
        for (var k in F) delete F[k];
        GQ = "";
        if (searchEl) searchEl.value = "";
      }

      if (searchEl) {
        searchEl.addEventListener("input", function (e) {
          GQ = e.target.value.toLowerCase();
          renderBody();
        });
      }
      if (resetBtn) {
        resetBtn.addEventListener("click", function () {
          clearAll();
          buildHead();
          renderBody();
        });
      }

      // Initial render.
      buildHead();
      renderBody();

      // Re-render when the "Show rejected" toggle flips (terminal rows in/out).
      document.addEventListener("careerrat:rejected", renderBody);
    })();

    // ── Jobs section: Table / Board / Calendar view toggle ─────────────────
    (function () {
      var viewWrap = document.getElementById("jobs-view-wrap");
      var btnTable = document.getElementById("vt-table");
      var btnBoard = document.getElementById("vt-board");
      var btnCal = document.getElementById("vt-cal");
      if (!viewWrap || !btnTable || !btnBoard) return;

      var VIEWS = {
        table: { cls: "jobs-view-table", btn: btnTable },
        board: { cls: "jobs-view-board", btn: btnBoard },
        calendar: { cls: "jobs-view-calendar", btn: btnCal },
      };

      var KEY_VIEW = "careerrat-jobs-view";
      var currentView = "table";
      try {
        var saved = localStorage.getItem(KEY_VIEW);
        if (saved && VIEWS[saved] && VIEWS[saved].btn) currentView = saved;
      } catch (e) {}

      function applyView(v) {
        if (!VIEWS[v] || !VIEWS[v].btn) v = "table";
        currentView = v;
        Object.keys(VIEWS).forEach(function (k) {
          var spec = VIEWS[k];
          var on = k === v;
          viewWrap.classList.toggle(spec.cls, on);
          if (spec.btn) {
            spec.btn.classList.toggle("active", on);
            spec.btn.setAttribute("aria-pressed", on ? "true" : "false");
          }
        });
        if (v === "calendar") document.dispatchEvent(new CustomEvent("careerrat:calendar"));
        try { localStorage.setItem(KEY_VIEW, v); } catch (e) {}
      }

      applyView(currentView);

      btnTable.addEventListener("click", function () { applyView("table"); });
      btnBoard.addEventListener("click", function () { applyView("board"); });
      if (btnCal) btnCal.addEventListener("click", function () { applyView("calendar"); });
    })();

    // ── Jobs section: Calendar view (month grid from real tracker dates) ───
    (function () {
      var cal = document.getElementById("jobs-calendar");
      var grid = document.getElementById("cal-grid");
      var titleEl = document.getElementById("cal-title");
      var dataEl = document.getElementById("cal-data");
      if (!cal || !grid || !titleEl || !dataEl) return;

      var events = [];
      try { events = JSON.parse(dataEl.textContent || "[]") || []; } catch (e) { events = []; }

      var byDay = {};
      events.forEach(function (ev) {
        if (ev && ev.d) { (byDay[ev.d] || (byDay[ev.d] = [])).push(ev); }
      });

      var MONTHS = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      var todayYmd = cal.getAttribute("data-today") || "";

      function pad2(n) { return (n < 10 ? "0" : "") + n; }
      function keyOf(y, m, d) { return y + "-" + pad2(m + 1) + "-" + pad2(d); }
      function partsOf(s) { var p = String(s).split("-"); return { y: +p[0], m: +p[1] - 1, d: +p[2] }; }

      var focus;
      if (todayYmd) { var t = partsOf(todayYmd); focus = { y: t.y, m: t.m }; }
      else if (events.length) { var l = partsOf(events[events.length - 1].d); focus = { y: l.y, m: l.m }; }
      else { focus = { y: 2026, m: 0 }; }

      function makeChip(ev) {
        var cls = ev.t === "applied" ? "cal-ev cal-ev--applied"
          : (ev.urg === "overdue" ? "cal-ev cal-ev--overdue" : "cal-ev cal-ev--due");
        var co = ev.co || "";
        var label = ev.label || "";
        var text = co ? (label + " · " + co) : label;
        var node = ev.link ? document.createElement("a") : document.createElement("span");
        node.className = cls;
        node.textContent = text;
        node.title = text + (ev.role ? " (" + ev.role + ")" : "");
        if (ev.link) { node.href = ev.link; node.target = "_blank"; node.rel = "noopener noreferrer"; }
        return node;
      }

      function render() {
        grid.textContent = "";
        var y = focus.y, m = focus.m;
        titleEl.textContent = MONTHS[m] + " " + y;
        var firstDow = new Date(y, m, 1).getDay();          // 0 = Sun
        var daysInMonth = new Date(y, m + 1, 0).getDate();
        var daysInPrev = new Date(y, m, 0).getDate();
        var totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;

        for (var i = 0; i < totalCells; i++) {
          var cellY = y, cellM = m, dayNum, inMonth;
          if (i < firstDow) {
            dayNum = daysInPrev - firstDow + 1 + i; inMonth = false;
            cellM = m - 1; if (cellM < 0) { cellM = 11; cellY = y - 1; }
          } else if (i >= firstDow + daysInMonth) {
            dayNum = i - firstDow - daysInMonth + 1; inMonth = false;
            cellM = m + 1; if (cellM > 11) { cellM = 0; cellY = y + 1; }
          } else {
            dayNum = i - firstDow + 1; inMonth = true;
          }

          var cell = document.createElement("div");
          var key = keyOf(cellY, cellM, dayNum);
          cell.className = "cal-cell" + (inMonth ? "" : " cal-cell--out") + (key === todayYmd ? " cal-cell--today" : "");

          var head = document.createElement("div");
          head.className = "cal-cell-day";
          head.textContent = dayNum;
          cell.appendChild(head);

          var evs = byDay[key];
          if (evs && evs.length) {
            var list = document.createElement("div");
            list.className = "cal-cell-evs";
            evs.forEach(function (ev) { list.appendChild(makeChip(ev)); });
            cell.appendChild(list);
          }
          grid.appendChild(cell);
        }
      }

      function shift(delta) {
        focus.m += delta;
        while (focus.m < 0) { focus.m += 12; focus.y -= 1; }
        while (focus.m > 11) { focus.m -= 12; focus.y += 1; }
        render();
      }

      var prevBtn = document.getElementById("cal-prev");
      var nextBtn = document.getElementById("cal-next");
      var todayBtn = document.getElementById("cal-today");
      if (prevBtn) prevBtn.addEventListener("click", function () { shift(-1); });
      if (nextBtn) nextBtn.addEventListener("click", function () { shift(1); });
      if (todayBtn) todayBtn.addEventListener("click", function () {
        if (todayYmd) { var p = partsOf(todayYmd); focus = { y: p.y, m: p.m }; render(); }
      });

      render();
    })();

    // ── Active Pipeline stage filter ───────────────────────────────────────
    (function () {
      var activeWrap = document.getElementById("active");
      var stageEl = document.getElementById("stagefilter");
      var activeCount = document.getElementById("activec");

      // Stage chips show/hide the matching stage group; "all" shows everything.
      // Per-stage totals are server-rendered; the overall "X of Y" updates live.
      // Terminal (rejected/withdrawn) groups stay hidden — and out of the count —
      // unless the "Show rejected" toggle adds .show-rejected to #jobs-section.
      var jobsSectionB = document.getElementById("jobs-section");
      function showRejectedB() { return !!(jobsSectionB && jobsSectionB.classList.contains("show-rejected")); }
      if (stageEl && activeWrap) {
        var groups = Array.from(activeWrap.querySelectorAll(".stage-group"));
        var current = "all";

        function renderStage() {
          var rej = showRejectedB();
          var visible = 0, totalShown = 0;
          groups.forEach(function (g) {
            if (g.classList.contains("stage-group--terminal") && !rej) { g.classList.add("hidden"); return; }
            var n = g.querySelectorAll(".card").length;
            totalShown += n;
            var show = current === "all" || g.dataset.stage === current;
            g.classList.toggle("hidden", !show);
            if (show) visible += n;
          });
          if (activeCount) activeCount.textContent = visible + " of " + totalShown;
          stageEl.querySelectorAll(".stage-btn").forEach(function (btn) {
            btn.classList.toggle("on", btn.dataset.stage === current);
          });
        }

        stageEl.querySelectorAll(".stage-btn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            current = btn.dataset.stage;
            renderStage();
          });
        });

        renderStage();
        document.addEventListener("careerrat:rejected", renderStage);
      }

      // Wire card hover to the existing job tooltip (active pipeline + rejected)
      var cardGrids = [activeWrap];
      var rejectedGrid = document.querySelector(".rejected-grid");
      if (rejectedGrid) cardGrids.push(rejectedGrid);
      if (jobTip) {
        cardGrids.forEach(function (grid) {
          if (!grid) return;
          grid.addEventListener("mousemove", function (e) {
            var card = e.target.closest(".card[data-tip]");
            if (!card) { jobTip.style.display = "none"; return; }
            try {
              var d = JSON.parse(card.dataset.tip);
              jobTip.innerHTML = buildJobTipHtml(d);
              jobTip.style.display = "block";
              placeJobTip(e);
            } catch (ex) {
              jobTip.style.display = "none";
            }
          });
          grid.addEventListener("mouseleave", function () {
            jobTip.style.display = "none";
          });
        });
      }
    })();

    // ── "Show rejected" toggle ─────────────────────────────────────────────
    // Flips #jobs-section.show-rejected; the table + board listen for the
    // "careerrat:rejected" event to re-filter and recount. State persists.
    (function () {
      var btn = document.getElementById("rej-toggle");
      var section = document.getElementById("jobs-section");
      if (!btn || !section) return;
      var KEY = "careerrat-show-rejected";
      var on = false;
      try { on = localStorage.getItem(KEY) === "1"; } catch (e) {}
      function apply() {
        section.classList.toggle("show-rejected", on);
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      apply();
      // Sync the table/board to the restored state (they rendered with defaults).
      document.dispatchEvent(new CustomEvent("careerrat:rejected"));
      btn.addEventListener("click", function () {
        on = !on;
        try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {}
        apply();
        document.dispatchEvent(new CustomEvent("careerrat:rejected"));
      });
    })();

    // ── Job detail modal ─────────────────────────────────────────────────────
    (function () {
      var detailEl = document.getElementById("job-details");
      if (!detailEl) return;
      var DETAIL;
      try { DETAIL = JSON.parse(detailEl.textContent || "{}"); } catch (e) { return; }

      var modal = document.getElementById("job-modal");
      var modalBody = document.getElementById("job-modal-body");
      if (!modal || !modalBody) return;

      function openModal(id) {
        var d = DETAIL[id];
        if (!d) return;
        // Hide tooltip while modal open
        if (jobTip) jobTip.style.display = "none";
        renderModal(d);
        modal.classList.add("open");
        document.body.style.overflow = "hidden";
      }

      function closeModal() {
        modal.classList.remove("open");
        document.body.style.overflow = "";
      }

      // ── Helpers ────────────────────────────────────────────────────────────
      function el(tag, cls) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        return e;
      }
      function txt(tag, cls, content) {
        var e = el(tag, cls);
        e.textContent = content;
        return e;
      }
      function fitColorVal(n) {
        return n >= 80 ? "var(--green)" : n >= 60 ? "var(--orange)" : "var(--purple)";
      }

      // ── Modal renderer ─────────────────────────────────────────────────────
      function renderModal(d) {
        modalBody.innerHTML = "";

        // Header
        var header = el("div", "jm-header");
        // Avatar
        var av = el("span", "avatar");
        av.style.setProperty("--avatar", "var(--c-0)");
        var name = d.company || "";
        var words = name.trim().split(/\\s+/);
        var initials = words.length >= 2
          ? (words[0].match(/[a-z0-9]/i) || [""])[0] + (words[1].match(/[a-z0-9]/i) || [""])[0]
          : (name.match(/[a-z0-9]{1,2}/i) || ["??"])[0];
        // Stable slot from hash
        var h = 0;
        for (var ci = 0; ci < name.length; ci++) h = ((h * 31) + name.charCodeAt(ci)) >>> 0;
        av.style.setProperty("--avatar", "var(--c-" + (h % 6) + ")");
        av.textContent = initials.toUpperCase().slice(0, 2);

        var titles = el("div", "jm-titles");
        var coName = txt("div", "jm-company", d.company || "");
        var roleName = txt("div", "jm-role", d.role || "");
        titles.appendChild(coName);
        titles.appendChild(roleName);

        // Badges row
        var badges = el("div", "jm-badges");
        if (d.status) {
          var slug = d.status.replace(/[^a-z0-9-]/g, "");
          var sb = txt("span", "badge badge-" + slug, d.status);
          badges.appendChild(sb);
        }
        // Fit badge
        if (d.fit !== "" && d.fit != null) {
          var fitN = Number(d.fit);
          var fitSpan = el("span", "badge");
          var isTriage = d.fitBasis === "triage";
          var prefix = isTriage ? "~" : "";
          fitSpan.textContent = prefix + fitN + "% fit";
          fitSpan.style.color = fitColorVal(fitN);
          fitSpan.style.background = "color-mix(in srgb, " + fitColorVal(fitN) + " 16%, var(--surface))";
          if (isTriage) fitSpan.title = "Triage estimate, not yet evaluated";
          badges.appendChild(fitSpan);
        }
        // JD link button
        if (d.link) {
          var linkA = document.createElement("a");
          linkA.href = d.link;
          linkA.target = "_blank";
          linkA.rel = "noopener noreferrer";
          linkA.className = "badge";
          linkA.textContent = "\\u2197 JD";
          linkA.style.color = "var(--accent)";
          badges.appendChild(linkA);
        }
        titles.appendChild(badges);

        header.appendChild(av);
        header.appendChild(titles);
        modalBody.appendChild(header);

        // Facts grid
        var gridData = [
          ["Applied",  d.applied || "\\u2014"],
          ["Channel",  d.channel || "\\u2014"],
          ["Location", d.loc || "\\u2014"],
          ["Mode",     d.mode || "\\u2014"],
          ["Base",     d.base || "\\u2014"],
          ["TC",       d.tc || "\\u2014"],
        ];
        if (d.warn) gridData.push(["Warning", d.warn]);
        var grid = el("div", "jm-grid");
        gridData.forEach(function(pair) {
          var cell = el("div");
          cell.appendChild(txt("div", "jm-k", pair[0]));
          cell.appendChild(txt("div", "jm-v", pair[1]));
          grid.appendChild(cell);
        });
        modalBody.appendChild(grid);

        // Note
        if (d.note) {
          var noteSection = el("div", "jm-section");
          noteSection.appendChild(txt("div", "jm-section-title", "Notes"));
          noteSection.appendChild(txt("div", "jm-artifact-box", d.note));
          modalBody.appendChild(noteSection);
        }

        // Artifacts
        var arts = d.artifacts || {};
        // JD
        var jdSection = el("div", "jm-section");
        jdSection.appendChild(txt("div", "jm-section-title", "Job Description"));
        if (arts.jd) {
          jdSection.appendChild(txt("div", "jm-artifact-box", arts.jd));
        } else {
          jdSection.appendChild(txt("p", "jm-empty", "Not captured yet \\u2014 paste it in and it'll show here."));
        }
        modalBody.appendChild(jdSection);

        // Cover Letter
        var clSection = el("div", "jm-section");
        clSection.appendChild(txt("div", "jm-section-title", "Cover Letter"));
        if (arts.coverLetter) {
          clSection.appendChild(txt("div", "jm-artifact-box", arts.coverLetter));
        } else {
          clSection.appendChild(txt("p", "jm-empty", "Not captured yet \\u2014 paste it in and it'll show here."));
        }
        modalBody.appendChild(clSection);

        // Resume
        var resSection = el("div", "jm-section");
        resSection.appendChild(txt("div", "jm-section-title", "R\\u00e9sum\\u00e9"));
        if (arts.resume) {
          var resBox = el("div", "jm-artifact-box");
          resBox.textContent = arts.resume;
          if (arts.resumeNote) {
            var rn = document.createElement("div");
            rn.style.marginTop = "8px";
            rn.style.color = "var(--text-muted)";
            rn.style.fontStyle = "italic";
            rn.textContent = arts.resumeNote;
            resBox.appendChild(rn);
          }
          resSection.appendChild(resBox);
        } else {
          resSection.appendChild(txt("p", "jm-empty", "Not captured yet \\u2014 paste it in and it'll show here."));
        }
        modalBody.appendChild(resSection);

        // Emails
        var emailSection = el("div", "jm-section");
        emailSection.appendChild(txt("div", "jm-section-title", "Email Thread"));
        var emails = d.emails || [];
        if (emails.length) {
          var emailList = el("div", "jm-email-list");
          emails.forEach(function(msg) {
            var item = el("div", "jm-email");
            var meta = el("div", "jm-email-meta");
            var dir = el("span", "jm-dir");
            if (msg.direction === "inbound") {
              dir.className = "jm-dir jm-dir-in";
              dir.textContent = "\\u2199 In";
            } else if (msg.direction === "note") {
              dir.className = "jm-dir jm-dir-note";
              dir.textContent = "\\u25cf Note";
            } else {
              dir.className = "jm-dir jm-dir-out";
              dir.textContent = "\\u2197 Out";
            }
            meta.appendChild(dir);
            var dateSpan = txt("span", "jm-email-date", msg.at || "");
            meta.appendChild(dateSpan);
            item.appendChild(meta);
            if (msg.subject) item.appendChild(txt("div", "jm-email-subject", msg.subject));
            if (msg.summary) item.appendChild(txt("div", "jm-email-summary", msg.summary));
            emailList.appendChild(item);
          });
          emailSection.appendChild(emailList);
        } else {
          emailSection.appendChild(txt("p", "jm-empty", "Not captured yet \\u2014 paste it in and it'll show here."));
        }
        modalBody.appendChild(emailSection);

        // Conversations
        var convSection = el("div", "jm-section");
        convSection.appendChild(txt("div", "jm-section-title", "Conversations"));
        var convs = d.conversations || [];
        if (convs.length) {
          var convList = el("div", "jm-conv-list");
          convs.forEach(function(conv) {
            var item = el("div", "jm-conv");
            var meta = el("div", "jm-conv-meta");
            if (conv.date) meta.appendChild(txt("span", "jm-conv-date", conv.date));
            if (conv.kind) meta.appendChild(txt("span", "jm-conv-kind", conv.kind));
            if (conv.who) meta.appendChild(txt("span", "jm-conv-who", conv.who));
            if (conv.recording) meta.appendChild(txt("span", "jm-conv-rec", "\\u23fa " + conv.recording));
            item.appendChild(meta);
            if (conv.notes) item.appendChild(txt("div", "jm-conv-notes", conv.notes));
            convList.appendChild(item);
          });
          convSection.appendChild(convList);
        } else {
          convSection.appendChild(txt("p", "jm-empty", "No conversations captured yet. Where legal, recording interviews (e.g. Granola) captures richer notes."));
        }
        modalBody.appendChild(convSection);
      }

      // ── Event wiring ────────────────────────────────────────────────────────
      // Close button
      var closeBtn = document.getElementById("job-modal-close");
      if (closeBtn) closeBtn.addEventListener("click", closeModal);

      // Backdrop click (click on modal overlay but not the panel)
      modal.addEventListener("click", function(e) {
        if (e.target === modal) closeModal();
      });

      // Escape key
      document.addEventListener("keydown", function(e) {
        if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
      });

      // Delegate click on .co inside #jobs-table
      var jobsTable = document.getElementById("jobs-table");
      if (jobsTable) {
        jobsTable.addEventListener("click", function(e) {
          var co = e.target.closest(".co");
          if (!co) return;
          var row = co.closest("tr[data-detail-id]");
          if (row) { e.stopPropagation(); openModal(row.dataset.detailId); }
        });
      }

      // Click on any pipeline card (active or rejected) — document-level delegate
      document.addEventListener("click", function(e) {
        var card = e.target.closest(".card[data-detail-id]");
        if (card) { e.stopPropagation(); openModal(card.dataset.detailId); }
      });

      // Click on "Open job" button inside a notification draft panel
      document.addEventListener("click", function(e) {
        var openBtn = e.target.closest(".notif-open-job[data-detail-id]");
        if (openBtn) { e.stopPropagation(); openModal(openBtn.dataset.detailId); }
      });
    })();
  })();

  // ── Notification bell + panel ─────────────────────────────────────────────
  (function () {
    var bell = document.getElementById("notif-bell");
    var panel = document.getElementById("notif-panel");
    var closeBtn = document.getElementById("notif-close");
    if (!bell || !panel) return;

    function openPanel() {
      panel.classList.add("open");
      bell.setAttribute("aria-expanded", "true");
    }
    function closePanel() {
      panel.classList.remove("open");
      bell.setAttribute("aria-expanded", "false");
    }

    bell.addEventListener("click", function (e) {
      e.stopPropagation();
      if (panel.classList.contains("open")) { closePanel(); } else { openPanel(); }
    });

    if (closeBtn) closeBtn.addEventListener("click", function () { closePanel(); });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("open")) closePanel();
    });

    document.addEventListener("mousedown", function (e) {
      var wrap = bell.closest(".notif-wrap");
      if (wrap && !wrap.contains(e.target)) closePanel();
    });

    // ── Expand / collapse notification items ──────────────────────────────
    panel.addEventListener("click", function (e) {
      var head = e.target.closest(".notif-item-head");
      if (!head) return;
      var item = head.closest(".notif-item");
      if (!item) return;
      item.classList.toggle("expanded");
    });

    // ── Copy draft to clipboard ────────────────────────────────────────────
    panel.addEventListener("click", function (e) {
      var btn = e.target.closest(".notif-copy");
      if (!btn) return;
      var item = btn.closest(".notif-item");
      if (!item) return;
      var subjEl = item.querySelector(".notif-subj");
      var bodyEl = item.querySelector(".notif-body");
      var subject = subjEl ? subjEl.textContent : "";
      var body = bodyEl ? bodyEl.textContent : "";
      var text = "Subject: " + subject + "\\n\\n" + body;

      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (ex) {}
        document.body.removeChild(ta);
      }

      var origText = btn.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = origText; }, 1800);
        }).catch(fallback);
      } else {
        fallback();
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = origText; }, 1800);
      }
    });

    // ── Open in mail (mailto) ──────────────────────────────────────────────
    panel.addEventListener("click", function (e) {
      var btn = e.target.closest(".notif-mail");
      if (!btn) return;
      var item = btn.closest(".notif-item");
      if (!item) return;
      var subjEl = item.querySelector(".notif-subj");
      var bodyEl = item.querySelector(".notif-body");
      var subject = subjEl ? subjEl.textContent : "";
      var body = bodyEl ? bodyEl.textContent : "";
      window.location.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    });

    // ── Draft button — copy agent prompt to clipboard ──────────────────────
    panel.addEventListener("click", function (e) {
      var btn = e.target.closest(".att-draft-btn");
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      var item = btn.closest(".notif-item");
      if (!item) return;
      var prompt = item.dataset.draftPrompt || "";
      if (!prompt) return;

      var origText = btn.textContent;

      function onCopied() {
        btn.textContent = "Copied ✓";
        setTimeout(function () { btn.textContent = origText; }, 1500);
      }

      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = prompt;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (ex) {}
        document.body.removeChild(ta);
        onCopied();
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(prompt).then(onCopied).catch(fallback);
      } else {
        fallback();
      }
    });
  })();

  // ── Today bar: Draft button handler ───────────────────────────────────────
  (function () {
    document.addEventListener("click", function (e) {
      var btn = e.target.closest(".tq-draft-btn");
      if (!btn) return;
      e.preventDefault();
      var prompt = btn.dataset.draftPrompt || "";
      if (!prompt) return;

      var origText = btn.textContent;

      function onCopied() {
        btn.textContent = "Copied ✓";
        setTimeout(function () { btn.textContent = origText; }, 1500);
      }

      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = prompt;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (ex) {}
        document.body.removeChild(ta);
        onCopied();
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(prompt).then(onCopied).catch(fallback);
      } else {
        fallback();
      }
    });
  })();
`;
