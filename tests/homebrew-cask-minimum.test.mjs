import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const generator = readFileSync(
  new URL("../scripts/generate-homebrew-cask.sh", import.meta.url),
  "utf8"
);
const releaseDoc = readFileSync(new URL("../docs/RELEASE.md", import.meta.url), "utf8");

// The shipped app's LSMinimumSystemVersion is 13.0 (Electron 44). Homebrew's
// artifact audit fails the tap update when the cask declares a lower minimum,
// which is how v0.19.2's cask bump was rejected.
test("generated cask declares the app's macOS 13 minimum", () => {
  const declared = generator.match(/depends_on macos: :(\w+)/);
  assert.ok(declared, "generator must declare a macOS minimum");
  assert.equal(declared[1], "ventura");
});

test("release docs agree with the generator's macOS minimum", () => {
  assert.match(releaseDoc, /currently 13\.0, so `:ventura`/);
  assert.doesNotMatch(releaseDoc, /currently 12\.0, so `:monterey`/);
});
