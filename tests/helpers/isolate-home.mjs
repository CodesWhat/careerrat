// Loaded with `node --test --import` for the whole suite. Some code resolves a
// documents folder from os.homedir(), and a test that forgets to point it elsewhere
// used to write fake application packets into the developer's real ~/Documents/careerrat.
// Each test process gets a throwaway HOME, and the process fails if anything still
// appears under the real one.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realHome = process.env.CAREERRAT_TEST_REAL_HOME || process.env.HOME || "";
if (realHome) {
  const guarded = join(realHome, "Documents", "careerrat");
  const existedBefore = existsSync(guarded);
  const fakeHome = mkdtempSync(join(tmpdir(), "careerrat-test-home-"));
  // The throwaway HOME hides the browsers Playwright downloaded under the real one.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const cache =
      process.platform === "darwin"
        ? join(realHome, "Library", "Caches", "ms-playwright")
        : join(realHome, ".cache", "ms-playwright");
    if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  }
  process.env.CAREERRAT_TEST_REAL_HOME = realHome;
  // CLI children would start a detached update check that writes into this
  // home after the test exits; tests never want the network check anyway.
  process.env.CAREERRAT_NO_UPDATE_CHECK = "1";
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.on("exit", () => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (!existedBefore && existsSync(guarded)) {
      console.error(
        `A test wrote to the real ${guarded}. Point it at a temp dir (CAREERRAT_DOWNLOADS_DIR or HOME).`
      );
      process.exitCode = 1;
    }
  });
}
