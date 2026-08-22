#!/usr/bin/env node
// One-shot capture of the chat activity-line UI (#171's icon/spinner rows,
// fed live by #175's installed-claude SSE streaming) for the README/docs
// screenshots. Drives the real dashboard the same way a person would: select
// the claude runtime, graduate onboarding, ask the AskBar a question that
// triggers a research skill (real web searches), and record the tool_use/
// tool_result activity lines as they stream in.
//
// Prereq — boot the isolated demo backend/SPA first (separate terminal):
//   bash scripts/demo-serve.sh
//
// Then, once both :7788 and :5173 are up:
//   node scripts/capture-chat-demo.mjs
//
// Re-runnable at a release cut against a freshly-seeded .demo-home: this
// script performs the onboarding graduation itself (ai-runtime select,
// quick-start, finish) rather than assuming a prior manual step, so a clean
// `bash scripts/demo-serve.sh` + this script is the whole recipe. No
// machine-specific paths — everything reads/writes inside the repo, and the
// web port is the only configurable knob (CAREERRAT_DEMO_WEB_PORT), matching
// demo-serve.sh's fixed vite default.
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WEB_PORT = process.env.CAREERRAT_DEMO_WEB_PORT || "5173";
const BASE_URL = `http://localhost:${WEB_PORT}`;
const APP_URL = `${BASE_URL}/app/`;

const OUT_DIR = join(REPO_ROOT, "assets", "screenshots");
const SCRATCH_DIR = join(REPO_ROOT, ".demo-capture"); // gitignored, removed at the end

const WIDTH = 1280;
const HEIGHT = 800;
const GIF_WIDTH = 960;
const MAX_GIF_BYTES = 5 * 1024 * 1024;

// A market-comp question rather than a company-health one: company-health
// on the seeded demo tracker resolves to "Tyrell Corporation," which real web
// search correctly identifies as ambiguous with the fictional Blade Runner
// company — the model's honest answer is a disambiguation request, not a
// useful-looking demo. research-comp never needs to resolve a company at
// all, so it returns a substantive cited answer every time.
//
// Must be "market comp for <role> in <location>" verbatim (no "what's"
// prefix) — compResearchRequestFromText's own intent handler in
// workspace-agent.mjs throws RESEARCH_COMP_INPUT_REQUIRED unless BOTH role
// and location resolve, and only this exact shape's regex captures both;
// the "what's market comp for X" phrasing folds "in Austin" into the role
// string instead and leaves location empty.
const ASK_TEXT = "Market comp for a Senior Platform Engineer in Austin.";

function log(msg) {
  console.log(`[capture-chat-demo] ${msg}`);
}

async function checkPortsUp() {
  // 7788 is hardcoded, not read from CAREERRAT_DEV_PORT — demo-serve.sh
  // unconditionally exports that value itself before booting, so this is
  // the one port a demo-serve.sh-booted backend can ever be on.
  const targets = [`${BASE_URL}/app/`, `http://localhost:7788/api/health`];
  for (const url of targets) {
    try {
      const res = await fetch(url);
      if (!res.ok && res.status !== 404) {
        throw new Error(`${url} responded ${res.status}`);
      }
    } catch (err) {
      throw new Error(
        `${url} is not reachable (${err.message}). Run \`bash scripts/demo-serve.sh\` first and wait for both ports.`
      );
    }
  }
}

// Onboarding graduation — run in-page (not via node fetch) so the request
// carries the real browser Origin/Referer and the capability cookie the vite
// dev proxy's capabilityCookieRelay already attached on navigation. Mirrors
// exactly what a person clicking through onboarding would trigger.
async function graduateOnboarding(page) {
  const results = await page.evaluate(async () => {
    async function post(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        // non-JSON error body — status alone is enough to report
      }
      return { url, status: res.status, ok: res.ok, json };
    }
    return [
      await post("/api/settings/ai-runtime/select", { runtimeId: "claude" }),
      await post("/api/onboard/quick-start", {}),
      await post("/api/onboard/finish", {}),
    ];
  });
  for (const r of results) {
    log(`${r.ok ? "ok" : "warn"} ${r.status} ${r.url}`);
  }
  return results;
}

// Resolves a usable ffmpeg binary without hardcoding a machine-specific
// Homebrew prefix — PATH first (portable across machines/CI), falling back to
// the common macOS Homebrew locations this repo's contributors actually use.
function resolveFfmpeg() {
  const candidates = ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore" });
      return bin;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("ffmpeg not found on PATH or in common Homebrew locations");
}

function ffmpegGif(ffmpeg, { input, start, duration, factor, fps, width, out, paletteOut }) {
  const filter = `setpts=PTS/${factor},fps=${fps},scale=${width}:-1:flags=lanczos`;
  // -ss/-t as INPUT options (before -i), not output options — ffmpeg 8.1's
  // palettegen single-frame muxer emits "No filtered frames for output
  // stream" / an empty file when -ss/-t are given as output options instead.
  execFileSync(ffmpeg, [
    "-y",
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-i",
    input,
    "-vf",
    `${filter},palettegen=stats_mode=diff`,
    paletteOut,
  ]);
  execFileSync(ffmpeg, [
    "-y",
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-i",
    input,
    "-i",
    paletteOut,
    "-filter_complex",
    `${filter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    "-loop",
    "0",
    out,
  ]);
}

// Converts the raw webm to a <5MB GIF, retrying at lower fps/width per the
// spec's "drop to ~10-12 fps if needed" before giving up.
function convertToGif(ffmpeg, input, out, { start, duration, factor }) {
  const attempts = [
    { fps: 15, width: GIF_WIDTH },
    { fps: 10, width: GIF_WIDTH },
    { fps: 10, width: 800 },
    { fps: 8, width: 800 },
  ];
  const paletteOut = join(SCRATCH_DIR, "palette.png");
  let lastSize = null;
  for (const attempt of attempts) {
    ffmpegGif(ffmpeg, { input, start, duration, factor, out, paletteOut, ...attempt });
    lastSize = statSync(out).size;
    log(`gif attempt fps=${attempt.fps} width=${attempt.width} → ${lastSize} bytes`);
    if (lastSize <= MAX_GIF_BYTES) return lastSize;
  }
  log(`warn: gif still ${lastSize} bytes after all fallback attempts`);
  return lastSize;
}

async function main() {
  await checkPortsUp();
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    recordVideo: { dir: SCRATCH_DIR, size: { width: WIDTH, height: HEIGHT } },
  });

  // Surfaces the raw SSE frame sequence in Node's stdout for verification —
  // the same assistant/tool_use/tool_result/chat_state/error types
  // ChatPanel.jsx's useEventSource subscribes to.
  await context.addInitScript(() => {
    const OrigES = window.EventSource;
    const tracked = new Set(["assistant", "tool_use", "tool_result", "chat_state", "error"]);
    const origAdd = OrigES.prototype.addEventListener;
    OrigES.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
      if (!tracked.has(type)) return origAdd.call(this, type, listener, options);
      const wrapped = function wrappedListener(...args) {
        try {
          console.log(`[SSE] ${type} ${args[0]?.data}`);
        } catch {
          // best-effort logging only
        }
        return listener.apply(this, args);
      };
      return origAdd.call(this, type, wrapped, options);
    };
  });

  const sseLog = [];
  const page = await context.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("[SSE]")) sseLog.push(text);
  });

  const recordingStart = Date.now();

  log(`loading ${APP_URL} (pre-graduation)`);
  await page.goto(APP_URL, { waitUntil: "networkidle" });

  log("graduating onboarding…");
  await graduateOnboarding(page);

  log(`reloading ${APP_URL} (post-graduation)`);
  await page.goto(APP_URL, { waitUntil: "networkidle" });

  const askInput = page.locator(".ask-bar__input");
  await askInput.waitFor({ state: "visible", timeout: 15000 });
  await askInput.fill(ASK_TEXT);

  // Best-effort: give the debounced classify preview a moment to resolve so
  // Enter commits the deterministic company.health ACTION row (selected by
  // default once preview.action exists) instead of racing it as a plain
  // free-text answer.
  await page
    .locator(".ask-bar__preview-kind--action")
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => log("warn: no action preview row before commit — proceeding anyway"));

  const tCommit = Date.now();
  await askInput.press("Enter");

  log("waiting for the research chat panel to mount…");
  await page.locator(".ask-bar__research-chat").waitFor({ state: "visible", timeout: 30000 });

  log("waiting for the first tool_use activity line (spinner)…");
  await page
    .locator(".chat-activity-line__spinner")
    .first()
    .waitFor({ state: "visible", timeout: 60000 });
  const tPendingFirst = Date.now();
  const pendingShot = join(SCRATCH_DIR, "pending.png");
  await page.screenshot({ path: pendingShot });
  log(`captured pending still at t+${((tPendingFirst - recordingStart) / 1000).toFixed(1)}s`);

  log("waiting for the turn to settle (no more spinners)…");
  await page
    .waitForFunction(
      () => {
        if (document.querySelector(".chat-activity-line__spinner")) return false;
        const hint = document.querySelector(".ask-bar__research-chat .field__hint");
        return Boolean(hint) && !/thinking/i.test(hint.textContent || "");
      },
      null,
      { timeout: 240000, polling: 500 }
    )
    .catch(() => log("warn: settle condition timed out — capturing current state anyway"));
  await page.waitForTimeout(1000); // let the settle re-render finish before the still
  // .chat-transcript is a fixed-height scroll box (apps/web/src/styles/app.css)
  // with no auto-scroll-to-bottom of its own — a research turn with several
  // WebSearch calls fills it with activity lines and leaves the actual
  // finished answer scrolled out of view underneath them. Scroll to the
  // bottom so the still (and the GIF's tail) shows the real answer a person
  // would see once they scrolled, not an accidental screenshot of just the
  // tool log.
  await page.evaluate(() => {
    const el = document.querySelector(".ask-bar__research-chat .chat-transcript");
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300); // let the scroll settle before the still
  const tSettled = Date.now();
  const settledShot = join(SCRATCH_DIR, "settled.png");
  await page.screenshot({ path: settledShot });
  log(`captured settled still at t+${((tSettled - recordingStart) / 1000).toFixed(1)}s`);

  await page.waitForTimeout(1500); // brief hold so the GIF doesn't cut off mid-settle
  const tEnd = Date.now();

  const video = page.video();
  await context.close();
  const rawVideoPath = await video.path();
  await browser.close();

  log(`SSE frames observed: ${sseLog.length}`);
  for (const line of sseLog) log(line);
  if (!sseLog.some((l) => l.startsWith("[SSE] tool_use"))) {
    throw new Error(
      "Zero tool_use SSE frames observed — the activity-line UI never had anything to render. " +
        "Not faking assets; investigate the runtime before re-running."
    );
  }

  // Trim to the interesting window (lead-in before send → settle + hold),
  // speed-adjusted so the final GIF always lands in the 12-24s target
  // regardless of how long the real web searches actually took.
  const rawStart = Math.max(0, (tCommit - recordingStart) / 1000 - 1);
  const rawEnd = (tEnd - recordingStart) / 1000;
  const rawDuration = rawEnd - rawStart;
  const factor = rawDuration > 24 ? rawDuration / 20 : rawDuration < 12 ? rawDuration / 13 : 1;
  log(
    `trim window: start=${rawStart.toFixed(1)}s duration=${rawDuration.toFixed(1)}s factor=${factor.toFixed(2)}`
  );

  const ffmpeg = resolveFfmpeg();
  const gifOut = join(SCRATCH_DIR, "chat-activity.gif");
  const gifSize = convertToGif(ffmpeg, rawVideoPath, gifOut, {
    start: rawStart,
    duration: rawDuration,
    factor,
  });

  const finalGif = join(OUT_DIR, "chat-activity.gif");
  const finalPending = join(OUT_DIR, "chat-activity-pending.png");
  const finalSettled = join(OUT_DIR, "chat-activity-settled.png");
  renameSync(gifOut, finalGif);
  renameSync(pendingShot, finalPending);
  renameSync(settledShot, finalSettled);

  rmSync(SCRATCH_DIR, { recursive: true, force: true });

  log("done:");
  log(`  ${finalGif} (${gifSize} bytes)`);
  log(`  ${finalPending} (${statSync(finalPending).size} bytes)`);
  log(`  ${finalSettled} (${statSync(finalSettled).size} bytes)`);
}

main().catch((err) => {
  console.error(`[capture-chat-demo] FAILED: ${err.message}`);
  if (!process.env.CAREERRAT_DEMO_KEEP_SCRATCH) {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
  process.exit(1);
});
