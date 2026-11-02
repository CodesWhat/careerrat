import { openDb } from "../db/connection.mjs";
import { commAppendMessage } from "../db/verbs/comm.mjs";
import { readContact } from "../people/contact.mjs";
import { assertCanNotify, NotifyError, notifyPerson } from "./person-notify.mjs";
import { buildSendLinks, resolveRecipient } from "./recipient.mjs";
import { operatorName } from "./roundup.mjs";
import { resolveTransport } from "./transports.mjs";

// CR123: in a person workspace, the email-comms handoff can email the reviewed recruiter
// reply draft to the person, who sends it from their own mailbox. It goes only to their
// opted-in contact address, never to the recruiter. The draft stays on the thread, so a
// later `comm mark-sent` records the "supervised" tier.
function readComm(repoRoot, env, id) {
  const row = openDb({ repoRoot, env })
    .prepare("SELECT data FROM communications WHERE id = ?")
    .get(id);
  return row ? JSON.parse(row.data) : null;
}

export async function deliverDraftToPerson({
  repoRoot,
  env = process.env,
  base,
  name,
  id,
  now = new Date(),
  ignoreQuietHours = false,
  transportOverride,
}) {
  const comm = readComm(repoRoot, env, id);
  if (!comm) throw new Error(`No communication "${id}".`);
  if (String(comm.channel || "email") !== "email") {
    throw new NotifyError(
      "COMMUNICATION_CHANNEL_UNSUPPORTED",
      `This thread is on ${comm.channel}. Only email drafts can be delivered to ${name}.`
    );
  }
  if (!comm.draft?.body) {
    throw new NotifyError(
      "COMMUNICATION_DRAFT_REQUIRED",
      "Draft a reply and review it before delivering it."
    );
  }
  const contact = readContact(base, name);
  assertCanNotify({ base, name, to: contact.email, now, ignoreQuietHours });

  const recipient = resolveRecipient(comm);
  const recruiter =
    (recipient.state === "ready" && recipient.name) ||
    String(comm.company || "").trim() ||
    "the recruiter";
  const subject = `Draft reply to ${recruiter} for you to send`;
  const links =
    recipient.state === "ready"
      ? buildSendLinks({ to: recipient.to, subject: comm.draft.subject, body: comm.draft.body })
      : null;
  const operator = operatorName({ base, name, env });
  const text = [
    `Hi ${name.charAt(0).toUpperCase()}${name.slice(1)},`,
    "",
    `${recruiter} wrote about ${[comm.role, comm.company].filter(Boolean).join(" at ") || "your application"}. Here's a reply I drafted. Read it, change anything you want, and send it from your own email. I don't send anything to them.`,
    "",
    recipient.state === "ready" ? `To: ${recipient.to}` : "To: (no address on the thread yet)",
    `Subject: ${comm.draft.subject || `Re: ${comm.subject || "your message"}`}`,
    "",
    comm.draft.body,
    "",
    ...(links
      ? ["Open it ready to send:", `Gmail: ${links.gmail}`, `Mail app: ${links.mailto}`, ""]
      : []),
    "When you've sent it, tell me and I'll mark it done.",
    "",
    `CareerRat, run by ${operator}`,
    "Reply STOP to pause these.",
    "",
  ].join("\n");

  const resolved = transportOverride || resolveTransport(env);
  // Always the person's own address: `to` is never taken from the thread.
  const entry = await notifyPerson({
    base,
    name,
    to: contact.email,
    subject,
    text,
    transport: resolved.transport,
    from: resolved.from,
    kind: "draft-delivery",
    extra: { communicationId: id },
    now,
    ignoreQuietHours,
  });
  commAppendMessage({
    repoRoot,
    env,
    id,
    message: {
      direction: "note",
      at: now.toISOString(),
      summary: `Draft delivered to ${name} to send themselves.`,
    },
  });
  return { entry, subject };
}
