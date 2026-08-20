# Changelog

All notable changes to CareerRat are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-08-20

### Added

- Settings can now test an AI key you already saved, not just one you're typing in for the first time. If you're on CareerRat's managed connection it confirms that instead (#141).
- Multi-step application forms now work on any site, not just LinkedIn Easy Apply. CareerRat walks the wizard one step at a time and confirms it actually moved forward before continuing, and a single-page form still just fills and stops. Two safety rails came with it: it will not follow a "Continue with LinkedIn" style sign-in button off the application, and it stops outright if a click takes the browser to a different site. Submit is still always yours to press, and a job is only recorded as Applied after CareerRat sees the confirmation page (#129).

### Fixed

- Reloading the page partway through search-source setup no longer sends you back to the start. CareerRat picks the conversation back up where it was, since the work was never lost, only the screen's memory of it (#141).
- When CareerRat declines to approve a company proposal for a real reason, you now see that reason instead of "Something went wrong, failed to fetch." A business rule was reading like a network outage (#127).
- A strategy review card no longer collapses and loses your other pending recommendations when the app's internal credential goes stale mid-review. There is a retry, and the card keeps its state (#127).
- Accepting or rejecting a company during onboarding no longer fails silently. If the save doesn't go through, the reason now appears on that row, and an accepted company that can't be saved to your tracked list tells you so and what to do (#128, #140).
- Application forms that use custom dropdowns (the kind that filter as you type, rather than a plain select box) now get filled correctly. Two things were wrong: a field with no value set would click whichever option happened to be first in the list instead of leaving the field for you, and a type-to-filter box could report success just from the text CareerRat had typed into it, without an option actually being selected (#112).
- CareerRat no longer tells you the Chrome extension can drive an automatic apply. It cannot, and now it says so, and points you at `careerrat automation status` to see which providers can (#108).
- Activity log entries you give your own ID to are no longer silently dropped when they look like an entry that already exists. Setting your own ID is how you say "this one is different," and that is now respected. Entries without an ID still collapse duplicates the way they did (#118).
- Strategy-review learning entries with a timestamp in the heading parse correctly again, instead of splitting the time in half and feeding a mangled title into the review (#118).
- Ask now recognizes compensation questions more reliably instead of falling back to a general answer (#116).
- The desktop update check no longer races with app startup (#110).

### Changed

- Em dashes are out of CareerRat's own copy, across the CLI, the app, and the settings screens (#119, #120, #121).
- The `careerrat` version, the desktop app version, and the changelog can no longer drift apart from each other unnoticed (#113).
- Released version tags are now protected against deletion and rewriting, so a published release can't quietly change out from under anyone who already downloaded it (#126).
- Internal cleanup: about 1,200 lines of code with no caller were removed, including a dozen unused client functions and four dead dashboard builders, and the automated dead-code gate dropped from 170 allowed findings to 30 (#130, #131, #132, #133, #135, #142, #145).
- The marketing site and the docs are now built by CI on every change. A TypeScript upgrade had broken the docs build and nothing in the repo was checking it (#144).
- Opening the database is no longer vulnerable to a "database is locked" error when the CLI and the app touch it at the same moment. CareerRat sets its retry window as the very first thing it does on a connection, rather than after two other setup steps that could contend (#136, #139).

## [0.10.0] - 2026-08-19

### Added

- The desktop app now checks GitHub's public release list once a day and shows an in-app notice when a newer version of CareerRat is available. It never downloads or installs anything on its own, it just tells you a new version exists and points you to it. You can turn the check off entirely from Settings. No candidate data is sent as part of this check (#99).
- The onboarding "checking this computer" step now has a small animated loading screen instead of a static message, with a reduced-motion fallback for anyone who has that system preference set (#100).
- The README now links directly to the signed, notarized macOS download so Mac users don't have to hunt for it (#101).

### Fixed

- A broken test on main is fixed, and the test now checks the shape of a dependency pin instead of one exact version, so routine dependency bumps stop breaking it (#102).

### Changed

- The release process now uploads the notarized desktop dmg to the GitHub release itself, and a release that publishes without one is now caught and flagged instead of shipping quietly incomplete (#101).
- Roadmap notes were corrected after the v0.9.0 handoff to reflect what actually landed (#103).
- Routine dependency bumps (#75, #76).

## [0.9.0] - 2026-08-18

### Added

- Applying to a job is now a supervised, in-app workflow end to end: Ask and the job drawer connect to a real browser executor (first behind a session-browser seam, then a bundled Playwright fallback with no separate install) that captures Greenhouse and Ashby application questions, lets you paste, save, rebuild, and retry answers for sites without a public question schema, fills confirmed fields, attaches your generated documents, and advances multi-step flows like LinkedIn Easy Apply. Submit always stays under your control, and CareerRat only records an application as Applied after it sees confirmation-page evidence (#70, #71).
- Ask can now answer application and screening questions on request, grounding every answer in your saved profile, evidence, and honesty settings, and asking you to confirm before it reuses an answer as a default for future applications (#57).
- Ask gained native company research: "research Acme," "market comp for a nurse in Denver," and "is Acme a safe place to land" now run company research, comp benchmarking, and health/risk checks directly in the workspace, with fresh results reused instead of re-run when they're still current, and fuzzy company-name matching that asks for clarification instead of guessing (#58).
- "Review my strategy" now runs directly in Ask: it reassembles your funnel and targeting data, drafts findings and specific recommendations, and lets you approve each recommendation individually before anything changes. It still works without an AI connection configured, just with a smaller reasoning step (#59).
- Ask can capture quick notes on a communication thread ("add a note to the Acme thread: recruiter wants Tuesday") and prepare a pre-filled reply for you to review and send yourself through your own mail client, since a fully automated send inside the browser wasn't ready to ship safely this round (#60).
- Ask can now explain your current settings in plain language and apply targeted changes from a sentence, like "set my comp floor to $150k" or "exclude Acme from my search," without opening a separate settings screen (#61).
- Ask can prepare a redacted bug report from your most recent error for you to review before anything is filed. Candidate name, email, phone, location, and any tracked company or role names are scrubbed before the draft is ever shown (#62).
- The Calendar page now shows real per-provider connection status (Ready / Needs setup / Off) and a history of confirmed calendar writes, replacing a placeholder that always said "Consent gated." Export links (.ics, Google, Outlook) now say plainly that they only create an event in your own calendar app and touch nothing else (#63).
- Ask can record a recruiter or hiring-contact lead you found yourself ("I found a recruiter at Acme on LinkedIn, named Jordan Lee") directly into Network, no extra consent needed since you did the finding. Live browsing for new leads stays on the guided workflow (#64).
- Ask can check application status across connected job portals on request ("check my status") and record a status update you paste in from a portal message ("Greenhouse says phone screen scheduled for Acme"), always showing which platforms you've allowed it to read (#65).
- Ask can check for new recruiter email on request ("any new recruiter emails?"), showing each mail source's real read state (Apple Mail locally, or your explicit consent status for Gmail/Outlook) and a count of threads waiting on a reply (#66).
- Ask can check for new LinkedIn and Wellfound messages the same way, with a count of LinkedIn threads specifically waiting on a reply (#69).
- Ask can now stage suggested edits to your LinkedIn profile and let you approve or reject each one individually from a before/after card. Nothing is ever written back to LinkedIn from the app; approving a suggestion only marks it ready (#68).
- The website (careerrat.com and the docs) now has privacy-respecting, cookieless analytics so the team can see aggregate traffic without tracking individuals; no personal or candidate data is involved (#82).

### Changed

- Job intake in the packaged app is more robust: a pasted or attached job no longer loses context partway through evaluation (#52).
- The "go deeper" nudge that appears while researching a job now docks in a fixed row above the chat input instead of floating as a separate overlay, so it can no longer get hidden behind the chat bar on some screen sizes (#83).
- The apply automation code was restructured into clearly separated pieces (business logic, browser-driver adapter, and executor selection) ahead of adding the Playwright-based executor, with no change in behavior (#70).
- README and project docs were reorganized to a clearer, more standard structure (badges, quick start, features, roadmap, community links), and the privacy claims in the README were narrowed to describe only what actually leaves your machine (#79, related docs cleanup).
- Project quality and security tooling was overhauled: dependency and CI action versions are now pinned for supply-chain safety, new automated linting/formatting/dead-code checks run in CI, commit messages are checked automatically, and an optional second-opinion automated code review can be requested on a pull request via a label. A weekly passive security scan of careerrat.com was also added. These are developer-facing changes with no effect on how CareerRat behaves for a job seeker (#72, #78, #80, #96, plus related chore/CI cleanup commits).

### Fixed

- Fixed a server crash: naming a sourced job something like "Constructor" (matching a built-in JavaScript object property name) could crash the whole app when it tried to look up that company's logo. Company names are now looked up safely, and the app no longer goes down if any single request handler throws an unexpected error (#89).
- Fixed a bug where re-checking a job you'd already evaluated could leave the job's stage and fit score contradicting each other (for example, showing "Reviewed Hold" next to a fit result that should have meant "Cut"). Both are now always updated together (#85).
- Fixed embedded research chat sessions (company research, comp, health, and discovery) silently failing to load their instructions when using an installed Claude CLI, which caused them to skip saving results to your workspace even though they appeared to run normally (#84).
- Fixed research chat turns that do live web searches timing out too aggressively; they now get a longer allowance while routine one-shot requests keep the original limit (#92).
- Fixed asking to "discover more companies" while a previous batch was still waiting on your review creating a duplicate batch instead of reopening the existing one (#91).
- Fixed the discover-companies and research-boards workflows so their write steps only run through the guided CLI flow, not accidentally during a live chat session (#93).

### Security

- All GitHub Actions workflow references are now pinned to exact commit SHAs (rather than movable version tags), closing a supply-chain gap that was sharpest in the npm publishing workflow (#72).
- Added automated secret scanning, static analysis, and dependency review to CI, plus a weekly passive security scan of the public website (#72, #96).
