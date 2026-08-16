// Client-side companion to src/core/comms/recipient.mjs. This app doesn't
// import server modules directly, so the "first participant with a
// plausible email wins" resolution and the mailto: link shape are kept in
// sync by hand — used by ReadyToSendCard (JobDrawer) to build an
// "Open in email app" link from a communication row's participants + draft
// without a round trip through communication.handoff.

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksLikeEmail(value) {
  return EMAIL_SHAPE.test(String(value || "").trim());
}

export function firstParticipantEmail(participants) {
  for (const participant of Array.isArray(participants) ? participants : []) {
    const email = String(participant?.email || "").trim();
    if (looksLikeEmail(email)) return email;
  }
  return null;
}

export function buildMailtoLink({ to, subject, body } = {}) {
  const recipient = String(to || "").trim();
  if (!recipient) return null;
  const subjectParam = encodeURIComponent(String(subject || ""));
  const bodyParam = encodeURIComponent(String(body || ""));
  return `mailto:${encodeURIComponent(recipient)}?subject=${subjectParam}&body=${bodyParam}`;
}

// Hand-synced mirror of buildSendLinks in src/core/comms/recipient.mjs (the
// parity test in tests/comm-recipient.test.mjs fails if the two drift).
// CommunicationHandoffCard builds its compose hrefs from artifact fields with
// this instead of rendering the server's pre-built link strings, so only
// literal schemes/hosts plus encodeURIComponent'd parts ever become an href.
export function buildComposeLinks({ to, subject, body } = {}) {
  const recipient = String(to || "").trim();
  const subjectParam = encodeURIComponent(String(subject || ""));
  const bodyParam = encodeURIComponent(String(body || ""));
  const encodedTo = encodeURIComponent(recipient);

  const mailto = `mailto:${encodedTo}?subject=${subjectParam}&body=${bodyParam}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1${recipient ? `&to=${encodedTo}` : ""}&su=${subjectParam}&body=${bodyParam}`;
  const outlook = `https://outlook.live.com/mail/0/deeplink/compose?${recipient ? `to=${encodedTo}&` : ""}subject=${subjectParam}&body=${bodyParam}`;

  return { mailto, gmail, outlook };
}
