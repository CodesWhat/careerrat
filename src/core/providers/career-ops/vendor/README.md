# Career Ops provider snapshot

These provider modules are vendored from
[`santifer/career-ops`](https://github.com/santifer/career-ops) at commit
`10a569b1e9178aa90ef8028ea287e411a831e1b6` (August 23, 2026).

Rolled forward 2026-08-23 from `8be39e0934b83410276d66b541bf3a2edf3411cb`
(August 14, 2026). Only the providers upstream actually changed between those
two commits were re-vendored — `echojobs`, `consider`, `lever`, `csod`,
`beesite`, `hackernews`, `phenom`, `tkms`, `ashby`, `greenhouse`, `recruitee`,
`smartrecruiters`, `avature`, `eightfold`, `getro`, `icims`, `oraclecloud`,
`tencent`, `themuse`, `workday` — plus the shared `_html-entities.mjs` decoder
(now covers Latin-1 letter entities and case-sensitive matching) and the new
shared `_html-to-text.mjs` helper it introduced for description hydration. The
remaining provider files are untouched from the prior pin. The four providers
upstream added since the prior pin (`jobbankca`, `mycareersfuture`, `senjob`,
`yourator`) were deliberately not vendored — that is a separate adoption
decision.

CareerRat uses the public network adapters under the upstream MIT license. The
upstream `local-parser` module is intentionally excluded because it executes
user-configured local commands and is not a public source adapter.

`_http.mjs` and `_profile-keywords.mjs` are CareerRat compatibility shims. They
keep requests inside CareerRat's injected, timeout-bound transport and keep
candidate lookup inside CareerRat's workspace model.

