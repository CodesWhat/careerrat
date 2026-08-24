// tests/comm-recipient.test.mjs — pure-function coverage for
// src/core/comms/recipient.mjs: resolveRecipient (the supervised send
// handoff's "who do we send to" resolution — first participant with a
// loosely-valid email wins) and buildSendLinks (mailto/Gmail/Outlook compose
// link building, with a focus on URL-encoding correctness for characters that
// break naive concatenation: spaces, newlines, and "&" inside subject/body).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSendLinks, resolveRecipient } from "../src/core/comms/recipient.mjs";

// ---------------------------------------------------------------------------
// resolveRecipient
// ---------------------------------------------------------------------------

describe("resolveRecipient", () => {
  it("returns the first participant with a plausible email", () => {
    const result = resolveRecipient({
      participants: [{ name: "Avery Recruiter", email: "avery@acme.test" }],
    });
    assert.deepEqual(result, { state: "ready", to: "avery@acme.test", name: "Avery Recruiter" });
  });

  it("omits name when the matched participant has none", () => {
    const result = resolveRecipient({ participants: [{ email: "avery@acme.test" }] });
    assert.deepEqual(result, { state: "ready", to: "avery@acme.test" });
  });

  it("skips a malformed email and falls through to the next plausible participant", () => {
    const result = resolveRecipient({
      participants: [
        { name: "Recruiter Bot", email: "recruiter" },
        { name: "n/a", email: "n/a" },
        { name: "Jordan Hiring Manager", email: "jordan@acme.test" },
      ],
    });
    assert.deepEqual(result, {
      state: "ready",
      to: "jordan@acme.test",
      name: "Jordan Hiring Manager",
    });
  });

  it("returns no-recipient when no participant has a plausible email", () => {
    assert.deepEqual(
      resolveRecipient({ participants: [{ name: "Avery Recruiter", email: "n/a" }] }),
      { state: "no-recipient" }
    );
  });

  it("returns no-recipient when participants is empty, missing, or not an array", () => {
    assert.deepEqual(resolveRecipient({ participants: [] }), { state: "no-recipient" });
    assert.deepEqual(resolveRecipient({}), { state: "no-recipient" });
    assert.deepEqual(resolveRecipient(null), { state: "no-recipient" });
    assert.deepEqual(resolveRecipient({ participants: "avery@acme.test" }), {
      state: "no-recipient",
    });
  });

  it("trims whitespace off the winning email and name", () => {
    const result = resolveRecipient({
      participants: [{ name: "  Avery Recruiter  ", email: "  avery@acme.test  " }],
    });
    assert.deepEqual(result, { state: "ready", to: "avery@acme.test", name: "Avery Recruiter" });
  });
});

// ---------------------------------------------------------------------------
// buildSendLinks
// ---------------------------------------------------------------------------

describe("buildSendLinks", () => {
  it("builds a mailto link with correctly encoded recipient, subject, and body", () => {
    const links = buildSendLinks({
      to: "avery@acme.test",
      subject: "Re: Interview availability",
      body: "Tuesday afternoon works for me.",
    });
    assert.equal(
      links.mailto,
      `mailto:${encodeURIComponent("avery@acme.test")}?subject=${encodeURIComponent("Re: Interview availability")}&body=${encodeURIComponent("Tuesday afternoon works for me.")}`
    );
  });

  it("encodes spaces, newlines, and ampersands in subject/body so the URL cannot be split", () => {
    const subject = "Re: Role & next steps";
    const body = "Hi Avery,\nTuesday at 2pm works.\n\nBest, Sam";
    const links = buildSendLinks({ to: "avery@acme.test", subject, body });

    // The raw separator characters must never survive un-encoded into the URL.
    assert.doesNotMatch(links.mailto, /& next/);
    assert.doesNotMatch(links.mailto, /\n/);
    assert.equal(
      links.mailto,
      `mailto:avery%40acme.test?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    );
    assert.equal(
      links.gmail,
      `https://mail.google.com/mail/?view=cm&fs=1&to=avery%40acme.test&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    );
    assert.equal(
      links.outlook,
      `https://outlook.live.com/mail/0/deeplink/compose?to=avery%40acme.test&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    );
  });

  it("omits the recipient param from every link when to is falsy, but still returns a composable link", () => {
    const links = buildSendLinks({ to: "", subject: "Re: Role", body: "Hello." });
    assert.equal(
      links.mailto,
      `mailto:?subject=${encodeURIComponent("Re: Role")}&body=${encodeURIComponent("Hello.")}`
    );
    assert.doesNotMatch(links.gmail, /&to=/);
    assert.doesNotMatch(links.outlook, /(?:\?|&)to=/);
    assert.match(links.gmail, /^https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1&su=/);
    assert.match(
      links.outlook,
      /^https:\/\/outlook\.live\.com\/mail\/0\/deeplink\/compose\?subject=/
    );
  });

  it("defaults a missing subject/body to empty strings rather than the literal 'undefined'", () => {
    const links = buildSendLinks({ to: "avery@acme.test" });
    assert.equal(links.mailto, "mailto:avery%40acme.test?subject=&body=");
    assert.doesNotMatch(links.mailto, /undefined/);
  });
});
