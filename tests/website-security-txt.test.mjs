import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SECURITY_TXT = new URL("../apps/website/public/.well-known/security.txt", import.meta.url);

test("website serves an RFC 9116 security.txt with Contact and a live Expires", async () => {
  const body = await readFile(SECURITY_TXT, "utf8");
  assert.match(body, /^Contact: (mailto:|https:\/\/)\S+$/m, "security.txt needs a Contact field");
  const expires = body.match(/^Expires: (\S+)$/m);
  assert.ok(expires, "security.txt needs an Expires field");
  const expiresAt = Date.parse(expires[1]);
  assert.ok(!Number.isNaN(expiresAt), `Expires is not a valid date: ${expires[1]}`);
  assert.ok(
    expiresAt > Date.now(),
    `security.txt Expires (${expires[1]}) has passed. Renew it in apps/website/public/.well-known/security.txt.`
  );
  assert.ok(
    expiresAt - Date.now() <= 366 * 24 * 60 * 60 * 1000,
    `security.txt Expires (${expires[1]}) is more than a year out, which RFC 9116 advises against.`
  );
});
