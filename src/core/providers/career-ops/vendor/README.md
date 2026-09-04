# Career Ops provider snapshot

These provider modules are vendored from
[`career-ops-hq/career-ops`](https://github.com/career-ops-hq/career-ops) at
commit `ffb49be1f394041840c31c23a5d3a3347854340e` (September 2, 2026). Upstream
moved from `santifer/career-ops` to the `career-ops-hq` org on 2026-09-01, the
repository name is unchanged, only the owner.

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
