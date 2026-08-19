// Guards the test helper itself. fixture-server.mjs only ever serves plain HTML
// out of tests/fixtures/**, so none of this is reachable by a user. It is still
// worth pinning: CodeQL flags the path handling as js/path-injection, and the
// honest answer to that flag has to be a test that shows the containment holds,
// not a suppression comment.
//
// What the original version actually got wrong, for the record, because the
// three failures were not equally real and it is worth not flattening them:
//
//   - None of the LEXICAL traversal cases below escaped it. normalize() plus a
//     leading-"../" strip happens to land back inside the root every time, so
//     the CodeQL path-injection alerts on those were pattern matches.
//   - The SYMLINK case did escape, and returned 200 with the contents of a file
//     outside the root. A string comparison cannot see a symlink, so no amount
//     of care with the path text would have caught it. That one was real.
//   - `/%` threw an uncaught URIError out of the request handler and took the
//     whole server process down mid-test, which showed up as some unrelated
//     test dying rather than this one failing.

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFixtureServer } from "./helpers/fixture-server.mjs";

// Lays out a root with two traps beside it: a plain sibling directory, and a
// sibling whose name *extends the root's name*. The second is what a bare
// `filePath.startsWith(root)` check lets through, so the tree has to be shaped
// this way for the assertion to mean anything.
function makeFixtureTree() {
  const base = mkdtempSync(join(tmpdir(), "careerrat-fixture-server-"));
  const root = join(base, "fix");
  mkdirSync(root);
  writeFileSync(join(root, "ok.html"), "<p>ok</p>");

  const prefixSibling = `${root}tures-elsewhere`;
  mkdirSync(prefixSibling);
  writeFileSync(join(prefixSibling, "secret.txt"), "LEAKED-SIBLING");
  writeFileSync(join(base, "outside.txt"), "LEAKED-OUTSIDE");

  // A symlink that lives INSIDE the root and points OUTSIDE it. This is the one
  // case a purely lexical containment check cannot catch, because the escape is
  // a filesystem property rather than a property of the path text. Before the
  // realpath check it returned 200 with the linked file's contents.
  symlinkSync(join(base, "outside.txt"), join(root, "linked-secret.txt"));

  return { root };
}

async function withServer(run) {
  const { root } = makeFixtureTree();
  const server = await startFixtureServer(root);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

test("fixture server serves a file inside the root", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/ok.html`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await response.text(), /ok/);
  });
});

test("fixture server never serves a byte from outside the root", async () => {
  const escapes = [
    "/../outside.txt",
    "/%2e%2e/outside.txt",
    "/a/../../outside.txt",
    "/..%2ftures-elsewhere/secret.txt",
    "/../fixtures-elsewhere/secret.txt",
    "/....//outside.txt",
    // Not a lexical escape at all. The path stays inside the root and the
    // symlink does the escaping, which is why the string check alone missed it.
    "/linked-secret.txt",
  ];

  await withServer(async ({ url }) => {
    for (const path of escapes) {
      const response = await fetch(url + path);
      const body = await response.text();

      // 403 (containment rejected it) and 404 (it resolved inside the root and
      // there is nothing there) are both correct outcomes. The assertion that
      // matters is that no request ever comes back 200 with the planted
      // content, so it is written against the body rather than the status.
      assert.doesNotMatch(body, /LEAKED/, `${path} escaped the fixture root`);
      assert.ok(response.status >= 400, `${path} should not have succeeded`);
    }
  });
});

test("fixture server answers a malformed percent-escape instead of crashing", async () => {
  await withServer(async ({ url }) => {
    for (const path of ["/%", "/%zz", "/ok.html%"]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 400, `${path} should be a 400`);
    }

    // The point of the test: the server is still up and serving afterwards. The
    // previous version threw URIError out of the handler and killed the process,
    // so this request would never get an answer at all.
    const stillAlive = await fetch(`${url}/ok.html`);
    assert.equal(stillAlive.status, 200, "server died on the malformed request");
  });
});

// The stat() checks pass and the 200 headers go out, and only then does the
// read itself fail. Without an 'error' listener on the read stream this threw
// out of the request handler and killed the whole `node --test` process, so the
// symptom was some unrelated test dying rather than this one failing.
test("fixture server survives a read that fails after the headers are sent", async () => {
  const { root } = makeFixtureTree();
  const unreadable = join(root, "unreadable.html");
  writeFileSync(unreadable, "<p>secret</p>");
  chmodSync(unreadable, 0o000);

  // Root ignores the mode bits, so in a container running as root there is no
  // way to provoke the failure at all. Skip rather than assert something false.
  let readIsActuallyBlocked = false;
  try {
    readFileSync(unreadable);
  } catch {
    readIsActuallyBlocked = true;
  }

  const server = await startFixtureServer(root);
  try {
    if (!readIsActuallyBlocked) return;

    // Headers are already on the wire, so the client sees a 200 and then a
    // reset partway through the body. Either the fetch or the body read can be
    // the thing that rejects depending on timing, so the assertion is only that
    // the full body never arrives intact.
    await assert.rejects(async () => {
      const response = await fetch(`${server.url}/unreadable.html`);
      await response.text();
    });

    const stillAlive = await fetch(`${server.url}/ok.html`);
    assert.equal(stillAlive.status, 200, "server died on the failed read");
  } finally {
    chmodSync(unreadable, 0o600);
    await server.close();
  }
});

test("fixture server rejects a NUL byte in the path", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/ok.html%00.txt`);
    assert.equal(response.status, 400);

    const stillAlive = await fetch(`${url}/ok.html`);
    assert.equal(stillAlive.status, 200, "server died on the NUL path");
  });
});
