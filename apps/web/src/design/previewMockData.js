export const PREVIEW_MOCK_DATA = {
  dashboard: {
    metrics: [
      { label: "Needs action", value: 7, tone: "danger" },
      { label: "Interviewing", value: 4, tone: "teal" },
      { label: "Waiting", value: 6, tone: "sky" },
      { label: "High-fit new", value: 5, tone: "gold" },
    ],
    needs: [
      {
        id: "need-review-hightouch",
        type: "Decision",
        title: "Decide what to do with 3 high-fit roles",
        meta: "Hightouch, LangChain, Glean",
        due: "Due now",
        action: "Review roles",
        tone: "danger",
      },
      {
        id: "need-ramp-followup",
        type: "Follow-up",
        title: "Send Ramp follow-up",
        meta: "Applied AI Engineer · recruiter thread",
        due: "4:30 PM",
        action: "Open thread",
        tone: "warning",
      },
      {
        id: "need-juniper-prep",
        type: "Interview",
        title: "Prep Juniper Square technical screen",
        meta: "System design, AI routing, compensation guardrails",
        due: "Tomorrow 10:00 AM",
        action: "Open dossier",
        tone: "teal",
      },
    ],
    today: [
      {
        time: "10:00 AM",
        type: "Interview",
        title: "Juniper Square technical screen",
        action: "Open dossier",
      },
      {
        time: "4:30 PM",
        type: "Follow-up",
        title: "Ramp recruiter follow-up",
        action: "Draft reply",
      },
      { time: "EOD", type: "Deadline", title: "Glean packet review", action: "Open packet" },
    ],
    activity: [
      { time: "9 min ago", event: "Sourced 7 roles from company boards", source: "search-jobs" },
      {
        time: "32 min ago",
        event: "Tailored Juniper Square resume packet",
        source: "tailor-application",
      },
      { time: "Yesterday", event: "Moved Stripe to hiring-manager", source: "track-outcomes" },
    ],
    pipeline: [
      { label: "Applied", value: 6, max: 10 },
      { label: "Screen", value: 3, max: 10 },
      { label: "Technical", value: 2, max: 10 },
      { label: "Offer", value: 1, max: 10 },
    ],
  },

  calendar: {
    rangeLabel: "Jul 8-14, 2026",
    selectedView: "Week",
    agenda: [
      {
        group: "Overdue",
        items: [
          {
            id: "cal-overdue-ramp",
            type: "Follow-up",
            time: "Yesterday",
            title: "Ramp recruiter follow-up",
            meta: "Applied AI Engineer",
            action: "Draft reply",
          },
          {
            id: "cal-overdue-glean",
            type: "Deadline",
            time: "Yesterday",
            title: "Glean packet deadline",
            meta: "AI Search Engineer",
            action: "Open packet",
          },
        ],
      },
      {
        group: "Today",
        items: [
          {
            id: "cal-today-juniper",
            type: "Interview",
            time: "10:00 AM",
            title: "Juniper Square technical screen",
            meta: "Senior Applied AI Engineer",
            action: "Open dossier",
          },
          {
            id: "cal-today-ramp",
            type: "Follow-up",
            time: "4:30 PM",
            title: "Send Ramp follow-up",
            meta: "Recruiter thread",
            action: "Open thread",
          },
        ],
      },
      {
        group: "This week",
        items: [
          {
            id: "cal-week-stripe",
            type: "Interview",
            time: "Fri 1:00 PM",
            title: "Stripe hiring manager",
            meta: "AI Product Engineer",
            action: "Open dossier",
          },
          {
            id: "cal-week-anthropic",
            type: "Deadline",
            time: "Fri EOD",
            title: "Anthropic writing sample",
            meta: "Applied AI Architect",
            action: "Open artifact",
          },
        ],
      },
    ],
    weekDays: [
      {
        day: "Mon",
        date: "Jul 6",
        items: [{ type: "Follow-up", time: "2:00", title: "LangChain touch" }],
      },
      {
        day: "Tue",
        date: "Jul 7",
        items: [{ type: "Deadline", time: "EOD", title: "Glean packet" }],
      },
      {
        day: "Wed",
        date: "Jul 8",
        today: true,
        items: [
          { type: "Interview", time: "10:00", title: "Juniper technical" },
          { type: "Follow-up", time: "4:30", title: "Ramp reply" },
        ],
      },
      { day: "Thu", date: "Jul 9", items: [{ type: "Prep", time: "11:30", title: "Stripe prep" }] },
      {
        day: "Fri",
        date: "Jul 10",
        items: [{ type: "Interview", time: "1:00", title: "Stripe HM" }],
      },
    ],
  },

  jobs: {
    pipeline: {
      stages: [
        { label: "Applied", count: 6 },
        { label: "Screen", count: 3 },
        { label: "Technical", count: 2 },
        { label: "Offer", count: 1 },
      ],
      applications: [
        {
          id: "job-juniper",
          company: "Juniper Square",
          role: "Senior Applied AI Engineer",
          stage: "Technical",
          nextAction: "Prep",
          due: "Tomorrow",
          fit: 93,
          comp: "$230k-$260k",
          mode: "NY hybrid",
        },
        {
          id: "job-stripe",
          company: "Stripe",
          role: "AI Product Engineer",
          stage: "Hiring manager",
          nextAction: "Confirm",
          due: "Friday",
          fit: 88,
          comp: "$240k+",
          mode: "NYC hybrid",
        },
        {
          id: "job-ramp",
          company: "Ramp",
          role: "Applied AI Engineer",
          stage: "Waiting",
          nextAction: "Follow up",
          due: "Today",
          fit: 91,
          comp: "$220k-$250k",
          mode: "NYC hybrid",
        },
      ],
    },
    finder: {
      sourceHealth: {
        lastRun: "Today 9:02 AM",
        newRoles: 7,
        duplicates: 3,
        reviewsNeeded: 4,
        errors: 1,
      },
      launchers: [
        {
          title: "Free Job Board Search",
          meta: "2 broad searches / 8 company boards",
          action: "Search free boards",
        },
        {
          title: "AI Web Search",
          meta: "Primary role lane",
          action: "Run primary lane",
          disabled: true,
        },
      ],
      results: [
        {
          id: "find-hightouch",
          company: "Hightouch",
          role: "Staff Engineer, AI Productivity",
          source: "Company board",
          freshness: "Fresh",
          fit: 96,
          comp: "$220k-$260k",
          mode: "Remote US",
          capture: "JD saved",
          bucket: "High fit",
        },
        {
          id: "find-langchain",
          company: "LangChain",
          role: "Deployed Engineer",
          source: "AI web",
          freshness: "1d old",
          fit: 89,
          comp: "$210k-$250k",
          mode: "New York",
          capture: "Partial JD",
          bucket: "Needs review",
        },
        {
          id: "find-glean",
          company: "Glean",
          role: "AI Search Engineer",
          source: "Company board",
          freshness: "2d old",
          fit: 86,
          comp: "$215k-$255k",
          mode: "Remote",
          capture: "Login needed",
          bucket: "Needs review",
        },
      ],
    },
  },

  network: {
    attention: [
      {
        id: "net-ramp",
        title: "Follow up with Maya Chen",
        meta: "Ramp recruiter · Applied AI Engineer",
        due: "Today",
        action: "Draft context ask",
      },
      {
        id: "net-leads",
        title: "Review 4 relationship leads",
        meta: "Anthropic, Stripe, Hightouch",
        due: "Due now",
        action: "Review leads",
      },
    ],
    companies: [
      {
        company: "Anthropic",
        role: "Applied AI Architect",
        status: "Needs path",
        contacts: ["Recruiter lead", "Peer lead"],
        next: "Approve or reject sourced leads",
      },
      {
        company: "Stripe",
        role: "AI Product Engineer",
        status: "Warm path",
        contacts: ["Hiring manager", "Former coworker"],
        next: "Log Friday context",
      },
      {
        company: "Juniper Square",
        role: "Senior Applied AI Engineer",
        status: "In process",
        contacts: ["Recruiter"],
        next: "Prep before screen",
      },
    ],
    leads: [
      {
        name: "Priya Raman",
        company: "Anthropic",
        role: "Engineering manager",
        basis: "Hiring team match",
        source: "LinkedIn",
        verified: "Today",
      },
      {
        name: "Eli Brooks",
        company: "Hightouch",
        role: "Staff engineer",
        basis: "Role family peer",
        source: "Company page",
        verified: "Yesterday",
      },
    ],
  },

  library: {
    counts: [
      { label: "Ready", value: 12, tone: "teal" },
      { label: "Needs review", value: 5, tone: "danger" },
      { label: "Open gaps", value: 3, tone: "gold" },
    ],
    needs: [
      {
        title: "Juniper packet needs PDF export",
        meta: "Resume ready · cover letter ready",
        action: "Export PDF",
      },
      {
        title: "Glean packet has unanswered screening item",
        meta: "Evidence gap",
        action: "Review gap",
      },
      {
        title: "Ramp follow-up snippet is stale",
        meta: "Last updated 18 days ago",
        action: "Open snippet",
      },
    ],
    assets: [
      {
        id: "packet-juniper",
        type: "Packet",
        title: "Juniper Square technical packet",
        link: "Senior Applied AI Engineer",
        status: "Needs export",
        updated: "Today",
        action: "Open packet",
      },
      {
        id: "resume-stripe",
        type: "Resume",
        title: "AI Product Engineer tailored resume",
        link: "Stripe",
        status: "Ready",
        updated: "Yesterday",
        action: "Export DOCX",
      },
      {
        id: "snippet-ai-routing",
        type: "Snippet",
        title: "AI routing systems proof point",
        link: "Platform AI lane",
        status: "Reusable",
        updated: "Jul 5",
        action: "Copy snippet",
      },
      {
        id: "asset-glean-jd",
        type: "Asset",
        title: "Glean JD capture",
        link: "AI Search Engineer",
        status: "Partial JD",
        updated: "Jul 7",
        action: "Open asset",
      },
    ],
  },
};

export function getPreviewMockData(snapshot) {
  return snapshot?.v3 && typeof snapshot.v3 === "object" ? snapshot.v3 : PREVIEW_MOCK_DATA;
}

export function formatV3Count(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Intl.NumberFormat("en-US").format(Number(value));
}
