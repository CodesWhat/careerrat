import { classifyBrowserAuthState } from "../automation/browser-session.mjs";
import { resolvePublicHttpTarget, validatePublicHttpUrl } from "../net/public-http-fetch.mjs";
import { extractReqId } from "../scoring/sourced-identity.mjs";

const SOURCE_SPECS = Object.freeze({
  indeed: {
    rowSelectors: ["[data-jk]", ".job_seen_beacon", ".resultContent", ".tapItem"],
    fields: {
      title: {
        selectors: ["h2.jobTitle a", "a[data-jk]", "a.jcs-JobTitle"],
      },
      company: {
        selectors: ["[data-testid='company-name']", ".companyName", "[data-testid='companyName']"],
      },
      location: {
        selectors: [
          "[data-testid='text-location']",
          ".companyLocation",
          "[data-testid='job-location']",
        ],
      },
      url: {
        selectors: ["a[data-jk][href]", "h2.jobTitle a[href]", "a.jcs-JobTitle[href]"],
        kind: "href",
      },
    },
    bodySelectors: [
      "#jobDescriptionText",
      "[data-testid='jobsearch-JobComponent-description']",
      "[data-testid='job-description']",
      "main",
    ],
  },
  glassdoor: {
    rowSelectors: [
      "[data-test='jobListing']",
      "li[data-test='jobListing']",
      "[data-job-id]",
      "li[class*='JobsList_jobListItem']",
    ],
    fields: {
      title: {
        selectors: ["[data-test='job-title']", "[data-test='job-link']", "a[data-test='job-link']"],
      },
      company: {
        selectors: [
          "[data-test='employer-name']",
          "[data-test='job-employer']",
          "[class*='employerName']",
        ],
      },
      location: {
        selectors: [
          "[data-test='emp-location']",
          "[data-test='job-location']",
          "[class*='location']",
        ],
      },
      url: {
        selectors: [
          "a[href*='/job-listing/']",
          "a[data-test='job-link'][href]",
          "a[href*='/partner/jobListing.htm']",
        ],
        kind: "href",
      },
    },
    bodySelectors: [
      "[data-test='jobDescriptionContent']",
      "[data-test='job-description']",
      "[class*='JobDetails_jobDescription']",
      "main",
    ],
  },
  linkedin: {
    rowSelectors: ["[data-job-id]", ".job-card-container", "li.jobs-search-results__list-item"],
    fields: {
      title: {
        selectors: ['a[href*="/jobs/view/"]', ".job-card-list__title", ".job-card-container__link"],
      },
      company: {
        selectors: [".artdeco-entity-lockup__subtitle", ".job-card-container__primary-description"],
      },
      location: {
        selectors: [".job-card-container__metadata-item", ".artdeco-entity-lockup__caption"],
      },
      url: { selectors: ['a[href*="/jobs/view/"]'], kind: "href" },
    },
    bodySelectors: [
      ".jobs-description__content",
      ".jobs-description-content__text",
      "#job-details",
      "main",
    ],
  },
  wellfound: {
    rowSelectors: ["[data-test='StartupResult']", "article", "li", "[role='listitem']"],
    fields: {
      title: {
        selectors: ["[data-test='job-title']", "h1", "h2", "h3", "[role='heading']"],
      },
      company: {
        selectors: ["[data-test='company-name']", ".company-name", "[class*='company']"],
      },
      location: {
        selectors: ["[data-test='location']", ".location", "[class*='location']"],
      },
      url: {
        selectors: ['a[href*="/jobs/"]', 'a[href*="/role/"]'],
        kind: "href",
      },
    },
  },
  hiringcafe: {
    rowSelectors: ["article", "li", "[role='listitem']", 'a[href*="/job/"]'],
    fields: {
      title: {
        selectors: ["span.w-full.font-bold", "span.text-start.font-bold", "h2", "h3"],
      },
      company: {
        selectors: ["[data-company]", "[class*='company']", "span.font-bold"],
      },
      location: { selectors: ["[data-location]", "[class*='location']"] },
      url: { selectors: ['a[href*="/job/"]', ":scope"], kind: "href" },
    },
  },
  generic: {
    rowSelectors: [
      "[data-job-id]",
      "[data-job-key]",
      ".job-card",
      ".job-listing",
      "article",
      "li",
      "tr",
      "[role='listitem']",
    ],
    fields: {
      title: {
        selectors: [
          "[data-job-title]",
          "[class*='job-title']",
          "[class*='jobTitle']",
          "h1",
          "h2",
          "h3",
          "[role='heading']",
          "a[href]",
        ],
      },
      company: {
        selectors: [
          "[data-company]",
          "[class*='company-name']",
          "[class*='companyName']",
          "[class*='company']",
        ],
      },
      location: {
        selectors: ["[data-location]", "[class*='location']", "[class*='Location']"],
      },
      url: { selectors: ["a[href]"], kind: "href" },
    },
  },
});

function normalizedProvider(source = {}) {
  const explicit = String(source.platform || source.provider || "").toLowerCase();
  if (explicit.includes("indeed")) return "indeed";
  if (explicit.includes("glassdoor")) return "glassdoor";
  if (explicit.includes("linkedin")) return "linkedin";
  if (explicit.includes("wellfound")) return "wellfound";
  if (explicit.includes("hiringcafe") || explicit.includes("hiring.cafe")) return "hiringcafe";
  return "generic";
}

function displayPlatform(source = {}) {
  const platform = String(source.platform || source.provider || "this site")
    .trim()
    .toLowerCase();
  const labels = {
    glassdoor: "Glassdoor",
    indeed: "Indeed",
    linkedin: "LinkedIn",
    wellfound: "Wellfound",
  };
  return labels[platform] || String(source.label || source.provider || "this site").trim();
}

function sourceUrl(source = {}) {
  const raw = String(source.url || "").trim();
  const checked = validatePublicHttpUrl(raw);
  if (!checked.ok) throw new Error(checked.reason || "The source URL is not usable.");
  return checked.url;
}

function normalizedText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedBodyText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function loginRequest(source, url) {
  const platformLabel = displayPlatform(source);
  return {
    platform: String(source.platform || normalizedProvider(source)).toLowerCase(),
    label: platformLabel,
    sourceLabel: String(source.label || source.provider || "Browser source"),
    url,
    prompt: `Do you want to log into ${platformLabel} so I can use it?`,
  };
}

function partialBodyResult(offer, error) {
  return {
    offer,
    error: error?.message || String(error),
    needsLogin: null,
  };
}

async function capturePostingBody({ offer, session, source, spec, resolvePublicTargetImpl }) {
  const initialTarget = await resolvePublicTargetImpl(offer.url);
  if (!initialTarget?.ok) {
    return {
      offer: null,
      error: initialTarget?.reason || "The job URL is not publicly reachable.",
      needsLogin: null,
    };
  }
  let page;
  try {
    page = await session.open(initialTarget.url);
  } catch (error) {
    if (error?.code === "UNSAFE_BROWSER_NAVIGATION") {
      return { offer: null, error: error.message, needsLogin: null };
    }
    return partialBodyResult(offer, error);
  }
  const finalTarget = await resolvePublicTargetImpl(page?.url || initialTarget.url);
  if (!finalTarget?.ok) {
    return {
      offer: null,
      error: finalTarget?.reason || "The browser was redirected to a non-public network address.",
      needsLogin: null,
    };
  }
  if (classifyBrowserAuthState(page)) {
    return { offer: null, error: null, needsLogin: loginRequest(source, initialTarget.url) };
  }
  let extracted;
  try {
    extracted = await session.extractText({
      selectors: spec.bodySelectors || ["main", "body"],
      maxText: 100_000,
    });
  } catch (error) {
    return partialBodyResult(offer, error);
  }
  const bodyText = normalizedBodyText(extracted?.text || page?.text);
  if (bodyText.length < 40) {
    return partialBodyResult(
      offer,
      new Error(`CareerRat could not read the full job description at ${offer.url}.`)
    );
  }
  const url = finalTarget.url;
  const req = extractReqId(url);
  return {
    offer: {
      ...offer,
      url,
      bodyText,
      bodyPartial: false,
      capturedUrl: url,
      reqId: req.id || offer.reqId,
    },
    error: null,
    needsLogin: null,
  };
}

function normalizedOffer(row, { source, provider, searchUrl }) {
  const title = normalizedText(row?.title);
  const company = normalizedText(row?.company || source.company);
  const checked = validatePublicHttpUrl(row?.url);
  if (!title || !company || !checked.ok) return null;
  const url = checked.url;
  const req = extractReqId(url);
  return {
    company,
    title,
    url,
    location: normalizedText(row?.location),
    bodyText: "",
    bodyPartial: true,
    bodyCapture: "session-browser",
    source: `${provider}-browser`,
    sourceId: String(source.id || ""),
    sourceLabel: String(source.label || source.id || source.provider || "Browser source"),
    sourceProvider: provider,
    searchUrl,
    capturedUrl: searchUrl,
    reqId: req.id || "",
  };
}

export async function captureBrowserSearchSource({
  source,
  session,
  maxRows = 100,
  resolvePublicTargetImpl = resolvePublicHttpTarget,
} = {}) {
  const label = String(source?.label || source?.provider || "Browser source");
  if (!session?.available) {
    return {
      offers: [],
      errors: [{ company: label, error: session?.reason || "The app browser is unavailable." }],
      needsLogin: null,
    };
  }

  let url;
  try {
    url = sourceUrl(source);
  } catch (error) {
    return { offers: [], errors: [{ company: label, error: error.message }], needsLogin: null };
  }

  try {
    const initialTarget = await resolvePublicTargetImpl(url);
    if (!initialTarget?.ok) {
      throw new Error(initialTarget?.reason || "The source URL is not publicly reachable.");
    }
    url = initialTarget.url;
    const page = await session.open(url);
    const finalTarget = await resolvePublicTargetImpl(page?.url || url);
    if (!finalTarget?.ok) {
      throw new Error(
        finalTarget?.reason || "The browser was redirected to a non-public network address."
      );
    }
    const auth = classifyBrowserAuthState(page);
    if (auth) {
      return {
        offers: [],
        errors: [],
        needsLogin: loginRequest(source, url),
      };
    }

    const provider = normalizedProvider(source);
    const spec = SOURCE_SPECS[provider] || SOURCE_SPECS.generic;
    const extracted = await session.extractRows({
      rowSelectors: spec.rowSelectors,
      fields: spec.fields,
      maxRows,
    });
    const seen = new Set();
    const offers = [];
    for (const row of extracted?.rows || []) {
      const offer = normalizedOffer(row, { source, provider, searchUrl: url });
      if (!offer || seen.has(offer.url)) continue;
      seen.add(offer.url);
      offers.push(offer);
    }
    const captured = [];
    const errors = [];
    let needsLogin = null;
    for (const offer of offers) {
      const result = await capturePostingBody({
        offer,
        session,
        source,
        spec,
        resolvePublicTargetImpl,
      });
      if (result.offer) captured.push(result.offer);
      if (result.error) errors.push({ company: offer.company || label, error: result.error });
      if (result.needsLogin) {
        needsLogin = result.needsLogin;
        break;
      }
    }
    return { offers: captured, errors, needsLogin };
  } catch (error) {
    return {
      offers: [],
      errors: [{ company: label, error: error?.message || String(error) }],
      needsLogin: null,
    };
  }
}
