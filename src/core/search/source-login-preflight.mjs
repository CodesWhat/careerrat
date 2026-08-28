import {
  canonicalSearchSourceUrl,
  resolveBrowserSourceIdentity,
} from "../providers/search-sources.mjs";
import { buildSourceUrl } from "../providers/source-url.mjs";

function searchList(config) {
  if (Array.isArray(config?.searches)) return config.searches;
  if (Array.isArray(config?.sources)) return config.sources;
  return [];
}

function sourceUrl(source) {
  const saved = String(source?.url || "").trim();
  if (saved && canonicalSearchSourceUrl(saved)) return saved;
  try {
    const built = String(buildSourceUrl({ ...source, enabled: true })?.url || "").trim();
    return canonicalSearchSourceUrl(built) ? built : "";
  } catch {
    return "";
  }
}

function sourceIdentity(source, url) {
  const identity = resolveBrowserSourceIdentity(source, url);
  if (!identity.ok) return null;
  if (source?.auth !== true && !identity.knownPlatform) return null;
  return identity;
}

export function pendingSourceLoginRequests(config) {
  const requests = [];
  for (const source of searchList(config)) {
    if (source?.enabled !== false || source.source_type !== "browser") continue;
    const url = sourceUrl(source);
    if (!url) continue;
    const identity = sourceIdentity(source, url);
    if (!identity) continue;
    const sourceLabel = String(source.label || identity.label).trim();
    requests.push({
      platform: identity.platform,
      label: identity.label,
      sourceLabel,
      url,
      prompt: `Do you want to log into ${identity.label} so I can use it?`,
    });
  }
  return requests;
}
