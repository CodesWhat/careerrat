// desktop-smoke.mjs — pure HTTP checks for the Electron --smoke path.
// BrowserWindow load events prove Chromium finished a navigation; these
// checks prove the navigation target was the built Rolester SPA, not a server
// error page that happened to load successfully.

export async function verifySmokeHttpSurface({ baseUrl, route, getOk }) {
  const healthBody = await getOk(new URL("/api/health", baseUrl).href);
  JSON.parse(healthBody);

  const routeBody = await getOk(new URL(route, baseUrl).href);
  if (!hasSpaRoot(routeBody)) {
    throw new Error(`GET ${route} did not return the SPA root`);
  }

  const assetPaths = extractAppAssetPaths(routeBody);
  if (assetPaths.length === 0) {
    throw new Error(`GET ${route} did not reference built app assets`);
  }

  for (const assetPath of assetPaths) {
    await getOk(new URL(assetPath, baseUrl).href);
  }
}

function hasSpaRoot(html) {
  return /<[^>]+\bid=["']root["'][^>]*>/i.test(html);
}

function extractAppAssetPaths(html) {
  const paths = [];
  const attrPattern = /<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(attrPattern)) {
    const path = match[1];
    if (path.startsWith("/app/assets/") || path.startsWith("app/assets/")) {
      paths.push(path);
    }
  }
  return [...new Set(paths)];
}
