#!/usr/bin/env node
// One-off: screenshot the running tracker:dev page so we can eyeball company
// logos on the card avatars and the status badges in the jobs table.
import { chromium } from "playwright";
import { readEnv } from "../src/core/env-compat.mjs";

const BASE = readEnv("CAREERRAT_DEV_URL") || "http://localhost:7777";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1700 } });
// `load` not `networkidle` — the dev server holds an SSE hot-reload connection
// open, so the network is never idle.
await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(400);

const shots = [
  [".active-section", "tracker-cards.png"],
  ["table.jobs", "tracker-table.png"],
];
for (const [sel, out] of shots) {
  const el = await page.$(sel);
  if (el) {
    await el.screenshot({ path: out });
    console.log(`wrote ${out}`);
  } else {
    console.log(`no ${sel} found`);
  }
}
await browser.close();
