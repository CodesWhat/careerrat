const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /(?:account|career page) is no longer active/i,
  /this job has expired/i,
  /job posting has expired/i,
  /\bjob expired\b/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
];

const PRIMARY_EXPIRED_PATTERNS = [
  /\b(?:expired|archived):\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}\b/i,
];

const LISTING_PAGE_PATTERNS = [/\d+\s+jobs?\s+found/i, /search for jobs page is loaded/i];

// Bot-wall / anti-automation interstitials (Cloudflare, hCaptcha, JS challenge).
// These return 200-OK with thin HTML, so without this tier they fall into the
// `insufficient_content` branch and get classified `expired` — permanently
// deduping a job that is actually live behind the challenge.
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /cloudflare ray id/i,
  /enable javascript and cookies/i,
  /verify you are (a )?human/i,
  /attention required/i,
  /needs to review the security of your connection/i,
];

const EXPIRED_URL_PATTERNS = [/[?&]error=true/i, /[?&][^#]*expired[_-]?jd[_-]?redirect/i];

const APPLY_PATTERNS = [/\bapply\b/i, /submit application/i, /easy apply/i, /start application/i];

const MIN_CONTENT_CHARS = 300;

function firstMatch(patterns, text = "") {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({
  status = 0,
  finalUrl = "",
  bodyText = "",
  applyControls = [],
} = {}) {
  if (status === 404 || status === 410) {
    return { result: "expired", code: "http_gone", reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: "expired", code: "expired_url", reason: `redirect to ${finalUrl}` };
  }

  const primaryExpired = firstMatch(PRIMARY_EXPIRED_PATTERNS, bodyText.slice(0, 2000));
  if (primaryExpired) {
    return {
      result: "expired",
      code: "expired_body",
      reason: `pattern matched: ${primaryExpired.source}`,
    };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return {
      result: "expired",
      code: "expired_body",
      reason: `pattern matched: ${expiredBody.source}`,
    };
  }

  if (hasApplyControl(applyControls)) {
    return {
      result: "active",
      code: "apply_control_visible",
      reason: "visible apply control detected",
    };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return {
      result: "expired",
      code: "listing_page",
      reason: `pattern matched: ${listingPage.source}`,
    };
  }

  const botChallenge = firstMatch(BOT_CHALLENGE_PATTERNS, bodyText);
  if (botChallenge) {
    return {
      result: "uncertain",
      code: "bot_challenge",
      reason: `bot-wall interstitial matched: ${botChallenge.source} - check manually`,
    };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return {
      result: "expired",
      code: "insufficient_content",
      reason: "insufficient content - likely nav/footer only",
    };
  }

  return {
    result: "uncertain",
    code: "no_apply_control",
    reason: "content present but no visible apply control found",
  };
}

export { APPLY_PATTERNS };
