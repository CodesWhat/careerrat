export const CAREER_OPS_UPSTREAM = Object.freeze({
  repository: "https://github.com/santifer/career-ops",
  commit: "10a569b1e9178aa90ef8028ea287e411a831e1b6",
  providerCount: 74,
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
  "comeet",
  "consider",
  "cryptocurrencyjobs",
  "csod",
  "dassault",
  "deutschebahn",
  "echojobs",
  "eightfold",
  "flowxtra",
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
  "jibeapply",
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
  "smartrecruiters",
  "softgarden",
  "solidjobs",
  "successfactors",
  "teamtailor",
  "tencent",
  "thehub",
  "themuse",
  "tkms",
  "vdab",
  "weworkremotely",
  "workable",
  "workday",
  "workingnomads",
  "wttj",
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

// The full upstream provider inventory at CAREER_OPS_UPSTREAM.commit (78
// providers), fetched directly from santifer/career-ops at that pin. This is
// the ground truth CAREER_OPS_PROVIDER_IDS is checked against below: every
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
  "comeet",
  "consider",
  "cryptocurrencyjobs",
  "csod",
  "dassault",
  "deutschebahn",
  "echojobs",
  "eightfold",
  "flowxtra",
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
  "vdab",
  "weworkremotely",
  "workable",
  "workday",
  "workingnomads",
  "wttj",
  "yourator",
]);

// Upstream providers not yet adopted, pending Scott's decision. Not a
// permanent exclusion; each can move into CAREER_OPS_PROVIDER_IDS later.
export const CAREER_OPS_DEFERRED_PROVIDER_IDS = Object.freeze({
  jobbankca: "Deferred pending review; not yet adopted from the pinned upstream.",
  mycareersfuture: "Deferred pending review; not yet adopted from the pinned upstream.",
  senjob: "Deferred pending review; not yet adopted from the pinned upstream.",
  yourator: "Deferred pending review; not yet adopted from the pinned upstream.",
});

// Upstream providers deliberately never adopted, with no plan to. Distinct
// from "deferred": local-parser is already vendored (it is in
// CAREER_OPS_PROVIDER_IDS) but marked unsupported in CAREER_OPS_PROVIDER_PARITY
// for the reason given there, so it counts as covered for parity purposes.
export const CAREER_OPS_EXCLUDED_PROVIDER_IDS = Object.freeze({
  "local-parser":
    "Executes user-configured local commands; it is not a public network source adapter.",
});
