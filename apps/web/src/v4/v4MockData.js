export const V4_MOCK_DATA = {
  header: { dateLabel: "Wednesday, July 8", overdueCount: 3 },
  metrics: [
    {
      key: "needs-you",
      label: "Needs you",
      value: 7,
      tone: "danger",
      to: "/jobs?filter=needs-you",
    },
    {
      key: "interviewing",
      label: "Interviewing",
      value: 4,
      tone: "teal",
      to: "/jobs?stage=interviewing",
    },
    { key: "waiting", label: "Waiting", value: 6, tone: "sky", to: "/jobs?stage=waiting" },
    {
      key: "high-fit-new",
      label: "High-fit new",
      value: 5,
      tone: "gold",
      to: "/jobs?filter=high-fit",
    },
  ],
  focus: {
    id: "job-juniper",
    dueLabel: "Due today",
    dueTone: "danger",
    title: "Prep Juniper Square technical screen",
    company: "Juniper Square",
    role: "Senior Applied AI Engineer",
    basis: {
      summary: "Fit 93 · recruiter replied 2d ago · JD saved",
      reasons: [
        "Technical screen is the next dated commitment.",
        "Role fit is high and the recruiter thread is active.",
        "Comp range and NY hybrid posture match the target lane.",
      ],
    },
    facts: [
      { label: "Format", value: "Hybrid" },
      { label: "Location", value: "NY" },
      { label: "Fit", value: 93 },
    ],
    cta: { label: "Open dossier", to: "/jobs?open=job-juniper" },
    secondary: { label: "Snooze" },
  },
  needs: [
    {
      id: "need-review-high-fit",
      kicker: "Decision",
      title: "Decide what to do with 3 high-fit roles",
      meta: "Hightouch, LangChain, Glean",
      due: "Due now",
      tone: "danger",
      action: { label: "Review", to: "/jobs?filter=manual-review" },
    },
    {
      id: "need-ramp-followup",
      kicker: "Follow-up",
      title: "Send Ramp recruiter follow-up",
      meta: "Applied AI Engineer · thread waiting 8d",
      due: "4:30 PM",
      tone: "warning",
      action: { label: "Draft", to: "/inbox?thread=ramp" },
    },
    {
      id: "need-stripe-prep",
      kicker: "Interview",
      title: "Prep Stripe hiring manager screen",
      meta: "AI Product Engineer · Friday 1:00 PM",
      due: "Tomorrow",
      tone: "teal",
      action: { label: "Open", to: "/jobs?open=job-stripe" },
    },
  ],
  needsOverflow: 4,
  agentTask: {
    id: "agent-evaluate-high-fit",
    skill: "evaluate-job",
    title: "Evaluate 3 high-fit sourced roles",
    why: "Fit ≥ 86, JD bodies saved, none gated yet.",
    risk: "read",
    cta: { label: "Run evaluate-job" },
    dismiss: { label: "Not now" },
  },
  schedule: {
    overdue: [
      {
        id: "sched-overdue-hightouch",
        time: "Yesterday",
        title: "Hightouch role decision",
        meta: "Staff Engineer, AI Productivity",
        to: "/jobs?open=find-hightouch",
      },
      {
        id: "sched-overdue-glean",
        time: "Yesterday",
        title: "Glean packet review",
        meta: "AI Search Engineer",
        to: "/jobs?open=find-glean",
      },
      {
        id: "sched-overdue-langchain",
        time: "Yesterday",
        title: "LangChain Partial JD check",
        meta: "Deployed Engineer",
        to: "/jobs?open=find-langchain",
      },
    ],
    today: [
      {
        id: "sched-juniper-screen",
        time: "10:00 AM",
        title: "Juniper Square technical screen",
        meta: "Senior Applied AI Engineer",
        to: "/jobs?open=job-juniper",
      },
      {
        id: "sched-ramp-followup",
        time: "4:30 PM",
        title: "Ramp recruiter follow-up",
        meta: "Applied AI Engineer",
        to: "/inbox?thread=ramp",
      },
      {
        id: "sched-glean-eod",
        time: "EOD",
        title: "Glean packet deadline",
        meta: "AI Search Engineer",
        to: "/jobs?open=find-glean",
      },
    ],
  },
  activity: [
    {
      id: "activity-search-jobs",
      relTime: "9m",
      skill: "search-jobs",
      summary: "Sourced 7 roles from company boards",
      to: "/jobs?filter=fresh",
    },
    {
      id: "activity-tailor-juniper",
      relTime: "32m",
      skill: "tailor-application",
      summary: "Tailored Juniper Square resume packet",
      to: "/library?asset=packet-juniper",
    },
    {
      id: "activity-stripe-stage",
      relTime: "1d",
      skill: "track-outcomes",
      summary: "Moved Stripe to hiring manager",
      to: "/jobs?open=job-stripe",
    },
    {
      id: "activity-langchain-partial",
      relTime: "1d",
      skill: "evaluate-job",
      summary: "Flagged LangChain Partial JD for review",
      to: "/jobs?open=find-langchain",
    },
    {
      id: "activity-anthropic-leads",
      relTime: "2d",
      skill: "relationship-sourcing",
      summary: "Found Anthropic recruiter and peer leads",
      to: "/network",
    },
  ],
  pipeline: {
    stages: [
      { key: "applied", label: "Applied", count: 6, conversionFromPrev: null },
      { key: "screen", label: "Screen", count: 3, conversionFromPrev: 50 },
      { key: "technical", label: "Technical", count: 2, conversionFromPrev: 67 },
      { key: "offer", label: "Offer", count: 1, conversionFromPrev: 50 },
    ],
    stale: [
      {
        id: "stale-ramp",
        company: "Ramp",
        role: "Applied AI Engineer",
        stage: "Waiting",
        days: 21,
        reason: "2.1x median",
      },
    ],
  },
};

export function getV4Data(snapshot) {
  return snapshot?.v4 && typeof snapshot.v4 === "object" ? snapshot.v4 : V4_MOCK_DATA;
}

export function formatV4Count(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Intl.NumberFormat("en-US").format(Number(value));
}
