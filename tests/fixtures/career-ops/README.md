# Career Ops provider conformance snapshot

These provider contract tests come from `santifer/career-ops` commit
`8be39e0934b83410276d66b541bf3a2edf3411cb` under its MIT license.

The 73 public-network provider suites are copied with their filenames and import
roots adapted so Node's test runner executes them against
`src/core/providers/career-ops/vendor`. The VDAB-only ambient
`config/profile.yml` fallback assertions are omitted because CareerRat injects
DB-backed candidate keywords through its registry instead; that replacement has
first-party coverage. `local-parser` is excluded because it executes
user-configured local commands and is not a network source.

CareerRat owns the small assertion helper in this directory. Shared CareerRat
tests separately cover the wrapper transport, normalized offer contract,
provenance, dedupe, and full-JD hydration.
