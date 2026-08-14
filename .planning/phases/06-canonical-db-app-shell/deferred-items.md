# Deferred Items - Phase 06 Canonical DB App Shell

## 06-05

- `tests/db-app-shell-regression.test.mjs` product-boundary scan still fails on
  `src/cli/boards-route.mjs` reading `config/search-sources.yml`. This is expected
  06-06 ownership and was not fixed during packet-route migration.
