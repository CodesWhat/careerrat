// verbs.mjs — the M6 spec's named deliverable, split per entity under
// verbs/ (app.mjs/sourced.mjs/comm.mjs/activity.mjs/analytics.mjs/shared.mjs)
// since a single file for every domain action would be unwieldy. This barrel
// is the one import surface CLI/HTTP actually use.
export * from "./verbs/index.mjs";
