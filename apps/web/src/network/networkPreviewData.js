// apps/web/src/network/networkPreviewData.js — dev-only fallback data for
// NetworkPage.jsx, shown when the live dashboard snapshot carries no
// network.companies (see hasNetworkContent() + networkForNext() there).
// Shaped like buildNetwork()'s real output (src/core/tracker/dashboard-data.js)
// — only the fields the page actually renders are included, and the
// reuseTitle/reuseBody/reuseScope copy matches networkReuseCopy()'s real
// strings for each state so the preview reads exactly like a live snapshot
// would. Network data is thin by design (see NETWORK_UX_RESEARCH.md), so this
// is what keeps the page demoable in the hosted/demo build.

const northstarAi = {
  company: "Northstar AI",
  domain: "northstar.example",
  contacts: [
    {
      type: "Recruiter",
      name: "Dana Whitfield",
      note: "Good screen energy; keep the next ask tied to platform scope.",
      email: "dana.whitfield@northstar.example",
      title: "Senior Technical Recruiter",
      platform: "email",
    },
    {
      type: "Decision maker",
      name: "Jordan Lee",
      note: "Owns AI platform reliability and evaluation loops.",
      email: "jordan.lee@northstar.example",
      title: "Director of Platform Reliability",
      platform: "linkedin",
    },
  ],
  warmth: 82,
  reuseState: "caution",
  reuseTitle: "Caution: active loop first",
  reuseBody:
    "Use this relationship for the current process; broaden the ask only after the active loop resolves.",
  reuseScope: "Reuse scope: same practice",
  nextTouch: "After screen",
  stateLabel: "In process",
  latestAt: "2026-07-09T16:30:00Z",
  notes: [
    "Recruiter wants concrete production AI examples before widening the ask.",
    "Manager signal: eval loops and measurable outcomes matter most.",
  ],
};

const veridianDynamics = {
  company: "Veridian Dynamics",
  domain: "veridiandynamics.com",
  contacts: [
    {
      type: "Decision maker",
      name: "Veronica Palmer",
      note: "Strong adjacent-team context for AI productivity work.",
      email: "veronica.palmer@veridiandynamics.com",
      title: "Engineering Manager, Data Platform",
      platform: "linkedin",
    },
    {
      type: "Recruiter",
      name: "Linda Zwordling",
      note: "Can clarify the team split before application copy is tailored.",
      email: "linda.zwordling@veridiandynamics.com",
      title: "Technical Recruiter",
      platform: "email",
    },
  ],
  warmth: 76,
  reuseState: "safe",
  reuseTitle: "Safe reuse: same-company routing",
  reuseBody:
    "Good reach-out point for adjacent roles when the ask is specific, low-pressure, and tied to known context.",
  reuseScope: "Same-company routing",
  nextTouch: "Ask for team context",
  stateLabel: "Warm path",
  latestAt: "2026-07-08T14:15:00Z",
  notes: ["Relationship is specific enough for one low-pressure context ask."],
};

const abstergoIndustries = {
  company: "Abstergo Industries",
  domain: "abstergo.com",
  contacts: [
    {
      type: "Recruiter",
      name: "Lucy Stillman",
      note: "Follow-up is due; keep it short and tied to applied AI scope.",
      email: "lucy.stillman@abstergo.com",
      title: "Recruiting Lead",
      platform: "email",
    },
  ],
  warmth: 69,
  reuseState: "caution",
  reuseTitle: "Caution: active loop first",
  reuseBody:
    "Use this relationship for the current process; broaden the ask only after the active loop resolves.",
  reuseScope: "Reuse scope: same practice",
  nextTouch: "Today",
  stateLabel: "In process",
  latestAt: "2026-07-06T18:10:00Z",
  notes: ["Application has gone quiet after a high-fit submission."],
};

// Zero named contacts yet — exercises buildPeopleCards()'s "company memory"
// fallback card, the same real gap signal a thin live workspace would show.
const archiveLabs = {
  company: "Archive Labs",
  domain: "",
  contacts: [],
  warmth: 42,
  reuseState: "closed",
  reuseTitle: "Closed: memory only",
  reuseBody:
    "Do not use as an immediate reach-out path; keep the objection memory for future screens.",
  reuseScope: "Reuse scope: none now",
  nextTouch: "New role only",
  stateLabel: "Closed",
  latestAt: "2026-06-20T11:00:00Z",
  notes: ["Closed-loop objection belongs in prep, not an immediate re-ping."],
};

export const PREVIEW_NETWORK = {
  companies: [northstarAi, veridianDynamics, abstergoIndustries, archiveLabs],
  sourcing: {
    reviewLeads: [
      {
        id: "preview-lead-carla",
        label: "Review lead",
        name: "Carla Walton",
        company: "Pied Piper",
        title: "AI Search Engineering",
        platform: "linkedin",
        note: "Potential peer path for search infra scope.",
      },
      {
        id: "preview-lead-alan",
        label: "Review lead",
        name: "Alan Bradley",
        company: "Encom",
        title: "Deployed engineering",
        platform: "wellfound",
        note: "Check fit before drafting outreach.",
      },
    ],
    targets: [
      {
        id: "preview-target-piedpiper",
        label: "Search contact path",
        company: "Pied Piper",
        role: "AI Search Engineer",
        fit: 78,
        summary: "No recruiter, hiring-team member, referral, or warm contact is tracked yet.",
      },
    ],
  },
};
