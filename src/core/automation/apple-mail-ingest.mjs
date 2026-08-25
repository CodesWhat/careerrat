import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { commCaptureInbound } from "../db/verbs/comm.mjs";
import { sourceWatermarkUpsert } from "../db/verbs/source.mjs";
import { userPath } from "../paths/workspace.mjs";
import { parseContactIdentity } from "./contact-identity.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_MESSAGES = 100;

const APPLE_MAIL_SCRIPT = String.raw`
function run(argv) {
  const mail = Application("Mail");
  const cutoff = new Date(argv[0]);
  const include = /\b(application|assessment|availability|candidate|interview|job|offer|recruiter|role|screen|scheduling)\b/i;
  const exclude = /\b(confirmation|login|one[- ]time|passcode|password|security|sign[- ]in|verification)\b/i;
  const rows = [];
  const messages = mail.inbox.messages.whose({ dateReceived: { _greaterThan: cutoff } })();
  for (let index = 0; index < messages.length && rows.length < ${MAX_MESSAGES}; index += 1) {
    const message = messages[index];
    const subject = String(message.subject() || "");
    if (!include.test(subject) || exclude.test(subject)) continue;
    rows.push({
      id: String(message.messageId() || (subject + ":" + message.dateReceived().toISOString())),
      subject,
      sender: String(message.sender() || ""),
      receivedAt: message.dateReceived().toISOString(),
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

async function readAppleMailMessages({ since, execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl(
    "osascript",
    ["-l", "JavaScript", "-e", APPLE_MAIL_SCRIPT, "--", since],
    { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout || "[]"));
  if (!Array.isArray(parsed)) throw new Error("Apple Mail returned an invalid message list.");
  return parsed.slice(0, MAX_MESSAGES).map((message) => ({
    id: clean(message?.id, 500),
    subject: clean(message?.subject, 500),
    sender: clean(message?.sender, 500),
    receivedAt: clean(message?.receivedAt, 100),
    body: clean(message?.body),
  }));
}

export async function ingestAppleMail({
  repoRoot,
  env = process.env,
  source = { id: "apple-mail" },
  applications = [],
  now = () => new Date(),
  readMessagesImpl = readAppleMailMessages,
  captureInboundImpl = commCaptureInbound,
  watermarkImpl = sourceWatermarkUpsert,
} = {}) {
  const completedOn = now();
  const completedAt = completedOn.toISOString();
  const since =
    source.lastRunAt || new Date(completedOn.getTime() - DEFAULT_LOOKBACK_MS).toISOString();
  let messages;
  try {
    messages = await readMessagesImpl({ since });
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
