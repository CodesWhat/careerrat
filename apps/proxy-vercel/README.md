# Rolester managed-AI proxy — Vercel deployment

Serverless front end for `src/cli/ai-proxy.mjs`'s per-request pipeline (see that file and `src/cli/proxy-core.mjs`). No JSONL fallback here — apply `scripts/meter-db-schema.sql` to your Supabase project **before** the first request.

Deploy (run from this directory; imports reach into `../../src/cli/`, so enable
"Include files outside the Root Directory" in the Vercel project's Root
Directory settings, or deploy from the repo root instead):

    vercel --scope codeswhat

Required env vars (Project Settings → Environment Variables):
`ROLESTER_PROXY_TOKEN` or `ROLESTER_PROXY_TOKENS`, `ROLESTER_UPSTREAM_KEY`,
`ROLESTER_METER_DB_URL`, `ROLESTER_METER_DB_KEY`. Optional (same as the node
proxy): `ROLESTER_UPSTREAM_URL/_HEADERS/_REPORTING`, `ROLESTER_METER_DB_TABLE`,
`ROLESTER_PROXY_USER_CAP_USD`, `ROLESTER_PROXY_USER_CAPS`.
