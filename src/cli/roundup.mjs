#!/usr/bin/env node
// careerrat --for <name> roundup [--since <date>] [--send] [--now] [--json]
//
// Prints the roundup for one person (dry run), or sends it to their registered,
// opted-in email with --send. On command only: nothing schedules this.
import { fileURLToPath } from "node:url";
import { runRoundup } from "../core/comms/roundup.mjs";
import { currentPerson, peopleBase, personExists } from "../core/paths/people.mjs";
import { readContact } from "../core/people/contact.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function printHelp() {
  console.log(`Usage: careerrat --for <name> roundup [options]

  (no flags)        Print the roundup. Sends nothing.
  --since <date>    Start of the window. Default: the last roundup sent, else 7 days ago.
  --send            Email it to their registered address. Needs their opt-in
                    (careerrat --for <name> people contact opt-in email --evidence "...")
                    and mail set up: CAREERRAT_MAIL_FROM plus RESEND_API_KEY, or the
                    CAREERRAT_SMTP_HOST/_PORT/_USER/_PASS settings.
  --now             Send even during their quiet hours.
  --json            Machine-readable output.

A repeat --send in the same window does nothing. Never includes pay, SSN, date of birth
or background-check links.`);
}

function fail(message) {
  console.error(`roundup: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const opts = { send: false, now: false, json: false, since: undefined };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  } else if (arg === "--send") opts.send = true;
  else if (arg === "--now") opts.now = true;
  else if (arg === "--json") opts.json = true;
  else if (arg === "--since") {
    opts.since = args[++i];
    if (!opts.since?.trim() || opts.since.startsWith("--")) fail("--since needs a date.");
  } else fail(`unknown option "${arg}".`);
}

const name = currentPerson(process.env);
if (!name) fail("roundup runs for a person. Try: careerrat --for <name> roundup");
const base = peopleBase({ repoRoot: ROOT });
if (!personExists(base, name)) fail(`No workspace for "${name}".`);

try {
  const result = await runRoundup({
    repoRoot: ROOT,
    env: process.env,
    base,
    name,
    since: opts.since,
    send: opts.send,
    ignoreQuietHours: opts.now,
  });
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          subject: result.subject,
          text: result.text,
          counts: result.counts,
          windowKey: result.window.windowKey,
          sent: result.sent,
          skipped: result.skipped,
        },
        null,
        2
      )
    );
  } else {
    if (!opts.send) {
      const contact = readContact(base, name);
      console.log(`Subject: ${result.subject}\n`);
      console.log(result.text);
      console.log(
        contact.email
          ? `Dry run. Send it to ${contact.email} with: careerrat --for ${name} roundup --send`
          : `Dry run. No contact address yet: careerrat --for ${name} people contact set --email <address>`
      );
    } else if (result.sent) {
      console.log(`Sent to ${result.entry.to} via ${result.entry.transport}.`);
    } else {
      console.log(`Not sent: ${result.skipped}.`);
    }
  }
} catch (error) {
  fail(error?.message || String(error));
}
