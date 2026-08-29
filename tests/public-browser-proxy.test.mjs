import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { test } from "node:test";

import { createPublicBrowserProxy } from "../src/core/net/public-browser-proxy.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function requestThroughProxy(proxyUrl, targetUrl, { headers = {} } = {}) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: proxy.hostname,
        port: proxy.port,
        path: targetUrl,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function rawProxyExchange(proxyUrl, payload) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: proxy.hostname, port: Number(proxy.port) });
    const chunks = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("proxy exchange timed out"));
    }, 2_000);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.includes("\r\n\r\n")) return;
      clearTimeout(timeout);
      socket.destroy();
      resolve(text);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function openPinnedTunnel(proxyUrl, authority, clientHello) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: proxy.hostname, port: Number(proxy.port) });
    let response = "";
    let tunnelStarted = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("proxy tunnel timed out"));
    }, 2_000);
    socket.on("connect", () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    );
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!tunnelStarted && response.includes("\r\n\r\n")) {
        tunnelStarted = true;
        assert.match(response, /^HTTP\/1\.1 200 /);
        socket.write(clientHello);
      }
      if (!response.includes("tunnel-ready")) return;
      clearTimeout(timeout);
      socket.destroy();
      resolve(response);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("browser proxy connects to the exact approved address without resolving the hostname again", async () => {
  let receivedHost = "";
  const origin = createHttpServer((req, res) => {
    receivedHost = String(req.headers.host || "");
    res.end("pinned response");
  });
  const originPort = await listen(origin);
  const resolutions = [];
  const proxy = await createPublicBrowserProxy({
    resolvePublicTargetImpl: async (rawUrl) => {
      const url = new URL(rawUrl);
      resolutions.push(url.toString());
      assert.equal(url.hostname, "rebind.invalid");
      return {
        ok: true,
        url: url.toString(),
        hostname: url.hostname,
        addresses: [{ address: "127.0.0.1", family: 4 }],
      };
    },
  });

  try {
    const result = await requestThroughProxy(proxy.url, `http://rebind.invalid:${originPort}/jobs`);
    assert.equal(result.status, 200);
    assert.equal(result.body, "pinned response");
    assert.equal(receivedHost, `rebind.invalid:${originPort}`);
    assert.equal(resolutions.length, 1);
  } finally {
    await proxy.close();
    await close(origin);
  }
});

test("browser proxy rejects private HTTP, CONNECT, and WebSocket targets before opening upstream", async () => {
  let upstreamConnections = 0;
  const origin = createHttpServer((_req, res) => res.end("must not be reached"));
  origin.on("connection", () => {
    upstreamConnections += 1;
  });
  const originPort = await listen(origin);
  const proxy = await createPublicBrowserProxy({
    resolvePublicTargetImpl: async (rawUrl) => ({
      ok: false,
      url: String(rawUrl),
      reason: "private or local host is not fetchable",
    }),
  });

  try {
    const httpResult = await requestThroughProxy(proxy.url, `http://127.0.0.1:${originPort}/admin`);
    assert.equal(httpResult.status, 403);

    const connectResult = await rawProxyExchange(
      proxy.url,
      `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`
    );
    assert.match(connectResult, /^HTTP\/1\.1 403 /);

    const websocketResult = await rawProxyExchange(
      proxy.url,
      `GET http://127.0.0.1:${originPort}/socket HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${originPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
    );
    assert.match(websocketResult, /^HTTP\/1\.1 403 /);
    assert.equal(upstreamConnections, 0);
  } finally {
    await proxy.close();
    await close(origin);
  }
});

test("browser proxy pins HTTPS and WSS tunnels while preserving browser TLS bytes for SNI", async () => {
  let receivedClientHello = "";
  const origin = createNetServer((socket) => {
    socket.once("data", (chunk) => {
      receivedClientHello = chunk.toString("utf8");
      socket.write("tunnel-ready");
    });
  });
  const originPort = await listen(origin);
  const proxy = await createPublicBrowserProxy({
    resolvePublicTargetImpl: async (rawUrl) => {
      const url = new URL(rawUrl);
      assert.equal(url.hostname, "secure.rebind.invalid");
      return {
        ok: true,
        url: url.toString(),
        hostname: url.hostname,
        addresses: [{ address: "127.0.0.1", family: 4 }],
      };
    },
  });

  try {
    await openPinnedTunnel(
      proxy.url,
      `secure.rebind.invalid:${originPort}`,
      "browser-client-hello-with-sni"
    );
    assert.equal(receivedClientHello, "browser-client-hello-with-sni");
  } finally {
    await proxy.close();
    await close(origin);
  }
});

test("browser proxy rewrites WebSocket Host to the validated public destination", async () => {
  let receivedHost = "";
  const origin = createHttpServer();
  origin.on("upgrade", (req, socket) => {
    receivedHost = String(req.headers.host || "");
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
    );
  });
  const originPort = await listen(origin);
  const proxy = await createPublicBrowserProxy({
    resolvePublicTargetImpl: async (rawUrl) => {
      const url = new URL(rawUrl);
      return {
        ok: true,
        url: url.toString(),
        hostname: url.hostname,
        addresses: [{ address: "127.0.0.1", family: 4 }],
      };
    },
  });

  try {
    const response = await rawProxyExchange(
      proxy.url,
      `GET http://socket.rebind.invalid:${originPort}/socket HTTP/1.1\r\n` +
        `Host: attacker.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
    );
    assert.match(response, /^HTTP\/1\.1 101 /);
    assert.equal(receivedHost, `socket.rebind.invalid:${originPort}`);
  } finally {
    await proxy.close();
    await close(origin);
  }
});
