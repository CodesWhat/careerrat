# Career Ops provider snapshot

These provider modules are vendored from
[`santifer/career-ops`](https://github.com/santifer/career-ops) at commit
`8be39e0934b83410276d66b541bf3a2edf3411cb` (August 14, 2026).

CareerRat uses the public network adapters under the upstream MIT license. The
upstream `local-parser` module is intentionally excluded because it executes
user-configured local commands and is not a public source adapter.

`_http.mjs` and `_profile-keywords.mjs` are CareerRat compatibility shims. They
keep requests inside CareerRat's injected, timeout-bound transport and keep
candidate lookup inside CareerRat's workspace model.

