import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { seedDemo } from "../src/core/db/demo-seed.mjs";
import { candidateConfigPatch, sourcingRunComplete } from "../src/core/db/verbs/index.mjs";
import { startFirstSearchRun } from "../src/core/onboarding/first-search-run.mjs";

const PRODUCT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIVE = process.env.CAREERRAT_LIVE_BROWSER === "1";
const SCREENSHOT_PATH = join(PRODUCT_ROOT, "output", "playwright", "chat-first-workspace.png");

async function seedVisualWorkspace(home) {
  const env = {
    ...process.env,
    CAREERRAT_HOME: home,
    CAREERRAT_AI_PROXY_URL: "http://127.0.0.1:9",
  };
  const pathCtx = { repoRoot: PRODUCT_ROOT, env };
  seedDemo({ ...pathCtx, today: "2026-08-27" });
  // Pin a ready engine. Without a selection the workspace asks the host which
  // AI CLIs are installed, finds none on a machine that has neither, and raises
  // the modal EngineDownCover over everything, which swallows the clicks below.
  writeInstalledRuntimeSelection({ ...pathCtx, runtimeId: null, providerFallback: true });
  candidateConfigPatch({
    ...pathCtx,
    name: "form-defaults",
    patch: {
      voluntary_self_identification: {
        enabled: false,
        default_action: "leave_blank",
        confirmed_at: "2026-08-27T12:00:00.000Z",
        answers: {},
      },
    },
  });
  const started = await startFirstSearchRun({
    ...pathCtx,
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  sourcingRunComplete({
    ...pathCtx,
    id: started.run.id,
    summary: { scanned: 0, new: 0, errors: [], offers: [] },
  });
  return pathCtx;
}

async function closeDevServer(dev) {
  await dev.shutdownAppOperations();
  await dev.shutdownSourcingWorkers?.();
  dev.chatRuntime.shutdown();
  if (dev.server.listening) {
    await new Promise((resolve) => dev.server.close(resolve));
  }
}

test("real Chromium renders the built chat-first workspace without selection glow or alignment drift", {
  skip: !LIVE && "set CAREERRAT_LIVE_BROWSER=1 to run the built app visual contract",
  timeout: 30_000,
}, async () => {
  assert.equal(
    existsSync(join(PRODUCT_ROOT, "apps", "web", "dist", "index.html")),
    true,
    "build apps/web before running the visual contract"
  );

  const home = mkdtempSync(join(tmpdir(), "careerrat-visual-workspace-"));
  const pathCtx = await seedVisualWorkspace(home);
  const dev = createDevServer(pathCtx);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await dev.listen({ port: 0, host: "127.0.0.1" });
    const baseUrl = `http://127.0.0.1:${dev.server.address().port}`;
    // The workspace intentionally keeps its live-reload EventSource open,
    // so networkidle can never be the readiness signal for this page.
    await page.goto(`${baseUrl}/app/`, { waitUntil: "domcontentloaded" });

    const workspace = page.locator(".chat-first-workspace");
    await workspace.waitFor({ state: "visible" });
    const returnToThreads = page.locator('button[aria-label="Return to threads"]');
    if (await returnToThreads.isVisible()) await returnToThreads.click();
    await page.locator('.chat-first-thread-card[aria-current="page"]').waitFor();
    await page.locator('.chat-first-composer input[aria-label^="Message "]').waitFor();

    const layout = await workspace.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        minWidth: style.minWidth,
        overflow: style.overflow,
        bodyScrollWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    assert.equal(layout.width, 1440);
    assert.equal(layout.height, 900);
    assert.equal(layout.minWidth, "1100px");
    assert.equal(layout.overflow, "hidden");
    assert.equal(layout.bodyScrollWidth, layout.viewportWidth);

    const selected = page.locator('.chat-first-thread-card[aria-current="page"]');
    const selectedStyle = await selected.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
    assert.deepEqual(selectedStyle, {
      backgroundColor: "rgb(71, 74, 79)",
      borderTopWidth: "0px",
      outlineWidth: "0px",
      boxShadow: "none",
    });

    const selectedBadge = selected.locator(".chat-first-thread-card__icon-badge");
    const selectedBadgeStyle = await selectedBadge.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        outlineStyle: style.outlineStyle,
        boxShadow: style.boxShadow,
      };
    });
    assert.deepEqual(selectedBadgeStyle, {
      backgroundColor: "rgb(217, 166, 244)",
      borderTopWidth: "0px",
      outlineStyle: "none",
      boxShadow: "none",
    });

    const inputBox = await page
      .locator('.chat-first-composer input[aria-label^="Message "]')
      .boundingBox();
    const sendBox = await page
      .locator('.chat-first-composer button[aria-label="Send message"]')
      .boundingBox();
    assert.ok(inputBox && sendBox, "composer controls have rendered geometry");
    const inputCenter = inputBox.y + inputBox.height / 2;
    const sendCenter = sendBox.y + sendBox.height / 2;
    assert.ok(Math.abs(inputCenter - sendCenter) <= 1, "composer input and send button align");

    const pickaxe = page.locator('.chat-first-deep-card [data-icon="pickaxe"]');
    await pickaxe.waitFor({ state: "visible" });
    const pickaxeBox = await pickaxe.boundingBox();
    const pickaxeBadgeBox = await pickaxe.locator("xpath=..").boundingBox();
    assert.ok(pickaxeBox && pickaxeBadgeBox, "deep-ingest icon has rendered geometry");
    assert.ok(pickaxeBox.width <= 14 && pickaxeBox.height <= 14, "pickaxe stays compact");
    assert.equal(pickaxeBadgeBox.width, 24);
    assert.equal(pickaxeBadgeBox.height, 24);

    const pill = page.locator(".chat-first-deep-card .chat-first-pill");
    const pillStyle = await pill.evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderRadius: style.borderRadius, fontSize: style.fontSize };
    });
    assert.equal(pillStyle.borderRadius, "999px");
    assert.equal(pillStyle.fontSize, "12px");

    const actionRows = page.locator(".chat-first-need-card__actions");
    const actionRowCount = await actionRows.count();
    for (let index = 0; index < actionRowCount; index += 1) {
      const justifyContent = await actionRows
        .nth(index)
        .evaluate((element) => getComputedStyle(element).justifyContent);
      assert.equal(justifyContent, "flex-end");
    }

    mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await closeDevServer(dev);
    closeAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test("real Chromium restores the original Settings editor control after Keep editing", {
  skip: !LIVE && "set CAREERRAT_LIVE_BROWSER=1 to run the built app visual contract",
  timeout: 30_000,
}, async () => {
  assert.equal(
    existsSync(join(PRODUCT_ROOT, "apps", "web", "dist", "index.html")),
    true,
    "build apps/web before running the visual contract"
  );

  const home = mkdtempSync(join(tmpdir(), "careerrat-settings-focus-"));
  const pathCtx = await seedVisualWorkspace(home);
  const dev = createDevServer(pathCtx);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await dev.listen({ port: 0, host: "127.0.0.1" });
    const baseUrl = `http://127.0.0.1:${dev.server.address().port}`;
    await page.goto(`${baseUrl}/app/settings?panel=editor&section=targets`, {
      waitUntil: "domcontentloaded",
    });

    const editor = page.locator("#cf-profile-editor-titles");
    await editor.waitFor({ state: "visible" });
    await editor.fill(`${await editor.inputValue()}\nPrincipal Platform Engineer`);
    await editor.focus();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Discard unsaved changes?" }).waitFor();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await editor.waitFor({ state: "visible" });

    assert.equal(await page.evaluate(() => document.activeElement?.id), "cf-profile-editor-titles");
  } finally {
    await browser.close();
    await closeDevServer(dev);
    closeAll();
    rmSync(home, { recursive: true, force: true });
  }
});
