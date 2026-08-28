import { canonicalSearchSourceUrl, platformForHost } from "../providers/search-sources.mjs";
import { buildSourceUrl } from "../providers/source-url.mjs";

const SITE_LABELS = Object.freeze({
  glassdoor: "Glassdoor",
  indeed: "Indeed",
  linkedin: "LinkedIn",
  wellfound: "Wellfound",
});

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
  try {
    const hostPlatform = platformForHost(new URL(url).hostname);
    const platform = String(source?.platform || hostPlatform || "")
      .trim()
      .toLowerCase();
    if (source?.auth !== true && !hostPlatform) return null;
    const label =
      SITE_LABELS[platform] || String(source?.provider || source?.label || "this site").trim();
    return { platform: platform || new URL(url).hostname.replace(/^www\./, ""), label };
  } catch {
    return null;
  }
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
