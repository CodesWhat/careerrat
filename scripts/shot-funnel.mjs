#!/usr/bin/env node
// One-off: screenshot the funnel section of the running tracker:dev page so we
// can eyeball the stage-driven "Furthest stage" column.
import { chromium } from "playwright";

const BASE = process.env.CAREERRAT_DEV_URL || "http://localhost:7777";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
await page.goto(BASE, { waitUntil: "load" });
const svg = await page.$("#sankey");
if (svg) {
  await svg.screenshot({ path: "tracker-funnel.png" });
  console.log("wrote tracker-funnel.png");
} else {
  await page.screenshot({ path: "tracker-funnel.png", fullPage: false });
  console.log("no #sankey found — wrote viewport screenshot");
}
await browser.close();
