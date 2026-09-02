# Career Ops provider conformance snapshot

These provider contract tests come from `career-ops-hq/career-ops` commit
`10a569b1e9178aa90ef8028ea287e411a831e1b6` under its MIT license.

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

The 77 public-network provider suites are copied with their filenames and import
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
