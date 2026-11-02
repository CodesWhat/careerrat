// search/posting-demotion.mjs — scan-time ghost and repost demotion (CR115h).
//
// A posting that reads like an evergreen "talent community" req, is very old,
// or keeps coming back across scans (same company+role, new URL each time) sinks
// in the ranking. It is never cut: the offer stays in `kept` with a visible
// reason. Field-neutral: reuses the legitimacy config (targeting.yml#legitimacy)
// and its universal phrase lists, no per-field assumptions.
import { assessLegitimacy, resolveLegitimacyConfig } from "../evaluate/legitimacy.mjs";

const DAY_MS = 86400000;

// Rank points subtracted from the score when sorting. Score itself is untouched.
const DEMOTION_POINTS = {
  strong: 15,
  mild: 5,
  veryOld: 10,
  reposted: 12,
};
// A posting this many times older than the legitimacy age limit is "very old".
const VERY_OLD_MULTIPLE = 3;
// Same company+role seen under this many distinct URLs counts as reposted.
const REPOST_URL_COUNT = 3;

function ageDays(offer, now) {
  const posted = Date.parse(String(offer.postedAt || offer.dateOpened || ""));
  return Number.isFinite(posted) ? Math.floor((now - posted) / DAY_MS) : null;
}

/**
 * @param {object} offer
 * @param {{targeting?:object, now?:number, history?:{seenCount:number,firstSeen:string,lastSeen:string,urlCount?:number}}} ctx
 *   history is the sightings row from BEFORE this scan; this scan is added here.
 * @returns {{points:number, reasons:string[], signals:string[]}|null} null when nothing fires
 */
export function assessScanDemotion(offer, { targeting, now = Date.now(), history } = {}) {
  const cfg = resolveLegitimacyConfig(targeting);
  if (!cfg.enabled) return null;
  const nowDate = new Date(now);
  const scanHistory = history
    ? {
        seenCount: Number(history.seenCount) + 1,
        firstSeen: history.firstSeen,
        lastSeen: nowDate.toISOString(),
      }
    : undefined;
  const verdict = assessLegitimacy({
    job: {
      frontmatter: { postedAt: offer.postedAt || offer.dateOpened || "" },
      body: String(offer.bodyText || offer.description || ""),
    },
    targeting,
    now: nowDate,
    scanHistory,
  });
  let points = 0;
  const reasons = [];
  const signals = [];
  // One soft signal on its own is not conclusive (legitimacy.mjs says so), so
  // only a "suspect" verdict turns its signals into rank points.
  for (const signal of verdict.verdict === "suspect" ? verdict.signals : []) {
    // thin-jd on a partial or absent body says nothing about the employer.
    if (signal.id === "thin-jd" && (offer.bodyPartial === true || !offer.bodyText)) continue;
    points += signal.severity === "strong" ? DEMOTION_POINTS.strong : DEMOTION_POINTS.mild;
    reasons.push(signal.detail);
    signals.push(signal.id);
  }
  const age = ageDays(offer, now);
  if (age != null && cfg.maxAgeDays > 0 && age > cfg.maxAgeDays * VERY_OLD_MULTIPLE) {
    points += DEMOTION_POINTS.veryOld;
    reasons.push(`very old: ${age} days`);
    signals.push("very-old");
  }
  if (history && Number(history.urlCount) >= REPOST_URL_COUNT) {
    points += DEMOTION_POINTS.reposted;
    reasons.push(`reposted: seen under ${history.urlCount} different links`);
    signals.push("reposted");
  }
  if (!points) return null;
  return { points, reasons, signals };
}

export function rankScore(offer) {
  return Number(offer?.score || 0) - Number(offer?.demotion?.points || 0);
}

export function demotionNote(demotion) {
  return demotion ? `ranked lower: ${demotion.reasons.join("; ")}` : "";
}
