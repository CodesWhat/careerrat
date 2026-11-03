import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { commCaptureInbound } from "../db/verbs/comm.mjs";
import { sourceWatermarkUpsert } from "../db/verbs/source.mjs";
import { currentPerson } from "../paths/people.mjs";
import { userPath } from "../paths/workspace.mjs";
import { parseContactIdentity } from "./contact-identity.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_MESSAGES = 100;

// Application acknowledgments ("Application confirmation", "Thank you for
// applying") are wanted: they clear the waiting-on-confirmation CTA. Only
// account-security mail is excluded.
const INCLUDE_SOURCE =
  "\\b(application|applying|applied|assessment|availability|candidate|interview|job|offer|recruiter|role|screen|scheduling)\\b";
const EXCLUDE_SOURCE =
  "\\b(login|one[- ]time|passcode|password|security|sign[- ]in|verification|verify)\\b";
const ACK_SOURCE =
  "\\b(application\\s+(confirmation|confirmed|received|submitted)|(we|have)\\s+received\\s+your\\s+application|thank(s| you)\\s+for\\s+(applying|your\\s+application|submitting)|submission\\s+confirmed)";
const INCLUDE_RE = new RegExp(INCLUDE_SOURCE, "i");
const EXCLUDE_RE = new RegExp(EXCLUDE_SOURCE, "i");
const ACK_RE = new RegExp(ACK_SOURCE, "i");

const APPLE_MAIL_SCRIPT = String.raw`
function run(argv) {
  const mail = Application("Mail");
  const cutoff = new Date(argv[0]);
  const addresses = JSON.parse(argv[1] || "[]").map((value) => String(value).toLowerCase());
  const include = new RegExp(${JSON.stringify(INCLUDE_SOURCE)}, "i");
  const exclude = new RegExp(${JSON.stringify(EXCLUDE_SOURCE)}, "i");
  const addressed = (message) => {
    if (!addresses.length) return true;
    const lists = [message.toRecipients(), message.ccRecipients()];
    return lists.some((list) =>
      list.some((recipient) => addresses.includes(String(recipient.address() || "").toLowerCase()))
    );
  };
  const rows = [];
  const messages = mail.inbox.messages.whose({ dateReceived: { _greaterThan: cutoff } })();
  for (let index = 0; index < messages.length && rows.length < ${MAX_MESSAGES}; index += 1) {
    const message = messages[index];
    const subject = String(message.subject() || "");
    if (!include.test(subject) || exclude.test(subject)) continue;
    if (!addressed(message)) continue;
    rows.push({
      id: String(message.messageId() || (subject + ":" + message.dateReceived().toISOString())),
      subject,
      sender: String(message.sender() || ""),
      receivedAt: message.dateReceived().toISOString(),
      recipients: message.toRecipients().concat(message.ccRecipients()).map((r) => String(r.address() || "")),
      body: String(message.content() || "").slice(0, 20000)
    });
  }
  return JSON.stringify(rows);
}
`;

function clean(value, max = 20_000) {
  return String(value || "")
    .replaceAll("\0", "")
    .trim()
    .slice(0, max);
}

function searchable(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function senderIdentity(sender) {
  return parseContactIdentity(sender);
}

function matchApplication(message, applications) {
  const haystack = searchable(`${message.subject} ${message.sender}`);
  let best = null;
  let bestScore = 0;
  for (const application of Array.isArray(applications) ? applications : []) {
    const company = searchable(application?.company);
    const role = searchable(application?.role);
    const score =
      (company && haystack.includes(company) ? 3 : 0) + (role && haystack.includes(role) ? 2 : 0);
    if (score > bestScore) {
      best = application;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function fallbackCompany(message) {
  const participant = senderIdentity(message.sender);
  if (participant.name) return participant.name.slice(0, 120);
  const domain = participant.email?.split("@")[1]?.split(".")[0];
  return domain
    ? domain.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "Recruiting contact";
}

function messageSummary(message) {
  const body = clean(message.body, 2_000).replace(/\s+/g, " ");
  return (body || clean(message.subject, 500) || "New job-search email").slice(0, 240);
}

function artifactPathFor(message) {
  const digest = createHash("sha256")
    .update(`${message.id}\0${message.receivedAt}\0${message.subject}`)
    .digest("hex")
    .slice(0, 16);
  return `workspace/comms/apple-mail-${digest}.md`;
}

function writeMessageArtifact({ repoRoot, env, message }) {
  const artifactPath = artifactPathFor(message);
  const absolutePath = userPath({ repoRoot, env }, artifactPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(
    absolutePath,
    [
      `# ${clean(message.subject, 500) || "Job-search email"}`,
      "",
      `From: ${clean(message.sender, 500) || "Unknown sender"}`,
      `Received: ${clean(message.receivedAt, 100)}`,
      "",
      clean(message.body),
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 }
  );
  return artifactPath;
}

async function readAppleMailMessages({ since, addresses = [], execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl(
    "osascript",
    ["-l", "JavaScript", "-e", APPLE_MAIL_SCRIPT, "--", since, JSON.stringify(addresses)],
    { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout || "[]"));
  if (!Array.isArray(parsed)) throw new Error("Apple Mail returned an invalid message list.");
  return parsed.slice(0, MAX_MESSAGES).map((message) => ({
    id: clean(message?.id, 500),
    subject: clean(message?.subject, 500),
    sender: clean(message?.sender, 500),
    receivedAt: clean(message?.receivedAt, 100),
    recipients: Array.isArray(message?.recipients)
      ? message.recipients.map((address) => clean(address, 320))
      : [],
    body: clean(message?.body),
  }));
}

// The addresses this workspace's mail may be filed under: the candidate's own
// email from their profile. Empty when none is registered.
function registeredAddresses({ repoRoot, env }) {
  try {
    const email = candidateConfigGet({ repoRoot, env }).profile?.candidate?.email;
    const address = String(email || "")
      .trim()
      .toLowerCase();
    return address ? [address] : [];
  } catch {
    return [];
  }
}

function isAddressedTo(message, addresses) {
  return (message.recipients || []).some((address) => addresses.includes(address.toLowerCase()));
}

export async function ingestAppleMail({
  repoRoot,
  env = process.env,
  source = { id: "apple-mail" },
  applications = [],
  now = () => new Date(),
  readMessagesImpl = readAppleMailMessages,
  addressesImpl = registeredAddresses,
  captureInboundImpl = commCaptureInbound,
  watermarkImpl = sourceWatermarkUpsert,
} = {}) {
  const completedOn = now();
  const completedAt = completedOn.toISOString();
  const since =
    source.lastRunAt || new Date(completedOn.getTime() - DEFAULT_LOOKBACK_MS).toISOString();
  const addresses = addressesImpl({ repoRoot, env });
  const person = currentPerson(env);
  if (person && !addresses.length) {
    return {
      kind: "mail_sync_result",
      source: "apple-mail",
      scanned: 0,
      captured: 0,
      duplicates: 0,
      blocker: {
        code: "APPLE_MAIL_ADDRESS_REQUIRED",
        message: `Apple Mail sync needs an email address for ${person}. Add the email address to ${person}'s candidate profile (candidate.email, for example through careerrat --for ${person} ingest) and run the mail check again. Apple Mail is not searched without it, so the owner's inbox can't leak into this workspace.`,
      },
      at: completedAt,
    };
  }
  let messages;
  try {
    messages = await readMessagesImpl({ since, addresses });
  } catch {
    return {
      kind: "mail_sync_result",
      source: "apple-mail",
      scanned: 0,
      captured: 0,
      duplicates: 0,
      blocker: {
        code: "APPLE_MAIL_ACCESS_REQUIRED",
        message:
          "Allow CareerRat to read Apple Mail in macOS Privacy & Security, then run the mail check again.",
      },
      at: completedAt,
    };
  }

  let captured = 0;
  let duplicates = 0;
  for (const message of messages) {
    if (!message.id || !message.receivedAt) continue;
    if (addresses.length && !isAddressedTo(message, addresses)) continue;
    if (!INCLUDE_RE.test(message.subject) || EXCLUDE_RE.test(message.subject)) continue;
    const application = matchApplication(message, applications);
    const artifactPath = writeMessageArtifact({ repoRoot, env, message });
    const result = captureInboundImpl({
      repoRoot,
      env,
      applicationId: application?.id,
      company: application?.company || fallbackCompany(message),
      role: application?.role || "Job-search correspondence",
      channel: "email",
      subject: message.subject,
      participant: senderIdentity(message.sender),
      summary: messageSummary(message),
      artifactPath,
      sourceId: message.id,
      at: message.receivedAt,
      acknowledgment: ACK_RE.test(message.subject),
    });
    if (result?.duplicate) duplicates += 1;
    else captured += 1;
  }

  watermarkImpl({
    repoRoot,
    env,
    source: {
      id: source.id || "apple-mail",
      kind: "mail",
      name: "Apple Mail",
      lastRunAt: completedAt,
    },
    at: completedAt,
  });

  return {
    kind: "mail_sync_result",
    source: "apple-mail",
    scanned: messages.length,
    captured,
    duplicates,
    blocker: null,
    at: completedAt,
  };
}
