# Career Ops provider snapshot

These provider modules are vendored from
[`career-ops-hq/career-ops`](https://github.com/career-ops-hq/career-ops) at
commit `8a20e491fdde2c928a54ff17a7bfe07ca5d2ab40` (September 7, 2026). Upstream
moved from `santifer/career-ops` to the `career-ops-hq` org on 2026-09-01, the
repository name is unchanged, only the owner.

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
