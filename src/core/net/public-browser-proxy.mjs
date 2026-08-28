import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";

import { resolvePublicHttpTarget } from "./public-http-fetch.mjs";

const RESOLUTION_TIMEOUT_MS = 15_000;
const STRIPPED_REQUEST_HEADERS = new Set(["proxy-authorization", "proxy-connection"]);

function normalizedAddresses(target) {
  return (Array.isArray(target?.addresses) ? target.addresses : [])
    .map((entry) => ({
      address: String(entry?.address || ""),
      family: Number(entry?.family || 0),
    }))
    .filter(({ address, family }) => address && (family === 4 || family === 6));
}

async function resolveApprovedTarget(resolvePublicTargetImpl, rawUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOLUTION_TIMEOUT_MS);
  try {
    const target = await resolvePublicTargetImpl(rawUrl, { signal: controller.signal });
    const addresses = normalizedAddresses(target);
    if (!target?.ok || addresses.length === 0) {
      return {
        ok: false,
        reason: target?.reason || "host resolved to no approved public addresses",
      };
    }
    return { ...target, addresses };
  } catch (error) {
    return {
      ok: false,
      reason: controller.signal.aborted ? "host resolution timed out" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function targetUrlFromRequest(req, allowedProtocols) {
  let parsed;
  try {
    parsed = new URL(req.url);
  } catch {
    try {
      parsed = new URL(req.url, `http://${req.headers.host || ""}`);
    } catch {
      return null;
    }
  }
  return allowedProtocols.has(parsed.protocol) ? parsed : null;
}

function requestHeaders(req, host) {
  const headers = { ...req.headers, host };
  for (const name of STRIPPED_REQUEST_HEADERS) delete headers[name];
  return headers;
}

function sendHttpError(res, statusCode, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `${message}\n`;
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  res.end(body);
}

function sendSocketError(socket, statusCode, message) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body
  );
}

function connectApproved(addresses, port, trackSocket) {
  return new Promise((resolve, reject) => {
    let index = 0;
    let lastError = null;

    const attempt = () => {
      if (index >= addresses.length) {
        reject(lastError || new Error("no approved address could be reached"));
        return;
      }
      const selected = addresses[index++];
      const socket = connectSocket({
        host: selected.address,
        family: selected.family,
        port,
      });
      trackSocket(socket);
      const onError = (error) => {
        lastError = error;
        socket.destroy();
        attempt();
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(socket);
      });
    };

    attempt();
  });
}

function websocketRequestHead(req, targetUrl) {
  const lines = [
    `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/${req.httpVersion}`,
    `Host: ${targetUrl.host}`,
  ];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    const normalizedName = String(name).toLowerCase();
    if (normalizedName === "host" || STRIPPED_REQUEST_HEADERS.has(normalizedName)) continue;
    lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

export async function createPublicBrowserProxy({
  resolvePublicTargetImpl = resolvePublicHttpTarget,
} = {}) {
  const sockets = new Set();
  const trackSocket = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const server = createServer(async (req, res) => {
    const requestedUrl = targetUrlFromRequest(req, new Set(["http:"]));
    if (!requestedUrl) {
      sendHttpError(res, 400, "Unsupported proxy request");
      return;
    }
    const target = await resolveApprovedTarget(resolvePublicTargetImpl, requestedUrl.toString());
    if (!target.ok) {
      sendHttpError(res, 403, "Blocked by CareerRat's public-network boundary");
      return;
    }

    const approvedUrl = new URL(target.url);
    const port = Number(approvedUrl.port || 80);
    const upstream = httpRequest({
      method: req.method,
      hostname: approvedUrl.hostname,
      port,
      path: `${approvedUrl.pathname}${approvedUrl.search}`,
      headers: requestHeaders(req, approvedUrl.host),
      agent: false,
      lookup: (_hostname, options, callback) => {
        if (options?.all) {
          callback(null, target.addresses);
          return;
        }
        const requestedFamily = Number(options?.family || 0);
        const selected = target.addresses.find(
          (entry) => !requestedFamily || entry.family === requestedFamily
        );
        if (!selected) {
          callback(new Error("no approved address for requested family"));
          return;
        }
        callback(null, selected.address, selected.family);
      },
    });
    upstream.on("socket", trackSocket);
    upstream.on("response", (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.on("error", () => sendHttpError(res, 502, "Public destination unavailable"));
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("connection", trackSocket);

  server.on("connect", async (req, clientSocket, head) => {
    let requestedUrl;
    try {
      requestedUrl = new URL(`https://${req.url}/`);
    } catch {
      sendSocketError(clientSocket, 400, "Invalid proxy tunnel");
      return;
    }
    const target = await resolveApprovedTarget(resolvePublicTargetImpl, requestedUrl.toString());
    if (!target.ok) {
      sendSocketError(clientSocket, 403, "Blocked by CareerRat's public-network boundary");
      return;
    }

    const approvedUrl = new URL(target.url);
    const port = Number(approvedUrl.port || 443);
    try {
      const upstreamSocket = await connectApproved(target.addresses, port, trackSocket);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    } catch {
      sendSocketError(clientSocket, 502, "Public destination unavailable");
    }
  });

  server.on("upgrade", async (req, clientSocket, head) => {
    const requestedUrl = targetUrlFromRequest(req, new Set(["http:", "ws:"]));
    if (!requestedUrl) {
      sendSocketError(clientSocket, 400, "Invalid WebSocket target");
      return;
    }
    const validationUrl = new URL(requestedUrl);
    validationUrl.protocol = "http:";
    const target = await resolveApprovedTarget(resolvePublicTargetImpl, validationUrl.toString());
    if (!target.ok) {
      sendSocketError(clientSocket, 403, "Blocked by CareerRat's public-network boundary");
      return;
    }

    const approvedUrl = new URL(target.url);
    const port = Number(approvedUrl.port || 80);
    try {
      const upstreamSocket = await connectApproved(target.addresses, port, trackSocket);
      upstreamSocket.write(websocketRequestHead(req, requestedUrl));
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    } catch {
      sendSocketError(clientSocket, 502, "Public destination unavailable");
    }
  });

  server.listen(0, "127.0.0.1");
  try {
    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => Promise.reject(error)),
    ]);
  } catch (error) {
    server.close();
    throw error;
  }

  let closing = null;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (closing) return closing;
      closing = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      return closing;
    },
  };
}
