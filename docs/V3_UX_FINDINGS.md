# Rolester V3 UX Findings

Researched July 8, 2026. This file consolidates current UI/UX research, competitor patterns, and product decisions for the next pass on the Rolester app pages: Dashboard, Calendar, Jobs, Network, and Library.

## Executive Summary

The V2 pages helped expose the right sections, but V3 should be more disciplined: every page needs one job, a compact first viewport, believable data, and direct action controls. Rolester should not copy generic SaaS dashboards or social-network layouts. Its advantage is private, agent-led job-search memory: what changed, what needs the user, what is worth pursuing, and what evidence or artifact is ready.

Global V3 rules:

- Use rows and compact work surfaces before large cards.
- Keep every card single-purpose.
- Use semantic color only: overdue/risk, warning, success, informational.
- Keep long AI explanations out of rows; use drawers for reasoning.
- Prefer explicit CTAs over descriptive text.
- Use real workflow labels: `Evaluate`, `Dismiss`, `Open dossier`, `Draft follow-up`, `Approve lead`, `Export PDF`.
- Show source/provenance whenever AI, web search, or generated artifacts are involved.
- Build every V3 page with realistic mock data before judging layout.

## Core Sources

General UX:

- NN/g dashboard visualization guidance: https://www.nngroup.com/articles/dashboards-preattentive/
- NN/g data tables: https://www.nngroup.com/articles/data-tables/
- NN/g filters and facets: https://www.nngroup.com/articles/filters-vs-facets/
- NN/g filter categories: https://www.nngroup.com/articles/filter-categories-values/
- NN/g date input guidance: https://www.nngroup.com/articles/date-input/
- Baymard applied filters: https://baymard.com/blog/how-to-design-applied-filters
- Baymard horizontal filters: https://baymard.com/blog/horizontal-filtering-sorting-design

Job-search competitors and adjacent tools:

- Huntr job tracker: https://huntr.co/product/job-tracker
- Huntr job tracker help: https://help.huntr.co/en/articles/9883324-job-tracker
- Huntr application packets: https://help.huntr.co/en/articles/14367332-application-hub-and-packets
- Teal job tracker: https://www.tealhq.com/tools/job-tracker
- Teal contacts tracker: https://help.tealhq.com/en/articles/9509581-getting-started-contacts-tracker
- Simplify Copilot: https://simplify.jobs/copilot
- Careerflow job tracker: https://www.careerflow.ai/job-tracker
- Jobscan job tracker: https://www.jobscan.co/job-tracker
- LinkedIn job filters: https://www.linkedin.com/help/linkedin/answer/a507441/filter-and-sort-job-search-results
- Indeed job search filters: https://www.indeed.com/help/job-seekers/articles/204488950-improving-your-job-searches-tips-and-help

Calendar, CRM, and library references:

- Google Calendar views: https://support.google.com/calendar/answer/6110849
- Google Calendar tasks: https://support.google.com/calendar/answer/9901136
- Notion Calendar product: https://www.notion.com/product/calendar
- Notion Calendar with Notion databases: https://www.notion.com/help/use-notion-calendar-with-notion
- Notion database views, filters, sorts, and groups: https://www.notion.com/help/views-filters-and-sorts
- Google Drive search filters: https://support.google.com/drive/answer/2375114
- folk CRM views: https://help.folk.app/en/articles/4998224-create-views
- folk CRM pipeline views: https://help.folk.app/en/articles/6044821-create-custom-pipeline-views
- folk reminders: https://help.folk.app/en/articles/5658439-set-reminders-on-your-contacts

## Competitor Pattern Summary

| Product | Useful Pattern | What Rolester Should Borrow | What Rolester Should Avoid |
| --- | --- | --- | --- |
| Huntr | Visual job tracker, job cards, activity timeline, contacts, documents, metrics, packets | Job-specific packets, contact/document links, compact pipeline state | Full manual Kanban as the home page |
| Teal | Save jobs, pipeline stages, job insights, notes, contacts, follow-up templates | Source-of-truth job records, keyword/fit diagnostics, contact linkage | Making ATS score or resume score the primary identity of a role |
| Simplify | Autofill, tailoring, auto-tracking submitted applications | Application side effects become tracker state | Treating automation as the visible product instead of the workflow |
| Careerflow | Status dashboard, deadlines, labels, follow-up support | Labels, reminders, beginner-friendly organization | Generic all-in-one dashboard copy |
| Jobscan | Job tracker tied to match/report data, notes, tasks, meetings | Diagnostic fit and match signals inside job context | Overweighting match score above human decision state |
| LinkedIn Jobs | Rich filters, in-network signals, Easy Apply | Filters and network context | Social feed mechanics, growth pressure, invite spam patterns |
| Indeed | Saved vs applied separation, status updates, archive/report/withdraw actions | Clear state transitions and terminal actions | Mixing saved/search noise with active applications |
| Google/Notion Calendar | Day/week/month/schedule views; database items with dates | Literal calendar views and source-linked dated records | Turning calendar into another dashboard |
| folk/Mesh/Clay-style CRM | Contact records, reminders, enrichment/review, pipeline/list views | Contact memory, reviewable leads, next touch queue | Sales CRM bloat or unverified leads as real relationships |

## Dashboard V3

### Decision

Dashboard V3 should be a command center, not an analytics page and not a landing page. It should answer: **What needs me now? What changed? What is the next best agent/user handoff?**

### Show

- One primary next action with due date/time and reason.
- Today/overdue work: follow-ups, interviews, decisions, required manual steps.
- Next interview focus with logistics and dossier status.
- Compact pipeline orientation: active, needs action, interviewing, waiting, high-fit sourced.
- Recent activity pulse: sourced, evaluated, tailored, sent, scheduled, rejected, advanced.
- Search/source health: last sweep, source gaps, reviews needed.
- One next agent task: `Run search-jobs`, `Evaluate 3 roles`, `Draft Ramp follow-up`, etc.

### Avoid

- Marketing hero copy.
- Big welcome panels.
- A full Kanban board on the home page.
- Vanity metrics like total saved jobs unless tied to action.
- Dense analytics above the fold.
- Mixed-topic cards that blend scheduling, comp, recruiter signal, fit, and next action.

### V3 Layout

First viewport:

- Left: `Needs You` priority card or row stack.
- Right: `Today` schedule/action list.
- Small top metrics: `Needs action`, `Interviewing`, `Waiting`, `High-fit new`.
- Below: `Recent Activity` and `Pipeline Snapshot`.

Implementation notes:

- Closed/archive counts should not be celebratory dashboard cards.
- Priority rows should use time-based due labels where possible, not generated prose.
- Keep strategy/analytics behind a secondary panel or lower page section.

## Calendar V3

### Decision

Calendar V3 should be literal time infrastructure. It should not duplicate dashboard prep cards. It should answer: **What is dated, when is it due, and what record/action does it belong to?**

### Show

- Views: `Week`, `Month`, `Day`, `Agenda`.
- Item types: `Interview`, `Follow-up`, `Deadline`.
- Timed interviews in the time grid.
- Follow-ups and deadlines in all-day/agenda groups.
- Always-visible `Overdue` group.
- Click-through to job drawer, comm thread, application artifact, or interview dossier.
- Filters by item type.

### Avoid

- Pipeline summaries.
- Prep hero cards.
- Long notes inside day cells.
- One color per company.
- Inferred/maybe events without real due dates.
- Duplicate CTAs representing the same follow-up.

### V3 Layout

Header:

- `Today`, previous/next, current range.
- Segmented control: `Week | Month | Day | Agenda`.
- Type filters: `Interview`, `Follow-up`, `Deadline`.

Default:

- Desktop defaults to `Week`.
- Mobile defaults to `Agenda`.
- Remember last view.

Agenda groups:

- `Overdue`
- `Today`
- `Tomorrow`
- `This week`
- `Later`

## Jobs V3

### Decision

Jobs V3 should be two tabs: **Pipeline** and **Finder**. Pipeline is for committed opportunities. Finder is a volatile review inbox for sourced roles before they become work.

### Pipeline Should Show

- Active applications only by default.
- Company, role, stage, next action, due date, last touch, source, fit, comp, work mode.
- Interview/follow-up indicators.
- Sankey/funnel as orientation, then compact table/list.
- Terminal roles behind a toggle.
- Drawer: JD, artifacts, conversations, contacts, comp notes, role-fit reasons/risks, activity.

### Finder Should Show

- Source health above results: last run, new roles, duplicates, errors, reviews needed.
- Search launchers:
  - Free job board / deterministic source search.
  - AI web search / primary role lane once a real backend route exists.
- Result rows with: company, role, source, freshness, fit bucket, comp signal, work mode, capture state.
- Capture badges: `JD saved`, `Partial JD`, `Login needed`, `Link only`.
- Applied filter chips and result counts.
- Row actions: `Evaluate`, `Open`, `Watch`, `Dismiss`, `Mark duplicate`, `Merge`, `Open JD`, `Copy link`, `Ask agent`.

### Avoid

- One monolithic Jobs table.
- Raw sourced noise mixed into active applications.
- Hidden filter state.
- Long AI prose in rows.
- `Apply` on unreviewed rows.
- Promoting every sourced role into Pipeline.
- Losing JD bodies behind links.

### V3 State Model

Finder state transitions should be explicit:

- `dismissed`
- `watching`
- `evaluating`
- `promoted`
- `duplicate`

Pipeline state remains application/interview/outcome driven.

Implementation note: the current free board search has an endpoint. AI web search should not be visually presented as working until there is a dedicated route and run state.

## Network V3

### Decision

Network V3 should be a private relationship CRM, not a LinkedIn clone. Borrow filters and professional context from LinkedIn, but avoid feeds, follower language, mutual-count theater, and broad social discovery.

### Show

- `Needs Attention` queue.
- Company-first relationship rows.
- Contact chips: recruiter, hiring manager, peer, alumni, referral path.
- Reviewable sourced leads with basis, source, verification date, confidence, approve/reject.
- Warm-path coverage by active company.
- Contact drawer: basis, source, last interaction, linked application, next safe touch, notes, memory.
- Dormant memory collapsed by default.

### Avoid

- Social feed.
- Birthdays/news/posts as primary UI.
- Warmth scores without explanation.
- Unverified scraped leads presented as relationships.
- Bulk outreach, auto-connect, auto-referral asks.
- Generic sales CRM fields like deal value, forecast, quota.

### V3 Layout

Top:

- `Needs Attention`: due follow-ups and unresolved lead decisions.

Main:

- `Company Paths`: active companies with relationship coverage and missing-path state.

Side:

- `Review Leads`: approve/reject sourced contacts.

Collapsed:

- `Relationship Memory`: useful history that should not become active CTA noise.

Status language:

- `Warm path`
- `Needs review`
- `Needs path`
- `In process`
- `Dormant`
- `Do not use`

CTA language:

- `Open context`
- `Draft context ask`
- `Log touch`
- `Snooze`
- `Approve lead`
- `Reject lead`
- `Run relationship sourcing`

## Library V3

### Decision

Keep the sidebar label **Library**, but title the page **Application Library**. The page should be a job-linked, provenance-aware workbench for packets, resumes, cover letters, snippets, evidence, and raw assets.

### Taxonomy

- **Packets:** JD, gate, resume, cover letter, answers, follow-up, exports.
- **Resumes:** base resumes and tailored versions.
- **Cover Letters:** drafts/finals linked to jobs.
- **Snippets:** reusable bullets, summaries, answers, follow-up blocks.
- **Evidence:** claims, STAR stories, writing voice, honesty boundaries, role signals.
- **Assets:** raw uploads, JD captures, links, source docs, imported files.

Facets:

- `Type`
- `Status`
- `Company`
- `Role family`
- `Scope`
- `Format`
- `Needs action`
- `Last updated`

### Show

- Search-first library with filter chips.
- `Needs review` strip: stale packet, missing cover letter, open evidence gap, export needed.
- Rows/cards with title, type, linked job/company, status, updated date, formats, primary action.
- Detail drawer with source/provenance, linked application, versions, evidence IDs, safe reusable text.
- Packet completeness checklist.

### Avoid

- Generic Resources page.
- Orphaned resumes or cover letters with no job/source link.
- ATS/match score as dominant visual.
- Mixing private evidence/honesty boundaries into outbound document views.
- Rebuilding the packet editor inside Library.

### V3 Layout

Header:

- `Application Library`
- Global search.
- Counts: `Ready`, `Needs review`, `Open gaps`.

Tabs:

- `All`
- `Packets`
- `Resumes`
- `Cover Letters`
- `Snippets`
- `Evidence`
- `Assets`

Primary CTAs:

- `Open packet`
- `Export PDF`
- `Export DOCX`
- `Copy snippet`
- `Use in packet`
- `Review gap`

## Mock Data Requirements For V3

V3 page work should not be judged against empty states. Use one consistent believable demo dataset across pages:

- 10-14 active applications.
- 20-30 sourced Finder results across 3 source runs.
- 4-6 high-fit roles requiring review.
- 3 interviews across this week and next week.
- 5 follow-ups, including at least 2 overdue.
- 2 deadlines.
- 8-12 contacts across active companies.
- 4 relationship leads awaiting review.
- 8-10 packets with mixed completeness.
- 3 tailored resumes, 4 cover letters, 6 snippets, and raw assets/JD captures.
- Terminal history present but not default-visible.

The mock data should include imperfect states: duplicate sourced role, partial JD capture, stale packet, missing contact path, overdue follow-up, and one rejected/archive role.

## V3 Implementation Priorities

1. Define shared V3 mock data and ensure all pages render from it.
2. Build Dashboard V3 as an action command center.
3. Build Jobs V3 Pipeline/Finder split from the same job model.
4. Build Calendar V3 as literal week/month/day/agenda.
5. Build Network V3 as company paths + relationship lead review.
6. Build Library V3 as Application Library with packet/artifact provenance.
7. Add shared row/action/drawer patterns so V3 pages feel like one product.

## Open Product Questions

- Do we expose `Finder` as the user-facing name, or keep `Search` in navigation and use `Finder` inside the page?
- Should Dashboard V3 include a small strategy insight card, or move all strategy into a lower page/secondary tab?
- What is the first real AI web-search backend contract: run by role lane, run by company list, or run by natural-language query?
- Should Network V3 allow a manual contact add flow in V3, or keep it lead-review only until relationship sourcing is stronger?
- Should Library V3 own export actions directly, or route all export generation through packet/tailoring flows?

