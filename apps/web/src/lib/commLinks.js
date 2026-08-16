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
