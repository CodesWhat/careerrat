// Recipient resolution + mailto/webmail link building for the supervised
// send handoff. Zero runtime dependencies, pure functions — inputs are never
// mutated. Companion to threads.mjs; kept separate because this module is
// about "who do we send to" and "how does an email client open it", not
// thread lifecycle.

// Loose shape check — has an "@" and a "." after it. Not RFC 5322, just
// enough to reject obviously-broken strings ("recruiter", "n/a") before they
// become a dead mailto: link.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksLikeEmail(value) {
  return EMAIL_SHAPE.test(String(value || "").trim());
}

// ---------------------------------------------------------------------------
// resolveRecipient
// ---------------------------------------------------------------------------

/**
 * resolveRecipient(communication) → {state: "ready", to, name?} | {state: "no-recipient"}
 *
 * Assumption: communication.participants[] carries no candidate/counterparty
 * marker — every entry is a counterparty (recruiter, hiring manager, etc.),
 * never the candidate themself. So the rule is simply "first participant with
 * a plausible email wins"; there is nothing to filter out.
 */
export function resolveRecipient(communication) {
  const participants = Array.isArray(communication?.participants) ? communication.participants : [];
  for (const participant of participants) {
    const email = String(participant?.email || "").trim();
    if (looksLikeEmail(email)) {
      const name = String(participant?.name || "").trim();
      return { state: "ready", to: email, ...(name ? { name } : {}) };
    }
  }
  return { state: "no-recipient" };
}

// ---------------------------------------------------------------------------
// buildSendLinks
// ---------------------------------------------------------------------------

/**
 * buildSendLinks({to, subject, body}) → {mailto, gmail, outlook}
 * When `to` is falsy, the recipient params are simply omitted from each
 * link (an empty mailto: is still a valid "compose" link the user can
 * address themselves; the caller decides whether to render it at all).
 */
export function buildSendLinks({ to, subject, body } = {}) {
  const recipient = String(to || "").trim();
  const subjectParam = encodeURIComponent(String(subject || ""));
  const bodyParam = encodeURIComponent(String(body || ""));
  const encodedTo = encodeURIComponent(recipient);

  const mailto = `mailto:${encodedTo}?subject=${subjectParam}&body=${bodyParam}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1${recipient ? `&to=${encodedTo}` : ""}&su=${subjectParam}&body=${bodyParam}`;
  const outlook = `https://outlook.live.com/mail/0/deeplink/compose?${recipient ? `to=${encodedTo}&` : ""}subject=${subjectParam}&body=${bodyParam}`;

  return { mailto, gmail, outlook };
}
