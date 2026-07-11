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
        id: "need-review-veridian",
        type: "Decision",
        title: "Decide what to do with 3 high-fit roles",
        meta: "Rekall, Encom, Globex",
        due: "Due now",
        action: "Review roles",
        tone: "danger",
      },
      {
        id: "need-abstergo-followup",
        type: "Follow-up",
        title: "Send Abstergo Industries follow-up",
        meta: "Applied AI Engineer · recruiter thread",
        due: "4:30 PM",
        action: "Open thread",
        tone: "warning",
      },
      {
        id: "need-cyberdyne-prep",
        type: "Interview",
        title: "Prep Cyberdyne Systems technical screen",
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
        title: "Cyberdyne Systems technical screen",
        action: "Open dossier",
      },
      {
        time: "4:30 PM",
        type: "Follow-up",
        title: "Abstergo Industries recruiter follow-up",
        action: "Draft reply",
      },
      { time: "EOD", type: "Deadline", title: "Globex packet review", action: "Open packet" },
    ],
    activity: [
      { time: "9 min ago", event: "Sourced 7 roles from company boards", source: "search-jobs" },
      {
        time: "32 min ago",
        event: "Tailored Cyberdyne Systems resume packet",
        source: "tailor-application",
      },
      {
        time: "Yesterday",
        event: "Moved Massive Dynamic to hiring-manager",
        source: "track-outcomes",
      },
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
            id: "cal-overdue-abstergo",
            type: "Follow-up",
            time: "Yesterday",
            title: "Abstergo Industries recruiter follow-up",
            meta: "Applied AI Engineer",
            action: "Draft reply",
          },
          {
            id: "cal-overdue-piedpiper",
            type: "Deadline",
            time: "Yesterday",
            title: "Globex packet deadline",
            meta: "AI Search Engineer",
            action: "Open packet",
          },
        ],
      },
      {
        group: "Today",
        items: [
          {
            id: "cal-today-cyberdyne",
            type: "Interview",
            time: "10:00 AM",
            title: "Cyberdyne Systems technical screen",
            meta: "Senior Applied AI Engineer",
            action: "Open dossier",
          },
          {
            id: "cal-today-abstergo",
            type: "Follow-up",
            time: "4:30 PM",
            title: "Send Abstergo Industries follow-up",
            meta: "Recruiter thread",
            action: "Open thread",
          },
        ],
      },
      {
        group: "This week",
        items: [
          {
            id: "cal-week-massivedynamic",
            type: "Interview",
            time: "Fri 1:00 PM",
            title: "Massive Dynamic hiring manager",
            meta: "AI Product Engineer",
            action: "Open dossier",
          },
          {
            id: "cal-week-tyrell",
            type: "Deadline",
            time: "Fri EOD",
            title: "Tyrell Corporation writing sample",
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
        items: [{ type: "Follow-up", time: "2:00", title: "Encom touch" }],
      },
      {
        day: "Tue",
        date: "Jul 7",
        items: [{ type: "Deadline", time: "EOD", title: "Globex packet" }],
      },
      {
        day: "Wed",
        date: "Jul 8",
        today: true,
        items: [
          { type: "Interview", time: "10:00", title: "Cyberdyne technical" },
          { type: "Follow-up", time: "4:30", title: "Abstergo reply" },
        ],
      },
      {
        day: "Thu",
        date: "Jul 9",
        items: [{ type: "Prep", time: "11:30", title: "Massive Dynamic prep" }],
      },
      {
        day: "Fri",
        date: "Jul 10",
        items: [{ type: "Interview", time: "1:00", title: "Massive Dynamic HM" }],
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
          id: "job-cyberdyne",
          company: "Cyberdyne Systems",
          role: "Senior Applied AI Engineer",
          stage: "Technical",
          nextAction: "Prep",
          due: "Tomorrow",
          fit: 93,
          comp: "$230k-$260k",
          mode: "NY hybrid",
        },
        {
          id: "job-massivedynamic",
          company: "Massive Dynamic",
          role: "AI Product Engineer",
          stage: "Hiring manager",
          nextAction: "Confirm",
          due: "Friday",
          fit: 88,
          comp: "$240k+",
          mode: "NYC hybrid",
        },
        {
          id: "job-abstergo",
          company: "Abstergo Industries",
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
          id: "find-veridian",
          company: "Rekall",
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
          id: "find-encom",
          company: "Encom",
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
          id: "find-piedpiper",
          company: "Globex",
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
        id: "net-abstergo",
        title: "Follow up with Lucy Stillman",
        meta: "Abstergo Industries recruiter · Applied AI Engineer",
        due: "Today",
        action: "Draft context ask",
      },
      {
        id: "net-leads",
        title: "Review 4 relationship leads",
        meta: "Tyrell Corporation, Massive Dynamic, Rekall",
        due: "Due now",
        action: "Review leads",
      },
    ],
    companies: [
      {
        company: "Tyrell Corporation",
        role: "Applied AI Architect",
        status: "Needs path",
        contacts: ["Recruiter lead", "Peer lead"],
        next: "Approve or reject sourced leads",
      },
      {
        company: "Massive Dynamic",
        role: "AI Product Engineer",
        status: "Warm path",
        contacts: ["Hiring manager", "Former coworker"],
        next: "Log Friday context",
      },
      {
        company: "Cyberdyne Systems",
        role: "Senior Applied AI Engineer",
        status: "In process",
        contacts: ["Recruiter"],
        next: "Prep before screen",
      },
    ],
    leads: [
      {
        name: "J.F. Sebastian",
        company: "Tyrell Corporation",
        role: "Engineering manager",
        basis: "Hiring team match",
        source: "LinkedIn",
        verified: "Today",
      },
      {
        name: "Phil Myman",
        company: "Rekall",
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
        title: "Cyberdyne packet needs PDF export",
        meta: "Resume ready · cover letter ready",
        action: "Export PDF",
      },
      {
        title: "Globex packet has unanswered screening item",
        meta: "Evidence gap",
        action: "Review gap",
      },
      {
        title: "Abstergo follow-up snippet is stale",
        meta: "Last updated 18 days ago",
        action: "Open snippet",
      },
    ],
    assets: [
      {
        id: "packet-cyberdyne",
        type: "Packet",
        title: "Cyberdyne Systems technical packet",
        link: "Senior Applied AI Engineer",
        status: "Needs export",
        updated: "Today",
        action: "Open packet",
      },
      {
        id: "resume-massivedynamic",
        type: "Resume",
        title: "AI Product Engineer tailored resume",
        link: "Massive Dynamic",
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
        id: "asset-piedpiper-jd",
        type: "Asset",
        title: "Globex JD capture",
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
