import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";

const SAFE_EXTERNAL_PROTOCOLS = Object.freeze(["https:", "mailto:"]);

const PDF_RENDER_MAX_BODY_BYTES = 8 * 1024 * 1024;

function digestToken(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest();
}

function rendererTokensMatch(provided, expected) {
  return timingSafeEqual(digestToken(provided), digestToken(expected));
}

function sendRendererText(res, status, message) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(message);
}

async function renderHtmlWithElectron({ BrowserWindow, html }) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      pageSize: "Letter",
      preferCSSPageSize: true,
      printBackground: true,
      generateTaggedPDF: true,
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Start the private PDF renderer used by the staged Node engine. PDF export
 * uses Electron's Chromium directly; the separate hermetic Playwright browser
 * bundled for supervised application automation is not involved here.
 */
export async function startDesktopPdfRenderer({
  BrowserWindow,
  token = randomBytes(32).toString("hex"),
  maxBodyBytes = PDF_RENDER_MAX_BODY_BYTES,
  renderHtml = renderHtmlWithElectron,
} = {}) {
  if (typeof BrowserWindow !== "function") {
    throw new TypeError("startDesktopPdfRenderer: BrowserWindow is required");
  }
  if (!String(token).trim()) {
    throw new TypeError("startDesktopPdfRenderer: token must be non-empty");
  }

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/render") {
      sendRendererText(res, 404, "Not found");
      return;
    }
    if (!rendererTokensMatch(req.headers["x-careerrat-render-token"], token)) {
      sendRendererText(res, 401, "Unauthorized");
      return;
    }

    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        rejected = true;
        sendRendererText(res, 413, "Render request is too large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (rejected) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendRendererText(res, 400, "Render request must be valid JSON");
        return;
      }
      if (typeof body?.html !== "string" || !body.html.trim()) {
        sendRendererText(res, 400, "Render request requires non-empty html");
        return;
      }

      try {
        const pdf = Buffer.from(await renderHtml({ BrowserWindow, html: body.html }));
        if (pdf.length < 8 || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
          throw new Error("Electron returned invalid PDF bytes");
        }
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": pdf.length,
          "cache-control": "no-store",
        });
        res.end(pdf);
      } catch (err) {
        sendRendererText(res, 500, err?.message || "Electron PDF rendering failed");
      }
    });
  });

  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });

  return {
    url: `http://127.0.0.1:${port}/render`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function resolveDesktopRuntimePaths({
  isPackaged,
  appDir,
  userDataPath,
  resourcesPath,
  careerratHomeOverride,
} = {}) {
  const isBrandedDevLaunch =
    isPackaged && appDir && isNodeModulesElectronResourcesPath(resourcesPath);

  if (!isPackaged || isBrandedDevLaunch) {
    if (!appDir) {
      throw new TypeError("resolveDesktopRuntimePaths: appDir is required in dev mode");
    }

    return {
      isPackaged: false,
      careerratHome: null,
      repoRoot: join(appDir, "../.."),
    };
  }

  if (isPackaged) {
    if (!userDataPath) {
      throw new TypeError("resolveDesktopRuntimePaths: userDataPath is required in packaged mode");
    }
    if (!resourcesPath) {
      throw new TypeError("resolveDesktopRuntimePaths: resourcesPath is required in packaged mode");
    }

    return {
      isPackaged: true,
      careerratHome: String(careerratHomeOverride || "").trim() || join(userDataPath, "data"),
      repoRoot: join(resourcesPath, "careerrat"),
    };
  }
}

export function resolveDesktopSmokeEngineRoot({ isPackaged, repoRoot, desktopDir }) {
  return isPackaged ? repoRoot : join(desktopDir, "staging", "careerrat");
}

function isNodeModulesElectronResourcesPath(resourcesPath) {
  return String(resourcesPath || "")
    .replaceAll("\\", "/")
    .includes("/node_modules/electron/dist/Electron.app/Contents/Resources");
}

// Session state (cookies/localStorage) tied to a future auth provider would
// be keyed by origin, which for a loopback app includes the port. In dev
// mode an ephemeral port (0) is fine — a fresh session each launch is
// expected. In packaged mode a stable port lets a signed-in session survive
// a relaunch.
export const DEFAULT_PACKAGED_PORT = 46753;

export function choosePreferredPort({ isPackaged, env } = {}) {
  if (!isPackaged) return 0;

  const parsed = Number(env.CAREERRAT_DESKTOP_PORT);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;

  return DEFAULT_PACKAGED_PORT;
}

export function isAllowedExternalUrl(target, { allowedProtocols = SAFE_EXTERNAL_PROTOCOLS } = {}) {
  if (!String(target || "").trim()) return false;

  try {
    const url = new URL(String(target));
    return allowedProtocols.includes(url.protocol);
  } catch {
    return false;
  }
}

export function decideExternalOpen({ target, baseUrl, allowedProtocols } = {}) {
  if (!String(target || "").trim()) {
    return { action: "deny", reason: "missing-url" };
  }

  let url;
  try {
    url = new URL(String(target));
  } catch {
    return { action: "deny", reason: "malformed-url" };
  }

  if (baseUrl) {
    try {
      const base = new URL(String(baseUrl));
      if (url.origin === base.origin) {
        return { action: "ignore", reason: "same-origin", url: url.href };
      }
    } catch {
      // A malformed base URL should not make an unsafe target openable.
    }
  }

  if (!isAllowedExternalUrl(url.href, { allowedProtocols })) {
    return { action: "deny", reason: `blocked-protocol:${url.protocol}`, url: url.href };
  }

  return { action: "open-external", url: url.href };
}
