import { buildLocationPolicy } from "./location-policy.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "Not set";
  if (amount >= 1000 && amount % 1000 === 0) return `$${amount / 1000}k`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function signalLabel(value) {
  if (typeof value === "string") return value;
  return value?.label || value?.signal || value?.name || "";
}

function selectedRuntime(runtimes) {
  const choices = list(runtimes?.runtimes);
  return choices.find((runtime) => runtime?.id === runtimes?.selectedId) || null;
}

function capabilityEnabled(automation, id, fallback = false) {
  const row = list(automation?.capabilities).find((item) => item?.capability === id);
  return row ? row.enabled === true : fallback;
}

function browserModel(automation) {
  const session = automation?.session || {};
  const options = list(session.options);
  const configured = options.find((option) => option?.id === session.provider);
  const effective = options.find((option) => option?.id === session.effectiveProvider);
  return {
    provider: configured?.label || session.provider || "Not configured",
    effectiveProvider: effective?.label || session.effectiveProvider || "Not detected",
    presenceStatus: session.presence?.status || "unknown",
    presenceDetail: session.presence?.detail || "Browser readiness has not been checked yet.",
    automaticFillSupported: Boolean((configured || effective)?.automatedApply),
    playwright: {
      packageInstalled: session.tooling?.playwright?.packageInstalled === true,
      browserInstalled: session.tooling?.playwright?.browserInstalled === true,
      ready: session.tooling?.playwright?.ready === true,
      detail:
        session.tooling?.playwright?.detail || "Playwright readiness has not been checked yet.",
    },
  };
}

function evidenceTally(data, fallbackClaims) {
  const confirmed = data?.deepIngest?.confirmed || {};
  const evidence = list(confirmed.evidence);
  const roles = new Set(
    evidence
      .map((row) => row?.role || row?.roleTitle || row?.title)
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  const promotions = evidence.filter(
    (row) =>
      row?.promotion === true ||
      /\bpromot(?:ed|ion)\b/i.test(
        [row?.kind, row?.category, row?.claim, row?.title].filter(Boolean).join(" ")
      )
  ).length;
  const stories = list(confirmed.storyBank);
  return {
    roles: roles.size,
    promotions,
    stories: stories.length || fallbackClaims.length,
  };
}

function latestSourceSweep(rows) {
  return rows
    .map((source) => source?.lastRunAt)
    .filter(Boolean)
    .sort((left, right) => String(right).localeCompare(String(left)))[0];
}

export function buildProfileSettingsModel({ onboard, runtimes, automation, sources } = {}) {
  const data = onboard?.data || {};
  const profile = data.profile || {};
  const targeting = data.targeting || {};
  const evidenceClaims = list(data.evidence?.claims);
  const voiceRows = list(data.deepIngest?.confirmed?.writingVoice);
  const sourceRows = [...list(sources?.searches), ...list(sources?.companies)];
  const companySources = list(sources?.companies);
  const runtime = selectedRuntime(runtimes);
  const targets = list(targeting.role_buckets).flatMap((bucket) => list(bucket?.titles));
  const dealbreakers = list(targeting.cut_signals).map(signalLabel).filter(Boolean);

  return {
    agentName: data.modes?.agent_name || "Paul",
    profile: {
      targets,
      compensation: {
        floor: money(profile.compensation?.oe_min_base || profile.compensation?.minimum_base),
        target: money(profile.compensation?.expected_base || profile.compensation?.target_base),
      },
      locationPolicy: buildLocationPolicy(profile.location),
      dealbreakers,
      evidence: {
        ...evidenceTally(data, evidenceClaims),
      },
      writingStyle: {
        sampleCount: voiceRows.length,
        description:
          voiceRows
            .map((row) => row?.summary || row?.description)
            .filter(Boolean)
            .join(" · ") || "Plain, direct, and grounded in your saved evidence.",
      },
      searchRules: [
        `${sourceRows.length} ${sourceRows.length === 1 ? "source" : "sources"} configured`,
        "Shows roles matched to your saved targets",
      ],
    },
    engine: {
      name: runtime?.name || "AI engine",
      connected: Boolean(runtime?.ready),
      selectedId: runtimes?.selectedId || null,
      choices: list(runtimes?.runtimes).map((choice) => ({ ...choice })),
    },
    browser: browserModel(automation),
    permissions: [
      {
        id: "draft_documents",
        name: "Draft documents",
        description: "resumes and covers from your evidence",
        enabled: true,
        mutable: false,
        statusLabel: "Always on",
      },
      {
        id: "authenticated_search",
        name: "Browse job portals",
        description: "use connected browser sessions when needed",
        enabled: capabilityEnabled(automation, "authenticated_search"),
        mutable: true,
      },
      {
        id: "authenticated_apply_preparation",
        name: "Prepare application forms",
        description: "Paul fills authenticated forms, you press every submit",
        enabled: capabilityEnabled(automation, "authenticated_apply_preparation"),
        mutable: true,
      },
      {
        id: "mail_access",
        name: "Send email replies",
        description: "uses the mail access you explicitly connected",
        enabled: capabilityEnabled(automation, "mail_access"),
        mutable: true,
      },
    ],
    sources: {
      scannedCount: sourceRows.filter((source) => Boolean(source?.lastRunAt)).length,
      pinnedCount: companySources.filter((source) => source?.enabled !== false).length,
      blockedCount: sourceRows.filter(
        (source) => source?.blocked === true || String(source?.status).toLowerCase() === "blocked"
      ).length,
      lastSweep:
        sources?.lastSweepAt || sources?.lastSweep || latestSourceSweep(sourceRows) || null,
    },
  };
}

export function permissionPatch(id, enabled) {
  if (id === "draft_documents") return null;
  return {
    setup_mode: "advanced",
    capabilities: { [id]: { enabled: Boolean(enabled) } },
  };
}
