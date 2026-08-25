const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/i;

export function parseContactIdentity(value) {
  const raw = String(value || "")
    .replaceAll("\0", "")
    .trim()
    .slice(0, 500);
  const emailMatch = raw.match(EMAIL_PATTERN);
  const email = emailMatch?.[0] || "";
  const start = emailMatch?.index ?? -1;
  const withoutEmail =
    start >= 0 ? `${raw.slice(0, start)} ${raw.slice(start + email.length)}` : raw;
  const name = withoutEmail
    .replace(/[<>"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    ...(name && name !== email ? { name } : {}),
    ...(email ? { email } : {}),
  };
}
