# Career Ops provider conformance snapshot

These provider contract tests come from `career-ops-hq/career-ops` commit
`8a20e491fdde2c928a54ff17a7bfe07ca5d2ab40` under its MIT license.

Rolled forward 2026-09-07 from `ffb49be1f394041840c31c23a5d3a3347854340e`. The
fixtures for the providers upstream actually changed between those two
commits were re-adapted from upstream's suites: `icims` gained a "Location
enrichment" section covering `pickLocation` walking every `jobLocation` entry
instead of trusting only the first one, including the two required regression
cases (an all-`UNAVAILABLE` first entry no longer masking a usable later one,
and the pre-existing single-entry behavior staying unchanged); `gem` gained
the new REST API test block (`parseRestResponse` normalization, envelope
handling, and `fetch()`'s REST-endpoint pinning); `radancy` was rewritten in
full for the retry-wrapped transport, cache-buster, `ctx.maxPages` probing,
and cap-warning accuracy that replaced its prior behavior wholesale; `wttj`
gained the server-side `filters` config test block; `greenhouse` gained the
`/offices` order-stability regression test (#3750). `workday`'s fixture is
unchanged: upstream's own suite in this range doesn't exercise
`chooseSplitFacet`'s new location-hint awareness at all, and the updated
provider file is independently covered by `tests/intake-resolve.test.mjs`
(71/71) and this snapshot's own conformance run. The remaining fixtures are
untouched from the prior pin.

Three new fixtures were added for the providers adopted from this range:
`builtin`, `collage`, and `garena`, adapted from upstream's suites the same
way the existing fixtures are. `telegram-channel` was evaluated and deferred,
not adopted (see the vendor README), so it has no fixture.

Rolled forward 2026-08-23 from `8be39e0934b83410276d66b541bf3a2edf3411cb`. Only
the fixtures for the providers upstream actually changed between those two
commits were re-adapted from upstream's suites — `echojobs`, `consider`,
`lever`, `csod`, `beesite`, `hackernews`, `phenom`, `tkms`, `ashby`,
`greenhouse`, `recruitee`, `smartrecruiters`, `avature`, `eightfold`, `getro`,
`icims`, `oraclecloud`, `tencent`, `themuse`, `workday`. The shared
`_html-entities.mjs` decoder's expanded Latin-1 entity table is exercised
through the `csod`/`beesite`/`hackernews`/`phenom`/`tkms` fixtures, which now
assert decoded titles, rather than a standalone fixture — this snapshot's
conformance runner (`tests/provider-upstream-conformance.test.mjs`) only
imports `providers/<id>.conformance.mjs` for a real provider id, so a
`_html-entities` fixture would never execute. The remaining 53 provider
fixtures are untouched from the prior pin.

`jobbankca`, `mycareersfuture`, `senjob`, and `yourator` were added
2026-08-23 when those four providers moved from
`CAREER_OPS_DEFERRED_PROVIDER_IDS` into the adopted set — their fixtures are
new, not rolled forward, and use invented, domain-neutral sample data rather
than upstream's live-captured payloads.

The 85 public-network provider suites are copied with their filenames and import
roots adapted so Node's test runner executes them against
`src/core/providers/career-ops/vendor`. The VDAB/jobbankca/mycareersfuture
ambient `config/profile.yml` fallback assertions are omitted because CareerRat
injects DB-backed candidate keywords through its registry instead; that
replacement has first-party coverage. One Remotli mock salary is changed to
`219500` because the upstream value is an intentional CareerRat private-data
release sentinel; the assertion remains equivalent. `local-parser` is excluded
because it executes user-configured local commands and is not a network
source.

CareerRat owns the small assertion helper in this directory. Shared CareerRat
tests separately cover the wrapper transport, normalized offer contract,
provenance, dedupe, and full-JD hydration.
