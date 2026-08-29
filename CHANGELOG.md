# Changelog

All notable changes to CareerRat are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.7] - 2026-08-29

0.16.6 was tagged but never published: no release assets, no npm publish, no
cask update. Everything listed under 0.16.6 ships here, plus the fixes below.

### Fixed

- Documentation describes the data layout a new install actually gets. Profile
  and workspace files live under `.careerrat/`, not beside the repo's own
  files, and the older top-level layout is called out as what an existing
  install has.
- The workspace visual test pins a ready engine instead of asking the host
  which AI CLIs are installed, so it passes on a machine that has none.

### Changed

- Release evidence records an AI runtime's path relative to the home directory
  instead of an absolute one, so a receipt committed to the public repository
  cannot publish the generating machine's account name.
- The live-search evidence generator withholds rows from companies on the
  personal-sentinel list before it counts them, so a public posting that
  happens to match one cannot trip the release-safety guard.

## [0.16.6] - 2026-08-28

### Changed

- Configured-board and AI web-search results are requalified after CareerRat captures the canonical job description. Location and office-day rules, compensation floor, seniority, posting age, work eligibility, and the candidate's saved fit bands now use the full posting before a role is saved, and per-company presentation limits apply only after that check. Job cards also recover clearly labeled salary or base-pay ranges from complete postings while leaving bonus, OTE, equity, total-comp, and partial-body ambiguity marked for verification.
- Conditional location policies stay visible instead of being flattened into a misleading city label, and RSS roles no longer repeat “at Company” inside a job card that already shows the company. Search also warns when the candidate already has an active application at the same company.
- Job threads now surface unresolved application answers in the right-side review panel. The candidate chooses **Answer**, writes the response in the normal composer, and CareerRat saves it against the exact application question before rebuilding the packet.
- Once the packet is ready, the same review panel explains supervised form preparation, offers the existing opt-in permission in place, and resumes only the matching paused application mission. CareerRat may fill confirmed fields and advance safe form steps, but the candidate always reviews and presses the final Submit control.
- Claude Code and OpenAI Codex remain the only supported product runtime choices. Both use the same CareerRat-owned workflows, skills, and durable state through direct installed-CLI adapters; v0.16.6 does not silently promote or fall back to another detected CLI.
- First-run setup presents CareerRat AI as an icon-and-label row matching the other runtime choices, instead of a bare text label, so the options read as one consistent list.
- Workspace, job, and research choices now share one durable click-or-type contract. Finite job, recruiter-thread, and company ambiguities render equal neutral choices that act on exact saved records without guessing or exposing internal IDs.
- Activity shows the twelve most recent steps instead of growing without a bound. The complete audit history remains local and durable.

### Fixed

- AI web search no longer stops at the old two-minute runtime limit and reports a misleading structured-output error. Claude Code and Codex now share an explicit eight-minute bound, and real runtime failures stop immediately instead of repeating the entire search as a schema retry.
- Long searches keep their sourcing run alive while CareerRat reads and saves full job descriptions, so a completed model search cannot be marked failed during post-search capture.
- Paul and the durable chat history show a plain-English retry message instead of model schemas, provider output, runtime codes, or parser details when AI search fails.
- Yes/No buttons appear only for genuinely binary questions. Either-or questions stay as normal text responses, while binary questions with a short lead-in still get buttons.
- Packet lineage recognizes unanswered question IDs as live review state instead of rebuilding a valid reviewable packet forever. A confirmed final answer resumes the owning paused mission instead of starting an unrelated preparation action.
- Saved North American home locations can answer the corresponding location screen deterministically, while voluntary demographic and self-identification answers remain explicit, local, and never inferred.
- Onboarding no longer advances to the next topic while a plain question with a short safety clarification is still waiting for the candidate's answer.
- First, manual, and AI searches now share one durable worker owner for progress, cancellation, settlement, clean shutdown, and restart recovery. AI search resumes its frozen prompts and provider plan instead of being orphaned by a route-local controller.
- Recording an application as Applied resolves its durable Submit gate and completes the owning mission in the same transaction, so a finished application cannot leave a ghost **Review & submit** action.
- Common AI, communication-draft, application-preparation, and board-discovery failures now explain what happened and what to do next in plain English.

### Verification

- Promotion requires one clean source revision to pass the repository and web suites, production web/docs/website builds, Biome, Qlty, Knip, placeholder and dependency checks, real Chromium UI and supervised application preparation, and the exact Claude Code/Codex hospitality and engineering native-search matrix with every emitted role manually reviewed.
- The tagged release workflow must then build and verify the signed, notarized, and stapled Mac app and updater feed, prove a real native update from the previous public version, and complete unsigned Windows packaging QA. A public Windows installer remains conditional on trusted SignPath Foundation signing and is not a macOS release blocker.

## [0.16.5] - 2026-08-27

### Changed

- Guided AI installation now shows trusted setup phases and recovery actions instead of streaming npm, shell, authentication, path, or stack output into the app.
- Browser setup uses plain product language and an in-app recovery action instead of provider, extension, Playwright, or CLI instructions.
- Expanded diagnostics explain that private raw details are hidden. They never render database errors, local paths, credentials, stack frames, parser text, or provider responses.

### Fixed

- Search translates skipped and failed lanes into candidate-facing states, removes unknown internal reason codes, and protects the no-lane summary and progress paths from raw backend copy.
- Browser-workflow cards derive their result message from the typed workflow state instead of displaying a persisted exception or backend summary.

### Release verification

- The repository suite passed 3,857 tests with 15 intentional skips and no failures. The full web suite passed all 776 tests, the combined candidate-error regression set passed 278 focused UI tests, and the browser/session suite passed all 50 tests. Web, website, docs, and desktop staging builds passed; lint completed without errors; placeholder lint, knip, actionlint, package inspection, dependency audit, and `git diff --check` passed.
- Protected PRs #235, #236, and #238 merged without changing branch protection. The signed `v0.16.5` tag points to the exact `main` promotion merge, and the public GitHub release contains the signed, notarized, and stapled DMG, signed updater ZIP, `latest-mac.yml`, and SPDX SBOM.
- The release pipeline passed Apple signing, notarization, stapling, Gatekeeper, packaged launch, Windows unsigned installer QA, and a native signed 0.16.4-to-0.16.5 update. `careerrat@latest`, the Homebrew cask, and careerrat.com are live at 0.16.5; the installed app reports 0.16.5 and its own update check reports current.

## [0.16.4] - 2026-08-26

### Added

- Signed Mac releases now update inside CareerRat. The app checks the atomic DMG, updater ZIP, and `latest-mac.yml` release feed, shows download progress, and waits for an explicit **Restart and install** before closing local services and applying the update.
- A one-time, non-modal GitHub star card can appear after the first successful search with matches. It never interrupts setup, empty searches, failed searches, or browser-only use.

### Changed

- Recoverable failures now explain what happened in plain English and tell the candidate exactly what to do next. Raw database paths, parser text, provider output, HTTP bookkeeping, and process details stay in logs instead of the interface.
- Location filtering now reads the captured job description, not just the board label. A listing marked Remote is rejected when its body requires too many office days or conflicts with the candidate's remote, hybrid, onsite, or commute limits.
- Search completion distinguishes new matches from matches already saved, so a dedupe-only refresh cannot look like an empty search.

### Fixed

- Profile setup accepts a normal no-relocation answer and saves every independently valid section when another section needs a retry.
- Onboarding no longer starts a duplicate Paul turn when a question ends with examples such as “For example” or “For instance.”
- Job capture now preserves the listing as its source while following a validated embedded application URL for supervised form filling.
- Failed packet loads, deep-ingest loads, discovery decisions, and discovery completion can be retried from the failure itself, and a successful retry clears the stale alert.
- Windows update notices now explain that no signed public installer is available yet and link to the current Windows release status instead of advertising a nonexistent download.

### Release verification

- The repository suite passed 3,856 tests with 15 intentional skips and zero failures after the recovery, locality, onboarding, application-link, and release-gate fixes. The web suite passed all 761 tests.
- A fresh Codex-backed desktop run completed resume intake, saved a remote-US and New York City hybrid profile with a two-day office limit, searched 358 listings across five sources, and retained four body-verified matches without admitting a five-day-office listing.
- The real-browser application harness passed all 11 Chromium scenarios, including résumé upload, native selects, Greenhouse and Ashby comboboxes, multistep forms, failure handoff, and prepare-only mode. The final Submit control was never clicked.
- Protected PRs #232, #233, and #234 merged without changing branch protection. The signed `v0.16.4` tag points to the exact `main` promotion merge, and the public GitHub release contains the notarized DMG, signed updater ZIP, `latest-mac.yml`, and SPDX SBOM.
- The release pipeline passed Apple signing, notarization, stapling, Gatekeeper, packaged launch, and a native signed 0.16.3-to-0.16.4 update. `careerrat@latest`, the Homebrew cask, and careerrat.com are live at 0.16.4; the installed app reports 0.16.4 and its own update check reports current.

## [0.16.3] - 2026-08-26

### Changed

- Paul now uses ordinary language for candidate-facing setup and replaces the abstract priority prompt with “What would make one job worth applying to before another?” plus concrete examples.
- Completing first run opens Search with an explicit running, matches-found, retry, or start state. The early location-aware search and the final targeting snapshot now resolve as one durable handoff instead of leaving a new user to guess where to go.
- Claude Code and OpenAI Codex remain the two first-class product choices. Both run the same CareerRat-owned workflows and durable threads through direct adapters without fallback, silent provider switching, or copy that presents one as the better engine.
- Profile now includes a local-only **Application defaults** editor for voluntary demographic and self-identification questions. They stay blank by default, or the candidate can choose the form's decline option when available; existing exact answers remain hidden and never enter Paul's context.
- First run now pauses at that local-only Application defaults choice when setup is otherwise complete and no choice has been confirmed. Saving either option hands off to the workspace and does not ask again on reload.

### Fixed

- Search title matching no longer promotes adjacent roles because a target phrase appears only in the job-description body. Locality filtering keeps home-country remote work and New York City local work while excluding foreign remote and unrelated local roles.
- Supervised application preparation recovers live Greenhouse typeaheads, waits for asynchronous choices to commit, fills safe confirmed fields, and uploads the generated résumé. Voluntary demographic answers are never inferred and use only the saved local Application defaults policy or an explicitly saved exact answer; CAPTCHAs and the final Submit control stay with the candidate.
- Screening answers now preserve multiline and semicolon-separated text, regenerated prompts cannot accept stale answer IDs, and manager/individual-contributor equivalence is applied before broader title matching.

### Release verification

- The release-candidate repository suite passed 3,848 tests with 15 intentional skips; the web suite passed all 712 tests. Web, website, docs, and desktop production builds passed, desktop smoke returned `SMOKE OK`, lint completed with no errors, knip and placeholder lint passed, and `git diff --check` is clean.
- A fresh desktop flow opened Search after setup and completed a locality-constrained search for home-country remote and New York City local roles. The successful result saved the full job description and a clean browser session reported zero errors and warnings.
- A real public Greenhouse form filled 22 fields and attached one résumé with zero unresolved fields. The CAPTCHA was the sole blocker, Submit stayed untouched, and the application remained at Reviewed Hold with `submitted_at` and `applied_at` null.
- A completed first-run setup with no confirmed voluntary-form policy showed only the local Application defaults dialog before any runtime or chat setup. Live passes covered both choices: **Leave them blank** saved the disabled blank policy, while **Choose decline when available** saved `enabled: true`, `default_action: decline_when_available`, a fresh `confirmed_at`, and `answers: {}`. Each handed off to the workspace, stayed dismissed after reload, and the current browser console reported zero errors and warnings.
- A fresh Codex-backed desktop intake rendered Paul's revised priority question in plain English with concrete examples, exposed clickable Yes/No answers for the preceding binary question, restored the conversation after reload, and reported zero current-context console errors or warnings.

## [0.16.2] - 2026-08-25

### Added

- A Mac with no supported AI tool now gets a plain-English Claude setup path inside CareerRat. It explains the paid-plan requirement, links to Scott's disclosed Claude referral, runs Anthropic's official native installer in an in-app progress console, walks the user through browser sign-in, and checks automatically until Claude Code is ready.

### Changed

- Empty first run now recommends one beginner path instead of showing a zero-runtime warning, a disabled interview action, and duplicate install cards. Codex remains available under “I already use another AI tool.”

### Fixed

- An installed but signed-out Claude Code or Codex can start sign-in directly from the engine picker instead of sending the user into Settings.
- The guided installer action keeps readable light text over its dark fill across the shared first-run button styles.

### Release verification

- The fixed macOS setup launcher runs one fixed official install command with `shell:false`, streams redacted progress into CareerRat, propagates launch and exit failures, and never accepts user-authored shell input. Unsupported, already-installed, non-desktop, and non-macOS requests fail closed.
- Focused UI, controller, route, and process-boundary tests pass. The full repository and web suites, production build, and changed-file lint pass.
- Real browser QA at the desktop layout covered the beginner screen, the collapsed Codex path, the in-app installer console, and the successful recheck transition into a ready Claude engine.

## [0.16.1] - 2026-08-25

### Changed

- Removed the website's redundant runtime-marketing sentence, restored calmer vertical spacing between sections, and updated the public docs with the completed v0.16.0 release state.

### Fixed

- The hosted-access email field and send action now share one bottom edge instead of rendering at mismatched heights.

## [0.16.0] - 2026-08-25

Release status: v0.16.0 is published. Protected PRs #217 and #218 merged, the
signed v0.16.0 tag points to the exact promotion merge on `main`, and the
signed, notarized, and stapled macOS release is public with its SBOM.
`careerrat@latest` is 0.16.0 and careerrat.com is running the production release.

### Added

- Claude Code and Codex are the only supported v0.16 product runtime choices. CareerRat invokes either installed CLI directly through an app-owned adapter, uses the same workflows and durable state for both, and never falls back to another provider. Other detected CLIs remain diagnostic until they pass the full product boundary and packaged acceptance matrix.
- Job search now combines deterministic job boards with bounded AI discovery, saves full job descriptions and source receipts, respects country-wide remote and New York City hybrid targeting, and reconciles overlapping results into one durable job.
- The desktop and website include the new CareerRat wordmark, favicon, and social sharing image. The Windows x64 installer passes build, install, launch, export, and uninstall QA; a public signed Windows asset remains blocked because SignPath Foundation signing requires project reputation CareerRat does not yet have.

### Changed

- The chat-first shell is now the sole product path. It uses compact activity, natural assistant bubbles, focused right-side editing, restrained confirmation controls, app-shaped menus, and a fixed desktop-first layout that can still maximize or enter full screen.
- CareerRat chooses runtimes by verified capabilities instead of provider names. Runtime definitions now separate technical adapter support from explicit product acceptance, so a detected binary or successful handshake cannot silently advertise incomplete workflows.
- Onboarding starts the first useful search as soon as targeting is ready, keeps one durable conversation, opens Deep ingest as its own resumable thread, and speaks to candidates in plain English throughout.
- Selected navigation, rows, tabs, providers, filters, switches, and checkboxes now share one neutral dark-gray fill. Ink remains a text and outline color, selection has no persistent accent glow, and keyboard focus remains visible.
- Board discovery now returns one validated review object and renders one compact source summary with a dedicated review window instead of a Markdown table, bookkeeping ledger, and a wall of inline actions.

### Fixed

- Reloading a saved conversation no longer exposes internal `careerrat:confirm` protocol blocks. Valid confirmations are rebuilt as normal controls, while malformed or stale protocol text stays hidden.
- Repeated search requests, progress receipts, stale running cards, and activity links now collapse into one current search result instead of filling the transcript.
- Onboarding turn scheduling no longer starts a second agent turn when the current reply already asks the next question, including questions followed by response instructions. Completed homes repair exact, prefaced, and prematurely stacked prompt repeats before rendering, while preserving distinct questions and answered turns. A résumé location no longer silently chooses remote, hybrid, or on-site preferences.
- Parallel deterministic and AI search lanes now reconcile in one transaction, stale workers cannot overwrite newer source configuration or completion state, hydration is bounded and cancellable, and search no longer re-probes every installed CLI on each click.
- Distinct requisitions with the same company and title now survive when their URL, provider requisition ID, or location differs; exact URL and requisition duplicates still collapse once.
- Evaluation fields reject drafting residue and self-corrections before persistence, retry once with either supported runtime, and fall back to manual review. Generic job capture now prefers structured JobPosting descriptions so full compensation and JD copy remain without source-site navigation or footer noise.
- Supervised application automation now accepts only a validated application entry point, re-checks every redirect by full origin before filling or uploading, preserves manual review after automation consent is withdrawn, and still never presses the final Submit button.
- Every editable permission switch now atomically updates its required provider scopes and consent, with the exact covered services shown in Settings, so a switch cannot appear on while the selected workflow remains blocked.
- Provider selection, routing, and persistence now require the complete accepted capability contract. Unsupported ACP adapters cannot become selectable through handshake evidence or a single support flag.
- Installed-runtime cancellation escalates from TERM to KILL on a bounded deadline, force-settles uncooperative children, and uses the same cleanup path for direct and ACP calls without leaving the request hanging.

### Release verification

- A fresh signed package passed new-candidate and returning-candidate onboarding, durable restart, Claude Code and Codex selection, runtime errors, forced cancellation, and process-cleanup QA without switching providers.
- A real coordinated search returned two live US-remote roles, retained New York City travel context, rejected foreign and non-NYC local results, preserved distinct requisitions, saved local JD evidence, and labeled both partial descriptions in the Jobs list.
- Source research renders one compact review card and decision window. Historical raw tables recover into that UI, while malformed output fails closed to a clear retry message.
- Supervised application QA filled and uploaded through a real three-step form, clicked only the two verified Next controls, and stopped on `Submit application` with `prepareOnly=true` and `submitClicked=false`.
- The full repository suite passed 3,737 tests with 15 intentional skips, the web suite passed 611 tests, and lint, Knip, builds, docs, website, security audit, workflow lint, signing, and package verification passed. Protected PRs #217 and #218 merged, the signed v0.16.0 tag points to `main`, the GitHub release and production website are live, and `careerrat@latest` is 0.16.0.
- The `codeswhat/tap/careerrat` Homebrew cask was updated to 0.16.0 and passed an in-place upgrade. `/Applications/CareerRat.app` reports version 0.16.0, passes Gatekeeper, and passed launch and visual inspection.

## [0.15.0] - 2026-08-24

### Added

- The complete chat-first handoff now ships as the only product shell, with first-class Deep ingest, durable job conversations, resumable missions, mock interviews, archive history, and whole-section profile editing.
- Installed AI engines are detected and presented in one in-app picker. Claude Code runs the full task-tool and research workflow, Codex runs isolated chat and drafting, and other detected CLIs stay visible until their runtime boundary is verified.
- Browser-backed mail, message, relationship, LinkedIn, and ATS-status workflows now share retained supervised sessions with explicit two-factor, CAPTCHA, retry, and final-submit handoffs.
- The public website has been rebuilt in the new visual system with the selected `CR.` website favicon, while the desktop app uses the stacked Career/Rat wordmark icon.

### Changed

- Candidate location policy now distinguishes worldwide remote, country-scoped remote, and local hybrid or on-site markets end to end across onboarding, discovery, prompts, scanning, settings, and generated agent context.
- Search selections collapse into one "Apply to N jobs" action. Application preparation fills supported fields in the supervised browser and always returns to a compact user submit gate.
- CareerRat now opens at 1280 by 860 but remains resizable, maximizable, and full-screen capable down to its 1100 by 680 minimum.

### Fixed

- Mission pause requests now stop before the next step is claimed, including when an installed CLI call finishes at the same time as the pause request.
- Optional blank application fields no longer inflate the answered-question count or force current packets to regenerate forever.
- Pipeline rows use user-facing review states and typed status copy instead of internal notes, tracked-row counts match what the list shows, location confirmation heals correctly, and duplicate artifact paths collapse to one Files card.
- The sidebar uses ink only for the active conversation, chat replies use neutral bubbles, Deep ingest uses the corrected pickaxe treatment, and the selected navigation no longer carries a glow or focus surround.

## [0.14.0] - 2026-08-24

### Added

- CareerRat now opens into a chat-first desktop workspace. The main conversation stays central, selected work fills the context panel, and Search, Pipeline, Files, People, and Schedule remain one click away without returning to the retired page-based dashboard.
- Job, recruiter, and research conversations are durable threads that survive navigation and restart. Multi-job work runs as a resumable mission, Deep ingest has its own thread and grounded review flow, and mock interviews stay attached to the job that prompted them.
- The complete bundled skill catalog now ships with the desktop app and runs through visible conversations, including sourcing, evaluation, tailoring, application preparation, communications, research, interview work, and outcome learning.

### Changed

- Résumé-first onboarding is conversational: drop a résumé or start talking, watch the candidate profile fill in beside the conversation, and open a focused section editor only when something needs correction.
- Supervised application automation can inspect a form, prepare role-specific artifacts, and fill confirmed fields. It always stops before the final Submit action so the candidate reviews and submits the application.

## [0.13.0] - 2026-08-23

### Added

- Four new job sources: Job Bank Canada, MyCareersFuture Singapore, Senjob for Senegal, and Yourator for Taiwan. CareerRat now implements all 77 public providers in its pinned source snapshot, and the doctor command derives its provider count from the manifest so the number can never go stale again (#200).
- Job descriptions for Greenhouse, Recruitee, and SmartRecruiters listings now load from each posting's detail endpoint during a sweep, so triage sees real posting text instead of an empty body (#199).

### Changed

- The vendored job-source providers rolled forward to the latest upstream snapshot: Lever listings with multiple locations no longer appear once per location, Ashby fetches retry and detect remote roles, accented characters like the é in Montréal now decode correctly in titles and locations across several sources, EchoJobs is retired upstream, and eight providers pace their requests more politely (#199).
- Lever job text now comes from the provider's own plain-description field, and structured salary ranges from Ashby, Manfred, and Welcome to the Jungle are recovered into the comp field, where they were silently dropped before (#199).

### Fixed

- The chat ask bar is visible again on phone-sized screens instead of rendering below the fold, reserves the right amount of space on tall desktop windows, and fades page content behind it without covering open panels (#198).
- The calendar's This Week number now always matches the agenda list below it, including weeks with more events than the list can hold and events that land on weekends (#198).
- Saving evidence claims now actually validates them against the schema; a wiring gap had made that check a silent no-op (#197).
- Machine-generated searches no longer fall back to a default job title when none can be derived from your profile, and any stored searches created by that old fallback are reconciled away (#197).
- Duplicate-company detection now ignores legal suffixes like Inc and GmbH, education only appears in tailored resumes when you opt in, the dashboard picks up tracker changes live without a manual refresh, and the Mac app follows normal macOS behavior when its last window closes (#197).

### Security

- Every outbound request a job sweep makes now goes through the private-network guard: redirects re-check DNS on every hop, lookups are bound to the request deadline, seven major ATS providers that still used older unguarded fetch paths now route through the guarded adapters, RSS feeds gained the same guard plus a deadline, and Consider's session handshake is guarded too (#199).

## [0.12.2] - 2026-08-22

### Changed

- careerrat.com now leads with the chat: the whole page describes CareerRat as a free Mac app you talk to, with the AI underneath framed as "bring your own AI" instead of CLI plumbing. The engine section shows a Settings-style card instead of a fake terminal, the privacy section says "Everything lives on your Mac" instead of "self-host it", and the npm command left the hero for the install section. The app screenshots now sit in a flat framed window with the site's chrome dots so they no longer blend into the page background (#194).

## [0.12.1] - 2026-08-22

### Changed

- careerrat.com now presents CareerRat as a Mac app first: the hero's main action is downloading the signed app, the walkthrough starts at "Download and open it", and the install section leads with the app and Homebrew. The npm path stays on the page as the way in for every other platform (#191).
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
