// URLs that read "expired" now and were last recorded as something else
// (open). A link with no prior record isn't "closed since": we never saw it open.
export function closedSinceLastCheck(previous, results) {
  return results
    .filter((r) => r.result === "expired" && previous.has(r.url))
    .filter((r) => previous.get(r.url).result !== "expired")
    .map((r) => r.url);
}
