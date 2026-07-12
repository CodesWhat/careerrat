const RAW_COMPANY_CATALOG = [
  ["Sweetgreen", "sweetgreen.com", ["sweet green"]],
  ["OpenAI", "openai.com"],
  ["Anthropic", "anthropic.com", ["claude"]],
  ["Perplexity", "perplexity.ai"],
  ["Anysphere", "cursor.com", ["cursor"]],
  ["Google", "google.com", ["alphabet"]],
  ["Microsoft", "microsoft.com"],
  ["Apple", "apple.com"],
  ["Amazon", "amazon.com", ["aws", "amazon web services"]],
  ["Meta", "meta.com", ["facebook", "instagram", "whatsapp"]],
  ["Netflix", "netflix.com"],
  ["NVIDIA", "nvidia.com"],
  ["AMD", "amd.com"],
  ["Intel", "intel.com"],
  ["Cisco", "cisco.com"],
  ["Oracle", "oracle.com"],
  ["IBM", "ibm.com"],
  ["Salesforce", "salesforce.com"],
  ["Adobe", "adobe.com"],
  ["ServiceNow", "servicenow.com"],
  ["Workday", "workday.com"],
  ["Intuit", "intuit.com"],
  ["Atlassian", "atlassian.com"],
  ["Stripe", "stripe.com"],
  ["Block", "block.xyz", ["square"]],
  ["PayPal", "paypal.com"],
  ["Robinhood", "robinhood.com"],
  ["Coinbase", "coinbase.com"],
  ["Plaid", "plaid.com"],
  ["Ramp", "ramp.com"],
  ["Brex", "brex.com"],
  ["Chime", "chime.com"],
  ["Databricks", "databricks.com"],
  ["Snowflake", "snowflake.com"],
  ["MongoDB", "mongodb.com"],
  ["Confluent", "confluent.io"],
  ["Elastic", "elastic.co"],
  ["GitHub", "github.com"],
  ["GitLab", "gitlab.com"],
  ["Vercel", "vercel.com"],
  ["Netlify", "netlify.com"],
  ["Cloudflare", "cloudflare.com"],
  ["Twilio", "twilio.com"],
  ["Zoom", "zoom.us"],
  ["Slack", "slack.com"],
  ["Dropbox", "dropbox.com"],
  ["Box", "box.com"],
  ["Notion", "notion.so"],
  ["Figma", "figma.com"],
  ["Canva", "canva.com"],
  ["Asana", "asana.com"],
  ["Airtable", "airtable.com"],
  ["Monday.com", "monday.com"],
  ["HubSpot", "hubspot.com"],
  ["Intercom", "intercom.com"],
  ["Zendesk", "zendesk.com"],
  ["Okta", "okta.com"],
  ["Docusign", "docusign.com"],
  ["Palantir", "palantir.com"],
  ["Scale AI", "scale.com", ["scale"]],
  ["Anduril", "anduril.com"],
  ["Tesla", "tesla.com"],
  ["SpaceX", "spacex.com"],
  ["Rivian", "rivian.com"],
  ["Lucid Motors", "lucidmotors.com", ["lucid"]],
  ["Uber", "uber.com"],
  ["Lyft", "lyft.com"],
  ["DoorDash", "doordash.com"],
  ["Instacart", "instacart.com"],
  ["Airbnb", "airbnb.com"],
  ["Expedia Group", "expediagroup.com", ["expedia"]],
  ["Booking Holdings", "bookingholdings.com", ["booking.com"]],
  ["Tripadvisor", "tripadvisor.com"],
  ["Walmart", "walmart.com"],
  ["Target", "target.com"],
  ["Costco", "costco.com"],
  ["The Home Depot", "homedepot.com", ["home depot"]],
  ["Lowe's", "lowes.com", ["lowes"]],
  ["Kroger", "kroger.com"],
  ["Albertsons", "albertsonscompanies.com", ["albertsons"]],
  ["CVS Health", "cvshealth.com", ["cvs"]],
  ["Walgreens", "walgreens.com"],
  ["McDonald's", "mcdonalds.com", ["mcdonalds"]],
  ["Starbucks", "starbucks.com"],
  ["Chipotle", "chipotle.com"],
  ["Cava", "cava.com"],
  ["Shake Shack", "shakeshack.com"],
  ["Yum! Brands", "yum.com", ["taco bell", "kfc", "pizza hut"]],
  ["Domino's", "dominos.com", ["dominos"]],
  ["Nike", "nike.com"],
  ["Adidas", "adidas.com"],
  ["Lululemon", "lululemon.com"],
  ["Levi Strauss", "levistrauss.com", ["levi's", "levis"]],
  ["Patagonia", "patagonia.com"],
  ["REI", "rei.com"],
  ["The Walt Disney Company", "thewaltdisneycompany.com", ["disney"]],
  ["Warner Bros. Discovery", "wbd.com", ["warner bros", "hbo"]],
  ["Comcast", "comcast.com", ["nbc universal", "nbcuniversal"]],
  ["Paramount", "paramount.com"],
  ["Spotify", "spotify.com"],
  ["Reddit", "reddit.com"],
  ["Pinterest", "pinterest.com"],
  ["Snap", "snap.com", ["snapchat"]],
  ["TikTok", "tiktok.com", ["bytedance"]],
  ["LinkedIn", "linkedin.com"],
  ["Indeed", "indeed.com"],
  ["Glassdoor", "glassdoor.com"],
  ["Gusto", "gusto.com"],
  ["Rippling", "rippling.com"],
  ["Deel", "deel.com"],
  ["Carta", "carta.com"],
  ["Mercury", "mercury.com"],
  ["SoFi", "sofi.com"],
  ["Affirm", "affirm.com"],
  ["Klarna", "klarna.com"],
  ["JPMorgan Chase", "jpmorganchase.com", ["chase", "jpmorgan"]],
  ["Bank of America", "bankofamerica.com", ["bofa"]],
  ["Capital One", "capitalone.com"],
  ["American Express", "americanexpress.com", ["amex"]],
  ["Visa", "visa.com"],
  ["Mastercard", "mastercard.com"],
  ["Goldman Sachs", "goldmansachs.com"],
  ["Morgan Stanley", "morganstanley.com"],
  ["BlackRock", "blackrock.com"],
  ["Fidelity Investments", "fidelity.com", ["fidelity"]],
  ["Charles Schwab", "schwab.com", ["schwab"]],
  ["UnitedHealth Group", "unitedhealthgroup.com", ["unitedhealth", "optum"]],
  ["Elevance Health", "elevancehealth.com", ["anthem"]],
  ["Cigna", "cigna.com"],
  ["Humana", "humana.com"],
  ["Johnson & Johnson", "jnj.com", ["johnson and johnson"]],
  ["Pfizer", "pfizer.com"],
  ["Moderna", "modernatx.com"],
  ["Eli Lilly", "lilly.com", ["lilly"]],
  ["Merck", "merck.com"],
  ["Roche", "roche.com"],
  ["Mayo Clinic", "mayoclinic.org"],
  ["Cleveland Clinic", "clevelandclinic.org"],
  ["Kaiser Permanente", "kaiserpermanente.org", ["kaiser"]],
  ["General Motors", "gm.com", ["gm"]],
  ["Ford", "ford.com"],
  ["Toyota", "toyota.com"],
  ["Honda", "honda.com"],
  ["Boeing", "boeing.com"],
  ["Lockheed Martin", "lockheedmartin.com"],
  ["Northrop Grumman", "northropgrumman.com"],
  ["Raytheon", "rtx.com", ["rtx"]],
  ["Honeywell", "honeywell.com"],
  ["General Electric", "ge.com", ["ge"]],
  ["3M", "3m.com"],
  ["Procter & Gamble", "pg.com", ["p&g", "procter and gamble"]],
  ["Coca-Cola", "coca-cola.com", ["coke"]],
  ["PepsiCo", "pepsico.com", ["pepsi"]],
  ["Unilever", "unilever.com"],
  ["Nestle", "nestle.com"],
  ["Mars", "mars.com"],
  ["UPS", "ups.com"],
  ["FedEx", "fedex.com"],
  ["DHL", "dhl.com"],
  ["Delta Air Lines", "delta.com", ["delta"]],
  ["United Airlines", "united.com"],
  ["American Airlines", "aa.com"],
  ["Southwest Airlines", "southwest.com", ["southwest"]],
  ["Marriott", "marriott.com"],
  ["Hilton", "hilton.com"],
  ["Hyatt", "hyatt.com"],
  ["Best Buy", "bestbuy.com", ["bestbuy", "best-buy"]],
  ["Wayfair", "wayfair.com"],
  ["Chewy", "chewy.com"],
  ["eBay", "ebay.com"],
  ["Etsy", "etsy.com"],
  ["Nordstrom", "nordstrom.com"],
  ["Macy's", "macys.com", ["macys"]],
  ["Kohl's", "kohls.com", ["kohls"]],
  ["TJX Companies", "tjx.com", ["tj maxx", "tjmaxx", "marshalls", "homegoods"]],
  ["Gap Inc.", "gapinc.com", ["gap", "old navy", "banana republic"]],
  ["Ulta Beauty", "ulta.com", ["ulta"]],
  ["Ross Stores", "rossstores.com", ["ross", "ross dress for less"]],
  ["Dollar General", "dollargeneral.com"],
  ["Dollar Tree", "dollartree.com"],
  ["Publix", "publix.com"],
  ["Alaska Airlines", "alaskaair.com"],
  ["JetBlue Airways", "jetblue.com", ["jetblue"]],
  ["Wells Fargo", "wellsfargo.com"],
  ["Citigroup", "citigroup.com", ["citi", "citibank"]],
  ["U.S. Bancorp", "usbank.com", ["us bank", "usbank"]],
  ["PNC Financial Services", "pnc.com", ["pnc"]],
  ["Truist Financial", "truist.com", ["truist"]],
  ["Progressive", "progressive.com"],
  ["Allstate", "allstate.com"],
  ["State Farm", "statefarm.com"],
  ["Liberty Mutual", "libertymutual.com"],
  ["MetLife", "metlife.com"],
  ["Prudential Financial", "prudential.com"],
  ["The Travelers Companies", "travelers.com", ["travelers"]],
  ["HCA Healthcare", "hcahealthcare.com", ["hca"]],
  ["Sony", "sony.com"],
  ["Universal Music Group", "universalmusic.com"],
  ["Fox Corporation", "foxcorporation.com", ["fox"]],
  ["iHeartMedia", "iheartmedia.com", ["iheart"]],
  ["Live Nation Entertainment", "livenation.com", ["live nation", "ticketmaster"]],
  ["Verizon", "verizon.com"],
  ["AT&T", "att.com", ["at&t", "atandt"]],
  ["T-Mobile US", "t-mobile.com", ["tmobile", "t mobile"]],
  ["Charter Communications", "charter.com", ["spectrum"]],
  ["SAP", "sap.com"],
  ["VMware", "vmware.com"],
  ["Dell Technologies", "dell.com", ["dell"]],
  ["HP Inc.", "hp.com"],
  ["Hewlett Packard Enterprise", "hpe.com", ["hpe"]],
  ["Qualcomm", "qualcomm.com"],
  ["Broadcom", "broadcom.com"],
  ["Texas Instruments", "ti.com"],
  ["Micron Technology", "micron.com", ["micron"]],
  ["CrowdStrike", "crowdstrike.com"],
  ["Palo Alto Networks", "paloaltonetworks.com"],
  ["Splunk", "splunk.com"],
  ["Datadog", "datadoghq.com"],
];

export const COMPANY_CATALOG = RAW_COMPANY_CATALOG.map(([name, domain, aliases = []]) => ({
  name,
  domain,
  aliases,
}));

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function companyKey(company) {
  const domain = String(company?.domain || "")
    .trim()
    .toLowerCase();
  if (domain) return `domain:${domain}`;
  return `name:${normalizeSearchText(company?.name)}`;
}

function selectedCompanyKeys(companies = []) {
  const keys = new Set();
  for (const company of Array.isArray(companies) ? companies : []) {
    const name = typeof company === "string" ? company : company?.name;
    const domain = typeof company === "string" ? "" : company?.domain;
    keys.add(companyKey({ name, domain }));
    keys.add(`name:${normalizeSearchText(name)}`);
  }
  return keys;
}

// Below 3 characters, a substring match is mostly noise (e.g. "be" hitting
// Adobe/Albertsons/alphabet-as-a-Google-alias) — short queries only surface
// exact or prefix hits, never substring.
const MIN_QUERY_LENGTH_FOR_SUBSTRING_MATCH = 3;

function scoreCatalogCompany(company, query) {
  const needle = normalizeSearchText(query);
  const compactNeedle = compactSearchText(query);
  if (!needle || !compactNeedle) return 0;

  const aliases = Array.isArray(company.aliases) ? company.aliases : [];
  const fields = [company.name, company.domain, ...aliases]
    .map((value) => ({
      normalized: normalizeSearchText(value),
      compact: compactSearchText(value),
    }))
    .filter((value) => value.normalized);

  for (const field of fields) {
    if (field.normalized === needle || field.compact === compactNeedle) return 100;
  }
  for (const field of fields) {
    if (field.normalized.startsWith(needle) || field.compact.startsWith(compactNeedle)) return 90;
  }
  if (compactNeedle.length < MIN_QUERY_LENGTH_FOR_SUBSTRING_MATCH) return 0;
  for (const field of fields) {
    if (field.normalized.includes(needle) || field.compact.includes(compactNeedle)) return 70;
  }
  return 0;
}

function normalizeSuggestion(item, source) {
  const name = String(item?.name || item?.domain || "").trim();
  const domain = String(item?.domain || "").trim();
  if (!name && !domain) return null;
  return {
    name: name || domain,
    domain: domain || null,
    source,
  };
}

export function resolveCompanySuggestions({
  query,
  selectedCompanies = [],
  logoResults = [],
  limit = 8,
} = {}) {
  const selected = selectedCompanyKeys(selectedCompanies);
  const deduped = new Map();

  const catalogMatches = COMPANY_CATALOG.map((company) => ({
    ...company,
    source: "catalog",
    score: scoreCatalogCompany(company, query),
  }))
    .filter((company) => company.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  for (const company of catalogMatches) {
    const suggestion = normalizeSuggestion(company, "catalog");
    if (!suggestion) continue;
    const key = companyKey(suggestion);
    if (selected.has(key) || selected.has(`name:${normalizeSearchText(suggestion.name)}`)) continue;
    deduped.set(key, suggestion);
  }

  for (const result of Array.isArray(logoResults) ? logoResults : []) {
    const suggestion = normalizeSuggestion(result, "logo-search");
    if (!suggestion) continue;
    const key = companyKey(suggestion);
    if (
      deduped.has(key) ||
      selected.has(key) ||
      selected.has(`name:${normalizeSearchText(suggestion.name)}`)
    ) {
      continue;
    }
    deduped.set(key, suggestion);
  }

  return Array.from(deduped.values()).slice(0, limit);
}
