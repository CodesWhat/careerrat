// tests/workspace-agent-preview.test.mjs
// node:test coverage for W3's ask-bar preview seam (commit 95f27540):
// previewWorkspaceIntent (src/core/agent/workspace-agent.mjs) and the
// POST /api/workspace/preview route it's mounted behind
// (src/cli/workspace-agent-route.mjs). Split into its own file rather than
// appended to tests/workspace-agent.test.mjs so it can land without touching
// that file (matches the temp-repo/mountDirect/callDirect conventions that
// file already establishes).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { mountWorkspaceAgentRoutes } from "../src/cli/workspace-agent-route.mjs";
import { previewWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { WORKSPACE_THREAD_ID, workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-workspace-agent-preview-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// previewWorkspaceIntent
// ---------------------------------------------------------------------------

test("previewWorkspaceIntent: sweep-style phrasings map to the search.run action", () => {
  const repoRoot = tempRepo();
  const phrasings = [
    "sweep my pinned boards",
    "scan for new job postings",
    "can you check my search sources today",
    "find me new roles at target companies",
  ];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.ok(result.action, `expected an action preview for "${text}"`);
    assert.equal(result.action.intent.type, "search.run");
    assert.equal(result.action.intent.entity.type, "workspace");
    assert.equal(result.action.intent.entity.id, WORKSPACE_THREAD_ID);
    assert.equal(typeof result.action.label, "string");
    assert.ok(result.action.label.length > 0);
  }
});

test("previewWorkspaceIntent: company expansion phrasings map to company.discover", () => {
  const repoRoot = tempRepo();
  const phrasings = [
    "find more companies for me",
    "discover companies that fit my preferences",
    "refresh my company discovery",
  ];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(result.action, {
      label: "Discover more matching companies",
      intent: {
        type: "company.discover",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { requestedCount: 12, request: text },
      },
    });
  }
});

test("previewWorkspaceIntent: new board discovery stays distinct from a job sweep", () => {
  const repoRoot = tempRepo();
  const phrasings = [
    "find more job boards for me",
    "discover new sources for my search",
    "research niche job boards",
  ];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(result.action, {
      label: "Find and review new job boards",
      intent: {
        type: "source.discover",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { request: text },
      },
    });
  }

  assert.equal(
    previewWorkspaceIntent({ text: "sweep my pinned boards", repoRoot, env: {} }).action.intent
      .type,
    "search.run"
  );
});

test("previewWorkspaceIntent: an explicit board URL import maps to a source write", () => {
  const repoRoot = tempRepo();
  const sourceUrl = "https://remoteok.com/remote-dev-jobs?order_by=date";
  for (const text of [
    `add this job board ${sourceUrl}`,
    `use this source for my searches ${sourceUrl}`,
  ]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(result.action, {
      label: "Add this job board",
      intent: {
        type: "source.add",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { url: sourceUrl },
      },
    });
  }
});

test("previewWorkspaceIntent: an explicit query request maps to source setup, not a sweep", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "add a job search for staff AI engineer",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Add a job search",
    intent: {
      type: "source.query-add",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { query: "staff AI engineer" },
    },
  });
});

test("previewWorkspaceIntent: explicit source toggles become reviewable source writes", () => {
  const repoRoot = tempRepo();
  assert.deepEqual(
    previewWorkspaceIntent({
      text: "disable the LinkedIn source",
      repoRoot,
      env: {},
    }).action,
    {
      label: "Disable this search source",
      intent: {
        type: "source.set-enabled",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { selector: "LinkedIn", enabled: false },
      },
    }
  );
  assert.deepEqual(
    previewWorkspaceIntent({
      text: "enable the RemoteOK job board",
      repoRoot,
      env: {},
    }).action,
    {
      label: "Enable this search source",
      intent: {
        type: "source.set-enabled",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { selector: "RemoteOK", enabled: true },
      },
    }
  );
});

test("previewWorkspaceIntent: rate or evaluate plus a job URL maps to job.evaluate-request", () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/12345";
  for (const text of [`rate this job ${jobUrl}`, `Can you evaluate ${jobUrl}?`]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(result.action, {
      label: "Capture and evaluate this job",
      intent: {
        type: "job.evaluate-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { jobUrl },
      },
    });
  }
});

test("previewWorkspaceIntent: a bare likely job URL maps to job.evaluate-request", () => {
  const repoRoot = tempRepo();
  const urls = [
    "https://jobs.lever.co/acme/abc-123",
    "https://www.linkedin.com/jobs/view/1234567890",
    "https://example.com/careers/jobs/staff-engineer",
  ];
  for (const jobUrl of urls) {
    const result = previewWorkspaceIntent({ text: jobUrl, repoRoot, env: {} });
    assert.equal(result.action?.intent.type, "job.evaluate-request");
    assert.equal(result.action?.intent.input.jobUrl, jobUrl);
  }
});

test("previewWorkspaceIntent: apply plus a job URL maps to job.prepare-request", () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://jobs.ashbyhq.com/acme/abc-123";
  const result = previewWorkspaceIntent({
    text: `Can you apply to this job? ${jobUrl}`,
    repoRoot,
    env: {},
  });

  assert.deepEqual(result.action, {
    label: "Evaluate and prepare this application",
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
  });
});

test("previewWorkspaceIntent: standalone tailoring resolves URL, open-job, and named-job requests", () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://jobs.ashbyhq.com/acme/abc-123";

  assert.deepEqual(
    previewWorkspaceIntent({
      text: `tailor my resume for ${jobUrl}`,
      repoRoot,
      env: {},
    }).action,
    {
      label: "Evaluate and tailor this job",
      intent: {
        type: "job.tailor-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { jobUrl },
      },
    }
  );

  assert.deepEqual(
    previewWorkspaceIntent({
      text: "write a cover letter for this job",
      context: { pathname: "/jobs", jobId: "app-acme" },
      repoRoot,
      env: {},
    }).action,
    {
      label: "Evaluate and tailor this saved job",
      intent: {
        type: "job.tailor-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { jobId: "app-acme" },
      },
    }
  );

  assert.deepEqual(
    previewWorkspaceIntent({
      text: "customize my application materials for the Acme Staff AI Engineer role",
      repoRoot,
      env: {},
    }).action,
    {
      label: "Evaluate and tailor this saved job",
      intent: {
        type: "job.tailor-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: {
          jobReference: "customize my application materials for the Acme Staff AI Engineer role",
        },
      },
    }
  );
});

test("previewWorkspaceIntent: this job resolves to the explicitly open saved job", () => {
  const repoRoot = tempRepo();
  const context = { pathname: "/jobs", jobId: "app-acme" };

  const rate = previewWorkspaceIntent({
    text: "Can you rate this job?",
    context,
    repoRoot,
    env: {},
  });
  assert.deepEqual(rate.action, {
    label: "Evaluate this saved job",
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: "app-acme" },
    },
  });

  const apply = previewWorkspaceIntent({
    text: "Apply to this job",
    context,
    repoRoot,
    env: {},
  });
  assert.deepEqual(apply.action, {
    label: "Evaluate and prepare this saved job",
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: "app-acme" },
    },
  });
});

test("previewWorkspaceIntent: never guesses what 'this job' means without an open job", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "Can you rate this job?",
    context: { pathname: "/jobs", jobId: null },
    repoRoot,
    env: {},
  });
  assert.equal(result.action, null);
});

test("previewWorkspaceIntent: named saved job references are resolved by the executor", () => {
  const repoRoot = tempRepo();

  const rate = previewWorkspaceIntent({
    text: "Can you rate the Acme role?",
    repoRoot,
    env: {},
  });
  assert.deepEqual(rate.action, {
    label: "Evaluate this saved job",
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: "Can you rate the Acme role?" },
    },
  });

  const apply = previewWorkspaceIntent({
    text: "Apply to the Northstar Staff AI role",
    repoRoot,
    env: {},
  });
  assert.deepEqual(apply.action, {
    label: "Evaluate and prepare this saved job",
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: "Apply to the Northstar Staff AI role" },
    },
  });

  const prepare = previewWorkspaceIntent({
    text: "Prepare the application for Anthropic Applied AI Engineer",
    repoRoot,
    env: {},
  });
  assert.deepEqual(prepare.action, {
    label: "Evaluate and prepare this saved job",
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: "Prepare the application for Anthropic Applied AI Engineer" },
    },
  });
});

test("previewWorkspaceIntent: natural application outcomes become confirmed typed writes", () => {
  const repoRoot = tempRepo();
  const rejected = "I got rejected by Temporal Labs.";
  assert.deepEqual(previewWorkspaceIntent({ text: rejected, repoRoot, env: {} }).action, {
    label: "Record this application as rejected",
    intent: {
      type: "outcome.record-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: rejected, to: "rejected", note: rejected },
    },
  });

  const offered = "Temporal Labs made me an offer for the Applied AI Engineer role.";
  assert.deepEqual(previewWorkspaceIntent({ text: offered, repoRoot, env: {} }).action, {
    label: "Record this application as offer",
    intent: {
      type: "outcome.record-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: offered, to: "offer", note: offered },
    },
  });
});

test("previewWorkspaceIntent: a user-reported application is distinct from an apply request", () => {
  const repoRoot = tempRepo();
  const reported = "I applied to the Temporal Labs Applied AI Engineer role.";
  assert.deepEqual(previewWorkspaceIntent({ text: reported, repoRoot, env: {} }).action, {
    label: "Record that I applied",
    intent: {
      type: "application.record-external-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: reported },
    },
  });

  assert.equal(
    previewWorkspaceIntent({
      text: "Can you apply to the Temporal Labs Applied AI Engineer role?",
      repoRoot,
      env: {},
    }).action.intent.type,
    "job.prepare-request"
  );
});

test("previewWorkspaceIntent: interview prep resolves a natural saved-job reference", () => {
  const repoRoot = tempRepo();
  const text = "Prepare me for my Temporal Labs Applied AI Engineer interview.";
  assert.deepEqual(previewWorkspaceIntent({ text, repoRoot, env: {} }).action, {
    label: "Prepare this interview",
    intent: {
      type: "interview.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: text },
    },
  });
});

test("previewWorkspaceIntent: recruiter reply requests become typed communication actions", () => {
  const repoRoot = tempRepo();
  const draft = "Draft a reply to the Temporal Labs recruiter saying Tuesday afternoon works.";
  assert.deepEqual(previewWorkspaceIntent({ text: draft, repoRoot, env: {} }).action, {
    label: "Draft this recruiter reply",
    intent: {
      type: "communication.draft-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        communicationReference: "the Temporal Labs recruiter",
        instruction: "Tuesday afternoon works.",
      },
    },
  });

  const sent = "I sent the Temporal Labs recruiter reply.";
  assert.deepEqual(previewWorkspaceIntent({ text: sent, repoRoot, env: {} }).action, {
    label: "Record that I sent this reply",
    intent: {
      type: "communication.record-external-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { communicationReference: "the Temporal Labs recruiter" },
    },
  });
});

test("previewWorkspaceIntent: free-text note phrasings become typed communication.note-request actions", () => {
  const repoRoot = tempRepo();

  const withColon = "Add a note to the Temporal Labs thread: Candidate prefers Tuesday afternoon.";
  assert.deepEqual(previewWorkspaceIntent({ text: withColon, repoRoot, env: {} }).action, {
    label: "Add this note to the thread",
    intent: {
      type: "communication.note-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { reference: "Temporal Labs", note: "Candidate prefers Tuesday afternoon." },
    },
  });

  const withSaying =
    "Log a note about the Temporal Labs recruiter, saying they pushed the timeline.";
  assert.deepEqual(
    previewWorkspaceIntent({ text: withSaying, repoRoot, env: {} }).action.intent.input,
    { reference: "Temporal Labs recruiter", note: "they pushed the timeline." }
  );

  const bare = "Note on the Acme thread: they want a writing sample.";
  assert.deepEqual(previewWorkspaceIntent({ text: bare, repoRoot, env: {} }).action.intent.input, {
    reference: "Acme",
    note: "they want a writing sample.",
  });
});

test("previewWorkspaceIntent: 'note to self' and other verb-less non-thread notes stay ordinary chat", () => {
  const repoRoot = tempRepo();

  const noteToSelf = "Note to self: check comp again before I reply.";
  assert.equal(previewWorkspaceIntent({ text: noteToSelf, repoRoot, env: {} }).action, null);

  const bareNonThread = "Note to Jordan about pay bands: seemed flexible.";
  assert.equal(previewWorkspaceIntent({ text: bareNonThread, repoRoot, env: {} }).action, null);

  const verbToSelf = "Add a note to myself: bring the license copy.";
  assert.equal(previewWorkspaceIntent({ text: verbToSelf, repoRoot, env: {} }).action, null);
});

test("previewWorkspaceIntent: 'send my reply' phrasings become typed communication.handoff-request actions", () => {
  const repoRoot = tempRepo();

  const toRecruiter = "Send my reply to the Temporal Labs recruiter.";
  assert.deepEqual(previewWorkspaceIntent({ text: toRecruiter, repoRoot, env: {} }).action, {
    label: "Prepare this reply to send",
    intent: {
      type: "communication.handoff-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { communicationReference: "Temporal Labs recruiter" },
    },
  });

  const shortForm = "Send the Acme reply.";
  assert.deepEqual(
    previewWorkspaceIntent({ text: shortForm, repoRoot, env: {} }).action.intent.input,
    { communicationReference: "Acme" }
  );

  const helpMe = "Help me send the Temporal Labs email.";
  assert.deepEqual(previewWorkspaceIntent({ text: helpMe, repoRoot, env: {} }).action.intent, {
    type: "communication.handoff-request",
    entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    input: { communicationReference: "Temporal Labs" },
  });
});

test("previewWorkspaceIntent: note, handoff, draft, and sent phrasings never shadow one another", () => {
  const repoRoot = tempRepo();

  // "I sent the reply to Acme" is past-tense self-report — must hit the sent
  // matcher, never handoff-request's "send ..." lead-in.
  const sent = "I sent the reply to Acme.";
  assert.equal(
    previewWorkspaceIntent({ text: sent, repoRoot, env: {} }).action.intent.type,
    "communication.record-external-request"
  );

  // "draft a reply to Acme" must hit the draft matcher, never note or handoff.
  const draft = "Draft a reply to Acme.";
  assert.equal(
    previewWorkspaceIntent({ text: draft, repoRoot, env: {} }).action.intent.type,
    "communication.draft-request"
  );

  // A note phrasing never resolves to a handoff, and vice versa.
  const note = "Add a note to the Acme thread: called and left voicemail.";
  assert.equal(
    previewWorkspaceIntent({ text: note, repoRoot, env: {} }).action.intent.type,
    "communication.note-request"
  );
  const handoff = "Send the Acme reply.";
  assert.equal(
    previewWorkspaceIntent({ text: handoff, repoRoot, env: {} }).action.intent.type,
    "communication.handoff-request"
  );
});

test("previewWorkspaceIntent: explicit screening questions become typed Ask actions", () => {
  const repoRoot = tempRepo();
  const text =
    "How should I answer this application question: Will you now or later require sponsorship?";
  assert.deepEqual(previewWorkspaceIntent({ text, repoRoot, env: {} }).action, {
    label: "Draft an evidence-backed answer",
    intent: {
      type: "screening.answer",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { questionText: "Will you now or later require sponsorship?" },
    },
  });

  const openJob = previewWorkspaceIntent({
    text: "Answer this screening question: Why are you interested in this role?",
    context: { pathname: "/jobs", jobId: "app-temporal" },
    repoRoot,
    env: {},
  });
  assert.deepEqual(openJob.action.intent, {
    type: "screening.answer",
    entity: { type: "application", id: "app-temporal" },
    input: { questionText: "Why are you interested in this role?" },
  });

  assert.equal(
    previewWorkspaceIntent({
      text: "How should I prioritize my applications?",
      repoRoot,
      env: {},
    }).action,
    null,
    "ordinary advice must stay an answer instead of being misclassified"
  );
});

test("previewWorkspaceIntent: scheduling language routes to the meeting planner before generic drafting", () => {
  const repoRoot = tempRepo();
  const text = "Reply to the Temporal Labs recruiter with my availability Tuesday afternoon.";
  assert.deepEqual(previewWorkspaceIntent({ text, repoRoot, env: {} }).action, {
    label: "Plan this interview scheduling reply",
    intent: {
      type: "scheduling.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        communicationReference: "the Temporal Labs recruiter",
        instruction: text,
      },
    },
  });

  const handle = "Handle the interview availability email from the Temporal Labs recruiter.";
  assert.equal(
    previewWorkspaceIntent({ text: handle, repoRoot, env: {} }).action.intent.type,
    "scheduling.prepare-request"
  );

  const accept = "Reply to the Temporal Labs recruiter accepting Tuesday August 18 at 2 PM ET.";
  assert.deepEqual(previewWorkspaceIntent({ text: accept, repoRoot, env: {} }).action, {
    label: "Plan this interview scheduling reply",
    intent: {
      type: "scheduling.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        communicationReference: "the Temporal Labs recruiter",
        instruction: accept,
      },
    },
  });
});

test("previewWorkspaceIntent: a named company research request maps to research.company", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({ text: "research Acme", repoRoot, env: {} });
  assert.deepEqual(result.action, {
    label: "Research this company",
    intent: {
      type: "research.company",
      entity: { type: "company", id: "acme" },
      input: { company: "Acme" },
    },
  });
});

test("previewWorkspaceIntent: 'research this company' with an open job resolves through the job id", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "research this company",
    context: { pathname: "/jobs", jobId: "app-acme" },
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Research this company",
    intent: {
      type: "research.company-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: "app-acme" },
    },
  });
});

test("previewWorkspaceIntent: a role-and-location comp request maps to research.comp", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "market comp for a nurse in Denver",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Research market comp",
    intent: {
      type: "research.comp",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      // The leading article on the role is stripped ("nurse", not "a nurse").
      input: { role: "nurse", location: "Denver" },
    },
  });
});

test("previewWorkspaceIntent: 'research market comp for X in Y' routes to research.comp, not research.company", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "research market comp for a nurse in Denver",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Research market comp",
    intent: {
      type: "research.comp",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { role: "nurse", location: "Denver" },
    },
  });
});

test("previewWorkspaceIntent: company-health phrasings map to company.health-request", () => {
  const repoRoot = tempRepo();
  const phrasings = ["is Acme a safe place to land", "how risky is Acme", "any layoffs at Acme"];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(
      result.action,
      {
        label: "Check company health",
        intent: {
          type: "company.health-request",
          entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
          input: { companyReference: "Acme" },
        },
      },
      `expected "${text}" to map to company.health-request`
    );
  }
});

test("previewWorkspaceIntent: strategy-review phrasings map to strategy.review", () => {
  const repoRoot = tempRepo();
  const phrasings = [
    "review my strategy",
    "review my job-search strategy",
    "what's working in my search",
    "why am I getting filtered out",
    "why am I getting filtered",
    "what should I change in my search",
    "run a strategy review",
  ];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(
      result.action,
      {
        label: "Review my search strategy",
        intent: {
          type: "strategy.review",
          entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        },
      },
      `expected "${text}" to map to strategy.review`
    );
  }
});

// Non-regression: strategy.review's phrasings (added alongside research.company/
// research.comp/company.health-request above) must not shadow the pre-existing
// research trio or company-discovery routes those share vocabulary with
// ("strategy", "search", "review", "companies").
test("previewWorkspaceIntent: strategy-review phrasings do not shadow the pre-existing research trio or company discovery", () => {
  const repoRoot = tempRepo();

  assert.deepEqual(previewWorkspaceIntent({ text: "research Acme", repoRoot, env: {} }).action, {
    label: "Research this company",
    intent: {
      type: "research.company",
      entity: { type: "company", id: "acme" },
      input: { company: "Acme" },
    },
  });

  assert.deepEqual(
    previewWorkspaceIntent({ text: "market comp for a nurse in Denver", repoRoot, env: {} }).action,
    {
      label: "Research market comp",
      intent: {
        type: "research.comp",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { role: "nurse", location: "Denver" },
      },
    }
  );

  assert.deepEqual(
    previewWorkspaceIntent({ text: "is Acme a safe place to land", repoRoot, env: {} }).action,
    {
      label: "Check company health",
      intent: {
        type: "company.health-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { companyReference: "Acme" },
      },
    }
  );

  assert.deepEqual(
    previewWorkspaceIntent({ text: "find companies matching my targeting", repoRoot, env: {} })
      .action,
    {
      label: "Discover more matching companies",
      intent: {
        type: "company.discover",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { requestedCount: 12, request: "find companies matching my targeting" },
      },
    }
  );
});

test("previewWorkspaceIntent: board and generic company phrasings keep their pre-existing routes", () => {
  const repoRoot = tempRepo();

  // "research boards" still reads as a board-discovery request, not a
  // single-company research request — looksLikeBoardDiscovery wins because
  // its ACTION_PREVIEW_RULES entry is checked before company research.
  assert.deepEqual(previewWorkspaceIntent({ text: "research boards", repoRoot, env: {} }).action, {
    label: "Find and review new job boards",
    intent: {
      type: "source.discover",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { request: "research boards" },
    },
  });

  // "sweep my boards" stays a job sweep, never board or company research.
  assert.equal(
    previewWorkspaceIntent({ text: "sweep my boards", repoRoot, env: {} }).action.intent.type,
    "search.run"
  );

  // "find companies matching my targeting" stays company.discover, not a
  // single-company research request.
  assert.deepEqual(
    previewWorkspaceIntent({
      text: "find companies matching my targeting",
      repoRoot,
      env: {},
    }).action,
    {
      label: "Discover more matching companies",
      intent: {
        type: "company.discover",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { requestedCount: 12, request: "find companies matching my targeting" },
      },
    }
  );

  // "research companies beyond my list" is a generic company phrase (plural
  // "companies"), so it stays company.discover instead of being captured as
  // a single named-company research request.
  assert.deepEqual(
    previewWorkspaceIntent({
      text: "research companies beyond my list",
      repoRoot,
      env: {},
    }).action,
    {
      label: "Discover more matching companies",
      intent: {
        type: "company.discover",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { requestedCount: 12, request: "research companies beyond my list" },
      },
    }
  );
});

test("previewWorkspaceIntent: a non-job URL stays answer-only", () => {
  const repoRoot = tempRepo();
  for (const text of [
    "https://example.com/about-us",
    "review https://example.com/about-us",
    "apply https://example.com/about-us",
  ]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.equal(result.action, null);
    assert.match(result.answer.label, /^Answer: /);
  }
});

test("previewWorkspaceIntent: non-action phrasing returns answer-only", () => {
  const repoRoot = tempRepo();
  const phrasings = ["what's blocking my top role?", "draft a nudge to a contact"];
  for (const text of phrasings) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.equal(result.action, null);
    assert.equal(typeof result.answer.label, "string");
    assert.match(result.answer.label, /^Answer: /);
  }
});

test("previewWorkspaceIntent: empty text returns no action and the generic prompt", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({ text: "", repoRoot, env: {} });
  assert.equal(result.action, null);
  assert.equal(result.answer.label, "Ask the workspace agent.");

  const whitespaceOnly = previewWorkspaceIntent({ text: "   \n\t  ", repoRoot, env: {} });
  assert.equal(whitespaceOnly.action, null);
  assert.equal(whitespaceOnly.answer.label, "Ask the workspace agent.");
});

test("previewWorkspaceIntent: long text truncates in the answer label", () => {
  const repoRoot = tempRepo();
  // No action-trigger words in here, so this previews as answer-only —
  // isolates the truncation behavior from the action-classification path.
  const longText = "banana ".repeat(40).trim();
  const compact = longText.replace(/\s+/g, " ").trim();
  assert.ok(compact.length > 140, "fixture text must exceed the 140-char truncation threshold");

  const result = previewWorkspaceIntent({ text: longText, repoRoot, env: {} });
  assert.equal(result.action, null);
  const expected = `Answer: \u{201c}${compact.slice(0, 139)}…\u{201d}`;
  assert.equal(result.answer.label, expected);
  assert.ok(result.answer.label.endsWith("…\u{201d}"));
});

test("previewWorkspaceIntent: engineAvailable is false when resolveAIRoute finds no route", () => {
  // No repoRoot (skips the installed-runtime lookup entirely) and an env with
  // no ANTHROPIC_API_KEY / CAREERRAT_AI_PROXY_URL — resolveAIRoute() falls all
  // the way through to type "none".
  const result = previewWorkspaceIntent({ text: "sweep my boards", env: {} });
  assert.equal(result.engineAvailable, false);
});

test("previewWorkspaceIntent: engineAvailable is true once a BYOK key is set", () => {
  const result = previewWorkspaceIntent({
    text: "sweep my boards",
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
  });
  assert.equal(result.engineAvailable, true);
});

test("previewWorkspaceIntent: never touches the DB or the workspace thread", () => {
  const repoRoot = tempRepo();
  previewWorkspaceIntent({ text: "sweep my boards", repoRoot, env: {} });
  previewWorkspaceIntent({ text: "what's blocking my top role?", repoRoot, env: {} });
  previewWorkspaceIntent({ text: "", repoRoot, env: {} });

  // workspaceThreadRead never creates the thread row itself (unlike
  // workspaceThreadOpen) — a null thread here proves nothing was written by
  // any of the calls above.
  const read = workspaceThreadRead({ repoRoot, env: {} });
  assert.equal(read.thread, null);
  assert.deepEqual(read.messages, []);
});

// ---------------------------------------------------------------------------
// settings.explain / settings.apply matcher regression
// ---------------------------------------------------------------------------

test("previewWorkspaceIntent: a comp-floor phrasing classifies as a settings.apply gate change", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "set my comp floor to $150k",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Set comp floor to $150,000",
    intent: {
      type: "settings.apply",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { change: { kind: "gate", type: "comp-floor", value: 150000 } },
    },
  });
});

test("previewWorkspaceIntent: a comp-floor-to-current-salary phrasing flags compReference instead of a number", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "set my comp floor to match my current salary",
    repoRoot,
    env: {},
  });
  assert.equal(result.action.intent.type, "settings.apply");
  assert.deepEqual(result.action.intent.input.change, {
    kind: "gate",
    type: "comp-floor",
    value: null,
    compReference: true,
  });
});

test("previewWorkspaceIntent: turning off one-click apply on a named platform classifies as a settings.apply automation change", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "turn off one-click apply on linkedin",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Turn off Authenticated one-click apply on linkedin",
    intent: {
      type: "settings.apply",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        change: {
          kind: "automation",
          op: "platform",
          capability: "one_click_apply",
          platform: "linkedin",
          enabled: false,
        },
      },
    },
  });
});

test("previewWorkspaceIntent: turning on one-click apply is not offered as an Ask action (falls to chat)", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({ text: "turn on one-click apply", repoRoot, env: {} });
  assert.equal(result.action, null);
});

test("previewWorkspaceIntent: a platform the capability doesn't run on gets no chip instead of a doomed one", () => {
  const repoRoot = tempRepo();
  // status_polling runs on ATS portals, not linkedin — offering a chip here
  // would guarantee a handler rejection after the click.
  const result = previewWorkspaceIntent({
    text: "turn off status polling on linkedin",
    repoRoot,
    env: {},
  });
  assert.equal(result.action, null);
});

test("previewWorkspaceIntent: 'what are my settings' classifies as settings.explain", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({ text: "what are my settings", repoRoot, env: {} });
  assert.deepEqual(result.action, {
    label: "Show my settings",
    intent: {
      type: "settings.explain",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {},
    },
  });
});

test("previewWorkspaceIntent: a bare job search phrasing still wins the search.run catch-all over settings", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({ text: "search for backend jobs", repoRoot, env: {} });
  assert.equal(result.action.intent.type, "search.run");
});

test("previewWorkspaceIntent: unrelated outcome and note phrasings are unaffected by the new settings matchers", () => {
  const repoRoot = tempRepo();

  const applied = "I applied to the Acme Corp Backend Engineer role.";
  assert.deepEqual(previewWorkspaceIntent({ text: applied, repoRoot, env: {} }).action, {
    label: "Record that I applied",
    intent: {
      type: "application.record-external-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: applied },
    },
  });

  const noteToSelf = "Note to self: buy milk.";
  assert.equal(previewWorkspaceIntent({ text: noteToSelf, repoRoot, env: {} }).action, null);
});

// ---------------------------------------------------------------------------
// issue.report matcher (report-issue skill)
// ---------------------------------------------------------------------------

test("previewWorkspaceIntent: bug-report phrasings map to issue.report with the trailing text captured as description", () => {
  const repoRoot = tempRepo();
  const cases = [
    ["report a bug", ""],
    ["file an issue: the tailor step crashed", "the tailor step crashed"],
    ["careerrat crashed", ""],
    ["the app is broken", ""],
  ];
  for (const [text, description] of cases) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.deepEqual(
      result.action,
      {
        label: "Prepare a bug report",
        intent: {
          type: "issue.report",
          entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
          input: { description },
        },
      },
      `expected "${text}" to map to issue.report`
    );
  }
});

test("previewWorkspaceIntent: bare 'broken' phrasings without a report/file verb or product token stay ordinary chat", () => {
  const repoRoot = tempRepo();
  for (const text of ["this offer is broken", "this is broken", "report on my pipeline"]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.equal(result.action, null, `expected "${text}" to not classify as an action`);
  }
});

test("previewWorkspaceIntent: 'report a bug' stays issue.report even when the trailing text mentions searching for jobs", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "report a bug when I search for jobs",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Prepare a bug report",
    intent: {
      type: "issue.report",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { description: "when I search for jobs" },
    },
  });
});

test("previewWorkspaceIntent: excluding a company classifies as a settings.apply gate change", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "exclude Acme Corp from my search",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: 'Exclude "Acme Corp" from your search',
    intent: {
      type: "settings.apply",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { change: { kind: "gate", type: "exclude-company", value: "Acme Corp" } },
    },
  });
});

test("previewWorkspaceIntent: a past-tense calendar self-report maps to calendar.record-write with the provider parsed from text", () => {
  const repoRoot = tempRepo();

  const google = previewWorkspaceIntent({
    text: "I added the interview to my google calendar",
    repoRoot,
    env: {},
  });
  assert.equal(google.action.label, "Record the calendar event you added");
  assert.equal(google.action.intent.type, "calendar.record-write");
  assert.equal(google.action.intent.entity.type, "workspace");
  assert.equal(google.action.intent.entity.id, WORKSPACE_THREAD_ID);
  assert.equal(google.action.intent.input.provider, "google_calendar");

  const outlook = previewWorkspaceIntent({
    text: "added it to outlook",
    repoRoot,
    env: {},
  });
  assert.equal(outlook.action.intent.type, "calendar.record-write");
  assert.equal(outlook.action.intent.input.provider, "outlook_calendar");
});

test("previewWorkspaceIntent: a calendar self-report with no named provider still fires the chip with provider null", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "I put the Acme interview on my calendar",
    repoRoot,
    env: {},
  });
  assert.equal(result.action.label, "Record the calendar event you added");
  assert.equal(result.action.intent.type, "calendar.record-write");
  assert.equal(result.action.intent.input.provider, null);
});

test("previewWorkspaceIntent: a read/query calendar phrasing never fires calendar.record-write, and a sources check still routes to search.run", () => {
  const repoRoot = tempRepo();

  for (const text of ["check my calendar", "what's on my calendar"]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.notEqual(
      result.action?.intent?.type,
      "calendar.record-write",
      `unexpected for "${text}"`
    );
  }

  const sourcesCheck = previewWorkspaceIntent({
    text: "check my calendar sources",
    repoRoot,
    env: {},
  });
  assert.equal(sourcesCheck.action.intent.type, "search.run");
});

test("previewWorkspaceIntent: forward-looking calendar requests never fire the self-report chip", () => {
  const repoRoot = tempRepo();

  // These ask the app to write, which calendar.record-write never does; only
  // first-person past-tense self-reports may offer the chip.
  for (const text of [
    "Please put my next interview into my calendar",
    "Can you put this on my calendar for me",
    "put the interview on my calendar",
    "add the onsite to google calendar",
  ]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.notEqual(
      result.action?.intent?.type,
      "calendar.record-write",
      `unexpected for "${text}"`
    );
  }
});

// ---------------------------------------------------------------------------
// relationship.record-lead / relationship.source-request matchers
// (relationshipRecordLeadFromText / relationshipSourceRequestFromText,
// workspace-agent.mjs ~6072/~6115). record-lead is a self-report of a
// contact the candidate already found; source-request is a consent-checked
// ask for CareerRat to go find one. record-lead MUST win when a phrase
// matches both vocabularies (ordering requirement documented at ~6478).
// ---------------------------------------------------------------------------

test("previewWorkspaceIntent: self-reported contact phrasings map to relationship.record-lead", () => {
  const repoRoot = tempRepo();

  const foundNamed = previewWorkspaceIntent({
    text: "I found a recruiter at Acme on linkedin, named Jordan Lee",
    repoRoot,
    env: {},
  });
  assert.equal(foundNamed.action.label, "Record the contact you found");
  assert.equal(foundNamed.action.intent.type, "relationship.record-lead");
  assert.equal(foundNamed.action.intent.entity.type, "workspace");
  assert.equal(foundNamed.action.intent.entity.id, WORKSPACE_THREAD_ID);
  assert.equal(foundNamed.action.intent.input.name, "Jordan Lee");
  assert.equal(foundNamed.action.intent.input.company, "Acme");
  assert.equal(foundNamed.action.intent.input.type, "Recruiter");
  assert.equal(foundNamed.action.intent.input.platform, "linkedin");

  const addAs = previewWorkspaceIntent({
    text: "add Casey Wu as a hiring manager at Globex",
    repoRoot,
    env: {},
  });
  assert.equal(addAs.action.label, "Record the contact you found");
  assert.equal(addAs.action.intent.type, "relationship.record-lead");
  assert.equal(addAs.action.intent.input.name, "Casey Wu");
  assert.equal(addAs.action.intent.input.company, "Globex");
  assert.equal(addAs.action.intent.input.type, "Decision maker");
});

test("previewWorkspaceIntent: sourcing-request phrasings map to relationship.source-request", () => {
  const repoRoot = tempRepo();
  const cases = [
    ["find a recruiter at Acme", "Acme"],
    ["who can refer me at Globex", "Globex"],
    ["warm intro to Initech", "Initech"],
  ];
  for (const [text, company] of cases) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.equal(
      result.action.label,
      "Request people sourcing",
      `expected "${text}" to map to relationship.source-request`
    );
    assert.equal(result.action.intent.type, "relationship.source-request");
    assert.equal(result.action.intent.entity.type, "workspace");
    assert.equal(result.action.intent.entity.id, WORKSPACE_THREAD_ID);
    assert.equal(result.action.intent.input.company, company);
  }
});

test("previewWorkspaceIntent: relationship-adjacent phrasings never misfire into relationship.record-lead/source-request", () => {
  const repoRoot = tempRepo();

  const research = previewWorkspaceIntent({ text: "research Acme", repoRoot, env: {} });
  assert.doesNotMatch(research.action?.intent?.type || "", /^relationship\./);

  const jobs = previewWorkspaceIntent({ text: "find jobs at Acme", repoRoot, env: {} });
  assert.equal(jobs.action.intent.type, "search.run");

  // "found" (not "find") with no "named X" never fires record-lead — it
  // fails closed to ordinary chat rather than routing anywhere at all.
  const noName = previewWorkspaceIntent({ text: "found a recruiter at Acme", repoRoot, env: {} });
  assert.equal(noName.action, null);

  const sources = previewWorkspaceIntent({
    text: "check my calendar sources",
    repoRoot,
    env: {},
  });
  assert.equal(sources.action.intent.type, "search.run");
});

test("previewWorkspaceIntent: relationship.record-lead wins over relationship.source-request when a phrase matches both vocabularies", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "I found a recruiter at Acme named Jordan Lee",
    repoRoot,
    env: {},
  });
  assert.equal(result.action.intent.type, "relationship.record-lead");
  assert.equal(result.action.intent.input.name, "Jordan Lee");
  assert.equal(result.action.intent.input.company, "Acme");
});

// ---------------------------------------------------------------------------
// status.record-portal-request / status.sync-request matchers
// (statusRecordPortalFromText / statusSyncRequestFromText,
// workspace-agent.mjs ~6432/~6464). record-portal-request is a self-report
// of what a portal shows for a specific job; sync-request is a
// consent-checked ask for CareerRat to go check every portal. Both MUST stay
// above the search.run catch-all, and record-portal-request MUST win when a
// phrase could plausibly match both (ordering requirement documented at
// ~6826).
// ---------------------------------------------------------------------------

test("previewWorkspaceIntent: '<platform> says/shows/lists' phrasings map to status.record-portal-request", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "Greenhouse says 'Phone screen scheduled' for Lumon",
    repoRoot,
    env: {},
  });
  assert.equal(result.action.label, "Record this portal status update");
  assert.equal(result.action.intent.type, "status.record-portal-request");
  assert.equal(result.action.intent.entity.type, "workspace");
  assert.equal(result.action.intent.entity.id, WORKSPACE_THREAD_ID);
  assert.equal(result.action.intent.input.jobReference, "Lumon");
  assert.equal(result.action.intent.input.rawStatus, "Phone screen scheduled");
});

test("previewWorkspaceIntent: '<platform> moved X to Y' phrasings also map to status.record-portal-request", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "the portal moved Lumon to interview",
    repoRoot,
    env: {},
  });
  assert.equal(result.action.intent.type, "status.record-portal-request");
  assert.equal(result.action.intent.input.jobReference, "Lumon");
  assert.equal(result.action.intent.input.rawStatus, "interview");
});

test("previewWorkspaceIntent: 'check my application statuses' maps to status.sync-request", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "check my application statuses",
    repoRoot,
    env: {},
  });
  assert.deepEqual(result.action, {
    label: "Check portal statuses",
    intent: {
      type: "status.sync-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {},
    },
  });
});

test("previewWorkspaceIntent: singular 'status' phrasings map to status.sync-request", () => {
  // Regression: the matcher shipped as /statuses?/ (literally "statuse" plus
  // an optional "s"), which silently missed every singular phrasing — the
  // most natural way to ask.
  const repoRoot = tempRepo();
  for (const text of ["check my status", "update my application status", "check my job statuses"]) {
    const result = previewWorkspaceIntent({ text, repoRoot, env: {} });
    assert.equal(result.action?.intent?.type, "status.sync-request", text);
  }
});

test("previewWorkspaceIntent: 'sync my statuses from <platform>' also maps to status.sync-request", () => {
  const repoRoot = tempRepo();
  const result = previewWorkspaceIntent({
    text: "sync my statuses from greenhouse",
    repoRoot,
    env: {},
  });
  assert.equal(result.action.intent.type, "status.sync-request");
  assert.equal(result.action.label, "Check portal statuses");
});

test("previewWorkspaceIntent: status matchers never shadow settings, search, or outcome routing", () => {
  const repoRoot = tempRepo();

  // Turning the capability on/off is a settings change, not a status.*
  // action — settings.apply already owns capability toggles.
  const togglePolling = previewWorkspaceIntent({
    text: "turn on status polling",
    repoRoot,
    env: {},
  });
  assert.equal(togglePolling.action.intent.type, "settings.apply");

  // Generic "check ... sources" phrasing still falls to the search.run
  // catch-all, not the new status.sync-request matcher.
  const checkSources = previewWorkspaceIntent({
    text: "check job sources",
    repoRoot,
    env: {},
  });
  assert.equal(checkSources.action.intent.type, "search.run");

  // A self-reported outcome stays on the outcome.record-request path, even
  // though it mentions "interview" — status.* is for portal-read updates.
  const reportedOutcome = previewWorkspaceIntent({
    text: "I got an interview at Acme",
    repoRoot,
    env: {},
  });
  assert.equal(reportedOutcome.action.intent.type, "outcome.record-request");

  // "check my settings" is unaffected by the new status matchers.
  const checkSettings = previewWorkspaceIntent({
    text: "check my settings",
    repoRoot,
    env: {},
  });
  assert.equal(checkSettings.action, null);
});

// ---------------------------------------------------------------------------
// POST /api/workspace/preview
// ---------------------------------------------------------------------------

function mountDirect(repoRoot, previewIntentImpl) {
  const routes = new Map();
  mountWorkspaceAgentRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env: {},
    previewIntentImpl,
  });
  return routes;
}

async function callDirect(routes, method, path, payload) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `expected mounted route for ${method} ${path}`);
  const req = Readable.from(
    payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), "utf8")]
  );
  req.method = method;
  req.url = path;
  req.headers = payload === undefined ? {} : { "content-type": "application/json" };
  let status = 200;
  let responseBody = "";
  const res = {
    writeHead(nextStatus) {
      status = nextStatus;
      return this;
    },
    end(chunk = "") {
      responseBody += String(chunk);
    },
  };
  await handler(req, res);
  return { status, body: responseBody ? JSON.parse(responseBody) : {} };
}

test("POST /api/workspace/preview returns ok:true with classify data and performs no thread writes", async () => {
  const repoRoot = tempRepo();
  // No override — exercises the route's real default (previewWorkspaceIntent
  // itself), not a stub, so this is an end-to-end check of the wiring.
  const routes = mountDirect(repoRoot);

  const response = await callDirect(routes, "POST", "/api/workspace/preview", {
    text: "sweep my pinned boards",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.action.intent.type, "search.run");
  assert.equal(typeof response.body.data.answer.label, "string");
  assert.equal(response.body.data.engineAvailable, false);

  const read = workspaceThreadRead({ repoRoot, env: {} });
  assert.equal(read.thread, null, "the preview route must never open/write the workspace thread");
  assert.deepEqual(read.messages, []);
});

test("POST /api/workspace/preview delegates text through to the injected classifier", async () => {
  const repoRoot = tempRepo();
  const seen = [];
  const routes = mountDirect(repoRoot, (input) => {
    seen.push(input);
    return { action: null, answer: { label: "stubbed" }, engineAvailable: true };
  });

  const response = await callDirect(routes, "POST", "/api/workspace/preview", {
    text: "what's blocking my top role?",
    context: { pathname: "/jobs", jobId: "app-acme" },
  });

  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "what's blocking my top role?");
  assert.deepEqual(seen[0].context, { pathname: "/jobs", jobId: "app-acme" });
  assert.deepEqual(response.body.data, {
    action: null,
    answer: { label: "stubbed" },
    engineAvailable: true,
  });
});
