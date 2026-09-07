export const CAREER_OPS_UPSTREAM = Object.freeze({
  repository: "https://github.com/career-ops-hq/career-ops",
  commit: "8a20e491fdde2c928a54ff17a7bfe07ca5d2ab40",
  providerCount: 87,
});

export const CAREER_OPS_PROVIDER_IDS = Object.freeze([
  "4dayweek",
  "a16z-speedrun-talent",
  "agentic-jobs",
  "alibaba",
  "amazon",
  "arbeitnow",
  "arbeitsagentur",
  "ashby",
  "avature",
  "bamboohr",
  "beesite",
  "breezy",
  "builtin",
  "careerviet",
  "collage",
  "comeet",
  "consider",
  "cryptocurrencyjobs",
  "csod",
  "dassault",
  "deutschebahn",
  "echojobs",
  "eightfold",
  "feishu-jobs",
  "flowxtra",
  "garena",
  "gem",
  "getonbrd",
  "getro",
  "glints",
  "greenhouse",
  "hackernews",
  "hecklerkoch",
  "higheredjobs",
  "himalayas",
  "ibm",
  "icims",
  "itviec",
  "jibeapply",
  "jobbankca",
  "jobicy",
  "jobspresso",
  "jobstreet",
  "jobvite",
  "join",
  "joinup",
  "justjoin",
  "landingjobs",
  "larajobs",
  "lever",
  "local-parser",
  "manfred",
  "meituan",
  "mokahr",
  "mycareersfuture",
  "nodesk",
  "nofluffjobs",
  "oraclecloud",
  "personio",
  "phenom",
  "pinpoint",
  "radancy",
  "recruitee",
  "remoteok",
  "remotive",
  "remotli",
  "rheinmetall",
  "rippling",
  "senjob",
  "smartrecruiters",
  "softgarden",
  "solidjobs",
  "successfactors",
  "teamtailor",
  "tencent",
  "thehub",
  "themuse",
  "tkms",
  "torre",
  "vdab",
  "weworkremotely",
  "workable",
  "workday",
  "workingnomads",
  "wttj",
  "yourator",
]);

export const CAREER_OPS_PROVIDER_PARITY = Object.freeze(
  CAREER_OPS_PROVIDER_IDS.map((id) =>
    id === "local-parser"
      ? Object.freeze({
          id,
          status: "unsupported",
          reason:
            "Executes user-configured local commands; it is not a public network source adapter.",
        })
      : Object.freeze({ id, status: "implemented" })
  )
);

export const CAREER_OPS_PUBLIC_PROVIDER_IDS = Object.freeze(
  CAREER_OPS_PROVIDER_PARITY.filter((provider) => provider.status === "implemented").map(
    (provider) => provider.id
  )
);

// The full upstream provider inventory at CAREER_OPS_UPSTREAM.commit (83
// providers), fetched directly from career-ops-hq/career-ops at that pin. This
// is the ground truth CAREER_OPS_PROVIDER_IDS is checked against below: every
// name here must land in either CAREER_OPS_PROVIDER_IDS (adopted),
// CAREER_OPS_DEFERRED_PROVIDER_IDS, or CAREER_OPS_EXCLUDED_PROVIDER_IDS, so a
// provider upstream silently adds can't fall through unnoticed.
export const CAREER_OPS_UPSTREAM_PROVIDER_IDS = Object.freeze([
  "4dayweek",
  "a16z-speedrun-talent",
  "agentic-jobs",
  "alibaba",
  "amazon",
  "arbeitnow",
  "arbeitsagentur",
  "ashby",
  "avature",
  "bamboohr",
  "beesite",
  "breezy",
  "builtin",
  "careerviet",
  "collage",
  "comeet",
  "consider",
  "cryptocurrencyjobs",
  "csod",
  "dassault",
  "deutschebahn",
  "echojobs",
  "eightfold",
  "feishu-jobs",
  "flowxtra",
  "garena",
  "gem",
  "getonbrd",
  "getro",
  "glints",
  "greenhouse",
  "hackernews",
  "hecklerkoch",
  "higheredjobs",
  "himalayas",
  "ibm",
  "icims",
  "itviec",
  "jibeapply",
  "jobbankca",
  "jobicy",
  "jobspresso",
  "jobstreet",
  "jobvite",
  "join",
  "joinup",
  "justjoin",
  "landingjobs",
  "larajobs",
  "lever",
  "local-parser",
  "manfred",
  "meituan",
  "mokahr",
  "mycareersfuture",
  "nodesk",
  "nofluffjobs",
  "oraclecloud",
  "personio",
  "phenom",
  "pinpoint",
  "radancy",
  "recruitee",
  "remoteok",
  "remotive",
  "remotli",
  "rheinmetall",
  "rippling",
  "senjob",
  "smartrecruiters",
  "softgarden",
  "solidjobs",
  "successfactors",
  "teamtailor",
  "telegram-channel",
  "tencent",
  "thehub",
  "themuse",
  "tkms",
  "torre",
  "vdab",
  "weworkremotely",
  "workable",
  "workday",
  "workingnomads",
  "wttj",
  "yourator",
]);

// Upstream providers not yet adopted, pending Scott's decision. Not a
// permanent exclusion; each can move into CAREER_OPS_PROVIDER_IDS later. The
// prior deferred batch (jobbankca, mycareersfuture, senjob, yourator) was
// adopted into CAREER_OPS_PROVIDER_IDS on 2026-08-23.
export const CAREER_OPS_DEFERRED_PROVIDER_IDS = Object.freeze({
  "telegram-channel":
    "Scrapes Telegram channel web-preview pages with heuristic per-post employer attribution (upstream measured a 25% pass rate on its own RU/CIS test corpus, 0% on the EN one); too fragile and low-precision to adopt as a general source.",
});

// Upstream providers deliberately never adopted, with no plan to. Distinct
// from "deferred": local-parser is already vendored (it is in
// CAREER_OPS_PROVIDER_IDS) but marked unsupported in CAREER_OPS_PROVIDER_PARITY
// for the reason given there, so it counts as covered for parity purposes.
export const CAREER_OPS_EXCLUDED_PROVIDER_IDS = Object.freeze({
  "local-parser":
    "Executes user-configured local commands; it is not a public network source adapter.",
});
