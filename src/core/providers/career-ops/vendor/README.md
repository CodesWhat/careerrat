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
  Not yet ported, because only providers in later slices import them:
  `resolveDefaultTimeoutMs` (teamtailor) and `fetchTextStream` (workable).
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
