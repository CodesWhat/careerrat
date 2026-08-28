import { classifyBrowserAuthState } from "../automation/browser-session.mjs";
import { validatePublicHttpUrl } from "../net/public-http-fetch.mjs";
import { extractReqId } from "../scoring/sourced-identity.mjs";

const SOURCE_SPECS = Object.freeze({
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
    source: `${provider}-browser`,
    sourceId: String(source.id || ""),
    sourceLabel: String(source.label || source.id || source.provider || "Browser source"),
    sourceProvider: provider,
    searchUrl,
    capturedUrl: searchUrl,
    reqId: req.id || "",
  };
}

export async function captureBrowserSearchSource({ source, session, maxRows = 100 } = {}) {
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
    const page = await session.open(url);
    const auth = classifyBrowserAuthState(page);
    if (auth) {
      const platformLabel = displayPlatform(source);
      return {
        offers: [],
        errors: [],
        needsLogin: {
          platform: String(source.platform || normalizedProvider(source)).toLowerCase(),
          label: platformLabel,
          sourceLabel: label,
          url,
          prompt: `Do you want to log into ${platformLabel} so I can use it?`,
        },
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
    return { offers, errors: [], needsLogin: null };
  } catch (error) {
    return {
      offers: [],
      errors: [{ company: label, error: error?.message || String(error) }],
      needsLogin: null,
    };
  }
}
