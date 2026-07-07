import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDashboardViewModel,
  hydrateDashboardFromTracker,
  renderDashboardViewModel,
} from "../src/core/tracker/dashboard-data.js";
import { buildLibrarySnapshot } from "../src/core/tracker/library-snapshot.mjs";

const root = new URL("..", import.meta.url);

function fakeElement() {
  const attrs = {};
  return {
    textContent: "",
    dataset: {},
    title: "",
    setAttribute(name, value) {
      attrs[name] = String(value);
      this[name] = String(value);
    },
    getAttribute(name) {
      return attrs[name];
    },
  };
}

test("Dashboard adapterbuilds live UI state from tracker JSON", async () => {
  const tracker = JSON.parse(
    await readFile(new URL("examples/demo-workspace/tracker.json", root), "utf8")
  );
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
  });

  assert.equal(vm.stats.inPlay, 23);
  assert.equal(vm.stats.responseRate, 34);
  assert.equal(vm.stats.interviews, 4);
  assert.equal(vm.jobs.totalCount, tracker.applications.length + tracker.sourced.length);
  assert.equal(vm.jobs.visibleCount, 25);
  assert.ok(vm.calendar.weeks[0].days.some((day) => day.events.length > 0));
  assert.ok(vm.latestRoles.some((role) => role.company === "Black Mesa"));
  assert.ok(vm.jobs.sankey.nodes.length > 0);
});

test("Dashboard sourceshell hydrates through the tracked data module", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /<title>Rolester · Application Tracker<\/title>/);
  assert.match(html, /data-page-panel="dashboard"/);
  assert.match(html, /data-page-panel="jobs"/);
  assert.match(html, /new URL\(["']\.\/dashboard-data\.js["'],\s*import\.meta\.url\)/);
  assert.match(html, /hydrateDashboardFromTracker/);
  assert.match(html, /data-jobs-funnel-toggle/);
  assert.match(html, /aria-controls="jobs-sankey-slot"/);
  assert.match(html, /data-mode-chip="usage"/);
  assert.match(html, /data-mode-value="application"/);
  assert.doesNotMatch(html, /Cold apply/);
  assert.match(html, /funnelCollapsed/);
});

test("Dashboard source shell exposes the Paper Command Center chrome", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.doesNotMatch(html, /\.page-title::after/);
  assert.doesNotMatch(html, /hero-blobs|blob-/);
});

test("Dashboard shell morphs the top nav from square header to floating pill on scroll", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /<nav class="[^"]*\bis-at-top\b[^"]*"[^>]*data-dashboard-header/);
  assert.match(html, /<main class="[^"]*"[^>]*data-dashboard-scroll-root/);
  assert.match(html, /function setupHeaderScrollState\(\)\s*\{/);
  assert.match(html, /document\.querySelector\('\[data-dashboard-scroll-root\]'\)/);
  assert.match(html, /header\.classList\.toggle\('is-scrolled',\s*isScrolled\)/);
  assert.match(html, /header\.classList\.toggle\('is-at-top',\s*!isScrolled\)/);
  assert.match(html, /setupHeaderScrollState\(\);/);
});

test("Dashboard shell keeps the Paper Command Center styling in the command deck prototype", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /id="settings-drawer"/);
  assert.match(html, /<span class="mode-status-chip-label">Usage:<\/span>/);
  assert.match(html, /<span class="mode-status-chip-label">Apply:<\/span>/);
  assert.doesNotMatch(html, /<span class="mode-status-chip-label">Application<\/span>/);
});

test("Dashboard shell moves mode chips out of page headers and into the settings drawer", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  for (const page of ["dashboard", "jobs", "sourced", "calendar", "network", "library"]) {
    const header = html.match(
      new RegExp(
        `<section class="[^"]*" data-page-panel="${page}"[\\s\\S]*?<header class="page-hero">[\\s\\S]*?</header>`
      )
    )?.[0];
    assert.ok(header, `expected ${page} page header`);
    assert.doesNotMatch(
      header,
      /class="mode-status-row hero-mode-row"/,
      `${page} header should not show mode row`
    );
    assert.doesNotMatch(
      header,
      /data-mode-value="usage"/,
      `${page} header should not show usage value`
    );
    assert.doesNotMatch(
      header,
      /data-mode-value="application"/,
      `${page} header should not show apply value`
    );
  }

  assert.match(html, /data-settings-open/);
  assert.match(html, /aria-controls="settings-drawer"/);
  assert.match(html, /id="settings-drawer"[\s\S]*aria-label="Settings"/);
  assert.match(html, /id="settings-drawer"[\s\S]*data-mode-chip="usage"/);
  assert.match(html, /id="settings-drawer"[\s\S]*data-mode-value="application"/);
  assert.match(html, /id="settings-drawer"[\s\S]*data-settings-value="candidate"/);
  assert.match(html, /id="settings-drawer"[\s\S]*data-settings-value="minimumBase"/);
  assert.match(html, /id="settings-drawer"[\s\S]*Current compensation hidden/);
  assert.doesNotMatch(html, /current_base/);
});

test("Dashboard shell settings drawer opens from the nav gear", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /<button[^>]+data-settings-open[^>]+aria-label="Open settings"/);
  assert.match(html, /function openSettingsDrawer\(\)\s*\{/);
  assert.match(html, /function closeSettingsDrawer\([^)]*\)\s*\{/);
  assert.match(html, /document\.querySelector\('\[data-settings-open\]'\)/);
  assert.match(html, /settingsDrawer\.classList\.remove\('translate-x-full'\)/);
  assert.match(html, /settingsDrawer\.classList\.add\('translate-x-full'\)/);
  assert.match(html, /settingsDrawer\.focus\(\)/);
});

test("Dashboard shell prototypes the command deck focus layout with activity dock and drawer", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /id="focus-card"/);
  assert.match(html, /id="focus-card-body"/);
  assert.match(html, /id="pulse-feed"/);
  assert.match(html, /id="activity-card"/);
  assert.match(html, /id="activity-drawer"/);
  assert.match(html, /aria-controls="activity-drawer"/);
  assert.match(html, /data-activity-drawer-open/);
  assert.match(html, /function setupActivityDrawer\(\)/);
  assert.match(html, /function openActivityDrawer\(\)/);
  assert.match(html, /function closeActivityDrawer\(/);
});

test("Dashboard shell exposes the Strategy insights card hooks", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");
  const dashboardSection = html.match(
    /<section class="page-panel page-shell" data-page-panel="dashboard"[\s\S]*?<section class="page-panel page-shell jobs-page-variant--rail"/
  )?.[0];

  assert.ok(dashboardSection, "expected dashboard page shell");
  assert.match(dashboardSection, /data-strategy-insights/);
  assert.match(dashboardSection, />Strategy insights</);
  assert.match(dashboardSection, /data-strategy-metric="topSource"/);
  assert.match(dashboardSection, /data-strategy-metric="bestLane"/);
  assert.match(dashboardSection, /data-strategy-metric="staleCount"/);
  assert.match(dashboardSection, />Quiet applications</);
  assert.match(dashboardSection, /data-strategy-recommendation-cta/);
  assert.match(dashboardSection, /openActionsDrawer\(\)/);
  assert.doesNotMatch(dashboardSection, /data-strategy-summary-list/);
  assert.match(dashboardSection, /<details class="strategy-details"/);
  assert.match(dashboardSection, /class="dashboard-disclosure-summary strategy-details-summary"/);
  assert.match(dashboardSection, /Strategy details/);
  assert.match(dashboardSection, /data-strategy-source-list/);
  assert.match(dashboardSection, /data-strategy-role-list/);
  assert.match(dashboardSection, /data-strategy-fit-list/);
  assert.match(dashboardSection, /data-strategy-stale-list/);
  assert.match(dashboardSection, /data-strategy-stage-list/);
  assert.match(dashboardSection, /data-strategy-cadence-list/);
  assert.match(dashboardSection, /data-strategy-trend-list/);
  assert.match(dashboardSection, /data-strategy-history-list/);
  assert.match(dashboardSection, /data-strategy-learning-signals/);
  assert.match(dashboardSection, /data-strategy-review-trigger/);
  assert.match(dashboardSection, /href="#strategy-review"/);
  assert.match(html, /function openStrategyReview\(\)/);
  assert.match(
    html,
    /document\.querySelector\('\[data-strategy-insights\] details\.strategy-details'\)/
  );
  assert.match(dashboardSection, />Outcome learning</);
  assert.match(dashboardSection, /data-strategy-recommendation/);
});

test("Dashboard shell exposes the next agent task card hooks", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");
  const dashboardSection = html.match(
    /<section class="page-panel page-shell" data-page-panel="dashboard"[\s\S]*?<section class="page-panel page-shell jobs-page-variant--rail"/
  )?.[0];

  assert.ok(dashboardSection, "expected dashboard page shell");
  assert.match(dashboardSection, /data-agent-guidance/);
  assert.match(dashboardSection, />Next agent task</);
  assert.match(dashboardSection, /data-agent-guidance-title/);
  assert.match(dashboardSection, /data-agent-guidance-message/);
  assert.match(dashboardSection, /data-agent-guidance-reason/);
  assert.match(dashboardSection, /data-agent-guidance-cta/);
});

test("Dashboard shell uses one square disclosure control for collapsible dropdowns", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /<summary class="dashboard-disclosure-summary strategy-details-summary">/);
});

test("Dashboard shell promotes the Jobs command rail as the jobs page baseline", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /aria-label="Triage rail"/);
  assert.match(html, />Triage posture</);
  assert.match(html, />Batch actions</);
  assert.match(html, />Next decision</);
  assert.match(html, /data-jobs-rail-action="high-fit"/);
  assert.match(html, /data-jobs-rail-action="manual-review"/);
  assert.match(html, /data-jobs-rail-action="interview-path"/);
  assert.match(html, /data-jobs-rail-action="stale-applications"/);
  assert.match(html, /function applyJobsRailAction\(/);
});

test("Dashboard shell promotes the A Calendar week board with week navigation and month zoom", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");
  const calendarSection = html.match(
    /<section class="page-panel page-shell calendar-page-variant--compare"[\s\S]*?<section class="page-panel page-shell[^"]*" data-page-panel="network"/
  )?.[0];

  assert.ok(calendarSection, "expected the Calendar workbench page");
  assert.match(calendarSection, /data-page-panel="calendar"/);
  assert.match(calendarSection, /data-calendar-workbench/);
  assert.match(calendarSection, /data-calendar-zoom="week"/);
  assert.match(calendarSection, /data-calendar-stat="thisWeek"/);
  assert.match(calendarSection, /data-calendar-stat="interviews"/);
  assert.match(calendarSection, /data-calendar-stat="dueToday"/);
  assert.match(calendarSection, /aria-label="Calendar week board"/);
  assert.match(calendarSection, /data-calendar-prev-week/);
  assert.match(calendarSection, /data-calendar-next-week/);
  assert.match(calendarSection, /data-calendar-week-label/);
  assert.match(calendarSection, /aria-label="Week navigation"/);
  assert.match(calendarSection, /aria-label="Calendar zoom"/);
  assert.match(calendarSection, /data-calendar-view="week"/);
  assert.match(calendarSection, /data-calendar-view="month"/);
  assert.match(calendarSection, /data-calendar-week-panel/);
  assert.match(calendarSection, /data-calendar-week-board/);
  assert.match(calendarSection, /data-calendar-month-panel/);
  assert.match(calendarSection, /data-calendar-month-title/);
  assert.match(calendarSection, /data-calendar-month-grid/);
  assert.match(calendarSection, /data-calendar-today-list/);
  assert.match(calendarSection, /data-calendar-this-week-stats/);
  assert.match(calendarSection, /data-calendar-protected-prep/);
  assert.match(calendarSection, /aria-label="Month command rail"/);
  assert.match(calendarSection, /data-calendar-view-label/);
  assert.match(calendarSection, /data-kind="interview"/);
  assert.match(calendarSection, /data-next-step-item data-detail-id="aperture"/);
  assert.doesNotMatch(html, /const CALENDAR_WEEKS = \[/);
  assert.doesNotMatch(html, /iso:\s*'2026-06-15'/);
  assert.match(html, /data-calendar-day-state="past"/);
  assert.match(html, /function annotateCalendarPastDays\(/);
  assert.match(html, /function downloadCalendarIcs\(/);
  assert.match(html, /data-calendar-download-event/);
  assert.match(html, /data-calendar-google-link/);
  assert.match(html, /data-calendar-outlook-link/);
  assert.match(html, /function setupCalendarWorkbench\(\)/);
  assert.match(html, /window\.updateCalendarWorkbench/);
  assert.match(html, /setupCalendarWorkbench\(\);/);
});

test("Dashboard adapter builds Calendar from tracker dates and actions", () => {
  const tracker = {
    applications: [
      {
        id: "aperture",
        company: "Aperture",
        role: "Applied AI Engineer",
        status: "interview",
        channel: "recruiter",
        fitScore: 91,
        appliedAt: "2026-06-10",
      },
      {
        id: "aperture-science",
        company: "Aperture Science",
        role: "Senior Software Engineer (AI)",
        status: "interview",
        channel: "portal",
        fitScore: 86,
        appliedAt: "2026-06-15",
      },
      {
        id: "hooli",
        company: "Hooli",
        role: "Applied AI Engineer",
        status: "interview",
        channel: "recruiter",
        fitScore: 82,
        appliedAt: "2026-06-12",
      },
      {
        id: "ecorp",
        company: "E Corp",
        role: "Deployed Engineer",
        status: "awaiting",
        channel: "portal",
        fitScore: 84,
        appliedAt: "2026-06-15",
        followUp: { kind: "app-nudge", dueAt: "2026-06-22" },
      },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "comm-aperture",
        applicationId: "aperture",
        company: "Aperture",
        role: "Applied AI Engineer",
        status: "scheduled",
        nextAction: "Attend Aperture hiring-manager interview",
        nextActionDue: "2026-06-18T15:00:00.000Z",
        summary: "Calendar invitation received for the Aperture interview.",
      },
      {
        id: "comm-aperture-science",
        applicationId: "aperture-science",
        company: "Aperture Science",
        role: "Senior Software Engineer (AI)",
        status: "needs-reply",
        nextAction: "Complete Aperture Science CodeSignal technical assessment",
        nextActionDue: "2026-06-17",
        summary: "Assessment due within 48 hours.",
      },
      {
        id: "comm-hooli",
        applicationId: "hooli",
        company: "Hooli",
        role: "Applied AI Engineer",
        status: "waiting",
        nextAction: "Reply to the recruiter about next steps",
        nextActionDue: "2026-06-18",
        summary: "Recruiter screen completed.",
      },
    ],
    calendarWrites: [
      {
        id: "cal-write-aperture",
        eventId: "comm-aperture",
        provider: "google_calendar",
        title: "Aperture interview",
        status: "written",
        wroteAt: "2026-06-18T14:40:00.000Z",
        eventIso: "2026-06-18",
        summary: "Created after candidate confirmation.",
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T12:00:00.000Z"),
  });

  assert.equal(vm.calendar.metrics.thisWeek, 3);
  assert.equal(vm.calendar.metrics.interviews, 1);
  assert.equal(vm.calendar.metrics.dueToday, 2);
  assert.equal(vm.calendar.currentWeekIndex, 0);
  assert.equal(vm.calendar.weeks[0].label, "Jun 15-19");
  assert.match(vm.calendar.weeks[0].export.filename, /rolester-calendar-jun-15-19\.ics/);
  assert.match(vm.calendar.weeks[0].export.ics, /BEGIN:VCALENDAR/);
  assert.match(vm.calendar.weeks[0].export.ics, /SUMMARY:Aperture interview/);
  assert.match(
    vm.calendar.weeks[0].export.ics,
    /SUMMARY:Complete Aperture Science CodeSignal technical assessment/
  );
  assert.match(vm.calendar.weeks[0].export.ics, /DTSTART:20260618T150000Z/);
  assert.deepEqual(
    vm.calendar.weeks[0].days.map((day) => day.iso),
    ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"]
  );
  const apertureEvent = vm.calendar.weeks[0].days
    .find((day) => day.iso === "2026-06-18")
    .events.find((event) => event.detailId === "aperture");
  assert.equal(apertureEvent.export.kind, "timed");
  assert.match(apertureEvent.export.filename, /aperture-interview-2026-06-18\.ics/);
  assert.match(apertureEvent.export.ics, /BEGIN:VEVENT/);
  assert.match(
    apertureEvent.export.googleUrl,
    /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/
  );
  assert.match(apertureEvent.export.googleUrl, /Aperture\+interview/);
  assert.match(
    apertureEvent.export.outlookUrl,
    /^https:\/\/outlook\.live\.com\/calendar\/0\/deeplink\/compose\?/
  );
  const apertureScEvent = vm.calendar.weeks[0].days
    .find((day) => day.iso === "2026-06-17")
    .events.find((event) => event.detailId === "aperture-science");
  assert.equal(apertureScEvent.export.kind, "all-day");
  assert.match(apertureScEvent.export.ics, /DTSTART;VALUE=DATE:20260617/);
  assert.ok(
    vm.calendar.weeks[0].days
      .find((day) => day.iso === "2026-06-18")
      .events.some((event) => event.detailId === "aperture" && event.kind === "interview")
  );
  assert.ok(
    vm.calendar.weeks[0].days
      .find((day) => day.iso === "2026-06-17")
      .events.some((event) => event.detailId === "aperture-science" && event.kind === "assessment")
  );
  assert.equal(vm.calendar.weeks[0].nextUp.detailId, "hooli");
  assert.match(vm.calendar.weeks[0].nextUp.title, /Reply to the recruiter/);
  assert.ok(vm.calendar.weeks[0].loops.some((loop) => loop.detailId === "hooli"));
  assert.equal(vm.calendar.month.title, "June 2026");
  assert.ok(vm.calendar.month.days.some((day) => day.iso === "2026-06-18" && day.isToday));
  assert.ok(
    vm.calendar.month.days.some((day) => day.events.some((event) => event.detailId === "aperture"))
  );
  assert.equal(vm.calendar.sync.capability, "calendar_sync");
  assert.deepEqual(
    vm.calendar.sync.providers.map((provider) => provider.key),
    ["apple_calendar", "google_calendar", "outlook_calendar", "automation_tools"]
  );
  assert.equal(vm.calendar.sync.history[0].providerLabel, "Google Calendar");
  assert.equal(vm.calendar.sync.history[0].title, "Aperture interview");
  assert.equal(vm.calendar.sync.history[0].statusLabel, "Written");
});

test("Dashboard renderer fills the Calendar workbench from view model", () => {
  const tracker = {
    applications: [
      {
        id: "aperture",
        company: "Aperture",
        role: "Applied AI Engineer",
        status: "interview",
        followUp: { kind: "interview", dueAt: "2026-06-18T15:00:00.000Z" },
      },
      {
        id: "hooli",
        company: "Hooli",
        role: "Applied AI Engineer",
        status: "interview",
      },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "comm-hooli",
        applicationId: "hooli",
        company: "Hooli",
        status: "waiting",
        nextAction: "Follow up with Hooli",
        nextActionDue: "2026-06-18",
      },
    ],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T12:00:00.000Z"),
  });
  const values = new Map();
  const week = { innerHTML: "" };
  const nextUp = { innerHTML: "" };
  const loops = { innerHTML: "" };
  const month = { innerHTML: "" };
  const today = { innerHTML: "" };
  const stats = { innerHTML: "" };
  const prep = { innerHTML: "" };
  const syncProviders = { innerHTML: "" };
  const syncHistory = { innerHTML: "" };
  const monthTitle = fakeElement();
  const monthCount = fakeElement();
  const labels = [fakeElement(), fakeElement()];
  const root = {
    querySelector(selector) {
      const stat = selector.match(/^\[data-calendar-stat="([^"]+)"\]$/);
      if (stat) {
        if (!values.has(stat[1])) values.set(stat[1], fakeElement());
        return values.get(stat[1]);
      }
      if (selector === "[data-calendar-week-board]") return week;
      if (selector === "[data-calendar-next-up]") return nextUp;
      if (selector === "[data-calendar-open-loops]") return loops;
      if (selector === "[data-calendar-month-grid]") return month;
      if (selector === "[data-calendar-today-list]") return today;
      if (selector === "[data-calendar-this-week-stats]") return stats;
      if (selector === "[data-calendar-protected-prep]") return prep;
      if (selector === "[data-calendar-sync-providers]") return syncProviders;
      if (selector === "[data-calendar-sync-history]") return syncHistory;
      if (selector === "[data-calendar-month-title]") return monthTitle;
      if (selector === "[data-calendar-month-count]") return monthCount;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-calendar-week-label]") return labels;
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.equal(values.get("thisWeek").textContent, "2");
  assert.equal(values.get("interviews").textContent, "1");
  assert.equal(values.get("dueToday").textContent, "2");
  assert.match(week.innerHTML, /Aperture/);
  assert.match(week.innerHTML, /Hooli/);
  assert.match(week.innerHTML, /data-kind="interview"/);
  assert.match(week.innerHTML, /data-calendar-download-event/);
  assert.match(week.innerHTML, /data-calendar-export-id=/);
  assert.match(
    week.innerHTML,
    /href="https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/
  );
  assert.match(week.innerHTML, /data-calendar-google-link/);
  assert.match(
    week.innerHTML,
    /href="https:\/\/outlook\.live\.com\/calendar\/0\/deeplink\/compose\?/
  );
  assert.match(week.innerHTML, /data-calendar-outlook-link/);
  assert.match(nextUp.innerHTML, /Aperture|Hooli/);
  assert.match(nextUp.innerHTML, /data-calendar-download-event/);
  assert.match(nextUp.innerHTML, /data-calendar-google-link/);
  assert.match(loops.innerHTML, /Hooli/);
  assert.match(month.innerHTML, /data-calendar-date="2026-06-18"/);
  assert.match(month.innerHTML, /calendar-dot/);
  assert.match(today.innerHTML, /Aperture/);
  assert.match(stats.innerHTML, />1<\/strong><span>Interviews<\/span>/);
  assert.match(prep.innerHTML, /Open prep/);
  assert.match(syncProviders.innerHTML, /Apple Calendar/);
  assert.match(syncProviders.innerHTML, /Google Calendar/);
  assert.match(syncProviders.innerHTML, /Outlook Calendar/);
  assert.match(syncProviders.innerHTML, /automation_tools/);
  assert.match(syncHistory.innerHTML, /No calendar writes yet/);
  assert.equal(monthTitle.textContent, "June 2026");
  assert.match(monthCount.textContent, /tracked/);
  assert.equal(labels[0].textContent, "Jun 15-19");
});

test("Dashboard shell locks Network to the company relationship map baseline", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");
  const networkSection = html.match(
    /<section class="page-panel page-shell network-page-variant--company-map"[\s\S]*?<section class="page-panel page-shell[^"]*" data-page-panel="library"/
  )?.[0];

  assert.ok(networkSection, "expected a Network company map page");
  assert.match(networkSection, /data-page-panel="network"/);
  assert.match(networkSection, /data-network-stat="warmPaths"/);
  assert.match(networkSection, /data-network-company-grid/);
  assert.match(networkSection, /class="page-subtitle">Company relationships/);
  assert.match(networkSection, /aria-label="Company relationship map"/);
  assert.match(networkSection, />Warm Paths</);
  assert.match(networkSection, />Companies</);
  assert.match(networkSection, />Dormant</);
  assert.match(networkSection, /data-network-stat="companies"/);
  assert.match(networkSection, /data-network-stat="dormant"/);
  assert.match(networkSection, /data-network-purpose="company-map"/);
  assert.match(networkSection, />Company relationship map</);
  assert.match(html, /data-network-toggle/);
  assert.match(html, /data-network-body/);
  assert.match(html, /\.network-signal-row/);
  assert.match(html, /\.network-reuse-panel\[data-reuse-state="caution"\]/);
  assert.match(html, /\.network-reuse-panel\[data-reuse-state="closed"\]/);
  assert.match(html, /\.network-reuse-panel\[data-reuse-state="safe"\]/);
  assert.match(html, /\.network-contact-node/);
  assert.match(html, /\.network-contact-pill/);
  assert.match(html, /\.network-company-head/);
  assert.doesNotMatch(networkSection, /data-next-step-item/);
});

test("Dashboard shell promotes Resources into the Evidence Library baseline", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");
  const librarySection = html.match(
    /<section class="page-panel page-shell library-page-variant--evidence"[\s\S]*?<div id="content-pool"/
  )?.[0];

  assert.match(html, /href="#library" data-page-link="library">Library<\/a>/);
  assert.doesNotMatch(html, /data-page-link="resources"/);
  assert.ok(librarySection, "expected the Evidence Library page");
  assert.match(librarySection, /data-page-panel="library"/);
  assert.match(librarySection, />Evidence Library</);
  assert.match(librarySection, /data-library-stat="claims"/);
  assert.match(librarySection, /data-library-filters/);
  assert.match(librarySection, /data-library-cards/);
  assert.match(librarySection, /data-library-deck/);
  assert.match(librarySection, /data-library-gaps/);
  assert.match(librarySection, />Claims</);
  assert.match(librarySection, />Stories</);
  assert.match(librarySection, />Gaps</);
  assert.match(librarySection, /data-library-callout/);
  assert.match(librarySection, /data-library-search/);
  assert.match(librarySection, />Story &amp; evidence bank</);
  assert.match(librarySection, /data-library-no-results/);
  assert.match(librarySection, /data-library-segment="evidence"/);
  assert.match(librarySection, /data-library-segment="story"/);
  assert.match(librarySection, /data-library-segment="voice"/);
  assert.match(librarySection, /data-library-tag="Applied AI"/);
  assert.match(librarySection, /data-library-tag="Typescript"/);
  assert.match(librarySection, /data-library-tag="Automation"/);
  assert.match(librarySection, /data-library-segments/);
  assert.match(librarySection, /data-library-segment="all"/);
  assert.match(librarySection, /aria-label="Claim guardrails"/);
  assert.match(librarySection, /placeholder="Search proof, stories, voice/);
  assert.doesNotMatch(librarySection, />Current Profile</);
  assert.doesNotMatch(librarySection, />Base floor</);
  assert.doesNotMatch(librarySection, />Config Files</);
  assert.doesNotMatch(librarySection, />Source résumé</);
  assert.doesNotMatch(librarySection, />Artifacts</);
});

test("Dashboard adapter builds Network relationship map from live tracker state", () => {
  const tracker = {
    applications: [
      {
        id: "aperture",
        company: "Aperture",
        role: "Applied AI Engineer",
        status: "awaiting",
        fitScore: 94,
        conversations: [
          {
            kind: "HM call",
            who: "Sherry Ali — Engineering Manager",
            notes: "Adoption metrics matter before the next screen.",
          },
        ],
      },
      {
        id: "initech",
        company: "Initech",
        role: "Director, Solution Architect",
        status: "interview",
        fitScore: 88,
      },
      {
        id: "piedpiper",
        company: "Pied Piper",
        role: "Manager, IAM Security Operations",
        status: "rejected",
        fitScore: 78,
        conversations: [
          {
            kind: "recruiter screen",
            who: "Casey Recruiter, Pied Piper recruiter contractor",
            notes: "No specific rejection gap disclosed.",
          },
        ],
      },
      {
        id: "portal-only",
        company: "PortalCo",
        role: "AI Engineer",
        status: "awaiting",
        fitScore: 91,
      },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "comm-aperture",
        applicationId: "aperture",
        company: "Aperture",
        role: "Applied AI Engineer",
        channel: "email",
        status: "waiting",
        summary: "Recruiter loop is warm.",
        nextAction: "Await Anna reply",
        nextActionDue: "2026-06-22",
        messages: [
          {
            direction: "inbound",
            at: "2026-06-15",
            from: "Avery Recruiter <anna@aperture.example.test>",
            to: ["Demo Candidate"],
            summary: "Aperture is interested and asked the candidate to schedule HM time.",
          },
        ],
      },
      {
        id: "comm-initech",
        applicationId: "initech",
        company: "Initech",
        role: "Director, Solution Architect",
        channel: "email",
        status: "waiting",
        summary: "Teams interview details sent.",
        nextAction: "Prepare for the Initech Teams interview",
        nextActionDue: "2026-06-18",
        participants: [
          {
            name: "Jordan Recruiter",
            role: "Initech Business Services Recruiting Manager",
          },
        ],
        messages: [
          {
            direction: "inbound",
            at: "2026-06-16",
            from: "Initech Candidate Portal",
            to: ["Demo Candidate"],
            subject: "Thank you for applying - Director, Solution Architect",
            summary: "Initech confirmed the application in Workday.",
          },
          {
            direction: "inbound",
            at: "2026-06-17",
            from: "Jordan Recruiter <jordan.recruiter@initech.example.test>",
            to: ["Demo Candidate"],
            summary: "Robert sent Teams meeting details.",
          },
        ],
      },
      {
        id: "comm-piedpiper",
        applicationId: "piedpiper",
        company: "Pied Piper",
        role: "Manager, IAM Security Operations",
        channel: "email",
        status: "closed",
        summary: "Screen closed.",
        messages: [
          {
            direction: "inbound",
            at: "2026-06-17",
            from: "Casey Recruiter <alex@piedpiper.example.test>",
            to: ["Demo Candidate"],
            summary: "Pied Piper moved forward with other candidates.",
          },
        ],
      },
      {
        id: "comm-portal-only",
        applicationId: "portal-only",
        company: "PortalCo",
        role: "AI Engineer",
        channel: "portal",
        status: "closed",
        summary: "Application submitted via portal.",
        messages: [
          {
            direction: "outbound-sent",
            at: "2026-06-17",
            from: "Demo Candidate",
            to: ["PortalCo"],
            summary: "Application submitted.",
          },
        ],
      },
    ],
    relationshipLeads: [
      {
        id: "lead-aperture-sam",
        applicationId: "aperture",
        company: "Aperture",
        name: "Sam Patel",
        type: "Decision maker",
        title: "Staff Engineering Manager",
        platform: "linkedin",
        status: "approved",
        note: "Candidate reviewed this as a useful hiring-team path.",
      },
      {
        id: "lead-initech-jamie",
        applicationId: "initech",
        company: "Initech",
        name: "Jamie Rivera",
        type: "Recruiter",
        title: "Talent Partner",
        platform: "linkedin",
        status: "review",
        basis: "Likely recruiting owner for Solution Architect roles.",
        url: "https://www.linkedin.com/in/jamie-rivera",
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-17T13:30:00.000Z"),
  });

  assert.equal(vm.network.metrics.warmPaths, 2);
  assert.equal(vm.network.metrics.companies, 3);
  assert.equal(vm.network.metrics.dormant, 1);
  assert.deepEqual(
    vm.network.companies.map((company) => company.company),
    ["Aperture", "Initech", "Pied Piper"]
  );
  assert.equal(vm.network.companies[0].reuseState, "safe");
  assert.equal(vm.network.companies[1].reuseState, "caution");
  assert.equal(vm.network.companies[2].reuseState, "closed");
  assert.ok(vm.network.companies[0].contacts.some((contact) => contact.name === "Avery Recruiter"));
  assert.ok(vm.network.companies[0].contacts.some((contact) => contact.type === "Decision maker"));
  assert.ok(vm.network.companies[0].contacts.some((contact) => contact.name === "Sam Patel"));
  assert.ok(
    vm.network.companies[1].contacts.some(
      (contact) => contact.name === "Jordan Recruiter" && contact.type === "Recruiter"
    )
  );
  assert.ok(
    vm.network.companies[1].contacts.every((contact) => contact.name !== "Initech Candidate Portal")
  );
  assert.equal(vm.network.coverage.recruiters, 3);
  assert.equal(vm.network.coverage.hiringManagers, 2);
  assert.doesNotMatch(JSON.stringify(vm.network.companies), /PortalCo/);
  assert.ok(vm.network.sourcing.targets.some((target) => target.company === "PortalCo"));
  assert.equal(vm.network.sourcing.reviewLeads.length, 1);
  assert.equal(vm.network.sourcing.reviewLeads[0].company, "Initech");
  assert.equal(vm.network.sourcing.reviewLeads[0].name, "Jamie Rivera");
  assert.equal(vm.network.sourcing.reviewLeads[0].label, "Review lead");
});

test("Dashboard renderer fills the Network company map", () => {
  const tracker = {
    applications: [
      { id: "aperture", company: "Aperture", role: "Applied AI Engineer", status: "awaiting" },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "comm-aperture",
        applicationId: "aperture",
        company: "Aperture",
        role: "Applied AI Engineer",
        channel: "email",
        status: "waiting",
        summary: "Recruiter loop is warm.",
        nextActionDue: "2026-06-22",
        messages: [
          {
            direction: "inbound",
            from: "Avery Recruiter <anna@aperture.example.test>",
            to: ["Demo Candidate"],
            summary: "Aperture is interested.",
          },
        ],
      },
    ],
    relationshipLeads: [
      {
        id: "lead-aperture-dana",
        applicationId: "aperture",
        company: "Aperture",
        name: "Dana Lee",
        type: "Decision maker",
        title: "Engineering Manager",
        platform: "linkedin",
        status: "review",
        basis: "Possible hiring-team contact.",
      },
    ],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-17T13:30:00.000Z"),
  });
  const values = new Map();
  const grid = { innerHTML: "" };
  const coverage = { innerHTML: "" };
  const gaps = { innerHTML: "" };
  const leadReview = { innerHTML: "" };
  const sourcingTargets = { innerHTML: "" };
  const root = {
    querySelector(selector) {
      const statMatch = selector.match(/^\[data-network-stat="([^"]+)"\]$/);
      if (statMatch) {
        if (!values.has(statMatch[1])) values.set(statMatch[1], fakeElement());
        return values.get(statMatch[1]);
      }
      if (selector === "[data-network-company-grid]") return grid;
      if (selector === "[data-network-coverage]") return coverage;
      if (selector === "[data-network-gaps]") return gaps;
      if (selector === "[data-network-lead-review]") return leadReview;
      if (selector === "[data-network-sourcing-targets]") return sourcingTargets;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.equal(values.get("warmPaths").textContent, "1");
  assert.equal(values.get("companies").textContent, "1");
  assert.match(grid.innerHTML, /Aperture/);
  assert.match(grid.innerHTML, /Avery Recruiter/);
  assert.match(grid.innerHTML, /data-reuse-state="safe"/);
  assert.match(coverage.innerHTML, />1<\/strong><span>Recruiters<\/span>/);
  assert.match(gaps.innerHTML, /hiring-manager coverage|No urgent relationship gaps/);
  assert.match(leadReview.innerHTML, /Dana Lee/);
  assert.match(leadReview.innerHTML, /Review lead/);
  assert.match(sourcingTargets.innerHTML, /No unconnected active rows|Search contact path/);
});

test("Dashboard library snapshot summarizes evidence, stories, voice, and claim gaps", () => {
  const snapshot = buildLibrarySnapshot({
    evidence: {
      claims: [
        {
          id: "resume-003",
          claim:
            "Demo Docs Assistant — production AI assistant with Slack, web, ticketing, hybrid RAG, and tools.",
          metrics: ["~50% routine IT requests auto-resolved"],
          role_signals: ["agents", "applied ai", "rag"],
          allowed_wording: ["Built Demo Docs Assistant, the firm AI assistant."],
          forbidden_wording: ["Do not claim model training ownership."],
        },
        {
          id: "resume-005",
          claim: "APIZone — enterprise integration platform syncing SaaS systems.",
          metrics: [],
          role_signals: ["identity", "automation"],
          allowed_wording: ["Built APIZone for SaaS sync."],
        },
      ],
    },
    stories: {
      stories: [
        {
          id: "story-pearl",
          title: "Built Demo Docs Assistant 0→1",
          competencies: ["0-to-1 ownership"],
          role_signals: ["agents", "applied ai"],
          metrics: ["~50% routine IT requests auto-resolved"],
        },
      ],
    },
    honesty: {
      claims: {
        do_not_fabricate: ["Do not invent customer impact numbers."],
      },
    },
    writingStyleText: "Lead impact with the number, then the mechanism. Plain, confident, human.",
  });

  assert.equal(snapshot.metrics.claims, 2);
  assert.equal(snapshot.metrics.stories, 1);
  // Only claim-specific forbidden_wording is a genuine open gap. Settled honesty
  // policy (do_not_fabricate / do_not_claim) is NOT surfaced as "Needs confirmation"
  // here — it lives in Settings → Honesty Boundaries (ui-change-queue C2).
  assert.equal(snapshot.metrics.gaps, 1);
  assert.equal(snapshot.cards[0].kind, "story");
  assert.equal(snapshot.cards[0].title, "Built Demo Docs Assistant 0→1");
  assert.ok(snapshot.filters.some((filter) => filter.label === "Agents" && filter.count === 2));
  assert.ok(snapshot.cards.some((card) => card.kind === "story"));
  assert.ok(snapshot.cards.some((card) => card.kind === "voice"));
  assert.doesNotMatch(JSON.stringify(snapshot), /current_base|currentBase|123K/);
});

test("Dashboard adapter exposes data-backed Evidence Library status", () => {
  const tracker = { applications: [], sourced: [], sources: [], communications: [] };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-17T13:30:00.000Z"),
    library: {
      metrics: { claims: 2, stories: 1, gaps: 1 },
      index: [{ label: "Evidence bank", value: "2" }],
      filters: [{ label: "Agents", count: 2 }],
      cards: [
        {
          kind: "evidence",
          label: "Evidence bank",
          title: "Demo Docs Assistant",
          summary: "Production AI assistant.",
          tags: [{ label: "Agents", tone: "teal" }],
          note: "Use for applied AI roles.",
        },
      ],
      readiness: { proof: 1, stories: 1, voice: 1 },
      gaps: [{ tone: "coral", title: "Do not use yet", body: "Do not invent metrics." }],
      storyLanes: [{ tone: "teal", body: "0-to-1 applied AI systems." }],
    },
  });

  assert.equal(vm.library.metrics.claims, 2);
  assert.equal(vm.library.metrics.stories, 1);
  assert.equal(vm.library.cards[0].title, "Demo Docs Assistant");
  assert.equal(vm.library.filters[0].label, "Agents");
});

test("Dashboard renderer fills the Evidence Library", () => {
  const tracker = { applications: [], sourced: [], sources: [], communications: [] };
  const vm = buildDashboardViewModel(tracker, {
    library: {
      metrics: { claims: 2, stories: 1, gaps: 1 },
      index: [{ label: "Evidence bank", value: "2" }],
      filters: [{ label: "Agents", count: 2 }],
      cards: [
        {
          kind: "evidence",
          label: "Evidence bank",
          title: "Demo Docs Assistant",
          summary: "Production AI assistant.",
          tags: [{ label: "Agents", tone: "teal" }],
          note: "Use for applied AI roles.",
        },
      ],
      readiness: { proof: 1, stories: 1, voice: 1 },
      gaps: [{ tone: "coral", title: "Do not use yet", body: "Do not invent metrics." }],
      storyLanes: [{ tone: "teal", body: "0-to-1 applied AI systems." }],
    },
  });
  const values = new Map();
  const index = { innerHTML: "" };
  const filters = { innerHTML: "" };
  const cards = { innerHTML: "" };
  const ready = { innerHTML: "" };
  const gaps = { innerHTML: "", closest: () => null };
  const lanes = { innerHTML: "" };
  const root = {
    querySelector(selector) {
      const statMatch = selector.match(/^\[data-library-stat="([^"]+)"\]$/);
      if (statMatch) {
        if (!values.has(statMatch[1])) values.set(statMatch[1], fakeElement());
        return values.get(statMatch[1]);
      }
      if (selector === "[data-library-index]") return index;
      if (selector === "[data-library-filters]") return filters;
      if (selector === "[data-library-cards]") return cards;
      if (selector === "[data-library-ready]") return ready;
      if (selector === "[data-library-gaps]") return gaps;
      if (selector === "[data-library-story-lanes]") return lanes;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.equal(values.get("claims").textContent, "2");
  assert.equal(values.get("stories").textContent, "1");
  assert.match(cards.innerHTML, /Evidence bank/);
  assert.match(filters.innerHTML, /Agents/);
  assert.match(cards.innerHTML, /Demo Docs Assistant/);
  assert.match(cards.innerHTML, /Use for applied AI roles/);
  assert.match(gaps.innerHTML, /Do not invent metrics/);
  assert.match(filters.innerHTML, /data-library-tag="Agents"/);
});

test("Dashboard adapter exposes real Jobs command rail counts and next decision", () => {
  const tracker = {
    applications: [
      {
        id: "screen",
        company: "Screen Co",
        role: "FDE",
        status: "screen",
        fitScore: 86,
        base: "$220K",
      },
      {
        id: "applied-high",
        company: "High Co",
        role: "Applied AI Engineer",
        status: "awaiting",
        fitScore: 91,
        base: "$240K",
      },
      {
        id: "missing-comp",
        company: "Review Co",
        role: "Solutions Engineer",
        status: "awaiting",
        fitScore: 74,
      },
    ],
    sourced: [
      {
        id: "fresh",
        company: "Fresh Co",
        role: "AI Engineer",
        status: "prospect",
        fitScore: 82,
        fitBasis: "triage",
      },
    ],
    sources: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-17T13:30:00.000Z"),
  });

  assert.equal(vm.jobs.rail.screenPlus, 1);
  assert.equal(vm.jobs.rail.fresh, 1);
  assert.equal(vm.jobs.rail.highFit, 3);
  // Triage counts only un-decided (sourced-stage) roles — the applied missing-comp
  // application is pipeline, not triage backlog, so it does not inflate the count.
  assert.equal(vm.jobs.rail.manualReview, 1);
  assert.match(vm.jobs.rail.nextDecision.title, /Review/);
});

test("Dashboard adapter builds actionable Jobs row and drawer payloads", () => {
  const tracker = {
    applications: [
      {
        id: "reply",
        company: "Reply Co",
        role: "Applied AI Engineer",
        status: "awaiting",
        channel: "recruiter",
        fitScore: 86,
        base: "$230K",
        appliedAt: "2026-06-10",
        artifacts: {
          jd: "workspace/jobs/reply-co.md",
          resume: "workspace/tailored/reply-co-resume.pdf",
        },
      },
      {
        id: "stale",
        company: "Quiet Co",
        role: "Forward Deployed Engineer",
        status: "awaiting",
        channel: "board",
        fitScore: 78,
        base: "$210K",
        appliedAt: "2026-05-20",
        conversations: [{ who: "recruiter@quietco.com" }],
      },
      {
        id: "loop",
        company: "Loop Co",
        role: "Solutions Engineer",
        status: "interview",
        channel: "referral",
        fitScore: 82,
        base: "$220K",
        nextInterviewAt: "2026-06-20T17:00:00.000Z",
      },
      {
        id: "wait",
        company: "No Contact Co",
        role: "Applied AI Engineer",
        status: "awaiting",
        channel: "board",
        fitScore: 95,
        base: "$245K",
        appliedAt: "2026-06-16",
      },
      {
        id: "blocked-manual",
        company: "Blocked Co",
        role: "Forward Deployed Engineer",
        status: "blocked",
        statusNote: "blocked:captcha — human verification required",
        channel: "board",
        fitScore: 90,
        base: "$240K",
        nextAction: "Clear captcha manually and resume application",
        nextActionDue: "2026-06-18",
      },
    ],
    sourced: [
      {
        id: "missing-comp",
        company: "Missing Co",
        role: "Agent Engineer",
        status: "prospect",
        fitScore: 84,
        fitBasis: "triage",
      },
    ],
    sources: [],
    communications: [
      {
        id: "comm-reply",
        applicationId: "reply",
        company: "Reply Co",
        role: "Applied AI Engineer",
        status: "needs-reply",
        subject: "Interview availability",
        nextAction: "Reply with availability",
        nextActionDue: "2026-06-17",
        messages: [
          {
            direction: "inbound",
            at: "2026-06-16T15:00:00.000Z",
            subject: "Interview availability",
            summary: "Recruiter asked for availability.",
          },
        ],
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T13:30:00.000Z"),
  });
  const byId = new Map(vm.jobs.rows.map((row) => [row.id, row]));

  const reply = byId.get("reply");
  assert.equal(reply.actionState, "needs-action");
  assert.equal(reply.workstream, "respond");
  assert.equal(reply.needsAction, true);
  assert.equal(reply.action.label, "Reply");
  assert.equal(reply.action.dueText, "1d overdue");
  assert.match(reply.action.title, /Reply with availability/);
  assert.equal(reply.drawer.nextAction.title, reply.action.title);
  assert.equal(reply.drawer.nextAction.workstream, "respond");
  assert.equal(vm.jobs.details.reply.nextAction.title, reply.action.title);
  assert.ok(reply.drawer.artifacts.some((artifact) => artifact.kind === "Resume"));
  assert.ok(reply.drawer.emails.some((email) => email.subject === "Interview availability"));

  const stale = byId.get("stale");
  assert.equal(stale.actionState, "stale");
  assert.equal(stale.workstream, "plan");
  assert.equal(stale.stale, true);
  assert.match(stale.action.summary, /quiet/i);

  const loop = byId.get("loop");
  assert.equal(loop.actionState, "interview");
  assert.equal(loop.workstream, "prepare");
  assert.equal(loop.interviewPath, true);

  const wait = byId.get("wait");
  assert.equal(wait.actionState, "watch");
  assert.equal(wait.workstream, "watch");
  assert.equal(wait.action.label, "Wait");
  assert.match(wait.action.title, /Wait on No Contact Co/);
  assert.doesNotMatch(wait.action.title, /Prioritize/);
  assert.equal(wait.drawer.nextAction.title, wait.action.title);

  const blocked = byId.get("blocked-manual");
  // manual-apply is an ACTIVE stage (auto-apply failed, needs the human to finish) —
  // not a terminal/archived row. See the status-vocab reclassification.
  assert.equal(blocked.terminal, false);
  assert.equal(blocked.actionState, "needs-action");
  assert.equal(blocked.workstream, "review");
  assert.equal(blocked.action.label, "Manual apply");
  assert.match(blocked.action.title, /Clear captcha manually/);
  assert.equal(blocked.drawer.nextAction.title, blocked.action.title);
  assert.ok(
    vm.nextSteps.some(
      (item) => item.detailId === "blocked-manual" && item.actionLabel === "Manual apply"
    )
  );

  const missing = byId.get("missing-comp");
  assert.equal(missing.actionState, "missing-comp");
  assert.equal(missing.workstream, "review");
  assert.equal(missing.missingComp, true);
  assert.equal(missing.drawer.nextAction.label, "Comp");
});

test("Dashboard renderer exposes Jobs actionability hooks and drawer detail contract", () => {
  const tracker = {
    applications: [
      {
        id: "reply",
        company: "Reply Co",
        role: "Applied AI Engineer",
        status: "awaiting",
        channel: "recruiter",
        fitScore: 86,
        base: "$230K",
        appliedAt: "2026-06-10",
      },
    ],
    sourced: [
      {
        id: "missing-comp",
        company: "Missing Co",
        role: "Agent Engineer",
        status: "prospect",
        fitScore: 84,
        fitBasis: "triage",
      },
    ],
    sources: [],
    communications: [
      {
        id: "comm-reply",
        applicationId: "reply",
        company: "Reply Co",
        role: "Applied AI Engineer",
        status: "needs-reply",
        nextAction: "Reply with availability",
        nextActionDue: "2026-06-17",
        messages: [],
      },
    ],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T13:30:00.000Z"),
  });
  const table = { innerHTML: "" };
  const cards = { innerHTML: "" };
  const root = {
    querySelector(selector) {
      if (selector === "#jobs-explorer-tbody") return table;
      if (selector === "#jobs-card-grid") return cards;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  const previousDetails = globalThis.rolesterJobDetails;
  renderDashboardViewModel(vm, root);

  assert.match(table.innerHTML, /data-action-state="needs-action"/);
  assert.match(table.innerHTML, /data-workstream="respond"/);
  assert.match(table.innerHTML, /data-needs-action="1"/);
  assert.match(table.innerHTML, /data-missing-comp="1"/);
  assert.match(table.innerHTML, /class="jobs-action-cell jobs-action-cell--icon"/);
  assert.match(table.innerHTML, /class="jobs-action-icon/);
  assert.match(table.innerHTML, /aria-label="Reply:/);
  assert.match(
    table.innerHTML,
    /<tr data-jobs-row[\s\S]*?<td>\s*<div class="jobs-company-cell">[\s\S]*?<td class="jobs-cell-action">/
  );
  assert.doesNotMatch(table.innerHTML, /class="jobs-action-copy"/);
  assert.match(cards.innerHTML, /class="jobs-card-action"/);
  assert.match(cards.innerHTML, />Reply<\/span>/);
  assert.match(cards.innerHTML, /data-action-state="missing-comp"/);
  assert.match(table.innerHTML, /class="jobs-fit[^"]*" style="--jobs-fit-color:/);
  assert.match(cards.innerHTML, /class="jobs-fit[^"]*" style="--jobs-fit-color:/);
  assert.match(table.innerHTML, />86<\/span>/);
  assert.match(table.innerHTML, />~84<\/span>/);
  assert.doesNotMatch(table.innerHTML, /<span>~?\d+\s+fit<\/span>/);
  assert.doesNotMatch(cards.innerHTML, /<span>~?\d+\s+fit<\/span>/);
  assert.doesNotMatch(table.innerHTML, /class="jobs-fit[\s\S]*?<i>/);
  assert.doesNotMatch(cards.innerHTML, /class="jobs-fit[\s\S]*?<i>/);
  assert.equal(globalThis.rolesterJobDetails.reply.nextAction.label, "Reply");
  assert.equal(globalThis.rolesterJobDetails["missing-comp"].nextAction.label, "Comp");
  globalThis.rolesterJobDetails = previousDetails;
});

test("Dashboard renderer resolves company avatars through the cached logo route without a saved logo token", () => {
  const tracker = {
    applications: [
      {
        id: "logo-cache",
        company: "Reply Co",
        domain: "reply.co",
        role: "Applied AI Engineer",
        status: "awaiting",
        fitScore: 86,
        appliedAt: "2026-06-10",
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T13:30:00.000Z"),
  });
  const table = { innerHTML: "" };
  const root = {
    querySelector(selector) {
      if (selector === "#jobs-explorer-tbody") return table;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.match(table.innerHTML, /src="\/api\/logos\/img\?domain=reply\.co&amp;name=Reply%20Co"/);
  assert.doesNotMatch(table.innerHTML, /img\.logo\.dev/);
});

test("Dashboard shell exposes actionable Jobs filters and drawer next-action section", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /data-jobs-filter="action"/);
  assert.match(html, /data-jobs-rail-action="needs-action"/);
  assert.match(html, /data-jobs-rail-action="stale-applications"/);
  assert.match(html, /data-jobs-rail-action="missing-comp"/);
  assert.match(html, /id="drawer-action-section"/);
  assert.match(html, /id="drawer-action-label"/);
  assert.match(html, /id="drawer-action-title"/);
  assert.match(html, /id="drawer-action-summary"/);
  assert.match(html, /id="drawer-action-meta"/);
  assert.match(html, /item\.dataset\.actionState/);
  assert.match(html, /item\.dataset\.workstream/);
  assert.doesNotMatch(html, />Next move <span data-sort-indicator="action"/);
  assert.match(
    html,
    /<th><button type="button" data-jobs-sort="company">Company[\s\S]*data-jobs-sort="stage">Status[\s\S]*data-jobs-sort="action">Action/
  );
  assert.doesNotMatch(html, /id="drawer-fit-fill"/);
  assert.doesNotMatch(html, /id="drawer-fit-score">92 fit<\/span>/);
});

test("Dashboard shell uses a compact Jobs toolbar with removable active filter chips", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");
  const toolbarStart = html.indexOf(
    '<div class="jobs-toolbar" aria-label="Jobs search and filters">'
  );
  const toolbarEnd = html.indexOf('<div class="jobs-filter-row"', toolbarStart);
  const toolbar =
    toolbarStart >= 0 && toolbarEnd > toolbarStart ? html.slice(toolbarStart, toolbarEnd) : "";

  assert.match(html, /class="jobs-filter-row" data-jobs-active-filters hidden/);
  assert.match(html, /data-jobs-filter-remove=/);
  assert.match(html, /aria-label="Remove job filter"/);
  assert.match(html, /data-jobs-filter-clear hidden>Clear all<\/button>/);
  assert.doesNotMatch(toolbar, /jobs-search-label|<span>Search<\/span>/);
});

test("Dashboard adapter builds Strategy insights from outcomes by source role and fit", () => {
  const tracker = {
    applications: [
      {
        id: "recruiter-screen",
        company: "Warm Co",
        role: "Forward Deployed Engineer",
        status: "screen",
        channel: "recruiter",
        fitScore: 92,
        appliedAt: "2026-06-12",
      },
      {
        id: "recruiter-interview",
        company: "Warm Labs",
        role: "Forward Deployed AI Engineer",
        status: "interview",
        channel: "recruiter",
        fitScore: 88,
        appliedAt: "2026-06-10",
      },
      {
        id: "board-awaiting",
        company: "Board Co",
        role: "Applied AI Engineer",
        status: "awaiting",
        channel: "board",
        fitScore: 81,
        appliedAt: "2026-06-04",
      },
      {
        id: "board-rejected",
        company: "Board Reject",
        role: "Applied AI Engineer",
        status: "rejected",
        channel: "board",
        fitScore: 74,
        appliedAt: "2026-06-03",
      },
      {
        id: "portal-stale",
        company: "Stale Co",
        role: "AI Solutions Engineer",
        status: "awaiting",
        channel: "portal",
        fitScore: 69,
        appliedAt: "2026-05-25",
      },
      {
        id: "referral-final",
        company: "Referral Co",
        role: "Solutions Architect",
        status: "final",
        channel: "referral",
        fitScore: 86,
        appliedAt: "2026-06-08",
      },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "comm-recruiter",
        applicationId: "recruiter-screen",
        company: "Warm Co",
        status: "waiting",
        summary: "Recruiter thread is active.",
        lastInboundAt: "2026-06-13",
        messages: [{ direction: "inbound", at: "2026-06-13", summary: "Screen invite." }],
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T12:00:00.000Z"),
  });

  assert.equal(vm.strategy.metrics.topSource.label, "Recruiter");
  assert.equal(vm.strategy.metrics.topSource.rate, "100%");
  assert.equal(vm.strategy.metrics.bestLane.label, "Forward deployed");
  assert.equal(vm.strategy.metrics.bestLane.rate, "100%");
  assert.equal(vm.strategy.metrics.staleCount.value, 1);
  assert.deepEqual(
    vm.strategy.sources.map((row) => row.label),
    ["Recruiter", "Referral", "Job board", "Find Jobs surfacing"]
  );
  assert.equal(vm.strategy.sources[0].advanced, 2);
  assert.equal(vm.strategy.fitBands[0].label, "High fit");
  assert.match(vm.strategy.recommendation.title, /Double down on Recruiter/);
  assert.match(vm.strategy.stale[0].title, /Stale Co/);
  assert.match(vm.strategy.stale[0].meta, /24d quiet/);
});

test("Dashboard renderer fills the Strategy insights card", () => {
  const tracker = {
    applications: [
      {
        id: "warm",
        company: "Warm Co",
        role: "Forward Deployed Engineer",
        status: "screen",
        channel: "recruiter",
        fitScore: 92,
        appliedAt: "2026-06-12",
      },
      {
        id: "stale",
        company: "Stale Co",
        role: "AI Solutions Engineer",
        status: "awaiting",
        channel: "portal",
        fitScore: 69,
        appliedAt: "2026-05-25",
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T12:00:00.000Z"),
  });
  const values = new Map();
  const sources = { innerHTML: "" };
  const roles = { innerHTML: "" };
  const fits = { innerHTML: "" };
  const stale = { innerHTML: "" };
  const recommendation = { innerHTML: "" };
  const root = {
    querySelector(selector) {
      const metricMatch = selector.match(/^\[data-strategy-metric="([^"]+)"\]$/);
      if (metricMatch) {
        if (!values.has(metricMatch[1])) values.set(metricMatch[1], fakeElement());
        return values.get(metricMatch[1]);
      }
      if (selector === "[data-strategy-source-list]") return sources;
      if (selector === "[data-strategy-role-list]") return roles;
      if (selector === "[data-strategy-fit-list]") return fits;
      if (selector === "[data-strategy-stale-list]") return stale;
      if (selector === "[data-strategy-recommendation]") return recommendation;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.equal(values.get("topSource").textContent, "Recruiter");
  assert.equal(values.get("bestLane").textContent, "Forward deployed");
  assert.equal(values.get("staleCount").textContent, "1");
  assert.match(sources.innerHTML, /Recruiter/);
  assert.match(roles.innerHTML, /Forward deployed/);
  assert.match(fits.innerHTML, /High fit/);
  assert.match(stale.innerHTML, /Stale Co/);
  assert.match(recommendation.innerHTML, /Double down|Clean up quiet/);
  assert.match(recommendation.innerHTML, /data-strategy-recommendation-cta/);
  assert.doesNotMatch(recommendation.innerHTML, /strategy-summary-row/);
});

test("Dashboard adapter and renderer expose the next agent task", () => {
  const tracker = { applications: [], sourced: [], sources: [], communications: [] };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T12:00:00.000Z"),
    agentGuidance: {
      agentLed: true,
      nextSkill: "search-jobs",
      command: null,
      message: "Ask your agent to run search-jobs next for the first sweep.",
      reason: "Sources are configured, but none have run watermarks yet.",
      pipeline: ["setup-searches", "research-boards", "discover-companies", "search-jobs"],
    },
  });

  assert.equal(vm.agentGuidance.nextSkill, "search-jobs");
  assert.equal(vm.agentGuidance.title, "Next agent task");
  assert.equal(vm.agentGuidance.ctaLabel, "Run search-jobs");

  const card = fakeElement();
  const title = fakeElement();
  const message = fakeElement();
  const reason = fakeElement();
  const cta = fakeElement();
  const root = {
    querySelector(selector) {
      if (selector === "[data-agent-guidance]") return card;
      if (selector === "[data-agent-guidance-title]") return title;
      if (selector === "[data-agent-guidance-message]") return message;
      if (selector === "[data-agent-guidance-reason]") return reason;
      if (selector === "[data-agent-guidance-cta]") return cta;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.equal(card.dataset.nextSkill, "search-jobs");
  assert.equal(title.textContent, "Next agent task");
  assert.match(message.textContent, /run search-jobs next/);
  assert.match(reason.textContent, /none have run watermarks/);
  assert.equal(cta.textContent, "Run search-jobs");
});

test("Dashboard labels portal rows as ATS channel, not source discovery coverage", () => {
  const tracker = {
    applications: [
      {
        id: "portal",
        company: "Portal Co",
        role: "Applied AI Engineer",
        status: "screen",
        channel: "portal",
        fitScore: 88,
        base: "$230K",
        appliedAt: "2026-06-10",
      },
      {
        id: "board",
        company: "Board Co",
        role: "Solutions Engineer",
        status: "awaiting",
        channel: "board",
        fitScore: 78,
        base: "$210K",
        appliedAt: "2026-06-11",
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T12:00:00.000Z"),
  });
  const portalRow = vm.jobs.rows.find((row) => row.id === "portal");

  assert.equal(portalRow.sourceLabel, "ATS portal");
  assert.equal(portalRow.tooltip.source, "ATS portal");
  assert.equal(vm.strategy.sources[0].label, "Find Jobs surfacing");
  assert.notEqual(vm.strategy.sources[0].label, "Portal");
});

test("Dashboard shell labels portal filtering as ATS portal channel", async () => {
  const html = await readFile(new URL("src/core/tracker/dashboard-shell.html", root), "utf8");

  assert.match(html, /<option value="portal">ATS portal<\/option>/);
  assert.match(html, /portal:\s*'ATS portal'/);
});

test("Dashboard adapter builds Strategy time-in-stage and cadence nudges", () => {
  const tracker = {
    applications: [
      {
        id: "quiet",
        company: "Quiet Co",
        role: "Applied AI Engineer",
        status: "awaiting",
        channel: "portal",
        fitScore: 82,
        appliedAt: "2026-05-25",
        statusUpdatedAt: "2026-05-25",
        conversations: [{ who: "recruiter@quietco.com" }],
      },
      {
        id: "overdue",
        company: "Overdue Co",
        role: "Forward Deployed Engineer",
        status: "awaiting",
        channel: "recruiter",
        fitScore: 91,
        appliedAt: "2026-06-01",
        statusUpdatedAt: "2026-06-03",
        followUp: { dueAt: "2026-06-15" },
      },
      {
        id: "scheduled",
        company: "Scheduled Co",
        role: "Solutions Engineer",
        status: "screen",
        channel: "referral",
        fitScore: 87,
        appliedAt: "2026-06-10",
        statusUpdatedAt: "2026-06-12",
        followUp: { dueAt: "2026-06-22" },
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T12:00:00.000Z"),
  });

  assert.equal(vm.strategy.stageAges[0].title, "Quiet Co");
  assert.match(vm.strategy.stageAges[0].meta, /24d in Applied/);
  assert.equal(vm.strategy.stageAges[1].title, "Overdue Co");
  assert.match(vm.strategy.stageAges[1].meta, /15d in Applied/);
  assert.equal(vm.strategy.cadence[0].title, "Follow up with Overdue Co");
  assert.match(vm.strategy.cadence[0].meta, /3d overdue/);
  assert.equal(vm.strategy.cadence[0].tone, "overdue");
  assert.ok(vm.strategy.cadence.some((row) => row.title === "Set next touch for Quiet Co"));
  assert.equal(vm.strategy.summary, undefined);
  assert.match(vm.strategy.recommendation.title, /Handle the top items in Next Steps/);
  assert.match(vm.strategy.recommendation.summary, /1 follow-up due or overdue/);
  assert.equal(vm.strategy.recommendation.ctaLabel, "Open Next Steps");
  assert.equal(vm.strategy.recommendation.ctaAction, "actions");
});

test("Dashboard renderer fills Strategy time-in-stage and cadence rows", () => {
  const tracker = {
    applications: [
      {
        id: "quiet",
        company: "Quiet Co",
        role: "Applied AI Engineer",
        status: "awaiting",
        channel: "portal",
        fitScore: 82,
        appliedAt: "2026-05-25",
        statusUpdatedAt: "2026-05-25",
        conversations: [{ who: "recruiter@quietco.com" }],
      },
      {
        id: "overdue",
        company: "Overdue Co",
        role: "Forward Deployed Engineer",
        status: "awaiting",
        channel: "recruiter",
        fitScore: 91,
        appliedAt: "2026-06-01",
        statusUpdatedAt: "2026-06-03",
        followUp: { dueAt: "2026-06-15" },
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T12:00:00.000Z"),
  });
  const values = new Map();
  const sources = { innerHTML: "" };
  const roles = { innerHTML: "" };
  const fits = { innerHTML: "" };
  const stale = { innerHTML: "" };
  const stages = { innerHTML: "" };
  const cadence = { innerHTML: "" };
  const recommendation = { innerHTML: "" };
  const root = {
    querySelector(selector) {
      const metricMatch = selector.match(/^\[data-strategy-metric="([^"]+)"\]$/);
      if (metricMatch) {
        if (!values.has(metricMatch[1])) values.set(metricMatch[1], fakeElement());
        return values.get(metricMatch[1]);
      }
      if (selector === "[data-strategy-source-list]") return sources;
      if (selector === "[data-strategy-role-list]") return roles;
      if (selector === "[data-strategy-fit-list]") return fits;
      if (selector === "[data-strategy-stale-list]") return stale;
      if (selector === "[data-strategy-stage-list]") return stages;
      if (selector === "[data-strategy-cadence-list]") return cadence;
      if (selector === "[data-strategy-recommendation]") return recommendation;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.match(stages.innerHTML, /Quiet Co/);
  assert.match(stages.innerHTML, /24d in Applied/);
  assert.match(cadence.innerHTML, /Follow up with Overdue Co/);
  assert.match(cadence.innerHTML, /3d overdue/);
  assert.match(cadence.innerHTML, /Set next touch for Quiet Co/);
  assert.match(recommendation.innerHTML, /Handle the top items in Next Steps/);
  assert.match(recommendation.innerHTML, /data-strategy-recommendation-cta/);
  assert.doesNotMatch(recommendation.innerHTML, /Follow up with Overdue Co/);
});

test("Dashboard adapter builds outcome learning trends and a strategy review trigger", () => {
  const tracker = {
    applications: [
      {
        id: "advanced-recruiter",
        company: "Advanced Recruiter",
        role: "Forward Deployed Engineer",
        status: "screen",
        channel: "recruiter",
        fitScore: 92,
        appliedAt: "2026-06-15",
        statusUpdatedAt: "2026-06-18",
      },
      {
        id: "interview-recruiter",
        company: "Interview Recruiter",
        role: "Forward Deployed Engineer",
        status: "interview",
        channel: "recruiter",
        fitScore: 94,
        appliedAt: "2026-06-08",
        statusUpdatedAt: "2026-06-17",
      },
      {
        id: "rejected-board",
        company: "Rejected Board",
        role: "Applied AI Engineer",
        status: "rejected",
        channel: "board",
        fitScore: 81,
        appliedAt: "2026-06-03",
        statusUpdatedAt: "2026-06-12",
      },
      {
        id: "rejected-portal",
        company: "Rejected Portal",
        role: "AI Solutions Architect",
        status: "rejected",
        channel: "portal",
        fitScore: 76,
        appliedAt: "2026-06-01",
        statusUpdatedAt: "2026-06-11",
      },
      {
        id: "old-rejection",
        company: "Old Rejection",
        role: "Applied AI Engineer",
        status: "rejected",
        channel: "board",
        fitScore: 79,
        appliedAt: "2026-05-05",
        statusUpdatedAt: "2026-05-12",
      },
      {
        id: "old-advance",
        company: "Old Advance",
        role: "Solutions Engineer",
        status: "screen",
        channel: "referral",
        fitScore: 88,
        appliedAt: "2026-04-22",
        statusUpdatedAt: "2026-05-01",
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-19T12:00:00.000Z"),
  });

  assert.equal(vm.strategy.learning.windowLabel, "Last 30d");
  assert.deepEqual(
    vm.strategy.learning.trends.map((trend) => trend.id),
    ["applied", "advanced", "interviews", "rejected"]
  );
  assert.equal(vm.strategy.learning.trends[0].value, 4);
  assert.equal(vm.strategy.learning.trends[1].value, 2);
  assert.equal(vm.strategy.learning.trends[1].deltaLabel, "50%");
  assert.equal(vm.strategy.learning.trends[2].value, 1);
  assert.equal(vm.strategy.learning.trends[3].value, 2);
  assert.deepEqual(
    vm.strategy.learning.history.map((bucket) => bucket.label),
    ["Last 30d", "31-60d", "61-90d"]
  );
  assert.equal(vm.strategy.learning.history[0].advanced, 2);
  assert.equal(vm.strategy.learning.history[0].rejected, 2);
  assert.equal(vm.strategy.learning.history[1].advanced, 1);
  assert.equal(vm.strategy.learning.signals[0].label, "Recruiter");
  assert.match(vm.strategy.learning.signals[0].meta, /2 advanced/);
  assert.equal(vm.strategy.learning.reviewTrigger.ready, true);
  assert.equal(vm.strategy.learning.reviewTrigger.ctaLabel, "Run strategy review");
  assert.equal(vm.strategy.learning.reviewTrigger.ctaAction, "strategy-review");
  assert.match(
    vm.strategy.learning.reviewTrigger.summary,
    /4 applications, 2 advanced, 2 rejected/
  );
});

test("Dashboard renderer fills outcome learning trends and review handoff", () => {
  const tracker = {
    applications: [
      {
        id: "advanced",
        company: "Advanced Co",
        role: "Forward Deployed Engineer",
        status: "screen",
        channel: "recruiter",
        fitScore: 92,
        appliedAt: "2026-06-15",
        statusUpdatedAt: "2026-06-18",
      },
      {
        id: "interview",
        company: "Interview Co",
        role: "Forward Deployed Engineer",
        status: "interview",
        channel: "recruiter",
        fitScore: 94,
        appliedAt: "2026-06-08",
        statusUpdatedAt: "2026-06-17",
      },
      {
        id: "rejected",
        company: "Rejected Co",
        role: "Applied AI Engineer",
        status: "rejected",
        channel: "board",
        fitScore: 81,
        appliedAt: "2026-06-03",
        statusUpdatedAt: "2026-06-12",
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-19T12:00:00.000Z"),
  });
  const trends = { innerHTML: "" };
  const history = { innerHTML: "" };
  const signals = { innerHTML: "" };
  const review = { innerHTML: "" };
  const root = {
    querySelector(selector) {
      if (selector === "[data-strategy-trend-list]") return trends;
      if (selector === "[data-strategy-history-list]") return history;
      if (selector === "[data-strategy-learning-signals]") return signals;
      if (selector === "[data-strategy-review-trigger]") return review;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.match(trends.innerHTML, /Applied/);
  assert.match(trends.innerHTML, /Advanced/);
  assert.match(trends.innerHTML, /Interviews/);
  assert.match(trends.innerHTML, /Rejected/);
  assert.match(history.innerHTML, /Last 30d/);
  assert.match(history.innerHTML, /31-60d/);
  assert.match(signals.innerHTML, /Recruiter/);
  assert.match(review.innerHTML, /Enough signal to review strategy/);
  assert.match(review.innerHTML, /Run strategy review/);
  assert.match(review.innerHTML, /href="#strategy-review"/);
});

test("Dashboard focus card prioritizes the next interview dossier when one is upcoming", () => {
  const tracker = {
    applications: [
      {
        id: "app-interview",
        company: "Aperture Science",
        role: "Forward Deployed Engineer",
        status: "interview",
        fitScore: 91,
        nextInterviewAt: "2026-06-17T14:00:00.000Z",
        artifacts: {
          interviewDossier: {
            markdown: "# Aperture Science dossier",
            title: "Aperture Science — Forward Deployed Engineer",
            round: "Technical loop",
            generatedAt: "2026-06-16T12:00:00.000Z",
          },
        },
        followUp: {
          kind: "interview-confirmation",
          dueAt: "2026-06-17T14:00:00.000Z",
        },
      },
    ],
    sourced: [
      { id: "src-1", company: "Massive Dynamic", role: "Applied AI Engineer", fitScore: 93 },
    ],
    sources: [],
    communications: [
      {
        id: "comm-1",
        status: "needs-reply",
        company: "Other Co",
        nextAction: "Reply with availability",
        nextActionDue: "2026-06-17T12:00:00.000Z",
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-17T10:00:00.000Z"),
  });

  assert.equal(vm.focus.kind, "interview");
  assert.equal(vm.focus.company, "Aperture Science");
  assert.equal(vm.focus.detailId, "app-interview");
  assert.match(vm.focus.title, /Interview dossier/i);
  assert.match(vm.focus.cta, /dossier/i);
});

test("Dashboard focus card falls back to urgent action when no interview is upcoming", () => {
  const tracker = {
    applications: [],
    sourced: [
      { id: "src-1", company: "Massive Dynamic", role: "Applied AI Engineer", fitScore: 93 },
    ],
    sources: [],
    communications: [
      {
        id: "comm-1",
        status: "needs-reply",
        company: "Aperture Science",
        nextAction: "Reply with availability",
        nextActionDue: "2026-06-17T12:00:00.000Z",
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-17T10:00:00.000Z"),
  });

  assert.equal(vm.focus.kind, "action");
  assert.equal(vm.focus.company, "Aperture Science");
  assert.equal(vm.focus.title, "Reply with availability");
  assert.equal(vm.focus.cta, "Handle next action");
});

test("Dashboard renderer fills the adaptive focus card", () => {
  const tracker = {
    applications: [
      {
        id: "aperture",
        company: "Aperture",
        role: "Forward Deployed Engineer",
        status: "interview",
        nextInterviewAt: "2026-06-17T14:00:00.000Z",
        followUp: { kind: "interview-confirmation", dueAt: "2026-06-17T14:00:00.000Z" },
        artifacts: {
          interviewDossier: {
            markdown: "# Aperture dossier",
            title: "Aperture — Forward Deployed Engineer",
          },
        },
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-17T10:00:00.000Z"),
  });
  const focusCard = {
    innerHTML: "",
    dataset: {},
    setAttribute(name, value) {
      this[name] = String(value);
    },
  };
  const root = {
    querySelector(selector) {
      return selector === "#focus-card-body" ? focusCard : null;
    },
  };

  renderDashboardViewModel(vm, root);

  assert.equal(focusCard.dataset.focusKind, "interview");
  assert.equal(focusCard.dataset.detailId, "aperture");
  assert.match(focusCard.innerHTML, /Interview dossier/i);
  assert.match(focusCard.innerHTML, /Aperture/);
  assert.match(focusCard.innerHTML, /Open dossier/);
});

test("Dashboard adapter exposes usage and application mode status", () => {
  const tracker = { applications: [], sourced: [], sources: [], communications: [] };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
    modes: {
      configured: true,
      valid: true,
      usageMode: "lean",
      applicationMode: "high-volume",
    },
  });

  assert.equal(vm.modes.source, "configured");
  assert.equal(vm.modes.usage.label, "Lean");
  assert.equal(vm.modes.usage.tone, "constraint");
  assert.equal(vm.modes.application.label, "High-volume");
  assert.equal(vm.modes.application.tone, "expanded");
});

test("Dashboard adapter exposes safe read-only settings without current compensation", () => {
  const tracker = { applications: [], sourced: [], sources: [], communications: [] };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
    settings: {
      profile: {
        candidate: "Demo Candidate",
        headline: "AI-native builder",
        location: "Remote / hybrid · Example City, ST",
        minimumBase: "$200K",
        targetBase: "$240K",
        currentBase: "$123K",
      },
      automation: {
        sessionProvider: "Browser extension",
        enabledCapabilities: ["Status polling", "Authenticated search"],
      },
      files: ["candidate/profile.yml", "candidate/targeting.yml"],
    },
  });

  assert.equal(vm.settings.profile.candidate, "Demo Candidate");
  assert.equal(vm.settings.profile.minimumBase, "$200K");
  assert.equal(vm.settings.profile.targetBase, "$240K");
  assert.equal(vm.settings.automation.sessionProvider, "Browser extension");
  assert.deepEqual(vm.settings.automation.enabledCapabilities, [
    "Status polling",
    "Authenticated search",
  ]);
  assert.equal(vm.settings.profile.currentBase, undefined);
  assert.doesNotMatch(JSON.stringify(vm.settings), /123K|currentBase|current_base/);
});

test("Dashboard renderer fills the mode chips", () => {
  const tracker = { applications: [], sourced: [], sources: [], communications: [] };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
    modes: {
      configured: false,
      valid: true,
      usageMode: "standard",
      applicationMode: "selective",
    },
  });

  const usageChip = fakeElement();
  const usageValue = fakeElement();
  const appChip = fakeElement();
  const appValue = fakeElement();
  const secondaryUsageChip = fakeElement();
  const secondaryUsageValue = fakeElement();
  const secondaryAppChip = fakeElement();
  const secondaryAppValue = fakeElement();
  const matches = {
    '[data-mode-chip="usage"]': [usageChip, secondaryUsageChip],
    '[data-mode-value="usage"]': [usageValue, secondaryUsageValue],
    '[data-mode-chip="application"]': [appChip, secondaryAppChip],
    '[data-mode-value="application"]': [appValue, secondaryAppValue],
  };
  const root = {
    querySelector(selector) {
      return matches[selector]?.[0] || null;
    },
    querySelectorAll(selector) {
      return matches[selector] || [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.equal(usageValue.textContent, "Standard");
  assert.equal(usageChip.dataset.modeTone, "default");
  assert.equal(appValue.textContent, "Selective");
  assert.equal(appChip.dataset.modeTone, "constraint");
  assert.match(appChip.getAttribute("aria-label"), /^apply mode: Selective\./);
  assert.match(appChip.title, /medium-fit roles/i);
  assert.equal(secondaryUsageValue.textContent, "Standard");
  assert.equal(secondaryUsageChip.dataset.modeTone, "default");
  assert.equal(secondaryAppValue.textContent, "Selective");
  assert.equal(secondaryAppChip.dataset.modeTone, "constraint");
});

test("Dashboard renderer fills the read-only settings drawer", () => {
  const tracker = { applications: [], sourced: [], sources: [], communications: [] };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
    settings: {
      profile: {
        candidate: "Demo Candidate",
        headline: "AI-native builder",
        location: "Remote / hybrid · Example City, ST",
        minimumBase: "$200K",
        targetBase: "$240K",
      },
      automation: {
        sessionProvider: "Browser extension",
        enabledCapabilities: ["Status polling", "Messaging"],
      },
      files: ["candidate/profile.yml", "candidate/honesty.yml"],
    },
  });

  const values = new Map();
  const filesList = { innerHTML: "" };
  const capabilitiesList = { innerHTML: "" };
  const root = {
    querySelector(selector) {
      if (selector === "[data-settings-files]") return filesList;
      if (selector === "[data-settings-capabilities]") return capabilitiesList;
      const valueMatch = selector.match(/^\[data-settings-value="([^"]+)"\]$/);
      if (valueMatch) {
        if (!values.has(valueMatch[1])) values.set(valueMatch[1], fakeElement());
        return values.get(valueMatch[1]);
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, root);

  assert.equal(values.get("candidate").textContent, "Demo Candidate");
  assert.equal(values.get("headline").textContent, "AI-native builder");
  assert.equal(values.get("location").textContent, "Remote / hybrid · Example City, ST");
  assert.equal(values.get("minimumBase").textContent, "$200K");
  assert.equal(values.get("targetBase").textContent, "$240K");
  assert.equal(values.get("sessionProvider").textContent, "Browser extension");
  assert.match(filesList.innerHTML, /candidate\/profile\.yml/);
  assert.match(capabilitiesList.innerHTML, /Status polling/);
  assert.doesNotMatch(filesList.innerHTML + capabilitiesList.innerHTML, /current_base|123K/);
});

test("Dashboard hydration loads mode, settings, and library state beside tracker data", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/tracker.json")) {
      return {
        ok: true,
        json: async () => ({ applications: [], sourced: [], sources: [], communications: [] }),
      };
    }
    if (String(url).endsWith("/activity.jsonl")) {
      return { ok: true, text: async () => "" };
    }
    if (String(url).endsWith("/modes.json")) {
      return {
        ok: true,
        json: async () => ({
          configured: true,
          valid: true,
          usageMode: "lean",
          applicationMode: "selective",
        }),
      };
    }
    if (String(url).endsWith("/settings.json")) {
      return {
        ok: true,
        json: async () => ({
          profile: {
            candidate: "Demo Candidate",
            minimumBase: "$200K",
            currentBase: "$123K",
          },
        }),
      };
    }
    if (String(url).endsWith("/library.json")) {
      return {
        ok: true,
        json: async () => ({
          metrics: { claims: 2, stories: 1, gaps: 1 },
          cards: [
            { kind: "evidence", title: "Demo Docs Assistant", summary: "Production AI assistant." },
          ],
        }),
      };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  };

  try {
    const vm = await hydrateDashboardFromTracker({
      root: { querySelector: () => null },
      source: "/workspace/tracker.json",
      now: new Date("2026-06-15T13:30:00.000Z"),
    });

    assert.ok(calls.includes("/workspace/modes.json"));
    assert.ok(calls.includes("/workspace/settings.json"));
    assert.ok(calls.includes("/workspace/library.json"));
    assert.equal(vm.modes.usage.label, "Lean");
    assert.equal(vm.modes.application.label, "Selective");
    assert.equal(vm.settings.profile.candidate, "Demo Candidate");
    assert.equal(vm.settings.profile.currentBase, undefined);
    assert.equal(vm.library.metrics.claims, 2);
    assert.equal(vm.library.cards[0].title, "Demo Docs Assistant");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Dashboard hydration falls back to settings embedded in modes state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/tracker.json")) {
      return {
        ok: true,
        json: async () => ({ applications: [], sourced: [], sources: [], communications: [] }),
      };
    }
    if (String(url).endsWith("/activity.jsonl")) {
      return { ok: true, text: async () => "" };
    }
    if (String(url).endsWith("/modes.json")) {
      return {
        ok: true,
        json: async () => ({
          configured: true,
          valid: true,
          usageMode: "standard",
          applicationMode: "balanced",
          settings: {
            profile: {
              candidate: "Demo Candidate",
              minimumBase: "$200K",
            },
          },
        }),
      };
    }
    if (String(url).endsWith("/settings.json")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (String(url).endsWith("/library.json")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  };

  try {
    const vm = await hydrateDashboardFromTracker({
      root: { querySelector: () => null },
      source: "/workspace/tracker.json",
      now: new Date("2026-06-15T13:30:00.000Z"),
    });

    assert.equal(vm.settings.profile.candidate, "Demo Candidate");
    assert.equal(vm.settings.profile.minimumBase, "$200K");
    assert.equal(vm.library.metrics.claims, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Dashboard Sankey starts source flows close to the left edge", () => {
  const tracker = {
    applications: [
      {
        id: "direct-awaiting",
        company: "Direct Awaiting",
        role: "Applied AI Engineer",
        status: "awaiting",
        channel: "board",
        fitScore: 86,
      },
      {
        id: "direct-screen",
        company: "Direct Screen",
        role: "Applied AI Engineer",
        status: "screen",
        channel: "board",
        fitScore: 91,
      },
      {
        id: "recruiter-screen",
        company: "Recruiter Screen",
        role: "Forward Deployed Engineer",
        status: "interview",
        channel: "recruiter",
        fitScore: 93,
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
  });
  const sankeySlot = { innerHTML: "" };
  const rootStub = {
    querySelector(selector) {
      return selector === "#jobs-sankey-slot" ? sankeySlot : null;
    },
    querySelectorAll() {
      return [];
    },
  };

  renderDashboardViewModel(vm, rootStub);

  assert.match(sankeySlot.innerHTML, /<rect x="220"[^>]+fill="#8E8B84"/);
  assert.match(sankeySlot.innerHTML, /d="M 225 /);
  assert.match(
    sankeySlot.innerHTML,
    /<text class="jobs-sankey-node-label jobs-sankey-node-label--source" x="212"[^>]+text-anchor="end">Direct apply/
  );
  assert.match(
    sankeySlot.innerHTML,
    /<text class="jobs-sankey-node-label jobs-sankey-node-label--source" x="212"[^>]+text-anchor="end">Recruiter sourced/
  );
  assert.doesNotMatch(sankeySlot.innerHTML, /x="124"[^>]+Recruiter sourced/);
  assert.doesNotMatch(sankeySlot.innerHTML, /<rect x="180"[^>]+fill="#8d7f73"/);
});

test("Dashboard adapter archives cut sourced rows but surfaces manual-apply as active", () => {
  const tracker = {
    applications: [],
    sourced: [
      { id: "live", company: "Live Co", role: "FDE", status: "prospect" },
      { id: "blocked", company: "Blocked Co", role: "FDE", status: "manual blocked" },
      { id: "cut", company: "Cut Co", role: "FDE", status: "cut" },
    ],
    sources: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
  });

  // cut stays archived (terminal); manual-blocked is now surfaced as an active
  // manual-apply row, so 2 are visible and only 1 (cut) is terminal.
  assert.equal(vm.jobs.totalCount, 3);
  assert.equal(vm.jobs.visibleCount, 2);
  assert.equal(vm.jobs.terminalCount, 1);
  const byId = new Map(vm.jobs.rows.map((r) => [r.id, r]));
  assert.equal(byId.get("cut").terminal, true);
  assert.equal(byId.get("blocked").terminal, false);
  assert.equal(byId.get("live").terminal, false);
});

test("Dashboard sourcebuckets count only true recruiter-sourced jobs", () => {
  const tracker = {
    applications: [
      {
        id: "direct",
        company: "Direct Co",
        role: "Applied AI Engineer",
        status: "awaiting",
        channel: "board",
        fitScore: 82,
        note: "Hold compensation at the target if a recruiter screen happens later. Confirmation page said success.",
      },
      {
        id: "recruiter-contacted",
        company: "Recruiter Co",
        role: "Forward Deployed Engineer",
        status: "interview",
        channel: "board",
        fitScore: 88,
        note: "Recruiter screen completed and next step is pending.",
      },
      {
        id: "recruiter-sourced",
        company: "Sourced Co",
        role: "AI Solutions Engineer",
        status: "interview",
        channel: "recruiter",
        fitScore: 86,
      },
      {
        id: "portal",
        company: "Portal Co",
        role: "AI Solutions Engineer",
        status: "interview",
        channel: "portal",
        fitScore: 84,
      },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "comm-recruiter-contacted",
        applicationId: "recruiter-contacted",
        company: "Recruiter Co",
        role: "Forward Deployed Engineer",
        channel: "email",
        status: "waiting",
        summary: "Recruiter reached out after the application.",
        messages: [
          {
            direction: "inbound",
            summary: "Recruiter sent an initial chat follow-up.",
          },
        ],
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
  });

  const recruiterContactedRow = vm.jobs.rows.find((row) => row.id === "recruiter-contacted");
  assert.equal(recruiterContactedRow.channel, "board");
  assert.equal(recruiterContactedRow.sourceBucket, "src-cold");
  assert.equal(recruiterContactedRow.sourceLabel, "Job board");

  const recruiterSourcedRow = vm.jobs.rows.find((row) => row.id === "recruiter-sourced");
  assert.equal(recruiterSourcedRow.channel, "recruiter");
  assert.equal(recruiterSourcedRow.sourceBucket, "src-recruiter");
  assert.equal(recruiterSourcedRow.sourceLabel, "Recruiter");

  const directRow = vm.jobs.rows.find((row) => row.id === "direct");
  assert.equal(directRow.sourceBucket, "src-cold");

  const sourceNodes = new Map(
    vm.jobs.sankey.nodes.filter((node) => node.col === 0).map((node) => [node.id, node])
  );
  assert.equal(sourceNodes.get("src-recruiter").label, "Recruiter sourced");
  assert.equal(sourceNodes.get("src-recruiter").count, 1);
  assert.equal(sourceNodes.get("src-cold").label, "Direct apply");
  assert.equal(sourceNodes.get("src-cold").count, 3);
});

test("Dashboard nextsteps use action labels and open the related job drawer", () => {
  const tracker = {
    applications: [
      {
        id: "aperture",
        company: "Aperture",
        role: "Applied AI Engineer",
        status: "interview",
        channel: "board",
        fitScore: 91,
      },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "comm-aperture",
        applicationId: "aperture",
        company: "Aperture",
        role: "Applied AI Engineer",
        channel: "email",
        status: "needs-reply",
        summary: "Hiring-manager interview scheduled.",
        nextAction: "Attend Aperture hiring-manager interview",
        nextActionDue: "2026-06-16",
        messages: [
          {
            direction: "inbound",
            summary: "Calendar invitation received for the Aperture interview.",
          },
        ],
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
  });
  const step = vm.nextSteps[0];

  assert.equal(step.title, "Attend Aperture hiring-manager interview");
  assert.equal(step.detailId, "aperture");
  assert.equal(step.actionLabel, "Interview");
  assert.equal(step.actionToneClass, "text-on-tertiary-container");
  assert.equal(step.supportingText, "Aperture · tomorrow");

  const nextStepsEl = { innerHTML: "" };
  const fakeRoot = {
    querySelector(selector) {
      return selector === "#next-steps-list" ? nextStepsEl : null;
    },
  };

  renderDashboardViewModel(vm, fakeRoot);

  assert.match(nextStepsEl.innerHTML, /data-next-step-item/);
  assert.match(nextStepsEl.innerHTML, /data-detail-id="aperture"/);
  assert.match(nextStepsEl.innerHTML, /font-bold text-primary/);
  assert.match(nextStepsEl.innerHTML, />Interview<\/span>/);
  assert.doesNotMatch(nextStepsEl.innerHTML, />Tomorrow<\/span>/);
  assert.doesNotMatch(nextStepsEl.innerHTML, /ui-badge/);
});
