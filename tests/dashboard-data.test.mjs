import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildDashboardViewModel } from "../src/core/tracker/dashboard-data.js";
import { buildLibrarySnapshot } from "../src/core/tracker/library-snapshot.mjs";

const root = new URL("..", import.meta.url);

test("Dashboard adapterbuilds live UI state from tracker JSON", async () => {
  const tracker = JSON.parse(
    await readFile(new URL("examples/demo-workspace/tracker.json", root), "utf8")
  );
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
  });

  assert.equal(vm.stats.inPlay, 22);
  assert.equal(vm.stats.responseRate, 32);
  assert.equal(vm.stats.interviews, 3);
  assert.equal(vm.jobs.totalCount, tracker.applications.length + tracker.sourced.length);
  assert.equal(vm.jobs.visibleCount, 31);
  assert.ok(vm.calendar.weeks[0].days.some((day) => day.events.length > 0));
  assert.ok(vm.latestRoles.some((role) => role.company === "Aperture Science"));
  assert.ok(vm.jobs.sankey.nodes.length > 0);
});

test("Jobs Sankey uses canonical semantic stages and never numbered rounds", () => {
  const vm = buildDashboardViewModel(
    {
      applications: [
        {
          id: "technical-active",
          company: "Northstar",
          role: "Platform Engineer",
          status: "interview",
          channel: "board",
          conversations: [{ kind: "technical", date: "2026-08-10" }],
        },
        {
          id: "hm-rejected",
          company: "Juniper",
          role: "Backend Engineer",
          status: "rejected",
          channel: "recruiter",
          conversations: [{ kind: "hiring manager", date: "2026-08-11" }],
        },
        {
          id: "awaiting",
          company: "Aperture",
          role: "Staff Engineer",
          status: "applied",
          channel: "board",
        },
      ],
      sourced: [],
      sources: [],
      communications: [],
    },
    { now: new Date("2026-08-14T12:00:00.000Z") }
  );

  const nodes = new Map(vm.jobs.sankey.nodes.map((node) => [node.id, node]));
  assert.equal(nodes.get("technical")?.label, "Technical");
  assert.equal(nodes.get("technical")?.filter, "reached-technical");
  assert.equal(nodes.get("hiring-manager")?.label, "Hiring manager");
  assert.equal(nodes.get("hiring-manager")?.filter, "reached-hiring-manager");
  assert.equal(
    [...nodes.keys()].some((id) => /^round-\d+$/.test(id)),
    false
  );
  assert.equal(
    vm.jobs.sankey.links.some((link) => link.from === "hiring-manager" && link.to === "rejected"),
    true
  );
});

test("Dashboard adapter excludes reviewed holds from application counts", () => {
  const vm = buildDashboardViewModel(
    {
      meta: {},
      applications: [
        {
          id: "hold-1",
          company: "Hold One",
          role: "Engineer",
          status: "reviewed-hold",
        },
        {
          id: "hold-2",
          company: "Hold Two",
          role: "Engineer",
          status: "reviewed-hold",
        },
        {
          id: "applied-1",
          company: "Active",
          role: "Engineer",
          status: "applied",
        },
      ],
      sourced: [],
      sources: [],
      communications: [],
    },
    { now: new Date("2026-06-15T13:30:00.000Z") }
  );

  assert.equal(vm.stats.applied, 1);
  assert.equal(vm.stats.inPlay, 1);
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

  // metrics.thisWeek is forward-looking (today+2..today+6, see buildCalendar in
  // dashboard-data.js), not the Mon-Fri `currentWeek` grid below: 06-17 is
  // yesterday (past) and both 06-18 items are today, so only the 06-22 followUp
  // falls in the forward window. currentWeek.events (Jun 15-19) still holds all 3.
  assert.equal(vm.calendar.metrics.thisWeek, 1);
  assert.equal(vm.calendar.weeks[0].events.length, 3);
  assert.equal(vm.calendar.metrics.interviews, 1);
  assert.equal(vm.calendar.metrics.dueToday, 2);
  assert.equal(vm.calendar.currentWeekIndex, 0);
  assert.equal(vm.calendar.weeks[0].label, "Jun 15-19");
  assert.match(vm.calendar.weeks[0].export.filename, /careerrat-calendar-jun-15-19\.ics/);
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

// 2026-08-23 UX audit: on a Sunday, the Mon-Fri `currentWeek` grid is entirely
// in the past, so a hero stat built from it undercounts (or reads zero) next
// to the agenda's forward-looking "This week" section, which is a
// self-contradiction a user reads on the same screen. metrics.thisWeek must
// stay forward-looking (today+2..today+6) regardless of which weekday "today"
// falls on.
test("Calendar's This Week hero stat stays forward-looking on a Sunday, not the past Mon-Fri week", () => {
  const tracker = {
    applications: [
      {
        id: "initech",
        company: "Initech",
        role: "Staff Engineer",
        status: "interview",
        channel: "portal",
        fitScore: 80,
        appliedAt: "2026-06-01",
        nextInterviewAt: "2026-06-24T15:00:00.000Z",
      },
      {
        id: "globodyne",
        company: "Globodyne",
        role: "Platform Engineer",
        status: "awaiting",
        channel: "portal",
        fitScore: 78,
        appliedAt: "2026-06-03",
        followUp: { kind: "app-nudge", dueAt: "2026-06-26" },
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-21T12:00:00.000Z"),
  });

  assert.equal(vm.calendar.todayIso, "2026-06-21");
  // The ISO Mon-Fri week (Jun 15-19) is entirely in the past on this Sunday.
  assert.equal(vm.calendar.weeks[0].label, "Jun 15-19");
  assert.equal(vm.calendar.weeks[0].events.length, 0);
  // The two forward-looking items (Jun 24 interview, Jun 26 follow-up) land in
  // today+2..today+6, so the hero stat reads 2, matching what the agenda's
  // forward "This week" bucket would show instead of the stale, contradicting 0.
  assert.equal(vm.calendar.metrics.thisWeek, 2);
  // calendar.thisWeek.events is the canonical, uncapped collection
  // CalendarPage's agenda pool also reads (collectCalendarEvents) so its
  // rendered "This week" row count can never drift from this hero number —
  // see CalendarPage.test.jsx for the full cap-overflow/weekend-event
  // regression case.
  assert.equal(vm.calendar.thisWeek.events.length, vm.calendar.metrics.thisWeek);
  assert.deepEqual(vm.calendar.thisWeek.events.map((event) => event.detailId).sort(), [
    "globodyne",
    "initech",
  ]);
});

test("Calendar counts and names a scheduled round inside the rolling 14-day horizon", () => {
  const tracker = {
    applications: [
      {
        id: "temporal-staff-platform",
        company: "Temporal",
        role: "Staff Software Engineer, Platform",
        status: "interview",
        interviewAt: "2026-08-20T18:00:00.000Z",
        interviewNote: "Hiring manager — Thu Aug 20 2:00 PM ET with Avery",
        conversations: [
          {
            id: "temporal-hiring-manager",
            kind: "hiring manager",
            stage: "hiring-manager",
            outcome: "pending",
            date: "2026-08-20T18:00:00.000Z",
            who: "Avery",
          },
        ],
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-08-09T16:00:00.000Z"),
  });
  const event = vm.calendar.upcoming.events.find(
    (item) => item.detailId === "temporal-staff-platform"
  );

  assert.equal(vm.calendar.metrics.interviews, 1);
  assert.equal(event?.title, "Temporal hiring manager");
  assert.equal(event?.iso, "2026-08-20");
});

test("buildCalendarSync maps each providerStatus shape to its status label", () => {
  const tracker = {
    applications: [],
    sourced: [],
    sources: [],
    communications: [],
  };

  const withMap = buildDashboardViewModel(tracker, {
    now: new Date("2026-08-15T12:00:00.000Z"),
    calendarProviderStatus: {
      google_calendar: { allowed: true, enabled: true, consent: true },
      outlook_calendar: { allowed: false, enabled: true, consent: false },
      apple_calendar: { allowed: false, enabled: false, consent: true },
      // automation_tools intentionally absent from the map.
    },
  });
  const statusByKey = Object.fromEntries(
    withMap.calendar.sync.providers.map((provider) => [provider.key, provider.status])
  );
  assert.equal(statusByKey.google_calendar, "Ready", "allowed:true reads Ready");
  assert.equal(
    statusByKey.outlook_calendar,
    "Needs setup",
    "allowed:false with enabled:true reads Needs setup"
  );
  assert.equal(
    statusByKey.apple_calendar,
    "Needs setup",
    "allowed:false with consent:true reads Needs setup"
  );
  assert.equal(
    statusByKey.automation_tools,
    "Consent gated",
    "a provider missing from the map reads Consent gated"
  );

  const allOff = buildDashboardViewModel(tracker, {
    now: new Date("2026-08-15T12:00:00.000Z"),
    calendarProviderStatus: {
      apple_calendar: { allowed: false, enabled: false, consent: false },
    },
  });
  const appleOff = allOff.calendar.sync.providers.find((p) => p.key === "apple_calendar");
  assert.equal(appleOff.status, "Off", "neither enabled nor consent reads Off");

  const noProviderStatus = buildDashboardViewModel(tracker, {
    now: new Date("2026-08-15T12:00:00.000Z"),
  });
  for (const provider of noProviderStatus.calendar.sync.providers) {
    assert.equal(
      provider.status,
      "Consent gated",
      "an absent providerStatus map reads Consent gated"
    );
  }
});

test("normalizeCalendarWrite passes through an explicit manual provenance and defaults every other value to automated", () => {
  const tracker = {
    applications: [],
    sourced: [],
    sources: [],
    communications: [],
    calendarWrites: [
      {
        id: "cal-write-manual",
        provider: "apple_calendar",
        title: "Globex onsite",
        wroteAt: "2026-08-14T10:00:00.000Z",
        eventIso: "2026-08-20",
        provenance: "manual",
      },
      {
        id: "cal-write-legacy",
        provider: "google_calendar",
        title: "Initech screen",
        wroteAt: "2026-08-13T10:00:00.000Z",
        eventIso: "2026-08-19",
        // no provenance field at all — a legacy row from before it existed.
      },
      {
        id: "cal-write-bogus",
        provider: "outlook_calendar",
        title: "Hooli follow-up",
        wroteAt: "2026-08-12T10:00:00.000Z",
        eventIso: "2026-08-18",
        provenance: "not-a-real-value",
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-08-15T12:00:00.000Z"),
  });
  const byId = Object.fromEntries(vm.calendar.sync.history.map((entry) => [entry.id, entry]));
  assert.equal(byId["cal-write-manual"].provenance, "manual");
  assert.equal(byId["cal-write-legacy"].provenance, "automated");
  assert.equal(byId["cal-write-bogus"].provenance, "automated");
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
  assert.equal(vm.network.companies[0].applicationId, "aperture");
  assert.ok(
    vm.network.companies[0].history.some(
      (entry) => entry.applicationId === "aperture" && entry.summary
    )
  );
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
  const tracker = {
    applications: [],
    sourced: [],
    sources: [],
    communications: [],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-17T13:30:00.000Z"),
    library: {
      metrics: {
        claims: 2,
        stories: 1,
        voice: 1,
        honesty: 2,
        roleSignals: 3,
        gaps: 1,
      },
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
      readiness: { proof: 1, stories: 1, voice: 1, honesty: 2, roleSignals: 3 },
      gaps: [
        {
          tone: "coral",
          title: "Do not use yet",
          body: "Do not invent metrics.",
        },
      ],
      storyLanes: [{ tone: "teal", body: "0-to-1 applied AI systems." }],
    },
  });

  assert.equal(vm.library.metrics.claims, 2);
  assert.equal(vm.library.metrics.stories, 1);
  assert.equal(vm.library.metrics.voice, 1);
  assert.equal(vm.library.metrics.honesty, 2);
  assert.equal(vm.library.metrics.roleSignals, 3);
  assert.equal(vm.library.readiness.honesty, 2);
  assert.equal(vm.library.readiness.roleSignals, 3);
  assert.equal(vm.library.cards[0].title, "Demo Docs Assistant");
  assert.equal(vm.library.filters[0].label, "Agents");
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
        conversations: [
          {
            date: "2026-06-10T17:00:00.000Z",
            kind: "recruiter screen",
            who: "Avery Recruiter",
          },
        ],
      },
      {
        id: "past-loop",
        company: "Past Loop Co",
        role: "Platform Engineer",
        status: "interview",
        channel: "referral",
        fitScore: 80,
        base: "$215K",
        appliedAt: "2026-06-17",
        conversations: [
          {
            date: "2026-06-17T17:00:00.000Z",
            kind: "recruiter screen",
            who: "Avery Recruiter",
          },
        ],
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
  assert.equal(loop.action.dueAt, "2026-06-20T17:00:00.000Z");

  const pastLoop = byId.get("past-loop");
  assert.notEqual(pastLoop.actionState, "interview");
  assert.notEqual(pastLoop.action.label, "Prep");

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

test("Jobs never attaches a communication with another application id to a same-company role", () => {
  const tracker = {
    applications: [
      {
        id: "black-mesa-research",
        company: "Black Mesa",
        role: "Research Engineer",
        status: "applied",
      },
      {
        id: "black-mesa-applied-ai",
        company: "Black Mesa",
        role: "Applied AI Engineer",
        status: "reviewed-hold",
        conversations: [
          {
            who: "Different Recruiter",
            kind: "recruiter screen",
            date: "2026-06-18T12:00:00.000Z",
            notes: "This belongs only to the Applied AI role.",
          },
        ],
      },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "black-mesa-receipt",
        applicationId: "black-mesa-research",
        company: "Black Mesa",
        status: "waiting",
        subject: "Application received — Research Engineer at Black Mesa",
        messages: [
          {
            direction: "inbound",
            at: "2026-06-17T12:00:00.000Z",
            from: "Casey Recruiter",
            summary: "Black Mesa received the Research Engineer application.",
          },
        ],
      },
    ],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T13:30:00.000Z"),
  });
  const byId = new Map(vm.jobs.rows.map((row) => [row.id, row]));

  assert.equal(byId.get("black-mesa-research").drawer.emails.length, 1);
  assert.equal(byId.get("black-mesa-applied-ai").drawer.emails.length, 0);
  assert.equal(
    byId
      .get("black-mesa-applied-ai")
      .drawer.timeline.some((item) => item.title.includes("Research Engineer")),
    false
  );
  assert.ok(
    vm.network.companies
      .find((company) => company.company === "Black Mesa")
      .history.every(
        (entry) => !entry.applicationId || entry.applicationId === "black-mesa-research"
      )
  );
  assert.equal(
    vm.network.companies
      .find((company) => company.company === "Black Mesa")
      .notes.includes("This belongs only to the Applied AI role."),
    false
  );
});

test("a reviewed-hold application never claims it was submitted", () => {
  const vm = buildDashboardViewModel({
    applications: [
      {
        id: "curri-hold",
        company: "Curri",
        role: "Senior Software Engineer",
        status: "reviewed-hold",
        gate: "keep",
        fitScore: 85,
        base: "$185,000 - $215,000",
        compNote: "Posted base clears the candidate floor.",
        location: "Remote - United States",
        mode: "remote",
        channel: "Ashby",
        postedAt: "2026-08-19T12:00:00.000Z",
        statusNote: "Ready for application preparation. Not submitted.",
        roleFit: {
          why: ["React and TypeScript evidence matches"],
          risks: ["No logistics background recorded"],
        },
      },
    ],
    sourced: [],
    communications: [],
    sources: [],
  });

  const row = vm.jobs.rows.find((candidate) => candidate.id === "curri-hold");
  assert.equal(row.stage, "reviewed-hold");
  assert.equal(row.stageLabel, "Ready to apply");
  assert.equal(row.drawer.stage, "Ready to apply");
  assert.equal(row.action.label, "Prepare");
  assert.match(row.action.summary, /not been submitted/i);
  assert.doesNotMatch(row.action.summary, /application is submitted/i);
  assert.deepEqual(
    {
      compensation: row.drawer.compSummary,
      compensationNote: row.drawer.compNote,
      location: row.drawer.location,
      mode: row.drawer.modeLabel,
      source: row.drawer.sourceLabel,
      postedAt: row.drawer.postedAt,
      status: row.drawer.statusNote,
      fit: row.drawer.roleFit,
    },
    {
      compensation: "$185,000 - $215,000",
      compensationNote: "Posted base clears the candidate floor.",
      location: "Remote - United States",
      mode: "Remote",
      source: "Ashby",
      postedAt: "2026-08-19T12:00:00.000Z",
      status: "Ready for application preparation. Not submitted.",
      fit: {
        why: ["React and TypeScript evidence matches"],
        risks: ["No logistics background recorded"],
      },
    }
  );
});

test("a reviewed-hold application that has not cleared the gate uses needs-review display copy", () => {
  const vm = buildDashboardViewModel({
    applications: [
      {
        id: "review-hold",
        company: "Review Co",
        role: "Platform Engineer",
        status: "reviewed-hold",
        gate: "review",
        evaluation: { gate: "review" },
      },
    ],
    sourced: [],
    communications: [],
    sources: [],
  });

  const row = vm.jobs.rows.find((candidate) => candidate.id === "review-hold");
  assert.equal(row.stage, "reviewed-hold");
  assert.equal(row.stageLabel, "Needs review");
  assert.equal(row.drawer.stage, "Needs review");
});

test("an explicitly approved current review verdict is ready for application preparation", () => {
  const evaluatedAt = "2026-08-26T18:53:39.162Z";
  const vm = buildDashboardViewModel({
    applications: [
      {
        id: "review-approved",
        company: "Approved Co",
        role: "Platform Engineer",
        status: "reviewed-hold",
        base: "$190,000 - $220,000",
        evaluation: { gate: "review", evaluatedAt },
        reviewApproval: {
          evaluatedAt,
          approvedAt: "2026-08-26T18:54:00.000Z",
        },
      },
    ],
    sourced: [],
    communications: [],
    sources: [],
  });

  const row = vm.jobs.rows.find((candidate) => candidate.id === "review-approved");
  assert.equal(row.stage, "reviewed-hold");
  assert.equal(row.stageLabel, "Ready to apply");
  assert.equal(row.drawer.stage, "Ready to apply");
  assert.equal(row.action.label, "Prepare");
  assert.match(row.action.summary, /ready for application preparation/i);
  assert.doesNotMatch(row.action.summary, /pending review/i);
});

test("Network never hides approved contacts or companies behind arbitrary display caps", () => {
  const applications = Array.from({ length: 7 }, (_, index) => ({
    id: `app-${index}`,
    company: `Company ${index}`,
    role: "Engineer",
    status: "applied",
    conversations: [
      {
        who: `Recruiter ${index}A`,
        kind: "recruiter screen",
        date: "2026-06-01",
      },
      {
        who: `Recruiter ${index}B`,
        kind: "recruiter screen",
        date: "2026-06-02",
      },
      { who: `Manager ${index}`, kind: "hiring manager", date: "2026-06-03" },
    ],
  }));
  const vm = buildDashboardViewModel(
    {
      applications,
      sourced: [],
      communications: [],
      relationshipLeads: [
        {
          id: "approved-fourth-contact",
          applicationId: "app-0",
          company: "Company 0",
          name: "Approved Referral",
          type: "Referral",
          status: "approved",
        },
      ],
    },
    { now: new Date("2026-06-18T13:30:00.000Z") }
  );

  assert.equal(vm.network.companies.length, 7);
  assert.ok(
    vm.network.companies[0].contacts.some((contact) => contact.name === "Approved Referral")
  );
});

test("Network deduplicates people by identity and never promotes a rejected lead audit note", () => {
  const vm = buildDashboardViewModel(
    {
      applications: [
        {
          id: "app-1",
          company: "Identity Co",
          role: "Engineer",
          status: "applied",
          conversations: [
            { who: "Alex Smith", kind: "recruiter screen", date: "2026-06-01" },
            { who: "Alex Smith", kind: "hiring manager", date: "2026-06-02" },
            {
              who: "Rejected Person",
              kind: "relationship lead rejected",
              date: "2026-06-03",
              notes: "Candidate rejected this lead from Network review.",
            },
          ],
        },
      ],
      sourced: [],
      communications: [],
      relationshipLeads: [
        {
          id: "rejected-lead",
          applicationId: "app-1",
          company: "Identity Co",
          name: "Rejected Person",
          type: "Recruiter",
          status: "rejected",
        },
      ],
    },
    { now: new Date("2026-06-18T13:30:00.000Z") }
  );

  const contacts = vm.network.companies[0].contacts;
  assert.equal(contacts.filter((contact) => contact.name === "Alex Smith").length, 1);
  assert.equal(
    contacts.some((contact) => contact.name === "Rejected Person"),
    false
  );
});

// ISSUE-018/ISSUE-035 — jobDetailFromRow's artifact list must never leak the
// raw workspace path as `note` (the Library/JobDrawer "primary metadata" bug):
// `note` is always a short human-readable string, and the raw path only ever
// rides along on a separate `path` field, omitted when there is none.
test("Dashboard adapter's artifact list surfaces friendly notes, never raw paths, with path split out", () => {
  const tracker = {
    applications: [
      {
        id: "with-dates",
        company: "Dated Co",
        role: "Platform Engineer",
        status: "awaiting",
        channel: "board",
        fitScore: 80,
        base: "$200K",
        appliedAt: "2026-06-01",
        artifacts: {
          jd: "workspace/jobs/dated-co.md",
          jdGeneratedAt: "2026-06-01T10:00:00.000Z",
          resume: "workspace/tailored/dated-co-resume.md",
          resumeNote: "Tailored for the platform team",
          coverLetter: "workspace/tailored/dated-co-cover.md",
          coverLetterGeneratedAt: "2026-06-02T10:00:00.000Z",
          interviewDossier: {
            path: "workspace/interview-prep/dated-co.md",
            generatedAt: "2026-06-03T10:00:00.000Z",
            markdown: "# Dated Co interview dossier",
          },
        },
      },
      {
        id: "no-dates",
        company: "Plain Co",
        role: "Backend Engineer",
        status: "awaiting",
        channel: "board",
        fitScore: 75,
        base: "$190K",
        appliedAt: "2026-06-05",
        artifacts: {
          jd: "workspace/jobs/plain-co.md",
          resume: "workspace/tailored/plain-co-resume.md",
        },
      },
    ],
    sourced: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-18T13:30:00.000Z"),
  });
  const byId = new Map(vm.jobs.rows.map((row) => [row.id, row]));

  const dated = byId.get("with-dates");
  const jd = dated.drawer.artifacts.find((a) => a.kind === "Job description");
  const resume = dated.drawer.artifacts.find((a) => a.kind === "Resume");
  const coverLetter = dated.drawer.artifacts.find((a) => a.kind === "Cover letter");
  const dossier = dated.drawer.artifacts.find((a) => a.kind === "Interview dossier");
  assert.equal(jd.path, "workspace/jobs/dated-co.md");
  assert.notEqual(jd.note, jd.path);
  assert.match(jd.note, /Captured/);
  assert.equal(resume.path, "workspace/tailored/dated-co-resume.md");
  assert.equal(resume.note, "Tailored for the platform team");
  assert.equal(coverLetter.path, "workspace/tailored/dated-co-cover.md");
  assert.notEqual(coverLetter.note, coverLetter.path);
  assert.match(coverLetter.note, /Generated/);
  assert.equal(dossier.path, "workspace/interview-prep/dated-co.md");
  assert.match(dossier.note, /Prepared/);

  const plain = byId.get("no-dates");
  const plainJd = plain.drawer.artifacts.find((a) => a.kind === "Job description");
  const plainResume = plain.drawer.artifacts.find((a) => a.kind === "Resume");
  assert.equal(plainJd.path, "workspace/jobs/plain-co.md");
  assert.equal(plainJd.note, "Captured job description");
  assert.equal(plainResume.path, "workspace/tailored/plain-co-resume.md");
  assert.equal(plainResume.note, "Generated document");

  // Regression guard for the exact reported bug: no artifact's clickable
  // note field is ever the raw workspace path.
  for (const row of [dated, plain]) {
    for (const artifact of row.drawer.artifacts) {
      if (artifact.path) assert.notEqual(artifact.note, artifact.path);
    }
  }
});

test("Dashboard artifact lists never turn prose summaries into document paths", () => {
  const vm = buildDashboardViewModel({
    applications: [
      {
        id: "legacy-prose-artifacts",
        company: "Legacy Co",
        role: "Engineer",
        status: "applied",
        artifacts: {
          jd: "workspace/jobs/legacy-co.md",
          resume: "Tailored the resume to emphasize platform leadership and reliability.",
          resumeNote: "Legacy tailoring summary.",
          coverLetter: "Connected the candidate's evidence to the role in a concise letter.",
          coverLetterNote: "Legacy cover-letter summary.",
        },
      },
    ],
    sourced: [],
    communications: [],
  });

  const artifacts = vm.jobs.rows[0].drawer.artifacts;
  assert.deepEqual(
    artifacts.map((artifact) => artifact.kind),
    ["Job description"]
  );
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

test("Dashboard adapter exposes the next agent task", () => {
  const tracker = {
    applications: [],
    sourced: [],
    sources: [],
    communications: [],
  };
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
      {
        id: "src-1",
        company: "Massive Dynamic",
        role: "Applied AI Engineer",
        fitScore: 93,
      },
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
      {
        id: "src-1",
        company: "Massive Dynamic",
        role: "Applied AI Engineer",
        fitScore: 93,
      },
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
  assert.equal(vm.focus.cta, "Handle reply");
});

test("Dashboard adapter exposes usage and application mode status", () => {
  const tracker = {
    applications: [],
    sourced: [],
    sources: [],
    communications: [],
  };
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
  const tracker = {
    applications: [],
    sourced: [],
    sources: [],
    communications: [],
  };
  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
    settings: {
      profile: {
        candidate: "Demo Candidate",
        headline: "AI-native builder",
        location: "Remote / hybrid · Example City, ST",
        remoteScope: "worldwide",
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
  assert.equal(vm.settings.profile.remoteScope, "worldwide");
  assert.equal(vm.settings.automation.sessionProvider, "Browser extension");
  assert.deepEqual(vm.settings.automation.enabledCapabilities, [
    "Status polling",
    "Authenticated search",
  ]);
  assert.equal(vm.settings.profile.currentBase, undefined);
  assert.doesNotMatch(JSON.stringify(vm.settings), /123K|currentBase|current_base/);
});

test("Dashboard adapter archives cut sourced rows but surfaces manual-apply as active", () => {
  const tracker = {
    applications: [],
    sourced: [
      { id: "live", company: "Live Co", role: "FDE", status: "prospect" },
      {
        id: "blocked",
        company: "Blocked Co",
        role: "FDE",
        status: "manual blocked",
      },
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

test("Dashboard adapter keeps an explicit sourced status in the pre-application queue", () => {
  const tracker = {
    applications: [],
    sourced: [
      {
        id: "fresh",
        company: "Fresh Co",
        role: "Staff Engineer",
        status: "sourced",
      },
    ],
    sources: [],
    communications: [],
  };

  const vm = buildDashboardViewModel(tracker, {
    now: new Date("2026-06-15T13:30:00.000Z"),
  });

  assert.equal(vm.jobs.rows[0].stage, "sourced");
  assert.equal(vm.jobs.rows[0].stageGroupLabel, "Sourced");
  assert.equal(vm.jobs.rail.fresh, 1);
  assert.equal(vm.jobs.rail.manualReview, 1);
  assert.equal(vm.jobs.funnel[1].id, "sourced");
});

test("Dashboard adapter warns sourced roles when the same company has an active application", () => {
  const vm = buildDashboardViewModel({
    applications: [
      {
        id: "hightouch-reviewed",
        company: "Hightouch",
        role: "Distributed Systems Engineer",
        status: "reviewed-hold",
      },
      {
        id: "closed-application",
        company: "Closed Co",
        role: "Platform Engineer",
        status: "rejected",
      },
    ],
    sourced: [
      {
        id: "hightouch-sibling",
        company: "HIGHTOUCH!",
        role: "Control Plane Engineer",
        status: "sourced",
        warn: "Compensation needs review.",
      },
      {
        id: "closed-sibling",
        company: "Closed Co",
        role: "Backend Engineer",
        status: "sourced",
      },
      {
        id: "unrelated",
        company: "Other Co",
        role: "Staff Engineer",
        status: "sourced",
      },
    ],
    sources: [],
    communications: [],
  });

  const byId = new Map(vm.jobs.rows.map((row) => [row.id, row]));
  const sibling = byId.get("hightouch-sibling");
  assert.equal(
    sibling.warn,
    "Compensation needs review. You already have an active application at Hightouch. Review it before applying to another role."
  );
  assert.equal(sibling.drawer.warn, sibling.warn);
  assert.deepEqual(sibling.drawer.gaps, [sibling.warn]);
  assert.equal(byId.get("closed-sibling").warn, "");
  assert.equal(byId.get("unrelated").warn, "");
});

test("Dashboard adapter projects partial job-description capture status onto its sourced row", () => {
  const vm = buildDashboardViewModel({
    applications: [],
    sourced: [
      {
        id: "partial-description",
        company: "Partial Co",
        role: "Platform Engineer",
        status: "sourced",
        scanner: { bodyPartial: true },
        artifacts: { jd: "workspace/jobs/partial-co-platform-engineer.md" },
      },
    ],
    sources: [],
    communications: [],
  });

  assert.equal(vm.jobs.rows[0].descriptionPartial, true);
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

test("Dashboard nextsteps use action labels and reference the related job's detail id", () => {
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
});
