import { normalizeCompanyRoleKey, normalizeTextKey } from "../tracker/tracker-data.mjs";

function postingUrl(row = {}) {
  return String(row.url || row.link || "").trim();
}

function normalizePostingUrl(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return String(rawUrl || "")
      .trim()
      .toLowerCase();
  }
}

export function extractReqId(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const greenhouse = path.match(/\/jobs\/(\d+)/);
    const greenhouseHost =
      url.hostname === "greenhouse.io" || url.hostname.endsWith(".greenhouse.io");
    if (greenhouse && greenhouseHost)
      return { provider: "greenhouse", value: greenhouse[1], id: `greenhouse:${greenhouse[1]}` };
    const ashby = path.match(/\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i);
    if (ashby && url.hostname === "jobs.ashbyhq.com")
      return {
        provider: "ashby",
        value: ashby[1].toLowerCase(),
        id: `ashby:${ashby[1].toLowerCase()}`,
      };
    const lever = path.match(/\/([^/]+)$/);
    if (url.hostname === "jobs.lever.co" && lever)
      return { provider: "lever", value: lever[1], id: `lever:${lever[1].toLowerCase()}` };
    const apple = path.match(/\/details\/([0-9-]+)/);
    if ((url.hostname === "apple.com" || url.hostname.endsWith(".apple.com")) && apple)
      return { provider: "apple", value: apple[1], id: `apple:${apple[1]}` };
    const hiringCafe = path.match(/\/job\/([a-z0-9_-]+)/i);
    if (url.hostname === "hiring.cafe" && hiringCafe)
      return {
        provider: "hiringcafe",
        value: hiringCafe[1].toLowerCase(),
        id: `hiringcafe:${hiringCafe[1].toLowerCase()}`,
      };
    const linkedIn = path.match(/\/jobs\/view\/(\d+)/);
    if ((url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) && linkedIn)
      return { provider: "linkedin", value: linkedIn[1], id: `linkedin:${linkedIn[1]}` };
    const hireology = path.match(/^\/[^/]+\/(\d+)\/description\/?$/i);
    if (url.hostname === "careers.hireology.com" && hireology)
      return {
        provider: "hireology",
        value: hireology[1],
        id: `hireology:${hireology[1]}`,
      };
    const workday = path.match(/_([a-z]{1,8}\d{4,}(?:-\d+)?)(?:\/|$)/i);
    if (/^[\w-]+\.wd[\w-]*\.myworkdayjobs\.com$/i.test(url.hostname) && workday)
      return {
        provider: "workday",
        value: workday[1],
        id: `workday:${workday[1].toLowerCase()}`,
      };
  } catch {
    return { provider: null, value: null, id: null };
  }
  return { provider: null, value: null, id: null };
}

function explicitReqId(row = {}) {
  return String(row.reqId || row.scanner?.reqId || "")
    .trim()
    .toLowerCase();
}

export function postingIdentityKeys(row = {}) {
  const url = postingUrl(row);
  const reqId = explicitReqId(row) || extractReqId(url).id;
  const keys = [];
  if (url) keys.push(`url:${normalizePostingUrl(url)}`);
  if (reqId) keys.push(`req:${reqId}`);
  if (keys.length) return keys;

  const company = String(row.company || row.co || "").trim();
  const role = String(row.role || row.title || "").trim();
  const location = normalizeTextKey(row.location || row.loc || "");
  if (company && role && location) {
    keys.push(`company-role-location:${normalizeCompanyRoleKey(company, role)}::${location}`);
  }
  return keys;
}

export function postingIdentityIsSeen(row, seenKeys) {
  return postingIdentityKeys(row).some((key) => seenKeys.has(key));
}

export function addPostingIdentity(seenKeys, row) {
  for (const key of postingIdentityKeys(row)) seenKeys.add(key);
  return seenKeys;
}
