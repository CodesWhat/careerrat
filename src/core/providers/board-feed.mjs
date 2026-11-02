// Shared helpers for the three local board feeds (RemoteOK, Remotive, Working
// Nomads). They read a public JSON feed and map each row to a scanner offer.
import { htmlToText } from "./career-ops/vendor/_html-to-text.mjs";

const MAX_BODY_CHARS = 20_000;

export async function fetchFeedJson(name, url, fetchImpl) {
  const res = await fetchImpl(url);
  if (typeof res === "string") return JSON.parse(res);
  // A 403/429/5xx must read as "the feed failed", not as an unexpected shape.
  if (res && res.ok === false) {
    throw new Error(`${name}: feed request failed with HTTP ${res.status}`);
  }
  if (res && typeof res.json === "function") return await res.json();
  return res;
}

// The feeds already carry the job description. Keep it, and mark the offer
// partial when it is missing so scoring knows it only saw a title.
export function feedBody(description) {
  const text =
    typeof description === "string" && description.trim()
      ? htmlToText(description).replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS)
      : "";
  return { bodyText: text, bodyPartial: text.length === 0 };
}
