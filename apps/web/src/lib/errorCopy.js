import { ApiError } from "./api.js";

// Client-side translation layer: server/API error strings are a developer-
// facing contract (file paths, SQLite/table names, query-param syntax, CLI
// command names) and must never render as the primary message a candidate
// sees. resolveErrorCopy() maps a raw err into plain-language copy plus an
// optional in-app action, while preserving the original raw string as
// `detail` for anyone who expands "Technical details".

export const GENERIC_ERROR_MESSAGE =
  "Something went wrong on this computer. Try again, and if it keeps happening, restart CareerRat.";

// A guard clause the UI throws before any request leaves the browser. Its
// message is copy we wrote for the candidate, so it is already safe to show
// and passes through untranslated. Throwing this type rather than a plain
// Error is what makes it safe: matching on the sentence instead would put the
// same copy in two files and silently fall back to the generic message the
// moment either one was reworded.
export class UserFacingError extends Error {
  constructor(message, action = null) {
    super(message);
    this.name = "UserFacingError";
    this.action = action;
  }
}

function normalize(err) {
  if (err instanceof ApiError) {
    const body = err.body || {};
    const raw = typeof body.error === "string" ? body.error : (body.error?.message ?? null);
    const code = body.code ?? body.error?.code ?? null;
    return { raw, code, status: err.status, details: body.details || null };
  }
  if (err instanceof Error) {
    return { raw: err.message || null, code: null, status: null, details: null };
  }
  return { raw: null, code: null, status: null, details: null };
}

function savedJobAmbiguityMessage(details) {
  const matches = Array.isArray(details?.matches) ? details.matches : [];
  const labels = matches
    .slice(0, 5)
    .map(({ company, role }) =>
      [String(company || "").trim(), String(role || "").trim()].filter(Boolean).join(" — ")
    )
    .filter(Boolean);
  return labels.length
    ? `That matches more than one saved job: ${labels.join("; ")}. Name the company and role more specifically.`
    : "That matches more than one saved job. Name the company and role more specifically.";
}

function communicationAmbiguityMessage(details) {
  const matches = Array.isArray(details?.matches) ? details.matches : [];
  const labels = matches
    .slice(0, 5)
    .map(({ company, role, subject }) =>
      [String(company || "").trim(), String(role || "").trim(), String(subject || "").trim()]
        .filter(Boolean)
        .join(" — ")
    )
    .filter(Boolean);
  return labels.length
    ? `That matches more than one recruiter thread: ${labels.join("; ")}. Name the company, role, or subject more specifically.`
    : "That matches more than one recruiter thread. Name the company, role, or subject more specifically.";
}

function communicationChannelUnsupportedMessage(details) {
  const channel = String(details?.channel || "").trim();
  return channel
    ? `This thread is on ${channel}. CareerRat can only prepare email sends. Reply there yourself, then choose “I sent this”.`
    : "CareerRat can only prepare email sends. Reply on that channel yourself, then choose “I sent this”.";
}

function settingsChangeUnsupportedMessage(details) {
  const reason = details?.reason;
  if (reason === "consent") {
    return "Consent changes happen in Settings, where CareerRat shows you exactly what each platform allows.";
  }
  if (reason === "capability-tier") {
    return "That automation level gets turned on in Settings so you can review what it does first.";
  }
  return "CareerRat can't change that setting from here. Use the Settings page.";
}

function settingsChangeInvalidMessage(details) {
  if (details?.reason === "comp-reference") {
    return "CareerRat keeps your current pay private and never uses it to set search settings. Give the number you want instead.";
  }
  let message = "CareerRat couldn't apply that settings change as written.";
  if (Array.isArray(details?.options) && details.options.length) {
    message += ` Valid options: ${details.options.join(", ")}.`;
  }
  return message;
}

function companyAmbiguityMessage(details) {
  const matches = Array.isArray(details?.matches) ? details.matches : [];
  const labels = matches
    .slice(0, 5)
    .map(({ company }) => String(company || "").trim())
    .filter(Boolean);
  return labels.length
    ? `That matches more than one saved company: ${labels.join("; ")}. Name it more specifically.`
    : "That matches more than one saved company. Name it more specifically.";
}

const RULES = [
  {
    match: ({ raw, code }) => code === "missing_key" || startsWith(raw, "No AI key is configured"),
    message: "No AI key is connected yet.",
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    match: ({ raw, code }) => code === "NO_AI_ROUTE" || /^no ai route configured/i.test(raw || ""),
    message: "No AI engine is connected yet.",
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    match: ({ raw }) => startsWith(raw, "no database yet"),
    message: "This workspace hasn't finished setup yet. Finish setup, then try again.",
    action: null,
  },
  {
    match: ({ raw }) =>
      raw === "candidate/profile.yml and candidate/targeting.yml are required first" ||
      startsWith(raw, "SQLite candidate setup is required"),
    message: "Your candidate profile isn't finished yet.",
    action: { label: "Finish setup", to: "/onboarding" },
  },
  {
    match: ({ raw }) => startsWith(raw, "Candidate setup is not search-ready"),
    message: "Your profile needs a bit more info before CareerRat can search for jobs.",
    action: { label: "Finish setup", to: "/onboarding" },
  },
  {
    match: ({ raw }) => startsWith(raw, "No search config found"),
    message: "No search sources are set up yet.",
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    match: ({ raw }) => startsWith(raw, "unsupported ATS host"),
    message:
      "That isn't a supported company job-board URL. Use a Greenhouse, Lever, Ashby, or Workday board.",
    action: null,
  },
  {
    match: ({ raw }) => raw === "a scan is already running",
    message: "A search is already running right now.",
    action: null,
  },
  {
    match: ({ code }) => code === "APPLICATION_NOT_VERIFIED",
    message:
      "CareerRat couldn't verify a submission confirmation, so it did not mark this Applied. Check the site, then use “I applied elsewhere” if it went through.",
    action: null,
  },
  {
    match: ({ code }) => code === "JOB_BODY_REQUIRES_BROWSER",
    message:
      "CareerRat couldn't read the full posting from that link. Open the job in your connected browser or paste the job description here.",
    action: null,
  },
  {
    match: ({ code }) => code === "JOB_IDENTITY_REQUIRED",
    message:
      "CareerRat read the page but couldn't identify the company and role. Paste the job description or use the direct posting link.",
    action: null,
  },
  {
    match: ({ code }) => code === "JOB_CAPTURE_FAILED",
    message:
      "CareerRat couldn't save that posting. Try the direct job link or paste the description.",
    action: { label: "Try again", retry: true },
  },
  {
    match: ({ code }) => code === "JOB_URL_REQUIRED",
    message: "Paste the direct job-posting link so CareerRat can read and save it.",
    action: null,
  },
  {
    match: ({ code }) => code === "JOB_REFERENCE_AMBIGUOUS",
    message: ({ details }) => savedJobAmbiguityMessage(details),
    action: null,
  },
  {
    match: ({ code }) => code === "JOB_REFERENCE_NOT_FOUND",
    message: "CareerRat couldn't find that saved job. Check the company or role and try again.",
    action: null,
  },
  {
    match: ({ code }) => code === "COMMUNICATION_REFERENCE_AMBIGUOUS",
    message: ({ details }) => communicationAmbiguityMessage(details),
    action: null,
  },
  {
    match: ({ code }) => code === "COMMUNICATION_REFERENCE_NOT_FOUND",
    message:
      "CareerRat couldn't find that recruiter thread. Check the company, role, or subject and try again.",
    action: null,
  },
  {
    match: ({ code }) => code === "COMMUNICATION_EXECUTOR_UNAVAILABLE",
    message:
      "CareerRat can't send email for you yet. Use Open in your email app, send it yourself, then choose I sent this.",
    action: null,
  },
  {
    match: ({ code }) => code === "COMMUNICATION_CHANNEL_UNSUPPORTED",
    message: ({ details }) => communicationChannelUnsupportedMessage(details),
    action: null,
  },
  {
    match: ({ code }) => code === "COMMUNICATION_NOT_VERIFIED",
    message: "CareerRat couldn't confirm that send. If you sent it yourself, choose I sent this.",
    action: null,
  },
  {
    match: ({ code }) => code === "COMMUNICATION_COMP_LEAK",
    message:
      "This draft still contains your private current pay figure. Edit the draft before sending.",
    action: null,
  },
  {
    match: ({ code }) => code === "COMMUNICATION_DRAFT_PLACEHOLDER",
    message: "This draft still has unfinished placeholder text. Finish the draft before sending.",
    action: null,
  },
  {
    match: ({ code }) => code === "SETTINGS_CHANGE_UNSUPPORTED",
    message: ({ details }) => settingsChangeUnsupportedMessage(details),
    action: { label: "Open Settings", to: "/settings" },
  },
  {
    match: ({ code }) => code === "SETTINGS_CHANGE_INVALID",
    message: ({ details }) => settingsChangeInvalidMessage(details),
    action: null,
  },
  {
    match: ({ code }) => code === "COMPANY_NOT_FOUND",
    message:
      "CareerRat couldn't find that company among your saved jobs. Name it exactly as it appears there.",
    action: null,
  },
  {
    match: ({ code }) => code === "COMPANY_AMBIGUOUS",
    message: ({ details }) => companyAmbiguityMessage(details),
    action: null,
  },
  {
    match: ({ code }) => code === "COMPANY_NOT_TRACKED",
    message:
      "Health ratings attach to a saved job. Save this role first, or ask CareerRat to research the company instead.",
    action: null,
  },
  {
    match: ({ code }) => code === "RESEARCH_COMP_INPUT_REQUIRED",
    message: "Tell CareerRat the role and the location so it can look up comp for it.",
    action: null,
  },
  {
    match: ({ code }) => code === "STRATEGY_APPLY_UNSUPPORTED",
    message:
      "CareerRat can't apply that recommendation automatically. Review it yourself and make the change by hand.",
    action: null,
  },
  {
    match: ({ code }) => code === "STRATEGY_APPLY_INVALID",
    message: "CareerRat couldn't apply that recommendation as written.",
    action: null,
  },
  {
    match: ({ code }) => code === "STRATEGY_APPLY_STALE",
    message:
      "That recommendation is out of date. Run the strategy review again, then apply from the fresh result.",
    action: null,
  },
  {
    match: ({ raw }) => startsWith(raw, "PDF/DOCX not supported"),
    message:
      "That file type isn't supported yet. Export your resume as text or markdown, then try again.",
    action: null,
  },
  {
    match: ({ raw }) => raw === "server restarted mid-session; re-open to retry",
    message: "CareerRat restarted while that was running.",
    action: { label: "Try again", retry: true },
  },
  {
    match: ({ raw }) => raw === "upstream_unreachable",
    message: "Couldn't reach the AI service right now.",
    action: { label: "Try again", retry: true },
  },
  {
    match: ({ raw }) => raw === "proxy_error",
    message: "Something went wrong reaching the AI service.",
    action: { label: "Try again", retry: true },
  },
  {
    match: ({ raw }) => raw === "artifact not found",
    message: "That file isn't available anymore.",
    action: null,
  },
  {
    match: ({ raw }) => raw === "not_found",
    message: "That couldn't be found.",
    action: null,
  },
  {
    match: ({ raw, status }) => raw === "unauthorized" || status === 401 || status === 403,
    message: "That request wasn't authorized.",
    action: null,
  },
  {
    match: ({ status }) => typeof status === "number" && status >= 500,
    message: "Something went wrong on the server. Try again in a moment.",
    action: { label: "Try again", retry: true },
  },
  {
    match: ({ status }) => status === 404,
    message: "That couldn't be found.",
    action: null,
  },
];

function startsWith(raw, prefix) {
  return typeof raw === "string" && raw.startsWith(prefix);
}

export function resolveErrorCopy(err) {
  if (err instanceof UserFacingError) {
    return { message: err.message, action: err.action, detail: null };
  }
  const { raw, code, status, details } = normalize(err);
  const context = { raw, code, status, details };
  const rule = RULES.find((candidate) => candidate.match(context));
  if (rule) {
    return {
      message: typeof rule.message === "function" ? rule.message(context) : rule.message,
      action: rule.action,
      detail: raw,
    };
  }
  return {
    message: GENERIC_ERROR_MESSAGE,
    action: { label: "Try again", retry: true },
    detail: raw,
  };
}

// Shared by every catch site across the app that resolves an error through
// resolveErrorCopy() and wants a call-site-specific fallback instead of the
// generic bucket's copy when nothing more specific was mapped — ported here
// from InterviewSurface.jsx's own errorState() (the first site to need it)
// so later sites reuse one definition instead of copy-pasting it per file.
export function errorState(err, fallback) {
  const resolved = resolveErrorCopy(err);
  return resolved.message === GENERIC_ERROR_MESSAGE ? { ...resolved, message: fallback } : resolved;
}

// Threads a real retry callback through a resolveErrorCopy()/errorState()
// result — the resolved `action` carries {label, retry: true} with no
// callback of its own, so every catch site that wants the "Try again" button
// to actually do something supplies the exact call that just failed. Ported
// here from JobDrawer.jsx/InterviewSurface.jsx's own withRetryAction() for
// the same reason as errorState() above.
export function withRetryAction(resolved, onRetry) {
  return resolved.action?.retry
    ? { ...resolved, action: { ...resolved.action, onRetry } }
    : resolved;
}
