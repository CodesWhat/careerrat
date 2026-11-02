// A short, safe reason for an AI call that failed. Providers and runtimes echo
// prompts, resume text and keys into their error messages, so the message is
// never copied through. The cause is built from the error's code, an HTTP
// status when there is one, and a plain-words category read from the message.
// Enough to tell "rate limited" from "not signed in" from "program missing".
const CATEGORIES = [
  [
    /\b(401|unauthori[sz]ed)\b|invalid[^.]{0,30}(key|credential)|not (logged|signed) in|log ?in required|please (log|sign) in/i,
    "not signed in, or the credential was rejected",
  ],
  [/\b403\b|forbidden|permission denied|not permitted/i, "access was denied"],
  [/\b429\b|rate.?limit|too many requests/i, "rate limited"],
  [
    /quota|credit balance|insufficient|billing|usage limit|\b402\b/i,
    "usage limit or billing problem",
  ],
  [
    /timed? ?out|etimedout|econnreset|econnrefused|enotfound|socket hang up|network|fetch failed/i,
    "network problem",
  ],
  [
    /enoent|command not found|not installed|spawn|no such file/i,
    "the AI program could not be started",
  ],
  [/context (length|window)|too long|max(imum)? tokens|too large/i, "the request was too large"],
  [/overloaded|\b5\d\d\b|server error|unavailable/i, "the AI service had a server problem"],
];

export function sanitizeFailureCause(error) {
  const message = String(error?.message ?? (typeof error === "string" ? error : ""));
  const parts = [];
  const category = CATEGORIES.find(([pattern]) => pattern.test(message));
  if (category) parts.push(category[1]);
  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 100 && status <= 599) parts.push(`HTTP ${status}`);
  const code = String(error?.code ?? "");
  if (/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) parts.push(code);
  return parts.join(", ");
}
