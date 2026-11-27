# Career Ops provider snapshot

These provider modules are vendored from
[`career-ops-hq/career-ops`](https://github.com/career-ops-hq/career-ops) at
commit `13786939dc79e0ec324b5571c9e6f29c50d43b53` (November 26, 2026). Upstream
moved from `santifer/career-ops` to the `career-ops-hq` org on 2026-09-01, the
repository name is unchanged, only the owner.

Rolled forward 2026-11-27 (CR70 slice 0, foundation only) from
`8a20e491fdde2c928a54ff17a7bfe07ca5d2ab40`. This roll moves the pin and adds
the shared plumbing the 70 new upstream providers need; it adopts no provider.
Every provider file in this directory is still the pre-roll copy, and the 70
new ids sit in `CAREER_OPS_DEFERRED_PROVIDER_IDS` as "CR70 slice N pending"
until their slice lands (see `.planning/cr70-slices.md`). Comments stay
verbatim from upstream; only message strings we emit are re-punctuated.

- New helpers copied verbatim: `_cached-lookup`, `_city-slug`, `_country`,
  `_department-team`, `_employment-type`, `_html-entity-table`, `_ids`,
  `_safe-url`, `_salary-text`, `_workplace-type`, `_wp-job-feed`.
  `_config-utils` and `_html-entities` picked up upstream changes verbatim.
- New `../lib/` directory (sibling of this one, matching upstream's
  `providers/../lib/` import path): `board-truncation.mjs` and `parse-date.mjs`
  verbatim except one em dash in a note string, and `posting-close.mjs`
  trimmed to `closesAtIso`. Upstream's `closeDatesByUrl`/`closeDateForUrl`
  read a scan-history file through `scan-history-columns.mjs` and `url-key.mjs`,
  which CareerRat does not vendor, and no provider imports them.
- `_http.mjs` stays our shim (every request goes through `guardedFetch`;
  upstream's transport, `_dns-cache`, `_ip-guard`, `_connection-scope` and
  `_http-cache` are not vendored, and nothing adopted imports them). It gained
  `fetchResponseWithRetry`, `isCloudflareChallenge`, and the matching
  non-retry cases in `isRetryableError` (Cloudflare challenge, oversize body,
  blocked address, spent timeout). `career-ops-registry.mjs` now keeps the
  `cf-mitigated` response header on a failed request as `cfMitigated`, which is
  what `isCloudflareChallenge` reads. Both local User-Agent exports stay.
  `resolveDefaultTimeoutMs` (teamtailor) and `fetchTextStream` (workable) were
  ported in the CR70 leftovers pass below.
- Hand-merged, local additions kept: `_html-to-text.mjs` takes upstream's
  tag-start and quadratic-backtracking fixes, `stripHtmlComments`,
  `replaceScriptStyleBlocks`, `visibleText` and `{ cap }` option, and keeps
  `htmlToTextCapture`/`capDescriptionText`/`DESCRIPTION_MAX_BYTES`. A bare
  `htmlToText()` is bounded by `DESCRIPTION_MAX_BYTES`, not upstream's
  `DESCRIPTION_CAP` default; a caller passing `{ cap }` gets exactly that.
  `_registry.mjs` and `_types.js` took upstream's changes with the local
  `fetchDetail`/`descriptionPartial` typedefs carried forward.
  `_profile-keywords.mjs` is unchanged: upstream's diff only touches the
  `config/profile.yml` fallback this compatibility module deliberately omits.
- Not touched: `robots-check.mjs` (only upstream's `sitemap` provider uses it,
  and it pulls in `_ip-guard`; decide it with slice 18), `_trust-validator`
  (nothing we adopt imports it).

CR70 slice 1 (2026-11-27) re-vendored verbatim from `13786939`: a16z-speedrun-talent, agentic-jobs, amazon, arbeitnow, arbeitsagentur, avature. Notable upstream changes: amazon reads multi-city locations and sizes its page budget from reported hits, a16z-speedrun-talent gained filters and job details, arbeitsagentur reports partial boards, avature reads per-country pages. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 2 (2026-11-27) re-vendored verbatim from `13786939`: bamboohr, beesite, breezy, builtin, careerviet, comeet, cryptocurrencyjobs, csod, dassault, deutschebahn, echojobs, eightfold. bamboohr now sends `redirect: 'manual'` on its list request and reads `err.status`/`err.location`; `guardedFetch` never follows a non-follow redirect, so the SSRF guard is unchanged, and `tests/provider-parity.test.mjs` now expects `manual` for that request. The bamboohr and cryptocurrencyjobs fixtures drop the cases that import upstream's `scan.mjs` (`buildLocationFilter`, `isOfferSeen`, `markOfferSeen`, `listingIdentityToken`), which CareerRat does not vendor. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 3 (2026-11-27) re-vendored verbatim from `13786939`: feishu-jobs, garena, gem, getro, glints, hecklerkoch, higheredjobs, himalayas, ibm, icims. hackernews was in this slice's list but is NOT re-vendored here: the new upstream file imports `../ats-vendor.mjs`, a repo-root upstream module CareerRat does not vendor, so it moves to the re-port slices (9 to 11) and keeps its pre-roll copy. The icims fixture reads its HTML sample from `tests/fixtures/career-ops/icims-search-page.html`. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 4 (2026-11-27) re-vendored verbatim from `13786939`: itviec, jibeapply, jobbankca, jobicy, jobspresso, jobstreet, jobvite, join. The jobbankca fixture is regenerated from upstream's suite minus the `config/profile.yml` fallback case (CareerRat's `_profile-keywords` has no ambient filesystem fallback); the join fixture drops the `scan.mjs` dedup cases (`isOfferSeen`, `markOfferSeen`, `listingIdentityToken`). Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 5 (2026-11-27) re-vendored verbatim from `13786939`: justjoin, landingjobs, larajobs, lever, manfred, mokahr, mycareersfuture, nodesk, oraclecloud, personio. Upstream's lever and oraclecloud import `isWorkModelOnly` from `greenhouse.mjs`, which still resolves against the pre-roll copy until slice 9. The mokahr, oraclecloud and mycareersfuture fixtures drop the cases that import upstream's `scan.mjs`/`url-key.mjs` or read `config/profile.yml`. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 6 (2026-11-27) re-vendored verbatim from `13786939`: phenom, pinpoint, radancy, remoteok, remotive, remotli, rheinmetall, rippling, senjob, softgarden. successfactors was in this slice's list but is NOT re-vendored here: the new upstream file imports `./successfactors-classic.mjs`, a new provider that lands in slice 17, so successfactors moves to that slice and keeps its pre-roll copy. The rippling fixture drops the `scan.mjs` dedup cases. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 7 (2026-11-27) re-vendored verbatim from `13786939`: tencent, thehub, themuse, tkms, torre. teamtailor was in this slice's list but is NOT re-vendored here: the new upstream file imports `resolveDefaultTimeoutMs` from `_http.mjs`, a transport export the shim does not carry, so it moves to the re-port slices and keeps its pre-roll copy. The themuse fixture drops the `verify-portals.mjs` `classifyFetchError` assertions. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 8 (2026-11-27) re-vendored verbatim from `13786939`: vdab, weworkremotely, workingnomads, wttj, yourator. workable was in this slice's list but is NOT re-vendored here: the new upstream file imports `fetchTextStream` from `_http.mjs`, a transport export the shim does not carry, so it moves to the re-port slices and keeps its pre-roll copy. The vdab fixture drops the `config/profile.yml` fallback case. Across slices 1 to 8, four listed providers stayed on their pre-roll copy for a dependency outside `providers/`: hackernews (`ats-vendor.mjs`), successfactors (`successfactors-classic`, a new provider), teamtailor (`resolveDefaultTimeoutMs`) and workable (`fetchTextStream`). Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 9 (2026-11-27) hand-ported from `13786939` onto our copies (three-way against `8a20e491`, not overwritten): greenhouse and workday. greenhouse takes upstream's large-board path (a board too big for `content=true` is read as the plain list, with opt-in per-posting detail fetches), `locations`, `listingIdentity`, external and requisition ids, and department/team fields; it keeps the byte-capped `htmlToTextCapture` description with `descriptionPartial`, the `decodeEntities` title and the `company_name`/`entry.name` company fallback. workday takes upstream's `validReqToken`/`workdayPostingId` identity rules, `WORKDAY_TRUNCATED_REASON`, stop reasons and the new `stripWorkdayRepostSuffix`; it keeps `fetchDetail`, `resolvePostingEndpoint`, `workdayHeaders` and `isRequisitionIdShaped`. The repost-suffix check in `stripRepostSuffixKeepCase` now calls `isRequisitionIdShaped` instead of upstream's two backtracking regexes, so the CR-29 round 3 and 4 fixes (underscore-bearing ids, bounded time on a long failing base) still hold; hyphen bases keep upstream's single-digit-only suffix rule. The workday fixture is now the full upstream suite (it covers `workdayDedupKey` and CXS-form URLs), with the cap-advice regex made case-insensitive for the re-punctuated warning. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 10 (2026-11-27) hand-ported from `13786939` onto our copies (three-way against `8a20e491`): ashby, consider and recruitee. ashby takes upstream's `compensationTiers` reader (widest readable Salary component, interval required on a nested component) and keeps the local `summaryComponents` Salary lookup as the starting source when a payload has no tiers. consider takes upstream's version of the handshake: upstream now sends it through `ctx.fetchResponse` with `fetchResponseWithRetry`, which is the divergence CareerRat carried, so the local comment is gone and the local `timeoutMs` option stays. recruitee takes upstream's language versions, multi-place `assembleLocation`, salary, listing identity and a thrown error on an unexpected envelope, and keeps the byte-capped `htmlToTextCapture` description by threading `descriptionPartial` through `versionText` and `languageVersions`. `tests/ats-providers.test.mjs` now expects recruitee to throw on a missing envelope, to fold city, country and remote into a flat location, and to drop an offer with no usable URL. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 11 (2026-11-27) hand-ported from `13786939` onto our copies (three-way against `8a20e491`): smartrecruiters, meituan and alibaba. smartrecruiters takes upstream's identity, department, employment-type and retry changes and keeps `extractDescriptionCapture`, so a detail body past the byte cap is cut and `descriptionPartial` is set. meituan and alibaba take upstream's safe id encoding and `markTruncated` on a failed or short page, and keep `capDescriptionText` in place of upstream's 4000-character slice, so a posting past the byte cap carries `descriptionPartial`. The smartrecruiters fixture drops the cases that import upstream's `scan.mjs` (`buildPostingAgeFilter`, `isOfferSeen`, `markOfferSeen`, `listingIdentityToken`); each of the three fixtures gains a local `descriptionPartial` case. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 12 (2026-11-27) newly adopted from `13786939`: atlassian, factorial, hiringroom, generalist-world, germantechjobs, startup-jobs, pythonorg, prevueaps, hibob, inhire, remote-com, applitrack. The hibob fixture is a node:test suite; the remote-com, inhire and startup-jobs fixtures drop their `scan.mjs` cases. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 13 (2026-11-27) newly adopted from `13786939`: aldi-nord, apple, bwi, bulldogjob, deel, bolt, dover, paylocity, polymer, redrover, notion, jazzhr. The aldi-nord fixture is a node:test suite; the apple and bolt fixtures drop their `scan.mjs` cases. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 14 (2026-11-27) newly adopted from `13786939`: bizneo, computrabajo, goldman, google, hirehive, itjobs, magneto, neogov, occ, paycom, schoolspring. The computrabajo, hirehive and magneto fixtures are node:test suites; the goldman and paycom fixtures drop their `scan.mjs` dedup cases. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 15 (2026-11-27) newly adopted from `13786939`: pracecz, platsbanken, jobscz, kalibrr, techinasia, kariyer, kula, rexx, tes, velorahr, trakstar, keka, homerun. The pracecz, platsbanken and jobscz fixtures drop their `config/profile.yml` fallback case (CareerRat's `_profile-keywords` has no ambient filesystem fallback) but keep the no-keywords error case; the rexx and velorahr fixtures drop their `scan.mjs` cases. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 16 (2026-11-27) newly adopted from `13786939`: adp-myjobs, adp-workforcenow, applicantpro, careerpuck, clearcompany, darwinbox, eploy, inrecruiting, pageup, taleo, ultipro, zoho-recruit. The applicantpro, eploy and zoho-recruit fixtures read their sample pages from `tests/fixtures/career-ops/` (copied from upstream, MIT). Message strings we emit are re-punctuated; comments stay verbatim.

CR70 slice 17 (2026-11-27) newly adopted from `13786939`: gupy, peoplesoft, talentlink, successfactors-classic, turbohire, taleez, viterbit, wp-job-manager. successfactors was re-vendored verbatim here (it was held back in slice 6 because the new upstream file imports successfactors-classic) and its fixture regenerated. The peoplesoft fixture reads its sample pages from `tests/fixtures/career-ops/` and drives the real `createContext()` transport instead of upstream's `makeHttpCtx()`; for that, `fetchResponse` in `career-ops-registry.mjs` now hands a raw 3xx back when a provider asks for `redirect: 'manual'` (guardedFetch already declined to follow it), which peoplesoft's same-origin redirect walk needs. The gupy fixture drops its `config/profile.yml` fallback case, the successfactors, successfactors-classic and taleez fixtures drop their `scan.mjs` cases, and the talentlink fixture is a node:test suite. Message strings we emit are re-punctuated; comments stay verbatim.

CR70 leftovers (2026-11-27) re-vendored verbatim from `13786939`: teamtailor, workable and hackernews, the three held back for a dependency the shim lacked. `_http.mjs` gains `resolveDefaultTimeoutMs` (verbatim) and `fetchTextStream`, a standalone export like upstream's that calls `guardedFetch` instead of fetch: the private-address screen and DNS pinning apply, `redirect` defaults to `error`, `timeoutMs` bounds the whole transfer, and `maxBytes` (default 10 MiB) bounds the decoded body with `response_too_large`. `ats-vendor.mjs` is vendored verbatim at `career-ops/ats-vendor.mjs`, the path hackernews imports it from. The workable fixture drops the `scan.mjs` `buildLocationFilter` and dedup cases and keeps a direct board_slug check; teamtailor and hackernews fixtures are unchanged apart from the vendor path. Message strings we emit are re-punctuated; comments stay verbatim.

Rolled forward 2026-09-07 from `ffb49be1f394041840c31c23a5d3a3347854340e`
(September 2, 2026). `icims.mjs` was re-vendored verbatim: upstream's
`pickLocation` now walks every `jobLocation` entry instead of trusting only the
first one, so an all-`UNAVAILABLE` first entry no longer masks a usable later
one (#3727/#3728). Four providers changed upstream only by having their
message strings re-punctuated to CareerRat's no-em-dash house style once
copied in verbatim, on top of real upstream feature work: `gem.mjs` (adds an
optional `api.gem.com` REST endpoint alongside the existing GraphQL board),
`radancy.mjs` (retry-wrapped transport, a `randomUUID()` cache-buster, and
`ctx.maxPages` probe-budget support with cap-warning accuracy fixes), `wttj.mjs`
(a server-side Algolia `filters` config that raises the per-request hits cap
from 200 to 1000 and makes `queries` optional), and `_registry.mjs` (a
JSDoc-only comment change).

Three new providers were adopted: `builtin.mjs` (Built In's board-wide
aggregator, two-payload joining of the server-side ItemList JSON with rendered
job-card enrichment, market-host allowlisting, and a loud warning if card
enrichment silently fails), `collage.mjs`, and `garena.mjs` (both small,
single/multi-tenant public job-board APIs with SSRF host-pinning; `garena.mjs`
also guards its office/id path segments against `.`/`..` traversal). A fourth
new provider, `telegram-channel.mjs`, was evaluated and deferred rather than
adopted: it scrapes public Telegram channel web-preview pages with heuristic
per-post employer attribution, and upstream's own measurement shows only a 25%
pass rate on its RU/CIS test corpus and 0% on its EN corpus, too fragile and
low-precision for general adoption. See `CAREER_OPS_DEFERRED_PROVIDER_IDS` in
`src/core/providers/provider-parity.mjs`.

Four files changed upstream in this range and were hand-ported into
CareerRat's own copies instead of being overwritten, because CareerRat has
either replaced, extended, or added to them:

- `greenhouse.mjs` picked up upstream's one change in this range: the
  `/offices`-derived location suffix is now sorted before being joined, not
  left in `/offices` traversal order, which Greenhouse never promised was
  stable between responses (#3750-style dedup-key stability). CareerRat's
  local extensions on this file (`htmlToTextCapture`/`decodeEntities` for a
  byte-capped, entity-decoded description, and the `entry.name` company
  fallback) are unaffected and carried forward unchanged.
- `workday.mjs` picked up upstream's one real change in this range:
  `chooseSplitFacet` is now location-hint aware (it prefers a location-shaped
  facet when `ctx.locationHints` is set) and offset-clamp recovery now detects
  a `splitIncomplete` coverage gap when no usable split facet exists or the
  chosen split still undercounts the true total. It is not byte-identical to
  upstream: it still carries every CareerRat-local addition from the prior
  roll (`fetchDetail`, `resolvePostingEndpoint`, `workdayHeaders`,
  `isRequisitionIdShaped`), which `src/core/intake/resolve.mjs`'s exact-URL
  resolution path and `workdayDedupKey`'s cross-site disambiguation still
  depend on. `tests/intake-resolve.test.mjs`'s Workday cases (71/71) confirm
  the hand-port didn't disturb either. One upstream commit cited for this
  range (CXS-form URL resolution) produced no actual diff against the prior
  pin at this file, verified byte-for-byte; nothing was ported for it.
- `_http.mjs` gained a new exported `isRefusedRedirectError` helper,
  distinguishing a redirect refused by the mandatory SSRF guard
  (`redirect:'error'` meeting a 3xx, #1440) from other `TypeError`s, and wired
  it into `isRetryableError` so a refused redirect is never treated as
  transient. CareerRat's local additions to this shim are unaffected.
- `_types.js` (a CareerRat-local extension of the JSDoc `@typedef`s) gained
  upstream's new optional `salary: {min?, max?, currency?}` Job property,
  attached only when a source exposes real figures. `career-ops-registry.mjs`'s
  existing `formatSalaryRange()` already consumes it generically; no registry
  change was needed. CareerRat's local `descriptionPartial`/`fetchDetail`
  additions on this file are unaffected.

Rolled forward 2026-09-02 from `10a569b1e9178aa90ef8028ea287e411a831e1b6`
(August 23, 2026). Only the providers upstream actually changed between those
two commits were re-vendored: `a16z-speedrun-talent`, `getonbrd`, `icims`,
`jobbankca`, `jobstreet`, `remotli`, `yourator` copied verbatim, no import in
any of them needed a shim change. Five providers upstream added in the same
range were adopted alongside them, also copied verbatim: `careerviet`,
`feishu-jobs`, `itviec`, `mokahr`, `torre`. The remaining provider files are
untouched from the prior pin.

Four files changed upstream in this range and were hand-ported into
CareerRat's own copies instead of being overwritten, because CareerRat has
either replaced, extended, or added to them:

- `workday.mjs` picked up upstream's real changes (facet-split pagination for
  offset-clamped tenants, a CXS-URL detection fix, and the new `dedupKey`
  export), but is not byte-identical to upstream: it also carries a
  CareerRat-local `fetchDetail` (plus its `resolvePostingEndpoint` and
  `workdayHeaders` helpers), which upstream's `workday.mjs` has never had at
  any pin. `src/core/intake/resolve.mjs`'s exact-URL resolution path depends
  on it for canonical company/title/location/full-JD hydration on a single
  matched posting. A verbatim copy silently deletes that capability without
  erroring anywhere, caught only by `tests/intake-resolve.test.mjs`'s Workday
  cases. Anyone rolling this pin forward again needs to re-port the same
  three symbols onto the new upstream body rather than overwrite the file.
- `_http.mjs` (a CareerRat compatibility shim, see below) gained upstream's
  new `MACOS_BROWSER_LIKE_USER_AGENT` export, which the new `feishu-jobs`
  provider imports for a WAF that rejects the shared Windows UA string.
- `_html-to-text.mjs` carries a CareerRat-local extension (a 64 KB byte cap
  with a `truncated`/`descriptionPartial` signal upstream doesn't have) on top
  of upstream's `htmlToText`. Upstream replaced the naive
  `noMedia.replace(/<[^>]+>/g, ' ')` tag stripper with a safer sequence that
  requires content between the angle brackets, so a `>` inside a quoted
  attribute value can no longer end a tag early and leak the rest of that
  attribute into the description; that fix was ported into the byte-capped
  local version, preserving the cap and its `truncated` flag.
- `workday.mjs` also carries a second local fix on top of the one above
  (2026-09-04, CR-29 round 3): `workdayDedupKey`'s cross-site "-N" disambiguator
  guard rejected valid requisition-ID shapes that contain a hyphen or
  underscore before the first digit (Walmart's `R-2593225`, `JR_2024_00123`),
  so a direct board URL and the same posting republished on a second site
  never collapsed to one key. The guard's character class was broadened to
  accept hyphens/underscores throughout; behavior for every previously-passing
  shape is unchanged. A third local fix (CR-29 round 4) replaced that same
  guard's single regex with an equivalent linear check
  (`isRequisitionIdShaped`): the broadened character class made the pattern
  catastrophically backtrack on a long failing base (~1.15s on a 2,000-char
  probe), which is enough to block the event loop before a fetch timeout
  would apply. The accepted/rejected shapes are unchanged.
- `_types.js` (a CareerRat-local extension of the JSDoc `@typedef`s) gained
  upstream's new optional `dedupKey` on the `Provider` contract: a
  provider-scoped identifier used where URL normalization is too coarse (e.g.
  a Workday requisition ID reused across a tenant's several sites).

CareerRat uses the public network adapters under the upstream MIT license. The
upstream `local-parser` module is intentionally excluded because it executes
user-configured local commands and is not a public source adapter.

`_http.mjs` and `_profile-keywords.mjs` are CareerRat compatibility shims. They
keep requests inside CareerRat's injected, timeout-bound transport and keep
candidate lookup inside CareerRat's workspace model.

## Local deviations (Codex pass 1 fixes, 2026-11-27)

These files differ from upstream on purpose. Re-vendoring must keep them.

- Response-size limits live in `career-ops-registry.mjs`, not in a vendor file:
  `fetchJson`, `fetchText` and `fetchResponse` read the decoded body with a
  byte count, cancel it at the limit and throw `response_too_large`. The limit
  is the request's `maxBytes`, or 10 MiB when a provider sets none.
- `workday.mjs`: `stripRepostSuffixKeepCase` strips a one-digit `-N` suffix only
  (upstream allows two). `JR2024-12` and `JR2024-13` are different requisitions
  and must keep distinct identities.
- `career-ops-registry.mjs` copies a stored `--query` into `gupy`, `jobscz`,
  `platsbanken` and `pracecz` keyword config (as it already did for
  `arbeitsagentur`, `vdab`, `jobbankca` and `mycareersfuture`) when the entry's
  own block sets no keywords. An explicit `keywords` list, or gupy's `q`, wins.
- `greenhouse.mjs`: `/offices` is fetched whenever a work-model-only posting
  ("Hybrid") has no usable inline office name, including after a successful
  `content=true` read. Upstream only fetches it on the oversized-board fallback.
  Inline office names still win where a posting has them. The greenhouse fixture
  changed to match.
