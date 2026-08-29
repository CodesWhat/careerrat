import { fetchPublicHttpText } from "../net/public-http-fetch.mjs";
import {
  DEEP_INGEST_FETCH_MAX_BYTES,
  DEEP_INGEST_FETCH_TIMEOUT_MS,
  plainTextFromHtml,
} from "./source-normalize.mjs";

export { validatePublicHttpUrl } from "../net/public-http-fetch.mjs";

export async function fetchDeepIngestUrl(
  rawUrl,
  {
    fetchImpl = fetch,
    resolveHost,
    timeoutMs = DEEP_INGEST_FETCH_TIMEOUT_MS,
    maxBytes = DEEP_INGEST_FETCH_MAX_BYTES,
    signal,
  } = {}
) {
  const fetched = await fetchPublicHttpText(rawUrl, {
    fetchImpl,
    resolveHost,
    timeoutMs,
    maxBytes,
    readErrorBody: false,
    signal,
  });
  if (!fetched.ok) {
    if (fetched.code === "fetch_failed" || fetched.code === "timeout") {
      throw new Error(fetched.reason);
    }
    return {
      ...fetched,
      status:
        fetched.code === "unsafe_url" || fetched.code === "unsafe_redirect"
          ? "not_available"
          : "gap",
    };
  }

  if (fetched.status < 200 || fetched.status >= 300) {
    return {
      ok: false,
      status: fetched.status === 404 ? "not_available" : "gap",
      url: rawUrl,
      finalUrl: fetched.finalUrl,
      reason: `HTTP ${fetched.status || "unknown"} from source`,
    };
  }

  const text = fetched.contentType.includes("html")
    ? plainTextFromHtml(fetched.rawText)
    : fetched.rawText.trim();
  return { ...fetched, text, reason: null };
}
