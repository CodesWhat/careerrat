#!/usr/bin/env node
// Browser-verify the dashboard themes against a running `npm run tracker:dev`.
// Loads the page, switches into each family+mode, asserts the resolved
// data-theme key and the computed --bg token, screenshots each, and fails on any
// console error. Screenshots are written as tracker-theme-*.png (gitignored).
import { chromium } from "playwright";

const BASE = process.env.CAREERRAT_DEV_URL || "http://localhost:7777";

// family → mode → expected resolved --bg (lowercased hex from styles.mjs)
const EXPECT = {
  tokyonight: { light: "#e1e2e7", dark: "#1a1b26" },
  gruvbox: { light: "#fbf1c7", dark: "#282828" },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "load" });

let failures = 0;
for (const [family, modes] of Object.entries(EXPECT)) {
  for (const [mode, expectedBg] of Object.entries(modes)) {
    // Drive the page's own persistence path, then reload so the boot script
    // resolves the theme exactly as a real user's saved choice would.
    await page.evaluate(
      ([f, m]) => {
        localStorage.setItem("careerrat-theme", f);
        localStorage.setItem("careerrat-mode", m);
      },
      [family, mode]
    );
    await page.goto(BASE, { waitUntil: "load" });

    const resolved = await page.getAttribute("html", "data-theme");
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()
    );
    const selectVal = await page.$eval("#theme-select", (el) => el.value);

    const wantKey = `${family}-${mode}`;
    const ok = resolved === wantKey && bg === expectedBg && selectVal === family;
    if (!ok) failures++;
    console.log(
      `${ok ? "OK  " : "FAIL"} ${wantKey.padEnd(18)} data-theme=${resolved} --bg=${bg} (want ${expectedBg}) select=${selectVal}`
    );

    await page.screenshot({ path: `tracker-theme-${wantKey}.png`, fullPage: false });
  }
}

if (consoleErrors.length) {
  failures += consoleErrors.length;
  console.log(`\nConsole errors (${consoleErrors.length}):`);
  for (const e of consoleErrors) console.log(`  ✗ ${e}`);
} else {
  console.log("\nNo console errors.");
}

await browser.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
