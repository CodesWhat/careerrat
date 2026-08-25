import { classifyBrowserAuthState } from "./browser-session.mjs";

const DEFAULT_URLS = Object.freeze({
  gmail:
    "https://mail.google.com/mail/u/0/#search/(application+OR+interview+OR+recruiter+OR+assessment+OR+offer)",
  outlook:
    "https://outlook.live.com/mail/0/search/id/AQMkADAwATM0MDAAMS0/search?q=application%20OR%20interview%20OR%20recruiter",
  linkedinMessages: "https://www.linkedin.com/messaging/",
  wellfoundMessages: "https://wellfound.com/messages",
  linkedinPeople: "https://www.linkedin.com/search/results/people/",
  wellfoundPeople: "https://wellfound.com/people",
  linkedinProfile: "https://www.linkedin.com/in/me/",
});

const MAIL = Object.freeze({
  gmail: {
    url: DEFAULT_URLS.gmail,
    rowSelectors: ["[data-careerrat-mail-row]", "tr.zA", '[role="main"] tr'],
    fields: {
      id: { kind: "attr", attribute: "data-thread-id", selectors: [":scope"] },
      subject: { selectors: ["[data-subject]", ".bog", '[role="link"] span'] },
      sender: { selectors: ["[data-sender]", ".yX.xY .yP", "[email]"] },
      receivedAt: {
        kind: "attr",
        attribute: "datetime",
        selectors: ["time", "[data-received-at]"],
      },
      preview: { selectors: ["[data-preview]", ".y2", ".snippet"] },
      href: { kind: "href", selectors: ["a[href]"] },
    },
    bodySelectors: ["[data-careerrat-body]", ".a3s.aiL", ".ii.gt .a3s", '[role="main"] .a3s'],
  },
  outlook: {
    url: DEFAULT_URLS.outlook,
    rowSelectors: ["[data-careerrat-mail-row]", '[role="option"]', "[data-convid]"],
    fields: {
      id: { kind: "attr", attribute: "data-convid", selectors: [":scope"] },
      subject: { selectors: ["[data-subject]", "[title]", ".subject"] },
      sender: {
        selectors: ["[data-sender]", ".sender", "[aria-label*='From']"],
      },
      receivedAt: {
        kind: "attr",
        attribute: "datetime",
        selectors: ["time", "[data-received-at]"],
      },
      preview: { selectors: ["[data-preview]", ".preview", ".snippet"] },
      href: { kind: "href", selectors: ["a[href]"] },
    },
    bodySelectors: [
      "[data-careerrat-body]",
      '[role="document"]',
      ".allowTextSelection",
      '[data-app-section="MailReadCompose"]',
    ],
  },
});

const MESSAGES = Object.freeze({
  linkedin: {
    url: DEFAULT_URLS.linkedinMessages,
    rowSelectors: [
      "[data-careerrat-message-row]",
      "li.msg-conversation-listitem",
      "li.msg-conversations-container__pillar",
    ],
    bodySelectors: [
      "[data-careerrat-body]",
      ".msg-s-message-list-content",
      ".msg-s-event-listitem__body",
    ],
  },
  wellfound: {
    url: DEFAULT_URLS.wellfoundMessages,
    rowSelectors: ["[data-careerrat-message-row]", "[data-test='message-thread']", "li"],
    bodySelectors: [
      "[data-careerrat-body]",
      '[data-test="message-thread-content"]',
      "main [data-test*='message'] p",
    ],
  },
});

const MESSAGE_FIELDS = Object.freeze({
  id: { kind: "attr", attribute: "data-thread-id", selectors: [":scope"] },
  participant: {
    selectors: ["[data-participant]", ".participant", "h3", "strong"],
  },
  company: { selectors: ["[data-company]", ".company"] },
  role: { selectors: ["[data-role]", ".role"] },
  receivedAt: {
    kind: "attr",
    attribute: "datetime",
    selectors: ["time", "[data-received-at]"],
  },
  preview: { selectors: ["[data-preview]", ".preview", ".snippet", "p"] },
  href: { kind: "href", selectors: ["a[href]"] },
});

const JOB_MAIL_SIGNAL =
  /\b(?:application|interview|recruiter|hiring|assessment|offer|candidate|position|role|job)\b/i;
const PRIVATE_MAIL_SIGNAL =
  /\b(?:verification code|security alert|password reset|new sign[- ]in|two[- ]factor|one[- ]time passcode)\b/i;

function clean(value, max = 20_000) {
  return String(value || "")
    .replaceAll("\0", "")
    .trim()
    .slice(0, max);
}

function workflowBlocker(state, message, details = {}) {
  return {
    ok: false,
    state,
    blocker: { code: state.toUpperCase(), message, ...details },
  };
}

async function openReady(session, url) {
  if (!session?.available) {
    return workflowBlocker(
      "browser_unavailable",
      session?.reason || "The configured browser is unavailable."
    );
  }
  try {
    const page = await session.open(url);
    const auth = classifyBrowserAuthState(page);
    if (auth) return workflowBlocker(auth.state, auth.message, { url: page.url });
    return { ok: true, page };
  } catch (error) {
    return workflowBlocker("browser_error", clean(error?.message, 500) || "Browser failed.");
  }
}

async function hydrateBodies(session, extraction, { max = 25, bodySelectors = [] } = {}) {
  const rows = extraction.rows.slice(0, max);
  const listUrl = (await session.pageContent()).url;
  for (const row of rows) {
    try {
      let page;
      if (row.href) page = await session.navigate(row.href);
      else
        page = await session.clickRow({
          rowSelector: extraction.rowSelector,
          index: row.index,
        });
      const auth = classifyBrowserAuthState(page);
      if (auth) return { rows: [], blocker: auth };
      const extracted = await session.extractText({
        selectors: bodySelectors,
        maxText: 20_000,
      });
      row.body = clean(extracted.text || row.preview);
      if (!extracted.selector) row.readError = "Message body selector was not found.";
      await session.navigate(listUrl);
    } catch (error) {
      row.body = clean(row.preview);
      row.readError = clean(error?.message, 300);
      await session.navigate(listUrl).catch(() => {});
    }
  }
  return { rows, blocker: null };
}

async function extractRowsReady(session, options) {
  let extraction = { rowSelector: null, rows: [] };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    extraction = await session.extractRows(options);
    if (extraction.rowSelector) return extraction;
    if (attempt === 5) break;
    if (attempt === 1) await session.scroll(600).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return extraction;
}

function sinceFilter(rows, since) {
  const cutoff = Date.parse(since || "");
  if (!Number.isFinite(cutoff)) return rows;
  return rows.filter((row) => {
    const received = Date.parse(row.receivedAt || "");
    return !Number.isFinite(received) || received >= cutoff;
  });
}

function jobSearchMail(rows) {
  return rows.filter((row) => {
    const text = `${row.subject || ""}\n${row.preview || ""}`;
    return JOB_MAIL_SIGNAL.test(text) && !PRIVATE_MAIL_SIGNAL.test(text);
  });
}

export async function readWebmailThreads({ session, platform, url, since } = {}) {
  const adapter = MAIL[platform];
  if (!adapter)
    return workflowBlocker("unsupported_platform", `Unsupported mail platform: ${platform}`);
  const opened = await openReady(session, url || adapter.url);
  if (!opened.ok) return opened;
  const extraction = await extractRowsReady(session, {
    rowSelectors: adapter.rowSelectors,
    fields: adapter.fields,
    maxRows: 50,
  });
  if (!extraction.rowSelector) {
    return workflowBlocker(
      "provider_changed",
      `${platform} opened, but CareerRat could not find the inbox thread list.`
    );
  }
  extraction.rows = jobSearchMail(sinceFilter(extraction.rows, since));
  const hydrated = await hydrateBodies(session, extraction, {
    bodySelectors: adapter.bodySelectors,
  });
  if (hydrated.blocker) return workflowBlocker(hydrated.blocker.state, hydrated.blocker.message);
  return {
    ok: true,
    state: "completed",
    records: hydrated.rows,
    url: opened.page.url,
  };
}

export async function readPlatformMessageThreads({ session, platform, url, since } = {}) {
  const adapter = MESSAGES[platform];
  if (!adapter) {
    return workflowBlocker("unsupported_platform", `Unsupported message platform: ${platform}`);
  }
  const opened = await openReady(session, url || adapter.url);
  if (!opened.ok) return opened;
  const extraction = await extractRowsReady(session, {
    rowSelectors: adapter.rowSelectors,
    fields: MESSAGE_FIELDS,
    maxRows: 50,
  });
  if (!extraction.rowSelector) {
    return workflowBlocker(
      "provider_changed",
      `${platform} opened, but CareerRat could not find the message thread list.`
    );
  }
  extraction.rows = sinceFilter(extraction.rows, since);
  const hydrated = await hydrateBodies(session, extraction, {
    bodySelectors: adapter.bodySelectors,
  });
  if (hydrated.blocker) return workflowBlocker(hydrated.blocker.state, hydrated.blocker.message);
  return {
    ok: true,
    state: "completed",
    records: hydrated.rows,
    url: opened.page.url,
  };
}

export async function readLinkedinPeople({ session, company, url } = {}) {
  const target = new URL(url || DEFAULT_URLS.linkedinPeople);
  if (!url) target.searchParams.set("keywords", `${company} recruiter hiring manager`);
  const opened = await openReady(session, target.toString());
  if (!opened.ok) return opened;
  const extraction = await extractRowsReady(session, {
    rowSelectors: [
      "[data-careerrat-person-row]",
      "li.reusable-search__result-container",
      ".search-results-container li",
    ],
    fields: {
      name: { selectors: ["[data-name]", ".entity-result__title-text", "h3"] },
      title: {
        selectors: ["[data-title]", ".entity-result__primary-subtitle", ".title"],
      },
      company: {
        selectors: ["[data-company]", ".entity-result__secondary-subtitle"],
      },
      basis: {
        selectors: ["[data-basis]", ".entity-result__summary", ".summary"],
      },
      url: { kind: "href", selectors: ["a[href*='/in/']", "a[href]"] },
    },
    maxRows: 25,
  });
  if (!extraction.rowSelector) {
    return workflowBlocker(
      "provider_changed",
      "LinkedIn opened, but CareerRat could not find the people result list."
    );
  }
  return {
    ok: true,
    state: "completed",
    records: extraction.rows.filter((row) => row.name && row.url),
    url: opened.page.url,
  };
}

export async function readWellfoundPeople({ session, company, url } = {}) {
  const target = new URL(url || DEFAULT_URLS.wellfoundPeople);
  if (!url) target.searchParams.set("q", `${company} recruiter hiring manager`);
  const opened = await openReady(session, target.toString());
  if (!opened.ok) return opened;
  const extraction = await extractRowsReady(session, {
    rowSelectors: ["[data-careerrat-person-row]", "[data-test='people-result']", "main li"],
    fields: {
      name: { selectors: ["[data-name]", "h3", "strong"] },
      title: { selectors: ["[data-title]", ".title", "p"] },
      company: { selectors: ["[data-company]", ".company"] },
      basis: { selectors: ["[data-basis]", ".summary"] },
      url: { kind: "href", selectors: ["a[href*='/u/']", "a[href]"] },
    },
    maxRows: 25,
  });
  if (!extraction.rowSelector) {
    return workflowBlocker(
      "provider_changed",
      "Wellfound opened, but CareerRat could not find the people result list."
    );
  }
  return {
    ok: true,
    state: "completed",
    records: extraction.rows.filter((row) => row.name && row.url),
    url: opened.page.url,
  };
}

export async function readLinkedinProfile({ session, url } = {}) {
  const opened = await openReady(session, url || DEFAULT_URLS.linkedinProfile);
  if (!opened.ok) return opened;
  const extraction = await extractRowsReady(session, {
    rowSelectors: ["[data-careerrat-profile-surface]", "main section"],
    fields: {
      surfaceId: {
        kind: "attr",
        attribute: "data-surface-id",
        selectors: [":scope"],
      },
      surface: { selectors: ["[data-surface]", "h1", "h2"] },
      current: { selectors: ["[data-current]", ".inline-show-more-text", "p"] },
    },
    maxRows: 20,
  });
  if (!extraction.rowSelector || !extraction.rows.some((row) => row.current)) {
    return workflowBlocker(
      "provider_changed",
      "LinkedIn opened, but CareerRat could not read the profile sections."
    );
  }
  return {
    ok: true,
    state: "completed",
    records: extraction.rows
      .filter((row) => row.current)
      .map((row, index) => ({
        surfaceId: clean(row.surfaceId, 80) || `surface-${index + 1}`,
        surface: clean(row.surface, 120) || `Profile section ${index + 1}`,
        current: clean(row.current, 4_000),
      })),
    url: opened.page.url,
  };
}

export async function readAtsStatus({ session, platform, url } = {}) {
  const opened = await openReady(session, url);
  if (!opened.ok) return opened;
  const extraction = await extractRowsReady(session, {
    rowSelectors: [
      "[data-careerrat-status]",
      "[data-application-status]",
      ".application-status",
      ".status",
    ],
    fields: {
      rawStatus: { selectors: [":scope", "[data-status-label]"] },
    },
    maxRows: 5,
  });
  const rawStatus = clean(extraction.rows[0]?.rawStatus, 300);
  if (!rawStatus) {
    return workflowBlocker(
      "provider_changed",
      `${platform} opened, but CareerRat could not find an application status label.`
    );
  }
  return { ok: true, state: "completed", rawStatus, url: opened.page.url };
}
