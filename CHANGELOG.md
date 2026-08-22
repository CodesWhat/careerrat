# Changelog

All notable changes to CareerRat are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The README and the docs now lead with the signed Mac app: download it from the latest release or install with Homebrew, with npm kept as the path for every other platform. The install guide spells out what each path needs (an AI CLI either way; Node.js only for npm) and how the Mac app stays current (#190).

## [0.12.0] - 2026-08-22

### Added

- When a job's evaluation lands at "review" with named fit risks, you can now click "Coach me on this fit" to get a plan for closing the gaps. Each gap gets either a suggested addition to your evidence, drawn only from things you have actually told CareerRat, or a plain "no honest way to close this one yet". Confirming a suggestion saves it through the same checks as any other evidence, and you can then re-evaluate the job to see if it changed your fit. Nothing runs unless you click, and CareerRat never invents experience for you (#160).
- Every published release now includes a software bill of materials, a standard SPDX file listing exactly which packages and versions CareerRat is built from, attached as `careerrat-<version>-sbom.spdx.json`. Security tools can read it to check a release against known vulnerabilities without installing anything (#154).
- A new quality check exercises every AI-produced verdict shape end to end: it runs the real evaluate-job, coach-gaps, search triage, and company-health prompts against a fictional demo candidate through your installed AI CLI and verifies each reply comes back in exactly the structure the app expects. Malformed AI output gets caught by a script run instead of by a real job seeker mid-search (#172).
- Publishing a desktop release is now a single tag push. CI builds, signs, notarizes, and staples the app, uploads the installer to the GitHub release, and publishes the release once the installer is confirmed present. The Homebrew tap then picks up the published release on its own, so no manual step remains between tagging a version and users being able to download or `brew install` it (#150, #151, #152).

### Changed

- The two release-pipeline steps that only talk to GitHub now run with all other outbound network access blocked, so a compromised dependency in those steps could not send anything anywhere else. The build step keeps monitoring-only mode for now because Apple's notarization service uses rotating delivery hosts that a fixed blocklist would break (#155).
- Routine background steps, like classifying a reply or filling in a company domain, now ask your installed Claude CLI for its smaller, faster model instead of the full-size one, the same cost saving API users already had. Other installed CLIs are left on their own default model, because the model names CareerRat knows are Claude's (#163).
- AI web search now knows which companies you have blocked, put on cooldown, or recently been rejected by, so it stops proposing roles you cannot act on. Skill-driven search runs also hand each job evaluation a shared digest of your targeting and profile instead of re-reading the same files for every job (#163).
- Every check that builds, tests, scans, or publishes CareerRat now runs with outbound network access blocked except for that step's own known destinations, extending #155's protection from two release steps to the whole pipeline. A compromised dependency inside any of those steps could no longer send anything anywhere unexpected. The one exception is the website security scan, which by design crawls the live site and keeps monitoring-only mode (#170).

- The chat activity lines now appear no matter how your AI is connected. They previously only worked with a direct API key or managed connection; the most common setup, your installed Claude CLI, got its answer in one silent piece at the end. Chat turns on that route now stream each step live as it happens (#175).
- While CareerRat works on something you asked for in chat, each step now shows as a small activity line with an icon, a plain-language label like "Reading files: resume.pdf" or "Searching the web", and a spinner that settles when the step finishes. The assistant also stops announcing those steps in prose, since you can already see them happen; it speaks up for questions, findings, and results instead (#171).

### Fixed

- The packet gate now enforces your excluded-companies list and cut signals itself, before asking the AI anything. A company on your excluded list is cut outright without an AI call, and a job matching one of your cut signals is held for your review instead of trusting the AI not to wave it through (#184).
- Resuming an interrupted apply session now re-checks the saved verdict and packet on the server before the browser is driven. Previously a resumed session trusted the request's own word that those checks had passed (#184).
- AI-drafted reply messages now go through the same private-pay and unfinished-placeholder checks as handoff drafts before being saved, and the handoff check itself now also catches phrased-out salary disclosures like "my current salary is", not just the literal field name (#184).
- Salary-expectation answers on application forms now state your target salary instead of your private walk-away minimum. If you have not set a target, the question comes back marked for you rather than guessing (#184).
- Approving a proposed job source no longer crashes when it also records the company's application system: the two database writes were fighting over the same connection. They now commit together as one change (#183).
- Edits to your profile, targeting, evidence, and application limits now show up in the tracker file immediately when a workspace has one, instead of waiting for some later unrelated write to refresh it. A workspace that never uses the tracker file stays without one (#183).
- When a change saves to the database but the tracker file fails to refresh afterwards, the error now says exactly that, instead of looking like the save itself failed. Retrying blindly after that message would have written the change twice (#183).
- A tracked job saved without a role title no longer breaks outcome analytics for the whole workspace. One such row used to make every later status change crash (#183).
- One broken job-board provider can no longer take down the whole provider registry. Each of the roughly 80 bundled providers now loads on its own; a bad one is skipped and recorded, and every other source keeps working (#182).
- The documented setup path for browser automation actually works now. The permission check has always required automation's "advanced" mode, but no CLI command could turn it on, so following the written recipe left every capability stuck off. `careerrat automation mode advanced --write` now exists, and the docs walk through it first (#182).
- An interview story citing evidence that is not on record is now rejected even when your evidence file is empty. Before, an empty evidence bank switched that check off entirely, which is exactly when an invented citation is most likely (#182).
- Re-adding a company to your exclusion list no longer duplicates it when the existing entry carries an inline comment (#182).
- The guard that keeps CareerRat's web fetches away from private and internal addresses now catches every textual disguise of an internal IPv4 address inside an IPv6 one (mapped, NAT64, and 6to4 forms). The old check looked for a spelling Node's URL parser never actually produces, so it could not fire at all (#181).
- The updater's safety check that keeps a release archive from ever writing into your private candidate or workspace folders now matches those folder names case-insensitively and sees through path tricks, closing a bypass on the case-insensitive filesystems Macs and Windows machines actually use (#181).
- The checks that verify AI answers now enforce the size limits they always claimed to: an evaluation that comes back with too many fit reasons, or an over-long summary, gets rejected and retried instead of slipping through. Limits on your own saved tracker notes were dropped entirely rather than enforced, since your notes are yours and were never restricted when you wrote them (#174).
- The AI-powered job search now sees the keep and cut signals from your targeting file. It was only reading signals written inside individual role buckets, a place the standard setup never puts them, so searches ran without the "more like this, never that" guidance you had actually written down (#166).
- Reloading the page no longer clears your last Ask answer from the screen. The answer and its follow-up buttons come back exactly as they were, because the conversation was always saved; only the screen forgot it. An answer that was still being worked on, or that failed, is not replayed (#159).
- The workspace chat no longer offers "Enrich my profile". That action never had an implementation behind it, so choosing it could only fail with an error. A new automated check now guarantees every action the chat offers actually works, so a dead menu item like this cannot ship again (#153).

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
