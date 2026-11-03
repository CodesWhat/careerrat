import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

// CR122: pluggable mail transports for agent-to-person notifications. A transport is
// `{ name, send({ from, to, subject, text }) -> { id } }`. Two real ones: the Resend
// HTTP API and plain SMTP. Nothing configured means a "not set up" error that lists
// what to set, never a silent no-op.
const SETUP_ENV_VARS = [
  "CAREERRAT_MAIL_FROM  the From address, on your sending subdomain (updates@mail.example.com)",
  "RESEND_API_KEY       Resend API key (the Resend transport), or",
  "CAREERRAT_SMTP_HOST, CAREERRAT_SMTP_PORT, CAREERRAT_SMTP_USER, CAREERRAT_SMTP_PASS  (the SMTP transport)",
];

const SETUP_DNS_RECORDS = [
  "SPF    TXT on the sending subdomain authorizing your provider (e.g. v=spf1 include:<provider> ~all)",
  "DKIM   the CNAME/TXT keys your provider gives you for the sending subdomain",
  "DMARC  TXT at _dmarc.<sending subdomain>, e.g. v=DMARC1; p=none; rua=mailto:<you>",
];

export class MailNotSetUpError extends Error {
  constructor(detail) {
    super(
      `${detail}\nSet these environment variables:\n  ${SETUP_ENV_VARS.join("\n  ")}\nAnd add these DNS records on a dedicated sending subdomain:\n  ${SETUP_DNS_RECORDS.join("\n  ")}`
    );
    this.name = "MailNotSetUpError";
    this.code = "MAIL_NOT_SET_UP";
  }
}

class MailTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailTransportError";
    this.code = "MAIL_TRANSPORT_FAILED";
  }
}

export function resendTransport({ apiKey, fetchImpl = globalThis.fetch }) {
  return {
    name: "resend",
    async send({ from, to, subject, text }) {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new MailTransportError(
          `Resend refused the message (${response.status}): ${body?.message || "no detail"}`
        );
      }
      return { id: body?.id ?? null };
    },
  };
}

function headerSafe(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function encodeSubject(subject) {
  const safe = headerSafe(subject);
  return /^[\x20-\x7e]*$/.test(safe) ? safe : `=?UTF-8?B?${Buffer.from(safe).toString("base64")}?=`;
}

export function buildRfc822({ from, to, subject, text, messageId, date = new Date() }) {
  const body = String(text).replace(/\r?\n/g, "\r\n");
  return [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8")
      .toString("base64")
      .replace(/.{1,76}/g, "$&\r\n"),
  ].join("\r\n");
}

function bareAddress(value) {
  const match = String(value).match(/<([^>]+)>/);
  return headerSafe(match ? match[1] : value);
}

// Minimal SMTP submission client: EHLO, optional STARTTLS, AUTH PLAIN, one message.
class SmtpSession {
  constructor(socket) {
    this.buffer = "";
    this.waiting = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new MailTransportError("SMTP connection closed early.")));
  }

  fail(error) {
    this.failure = error;
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = null;
      reject(error);
    }
  }

  flush() {
    if (!this.waiting) return;
    const lines = this.buffer.split("\r\n");
    const complete = lines.slice(0, -1);
    const last = complete.at(-1);
    if (last === undefined || !/^\d{3} /.test(last)) return;
    this.buffer = lines.at(-1);
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve({ code: Number(last.slice(0, 3)), lines: complete });
  }

  reply() {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.flush();
    });
  }

  async command(line, expect) {
    this.socket.write(`${line}\r\n`);
    const reply = await this.reply();
    if (!expect.includes(reply.code)) {
      throw new MailTransportError(`SMTP ${line.split(" ")[0]} failed: ${reply.lines.at(-1)}`);
    }
    return reply;
  }
}

function connect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const socket =
      secure === "tls"
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
    socket.once(secure === "tls" ? "secureConnect" : "connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function smtpTransport({ host, port, user, pass, secure, hostname = "careerrat.local" }) {
  const mode = secure || (port === 465 ? "tls" : "starttls");
  return {
    name: "smtp",
    async send({ from, to, subject, text }) {
      const socket = await connect({ host, port, secure: mode });
      let session = new SmtpSession(socket);
      try {
        const greeting = await session.reply();
        if (greeting.code !== 220)
          throw new MailTransportError("SMTP server refused the connection.");
        await session.command(`EHLO ${hostname}`, [250]);
        if (mode === "starttls") {
          await session.command("STARTTLS", [220]);
          socket.removeAllListeners("data");
          socket.removeAllListeners("close");
          socket.removeAllListeners("error");
          const secured = tls.connect({ socket, servername: host });
          await new Promise((resolve, reject) => {
            secured.once("secureConnect", resolve);
            secured.once("error", reject);
          });
          session = new SmtpSession(secured);
          await session.command(`EHLO ${hostname}`, [250]);
        }
        if (user) {
          const credentials = Buffer.from(`\0${user}\0${pass}`).toString("base64");
          await session.command(`AUTH PLAIN ${credentials}`, [235]);
        }
        const messageId = `<${randomUUID()}@${hostname}>`;
        await session.command(`MAIL FROM:<${bareAddress(from)}>`, [250]);
        await session.command(`RCPT TO:<${bareAddress(to)}>`, [250, 251]);
        await session.command("DATA", [354]);
        const message = buildRfc822({ from, to, subject, text, messageId }).replace(/^\./gm, "..");
        await session.command(`${message}\r\n.`, [250]);
        await session.command("QUIT", [221]).catch(() => {});
        return { id: messageId };
      } finally {
        session.socket.destroy();
      }
    },
  };
}

// Picks a transport from the environment. Resend wins when both are configured.
export function resolveTransport(env = process.env, { fetchImpl } = {}) {
  const from = String(env.CAREERRAT_MAIL_FROM || "").trim();
  const resendKey = String(env.RESEND_API_KEY || "").trim();
  const smtpHost = String(env.CAREERRAT_SMTP_HOST || "").trim();
  if (!resendKey && !smtpHost) throw new MailNotSetUpError("Mail sending isn't set up yet.");
  if (!from)
    throw new MailNotSetUpError("CAREERRAT_MAIL_FROM isn't set, so there's no From address.");
  if (resendKey) return { transport: resendTransport({ apiKey: resendKey, fetchImpl }), from };
  const port = Number(env.CAREERRAT_SMTP_PORT || 587);
  const user = String(env.CAREERRAT_SMTP_USER || "").trim();
  const pass = String(env.CAREERRAT_SMTP_PASS || "");
  if (!Number.isInteger(port) || port <= 0 || (user && !pass)) {
    throw new MailNotSetUpError(
      "The SMTP settings are incomplete (port, or user without a password)."
    );
  }
  const secure = String(env.CAREERRAT_SMTP_SECURE || "").trim() || undefined;
  return { transport: smtpTransport({ host: smtpHost, port, user, pass, secure }), from };
}
