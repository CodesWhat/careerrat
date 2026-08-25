import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  createBrowserSessionManager,
  createConfiguredBrowserSession,
} from "../src/core/automation/browser-session.mjs";
import {
  ingestPlatformMessagesInApp,
  ingestWebmailInApp,
  optimizeLinkedinInApp,
  sourceRelationshipsInApp,
  syncStatusesInApp,
} from "../src/core/automation/browser-workflows.mjs";
import { openDb, requireDb } from "../src/core/db/connection.mjs";
import { assembleTrackerObject } from "../src/core/db/export-to-tracker.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";
import { commUpsert } from "../src/core/db/verbs/comm.mjs";
import { linkedinProposalBatchLatest } from "../src/core/db/verbs/linkedin-proposals.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

let server;
let origin;
const roots = [];

function page(body) {
  return `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;
}

const pages = {
  "/gmail": page(`
    <main><article data-careerrat-mail-row data-thread-id="gmail-1">
      <span data-sender>Jordan &lt;jordan@acme.test&gt;</span>
      <span data-subject>Acme Product Engineer interview</span>
      <time datetime="2026-08-24T13:00:00.000Z"></time>
      <span data-preview>Can we schedule Tuesday?</span>
      <a href="/gmail/thread">Open</a>
    </article>
    <article data-careerrat-mail-row data-thread-id="gmail-security">
      <span data-sender>Google Security &lt;no-reply@google.test&gt;</span>
      <span data-subject>New sign-in verification code</span>
      <time datetime="2026-08-24T13:10:00.000Z"></time>
      <span data-preview>Use this code to finish signing in.</span>
      <a href="/gmail/thread">Open</a>
    </article></main>`),
  "/gmail/thread": page(
    `<aside>PERSONAL INBOX PREVIEW THAT MUST NOT BE SAVED</aside><main><h1>Acme Product Engineer interview</h1><p data-careerrat-body>Can we schedule Tuesday at 2pm?</p></main>`
  ),
  "/outlook": page(`
    <main><article data-careerrat-mail-row data-convid="outlook-1">
      <span data-sender>Pat &lt;pat@beta.test&gt;</span>
      <span data-subject>Beta Designer application update</span>
      <time datetime="2026-08-24T14:00:00.000Z"></time>
      <span data-preview>Your application is under review.</span>
      <a href="/outlook/thread">Open</a>
    </article></main>`),
  "/outlook/thread": page(
    `<aside>PRIVATE CALENDAR CONTENT THAT MUST NOT BE SAVED</aside><main><h1>Beta application update</h1><p data-careerrat-body>Your application is under review.</p></main>`
  ),
  "/linkedin/messages": page(`
    <main><article data-careerrat-message-row data-thread-id="li-message-1">
      <strong data-participant>Lee Recruiter</strong><span data-company>Acme</span>
      <span data-role>Product Engineer</span><time datetime="2026-08-24T15:00:00.000Z"></time>
      <p data-preview>Interested in a screen?</p><a href="/linkedin/messages/thread">Open</a>
    </article></main>`),
  "/linkedin/messages/thread": page(
    `<main><p data-careerrat-body>Would you be interested in a recruiter screen this week?</p></main>`
  ),
  "/wellfound/messages": page(`
    <main><article data-careerrat-message-row data-thread-id="wf-message-1">
      <strong data-participant>Wren Founder</strong><span data-company>Beta</span>
      <span data-role>Designer</span><time datetime="2026-08-24T15:30:00.000Z"></time>
      <p data-preview>Let's talk.</p><a href="/wellfound/messages/thread">Open</a>
    </article></main>`),
  "/wellfound/messages/thread": page(
    `<main><p data-careerrat-body>Let's talk about the product designer role.</p></main>`
  ),
  "/linkedin/people": page(`
    <main id="people-results"></main>
    <script>setTimeout(() => {
      document.querySelector('#people-results').innerHTML = '<article data-careerrat-person-row><h3 data-name>Alex Hiring</h3><span data-title>Engineering Hiring Manager</span><span data-company>Acme</span><span data-basis>Works on the target team</span><a href="https://www.linkedin.com/in/alex-hiring">Profile</a></article>';
    }, 120)</script>`),
  "/linkedin/profile": page(`
    <main>
      <section data-careerrat-profile-surface data-surface-id="headline"><h2 data-surface>Headline</h2><p data-current>Software Engineer</p></section>
      <section data-careerrat-profile-surface data-surface-id="about"><h2 data-surface>About</h2><p data-current>I build reliable systems.</p></section>
    </main>`),
  "/greenhouse/status": page(
    `<main><div data-careerrat-status>Phone screen scheduled</div></main>`
  ),
  "/greenhouse/status-unclear": page(
    `<main><div data-careerrat-status>Background check queued</div></main>`
  ),
  "/auth": page(`<main><h1>Sign in to continue</h1><label>Enter your password</label></main>`),
};

before(async () => {
  server = createServer((req, res) => {
    const body = pages[new URL(req.url, "http://fixture").pathname];
    res.writeHead(body ? 200 : 404, {
      "content-type": "text/html; charset=utf-8",
    });
    res.end(body || page("Not found"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(capabilities, consent) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-browser-workflow-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "automation",
    patch: {
      setup_mode: "advanced",
      session: {
        provider: "playwright",
        profile_root: join(repoRoot, "profiles"),
      },
      capabilities,
      consent,
    },
  });
  return repoRoot;
}

function headlessSession(options) {
  return createConfiguredBrowserSession({
    ...options,
    headless: true,
    // GitHub's Linux runner already ships Google Chrome. Use that installed
    // browser for these live fixtures so the full unit suite does not depend
    // on an untracked Playwright browser download. Packaged desktop smoke tests
    // separately exercise the hermetic Chromium bundled with CareerRat.
    channel: process.platform === "linux" ? "chrome" : undefined,
  });
}

function tracker(repoRoot) {
  return assembleTrackerObject(requireDb({ repoRoot, env: {} }));
}

test("Playwright fixtures: Gmail and Outlook ingest write canonical inbound mail", async () => {
  const repoRoot = workspace(
    {
      mail_access: { enabled: true, platforms: { gmail: true, outlook: true } },
    },
    { gmail: true, outlook: true }
  );
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme",
      company: "Acme",
      role: "Product Engineer",
      status: "applied",
    },
  });
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-beta",
      company: "Beta",
      role: "Designer",
      status: "applied",
    },
  });
  const result = await ingestWebmailInApp({
    repoRoot,
    env: {},
    applications: tracker(repoRoot).applications,
    urls: { gmail: `${origin}/gmail`, outlook: `${origin}/outlook` },
    createSessionImpl: headlessSession,
    now: () => new Date("2026-08-24T16:00:00.000Z"),
  });
  assert.equal(result.state, "completed");
  assert.equal(result.captured, 2);
  const state = tracker(repoRoot);
  assert.equal(state.communications.length, 2);
  for (const communication of state.communications) {
    const artifact = communication.messages[0].artifactPath;
    const saved = readFileSync(userPath({ repoRoot, env: {} }, artifact), "utf8");
    assert.doesNotMatch(saved, /PERSONAL INBOX PREVIEW|PRIVATE CALENDAR CONTENT/);
  }
  assert.deepEqual(state.sources.map((source) => source.id).sort(), [
    "gmail-webmail",
    "outlook-webmail",
  ]);
});

test("Playwright fixtures: LinkedIn and Wellfound message ingest write separate channels", async () => {
  const repoRoot = workspace(
    {
      messaging: {
        enabled: true,
        platforms: { linkedin: true, wellfound: true },
      },
    },
    { linkedin: true, wellfound: true }
  );
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-acme",
      company: "Acme",
      role: "Product Engineer",
      status: "applied",
    },
  });
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-beta",
      company: "Beta",
      role: "Designer",
      status: "applied",
    },
  });
  const result = await ingestPlatformMessagesInApp({
    repoRoot,
    env: {},
    applications: tracker(repoRoot).applications,
    urls: {
      linkedin: `${origin}/linkedin/messages`,
      wellfound: `${origin}/wellfound/messages`,
    },
    createSessionImpl: headlessSession,
    now: () => new Date("2026-08-24T16:00:00.000Z"),
  });
  assert.equal(result.state, "completed");
  assert.equal(result.captured, 2);
  assert.deepEqual(
    tracker(repoRoot)
      .communications.map((row) => row.channel)
      .sort(),
    ["linkedin", "portal"]
  );
});

test("Playwright fixture: relationship sourcing captures review-only LinkedIn leads", async () => {
  const repoRoot = workspace(
    { relationship_sourcing: { enabled: true, platforms: { linkedin: true } } },
    { linkedin: true }
  );
  const result = await sourceRelationshipsInApp({
    repoRoot,
    env: {},
    company: "Acme",
    role: "Product Engineer",
    applicationId: null,
    urls: { linkedin: `${origin}/linkedin/people` },
    createSessionImpl: headlessSession,
    now: () => new Date("2026-08-24T16:00:00.000Z"),
  });
  assert.equal(result.state, "completed");
  assert.equal(result.found, 1);
  const lead = tracker(repoRoot).relationshipLeads[0];
  assert.equal(lead.name, "Alex Hiring");
  assert.equal(lead.status, "review");
});

test("Playwright fixture: LinkedIn profile read creates proposals without editing the profile", async () => {
  const repoRoot = workspace(
    { profile_optimize: { enabled: true, platforms: { linkedin: true } } },
    { linkedin: true }
  );
  const result = await optimizeLinkedinInApp({
    repoRoot,
    env: {},
    profileUrl: `${origin}/linkedin/profile`,
    createSessionImpl: headlessSession,
    proposeImpl: async ({ surfaces }) =>
      surfaces.map((surface) => ({
        ...surface,
        proposed: `${surface.current} | Applied AI`,
        rationale: "Aligns the saved evidence with the target role.",
        evidenceRef: "candidate evidence",
      })),
    now: () => new Date("2026-08-24T16:00:00.000Z"),
  });
  assert.equal(result.state, "completed");
  assert.equal(result.proposed, 2);
  const batch = linkedinProposalBatchLatest({ repoRoot, env: {} });
  assert.equal(batch.surfaces.length, 2);
  assert.ok(batch.surfaces.every((surface) => surface.decision === null));
});

test("Playwright fixture: ATS sync reads status and atomically clears portal CTAs", async () => {
  const repoRoot = workspace(
    { status_polling: { enabled: true, platforms: { greenhouse: true } } },
    { greenhouse: true }
  );
  const application = {
    id: "app-acme",
    company: "Acme",
    role: "Product Engineer",
    status: "applied",
    statusPlatform: "greenhouse",
    statusUrl: `${origin}/greenhouse/status`,
    nextAction: "Check application portal status",
  };
  appUpsert({ repoRoot, env: {}, row: application });
  commUpsert({
    repoRoot,
    env: {},
    row: {
      id: "comm-acme-portal",
      applicationId: application.id,
      company: application.company,
      role: application.role,
      channel: "portal",
      status: "needs-reply",
      nextAction: "Check portal status",
      draft: { body: "stale" },
      messages: [],
    },
  });
  const result = await syncStatusesInApp({
    repoRoot,
    env: {},
    applications: [application],
    createSessionImpl: headlessSession,
    now: () => new Date("2026-08-24T16:00:00.000Z"),
  });
  assert.equal(result.state, "completed");
  assert.equal(result.updated, 1);
  const state = tracker(repoRoot);
  assert.equal(state.applications[0].status, "interview");
  assert.equal(state.applications[0].nextAction, null);
  assert.equal(state.communications[0].draft, null);
  assert.equal(state.communications[0].nextAction, null);
});

test("Playwright fixture: ambiguous ATS status stays visible for review and writes nothing", async () => {
  const repoRoot = workspace(
    { status_polling: { enabled: true, platforms: { greenhouse: true } } },
    { greenhouse: true }
  );
  const application = {
    id: "app-acme-review",
    company: "Acme",
    role: "Product Engineer",
    status: "interview",
    statusPlatform: "greenhouse",
    statusUrl: `${origin}/greenhouse/status-unclear`,
  };
  appUpsert({ repoRoot, env: {}, row: application });

  const result = await syncStatusesInApp({
    repoRoot,
    env: {},
    applications: [application],
    createSessionImpl: headlessSession,
  });
  assert.equal(result.state, "needs-review");
  assert.match(result.summary, /Acme/i);
  assert.match(result.summary, /Background check queued/i);
  assert.equal(tracker(repoRoot).applications[0].status, "interview");
});

test("Playwright fixture: authentication walls return visible retry state and write nothing", async () => {
  const repoRoot = workspace(
    { mail_access: { enabled: true, platforms: { gmail: true } } },
    { gmail: true }
  );
  const manager = createBrowserSessionManager({
    createSessionImpl: headlessSession,
  });
  try {
    const result = await ingestWebmailInApp({
      repoRoot,
      env: {},
      urls: { gmail: `${origin}/auth` },
      createSessionImpl: (options) => manager.get(options),
    });
    assert.equal(result.state, "needs-user");
    assert.equal(result.blockers[0].code, "AUTH_REQUIRED");
    assert.match(result.blockers[0].message, /sign in/i);
    assert.match(result.summary, /sign in/i);
    assert.match(result.summary, /retry/i);
    assert.equal(tracker(repoRoot).communications.length, 0);
    assert.equal(tracker(repoRoot).sources.length, 0);

    const retried = await ingestWebmailInApp({
      repoRoot,
      env: {},
      urls: { gmail: `${origin}/gmail` },
      createSessionImpl: (options) => manager.get(options),
    });
    assert.equal(retried.state, "completed");
    assert.equal(retried.captured, 1);
  } finally {
    await manager.shutdown();
  }
});
