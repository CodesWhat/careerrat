import { describe, expect, it } from "vitest";

import { ApiError } from "./api.js";
import { GENERIC_ERROR_MESSAGE, resolveErrorCopy, UserFacingError } from "./errorCopy.js";

const RULE_CASES = [
  {
    name: "missing_key code",
    err: new ApiError(400, { code: "missing_key", error: "No AI key is configured for this org" }),
    message: "No AI key is connected yet.",
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    name: "No AI key is configured prefix",
    err: new ApiError(400, { error: "No AI key is configured. Add one in Settings." }),
    message: "No AI key is connected yet.",
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    name: "NO_AI_ROUTE code",
    err: new ApiError(400, {
      code: "NO_AI_ROUTE",
      error: "no ai route configured for this workspace",
    }),
    message: "No AI engine is connected yet.",
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    name: "no ai route configured raw regex",
    err: new ApiError(400, { error: "No AI route configured" }),
    message: "No AI engine is connected yet.",
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    name: "no database yet",
    err: new ApiError(409, { error: "no database yet, run careerrat migrate" }),
    message: "This workspace hasn't finished setup yet. Finish setup, then try again.",
    action: null,
  },
  {
    name: "candidate/profile.yml exact",
    err: new ApiError(400, {
      error: "candidate/profile.yml and candidate/targeting.yml are required first",
    }),
    message: "Your candidate profile isn't finished yet.",
    action: { label: "Finish setup", to: "/onboarding" },
  },
  {
    name: "SQLite candidate setup prefix",
    err: new ApiError(400, { error: "SQLite candidate setup is required before this route" }),
    message: "Your candidate profile isn't finished yet.",
    action: { label: "Finish setup", to: "/onboarding" },
  },
  {
    name: "Candidate setup is not search-ready",
    err: new ApiError(400, { error: "Candidate setup is not search-ready: missing targeting" }),
    message: "Your profile needs a bit more info before CareerRat can search for jobs.",
    action: { label: "Finish setup", to: "/onboarding" },
  },
  {
    name: "No search config found",
    err: new ApiError(400, { error: "No search config found for this workspace" }),
    message: "No search sources are set up yet.",
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    name: "unsupported ATS host",
    err: new ApiError(400, {
      error: 'unsupported ATS host — cannot scan "https://example.com/jobs"',
    }),
    message:
      "That isn't a supported company job-board URL. Use a Greenhouse, Lever, Ashby, or Workday board.",
    action: null,
  },
  {
    name: "a scan is already running",
    err: new ApiError(409, { error: "a scan is already running" }),
    message: "A search is already running right now.",
    action: null,
  },
  {
    name: "application submission not verified",
    err: new ApiError(409, {
      code: "APPLICATION_NOT_VERIFIED",
      error: "No confirmation page found.",
    }),
    message:
      "CareerRat couldn't verify a submission confirmation, so it did not mark this Applied. Check the site, then use “I applied elsewhere” if it went through.",
    action: null,
  },
  {
    name: "job body requires browser",
    err: new ApiError(409, {
      code: "JOB_BODY_REQUIRES_BROWSER",
      error: "The full job description could not be read from this URL.",
    }),
    message:
      "CareerRat couldn't read the full posting from that link. Open the job in your connected browser or paste the job description here.",
    action: null,
  },
  {
    name: "job identity required",
    err: new ApiError(400, {
      code: "JOB_IDENTITY_REQUIRED",
      error: "The company and role could not be determined.",
    }),
    message:
      "CareerRat read the page but couldn't identify the company and role. Paste the job description or use the direct posting link.",
    action: null,
  },
  {
    name: "job capture failed",
    err: new ApiError(409, {
      code: "JOB_CAPTURE_FAILED",
      error: "The posting could not be captured.",
    }),
    message:
      "CareerRat couldn't save that posting. Try the direct job link or paste the description.",
    action: { label: "Try again", retry: true },
  },
  {
    name: "job URL required",
    err: new ApiError(400, {
      code: "JOB_URL_REQUIRED",
      error: "A job URL is required.",
    }),
    message: "Paste the direct job-posting link so CareerRat can read and save it.",
    action: null,
  },
  {
    name: "ambiguous saved job reference",
    err: new ApiError(409, {
      code: "JOB_REFERENCE_AMBIGUOUS",
      error: { message: "internal text must not render" },
      details: {
        matches: [
          { company: "Acme", role: "Senior AI Engineer" },
          { company: "Acme", role: "Staff Platform Engineer" },
        ],
      },
    }),
    message:
      "That matches more than one saved job: Acme — Senior AI Engineer; Acme — Staff Platform Engineer. Name the company and role more specifically.",
    action: null,
  },
  {
    name: "missing saved job reference",
    err: new ApiError(404, {
      code: "JOB_REFERENCE_NOT_FOUND",
      error: { message: "internal text must not render" },
    }),
    message: "CareerRat couldn't find that saved job. Check the company or role and try again.",
    action: null,
  },
  {
    name: "ambiguous recruiter thread reference",
    err: new ApiError(409, {
      code: "COMMUNICATION_REFERENCE_AMBIGUOUS",
      error: { message: "internal text must not render" },
      details: {
        matches: [
          { company: "Acme", role: "Senior AI Engineer", subject: "Interview availability" },
          { company: "Acme", role: "Staff Platform Engineer", subject: "Application update" },
        ],
      },
    }),
    message:
      "That matches more than one recruiter thread: Acme — Senior AI Engineer — Interview availability; Acme — Staff Platform Engineer — Application update. Name the company, role, or subject more specifically.",
    action: null,
  },
  {
    name: "missing recruiter thread reference",
    err: new ApiError(404, {
      code: "COMMUNICATION_REFERENCE_NOT_FOUND",
      error: { message: "internal text must not render" },
    }),
    message:
      "CareerRat couldn't find that recruiter thread. Check the company, role, or subject and try again.",
    action: null,
  },
  {
    name: "company research: no tracked company matches",
    err: new ApiError(404, {
      code: "COMPANY_NOT_FOUND",
      error: { message: "internal text must not render" },
    }),
    message:
      "CareerRat couldn't find that company among your saved jobs. Name it exactly as it appears there.",
    action: null,
  },
  {
    name: "company research: ambiguous tracked company reference",
    err: new ApiError(409, {
      code: "COMPANY_AMBIGUOUS",
      error: { message: "internal text must not render" },
      details: {
        matches: [{ company: "Acme Freight" }, { company: "Acme Medical" }],
      },
    }),
    message:
      "That matches more than one saved company: Acme Freight; Acme Medical. Name it more specifically.",
    action: null,
  },
  {
    name: "company health: company is not a tracked job",
    err: new ApiError(409, {
      code: "COMPANY_NOT_TRACKED",
      error: { message: "internal text must not render" },
    }),
    message:
      "Health ratings attach to a saved job. Save this role first, or ask CareerRat to research the company instead.",
    action: null,
  },
  {
    name: "market comp: role and location required",
    err: new ApiError(400, {
      code: "RESEARCH_COMP_INPUT_REQUIRED",
      error: { message: "internal text must not render" },
    }),
    message: "Tell CareerRat the role and the location so it can look up comp for it.",
    action: null,
  },
  {
    name: "PDF/DOCX not supported prefix",
    err: new ApiError(400, { error: "PDF/DOCX not supported yet, use text or markdown" }),
    message:
      "That file type isn't supported yet. Export your resume as text or markdown, then try again.",
    action: null,
  },
  {
    name: "server restarted mid-session",
    err: new ApiError(409, { error: "server restarted mid-session; re-open to retry" }),
    message: "CareerRat restarted while that was running.",
    action: { label: "Try again", retry: true },
  },
  {
    name: "upstream_unreachable",
    err: new ApiError(502, { error: "upstream_unreachable" }),
    message: "Couldn't reach the AI service right now.",
    action: { label: "Try again", retry: true },
  },
  {
    name: "proxy_error",
    err: new ApiError(502, { error: "proxy_error" }),
    message: "Something went wrong reaching the AI service.",
    action: { label: "Try again", retry: true },
  },
  {
    name: "artifact not found",
    err: new ApiError(404, { error: "artifact not found" }),
    message: "That file isn't available anymore.",
    action: null,
  },
  {
    name: "not_found",
    err: new ApiError(404, { error: "not_found" }),
    message: "That couldn't be found.",
    action: null,
  },
  {
    name: "unauthorized raw",
    err: new ApiError(401, { error: "unauthorized" }),
    message: "That request wasn't authorized.",
    action: null,
  },
  {
    name: "status 401 without unauthorized raw",
    err: new ApiError(401, { error: "some other reason" }),
    message: "That request wasn't authorized.",
    action: null,
  },
  {
    name: "status 403",
    err: new ApiError(403, { error: "forbidden" }),
    message: "That request wasn't authorized.",
    action: null,
  },
  {
    name: "status >= 500 generic server error",
    err: new ApiError(500, { error: "internal server error boom" }),
    message: "Something went wrong on the server. Try again in a moment.",
    action: { label: "Try again", retry: true },
  },
  {
    name: "status 404 with unmapped raw",
    err: new ApiError(404, { error: "route not registered" }),
    message: "That couldn't be found.",
    action: null,
  },
  {
    name: "a UserFacingError (copy we wrote, not a server string)",
    err: new UserFacingError("Advanced mode must be turned on first."),
    message: "Advanced mode must be turned on first.",
    action: null,
  },
];

describe("resolveErrorCopy — mapped rules", () => {
  for (const { name, err, message, action } of RULE_CASES) {
    it(`maps ${name}`, () => {
      const result = resolveErrorCopy(err);
      expect(result.message).toBe(message);
      expect(result.action).toEqual(action);
    });
  }
});

describe("resolveErrorCopy — detail preservation", () => {
  it("preserves the raw string verbatim for a plain-string body.error", () => {
    const err = new ApiError(409, { error: "a scan is already running" });
    expect(resolveErrorCopy(err).detail).toBe("a scan is already running");
  });

  it("preserves the raw string verbatim for a body.error object with message", () => {
    const err = new ApiError(400, {
      error: { message: "No AI key is configured here", code: "x" },
    });
    expect(resolveErrorCopy(err).detail).toBe("No AI key is configured here");
  });

  it("preserves a dynamic-suffix raw string verbatim", () => {
    const err = new ApiError(400, {
      error: "SQLite candidate setup is required: candidate/profile.yml missing",
    });
    expect(resolveErrorCopy(err).detail).toBe(
      "SQLite candidate setup is required: candidate/profile.yml missing"
    );
  });

  it("preserves null detail when nothing could be extracted", () => {
    const err = new ApiError(500, {});
    expect(resolveErrorCopy(err).detail).toBeNull();
  });
});

describe("resolveErrorCopy — unmapped/generic fallback", () => {
  it("falls back to the generic message for an unmapped client-bug string", () => {
    const err = new ApiError(400, { error: "body.claims must be an array" });
    expect(resolveErrorCopy(err).message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("falls back to the generic message for another unmapped client-bug string", () => {
    const err = new ApiError(400, { error: "?domain= or ?name= is required" });
    expect(resolveErrorCopy(err).message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("falls back to the generic message for a completely novel unseen string", () => {
    const err = new ApiError(400, { error: "flux capacitor desynchronized at row 42" });
    expect(resolveErrorCopy(err).message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("gives the generic fallback a retry action", () => {
    const err = new ApiError(400, { error: "flux capacitor desynchronized at row 42" });
    expect(resolveErrorCopy(err).action).toEqual({ label: "Try again", retry: true });
  });

  // The passthrough is earned by the TYPE, never by the sentence. A plain
  // Error carrying identical text is still an untrusted string and must be
  // translated, otherwise a server that happened to echo that wording would
  // render straight to the candidate.
  it("does not pass through a plain Error carrying UserFacingError's wording", () => {
    const err = new Error("Advanced mode must be turned on first.");
    expect(resolveErrorCopy(err).message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("keeps a UserFacingError's raw text out of the technical-details slot", () => {
    const err = new UserFacingError("Advanced mode must be turned on first.");
    expect(resolveErrorCopy(err).detail).toBeNull();
  });
});

describe("resolveErrorCopy — regression guard against raw string leakage", () => {
  const BANNED_SUBSTRINGS = [["role", "ster"].join(""), "yml", "sqlite", "body.", "?"];
  const ALL_CASES = [
    ...RULE_CASES.map((c) => c.err),
    new ApiError(400, { error: "body.claims must be an array" }),
    new ApiError(400, { error: "?domain= or ?name= is required" }),
  ];

  it("never lets a mapped message contain a banned raw-string substring", () => {
    for (const err of ALL_CASES) {
      const { message } = resolveErrorCopy(err);
      const lowered = message.toLowerCase();
      for (const banned of BANNED_SUBSTRINGS) {
        expect(lowered.includes(banned)).toBe(false);
      }
    }
  });

  it("actually translates raw strings that contained a banned substring, not just omits them", () => {
    const bannedInputs = [
      new ApiError(400, {
        error: "candidate/profile.yml and candidate/targeting.yml are required first",
      }),
      new ApiError(400, { error: "SQLite candidate setup is required" }),
      new ApiError(400, { error: "body.claims must be an array" }),
      new ApiError(400, { error: "?domain= or ?name= is required" }),
    ];
    for (const err of bannedInputs) {
      const { message, detail } = resolveErrorCopy(err);
      expect(detail).not.toBeNull();
      expect(message).not.toBe(detail);
      expect(message.toLowerCase()).not.toContain(detail.toLowerCase());
    }
  });
});

describe("resolveErrorCopy — non-ApiError input", () => {
  it("handles a plain Error without throwing", () => {
    const err = new Error("Failed to fetch");
    expect(() => resolveErrorCopy(err)).not.toThrow();
    const result = resolveErrorCopy(err);
    expect(result.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(result.detail).toBe("Failed to fetch");
  });

  it("handles a completely unknown value without throwing", () => {
    expect(() => resolveErrorCopy({})).not.toThrow();
    const result = resolveErrorCopy({});
    expect(result.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(result.detail).toBeNull();
  });

  it("handles undefined without throwing", () => {
    expect(() => resolveErrorCopy(undefined)).not.toThrow();
    expect(resolveErrorCopy(undefined).message).toBe(GENERIC_ERROR_MESSAGE);
  });
});
