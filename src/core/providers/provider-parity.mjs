export const CAREER_OPS_UPSTREAM = Object.freeze({
  repository: "https://github.com/santifer/career-ops",
  commit: "8be39e0934b83410276d66b541bf3a2edf3411cb",
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
