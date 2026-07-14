# Rolester managed-AI proxy — Vercel deployment

Serverless front end for `src/cli/ai-proxy.mjs`'s per-request pipeline (see that file and `src/cli/proxy-core.mjs`). No JSONL fallback here — apply `scripts/meter-db-schema.sql` to your Supabase project **before** the first request.

Deploy — use the staging script (imports reach into `../../src/cli/`, and a
bare CLI deploy from this directory would not carry them; the script assembles
a flat self-contained copy and deploys that):

    bash scripts/deploy-proxy-vercel.sh --prod --yes

Clients use the bare deployment domain as the base URL (e.g.
`ROLESTER_AI_PROXY_URL=https://rolester-proxy.vercel.app`): vercel.json
rewrites `/v1/*` onto the function's `/api/v1/*` mount, and the handler strips
the `/api` prefix before metering and upstream forwarding.

Required env vars (Project Settings → Environment Variables):
`ROLESTER_PROXY_TOKEN` or `ROLESTER_PROXY_TOKENS`, `ROLESTER_UPSTREAM_KEY`,
`ROLESTER_METER_DB_URL`, `ROLESTER_METER_DB_KEY`. Optional (same as the node
proxy): `ROLESTER_UPSTREAM_URL/_HEADERS/_REPORTING`, `ROLESTER_METER_DB_TABLE`,
`ROLESTER_PROXY_USER_CAP_USD`, `ROLESTER_PROXY_USER_CAPS`.
