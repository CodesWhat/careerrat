#!/usr/bin/env node
// One-off: high-DPI shot of the jobs table to verify every status renders as a
// coloured badge (incl. multi-word labels). Element screenshot auto-scrolls.
import { chromium } from "playwright";

const BASE = process.env.CAREERRAT_DEV_URL || "http://localhost:7777";
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1320, height: 1200 },
  deviceScaleFactor: 2,
});
await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(400);
const tbl = await page.$("table.jobs");
await tbl.scrollIntoViewIfNeeded();
await tbl.screenshot({ path: "tracker-status.png" });
console.log("wrote tracker-status.png");
await browser.close();
