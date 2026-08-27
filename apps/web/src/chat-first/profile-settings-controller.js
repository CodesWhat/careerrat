import { UserFacingError } from "../lib/errorCopy.js";
import { runtimePresentation } from "./first-run-controller.js";
import { buildLocationPolicy } from "./location-policy.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

function lines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
}

function lineValue(value) {
  return list(value)
    .map((row) => String(row || "").trim())
    .filter(Boolean)
    .join("\n");
}

function field(id, label, type, value = "", extra = {}) {
  return { id, label, type, value, ...extra };
}

function numberValue(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? String(amount) : "";
}

function amountOrNull(value, label) {
  if (String(value ?? "").trim() === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new UserFacingError(`${label} must be a valid amount.`);
  }
  return amount;
}

function officeDaysOrNull(value) {
  if (String(value ?? "").trim() === "") return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 7) {
    throw new UserFacingError("Office days must be a whole number from 0 to 7.");
  }
  return days;
}

function remoteScopeValue(location = {}) {
  if (location.remote !== true) return "off";
  return location.remote_scope === "worldwide" ? "worldwide" : "home-country";
}

const REMOTE_SCOPE_OPTIONS = [
  { value: "off", label: "Not open to remote roles" },
  { value: "home-country", label: "Remote within my home country" },
  { value: "worldwide", label: "Remote worldwide" },
];

const VOLUNTARY_FORM_POLICY_OPTIONS = [
  { value: "leave_blank", label: "Leave these blank (default)" },
  {
    value: "decline_when_available",
    label: "Choose the form's decline option when available",
  },
];

const PERMISSION_PLATFORMS = Object.freeze({
  authenticated_search: ["linkedin", "indeed", "wellfound", "glassdoor"],
  authenticated_apply_preparation: [
    "greenhouse",
    "lever",
    "ashby",
    "workable",
    "smartrecruiters",
    "linkedin",
    "external_ats",
  ],
  mail_access: ["gmail", "outlook", "webmail"],
});

const PERMISSION_PROVIDER_SCOPES = Object.freeze({
  authenticated_search:
    "Turning this on records consent for LinkedIn, Indeed, Wellfound, and Glassdoor.",
  authenticated_apply_preparation:
    "Turning this on records consent for Greenhouse, Lever, Ashby, Workable, SmartRecruiters, LinkedIn, and external ATS sites.",
  mail_access: "Turning this on records consent for Gmail, Outlook, and webmail.",
});

function cadenceLabel(value) {
  return (
    {
      daily: "daily",
      "every-3-days": "every 3 days",
      weekly: "weekly",
      manual: "manually",
    }[value] || "daily"
  );
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
    providerId: session.provider || null,
    provider: configured?.label || session.provider || "Not configured",
    effectiveProviderId: session.effectiveProvider || null,
    effectiveProvider: effective?.label || session.effectiveProvider || "Not detected",
    presenceStatus: session.presence?.status || "unknown",
    presenceDetail: session.presence?.detail || "Browser readiness has not been checked yet.",
    automaticFillSupported: Boolean((configured || effective)?.automatedApply),
    options: options.map((option) => ({
      id: option?.id,
      label: option?.label || option?.id || "Browser provider",
      needs: option?.needs || "",
      automatedApply: option?.automatedApply === true,
    })),
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

function locationPolicyForProfile(location, onboard) {
  const policy = buildLocationPolicy(location);
  if (!policy || typeof location?.mode_preferences_confirmed === "boolean") return policy;
  const quickFacts = list(onboard?.setupProgress?.items).find((item) => item?.key === "quickFacts");
  return quickFacts ? { ...policy, confirmed: quickFacts.done === true } : policy;
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
  const roleBuckets = list(targeting.role_buckets).map((bucket) => ({
    ...bucket,
    titles: [...list(bucket?.titles)],
  }));
  const dealbreakers = list(targeting.cut_signals).map(signalLabel).filter(Boolean);
  const keepSignals = list(targeting.keep_signals).map(signalLabel).filter(Boolean);
  const compensation = profile.compensation || {};
  const location = profile.location || {};
  const writingVoice = voiceRows[0] || {};
  const pinnedCount = companySources.filter((source) => source?.enabled !== false).length;
  const cadence = targeting.search_preferences?.cadence?.mode || "daily";
  const fitFloor = Number(targeting.fit_bands?.fit_floor);
  const displayedFitFloor = Number.isFinite(fitFloor) ? fitFloor : 70;
  const agentName = data.modes?.agent_name || "Paul";
  const publicSyncPreference = onboard?.publicSyncPreference || {};
  const runtimeSupport = runtimePresentation(runtime || {});
  const voluntarySelfIdentification = data["form-defaults"]?.voluntary_self_identification || {};
  const voluntaryFormPolicy =
    voluntarySelfIdentification.enabled === true &&
    voluntarySelfIdentification.default_action === "decline_when_available"
      ? "decline_when_available"
      : "leave_blank";
  const preservedVoluntaryAnswers =
    voluntarySelfIdentification.answers &&
    typeof voluntarySelfIdentification.answers === "object" &&
    !Array.isArray(voluntarySelfIdentification.answers)
      ? { ...voluntarySelfIdentification.answers }
      : {};

  return {
    agentName,
    profile: {
      targets,
      compensation: {
        floor: money(compensation.minimum_base ?? compensation.oe_min_base),
        target: money(compensation.target_base ?? compensation.expected_base),
      },
      locationPolicy: locationPolicyForProfile(location, onboard),
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
        `${pinnedCount} ${pinnedCount === 1 ? "board" : "boards"} pinned`,
        `Sweeps ${cadenceLabel(cadence)}`,
        `Shows only fit ${displayedFitFloor}+`,
      ],
      applicationDefaults: {
        action: VOLUNTARY_FORM_POLICY_OPTIONS.find((option) => option.value === voluntaryFormPolicy)
          .label,
        localNotice: `Local only on this computer. This setting never goes through ${agentName}.`,
      },
      editors: {
        targets: {
          id: "targets",
          title: "Edit targets",
          roleBuckets,
          fields: (roleBuckets.length
            ? roleBuckets
            : [{ name: "Primary targets", titles: targets }]
          ).map((bucket, index) =>
            field(
              index === 0 ? "titles" : `titles:${index}`,
              roleBuckets.length > 1
                ? `${bucket.name || `Target lane ${index + 1}`} titles`
                : "Target role titles",
              "textarea",
              lineValue(bucket.titles),
              {
                rows: 6,
                placeholder: "One role title per line",
              }
            )
          ),
        },
        compensation: {
          id: "compensation",
          title: "Edit compensation",
          fields: [
            field(
              "minimumBase",
              "Minimum base salary",
              "number",
              numberValue(compensation.minimum_base ?? compensation.oe_min_base),
              { min: "0", step: "1000" }
            ),
            field(
              "targetBase",
              "Target base salary",
              "number",
              numberValue(compensation.target_base ?? compensation.expected_base),
              { min: "0", step: "1000" }
            ),
          ],
        },
        dealbreakers: {
          id: "dealbreakers",
          title: "Edit dealbreakers",
          fields: [
            field("signals", "Dealbreakers", "textarea", lineValue(dealbreakers), {
              rows: 6,
              placeholder: "One dealbreaker per line",
            }),
          ],
        },
        "location-policy": {
          id: "location-policy",
          title: "Edit location policy",
          fields: [
            field(
              "home",
              "Home market",
              "text",
              location.home || profile.candidate?.location || ""
            ),
            field("remoteScope", "Remote job eligibility", "select", remoteScopeValue(location), {
              options: REMOTE_SCOPE_OPTIONS,
            }),
            field("hybrid", "Hybrid", "checkbox", "", {
              checked: location.hybrid === true,
            }),
            field("onsite", "On-site", "checkbox", "", {
              checked: location.onsite === true,
            }),
            field(
              "maxOfficeDays",
              "Maximum office days per week",
              "number",
              numberValue(location.max_commute_days_per_week),
              { min: 0, max: 7, step: 1 }
            ),
            field("relocation", "Relocation markets", "textarea", lineValue(location.relocation), {
              rows: 4,
              placeholder: "One market per line",
            }),
          ],
        },
        "writing-style": {
          id: "writing-style",
          title: "Edit writing style",
          itemId: writingVoice.id || null,
          fields: [
            field(
              "summary",
              "How drafts should sound",
              "textarea",
              writingVoice.summary || writingVoice.description || "",
              { rows: 4, placeholder: "Plain, direct, concrete, no buzzwords" }
            ),
            field(
              "doPhrases",
              "Phrases or habits to use",
              "textarea",
              lineValue(writingVoice.doPhrases || writingVoice.do_phrases),
              { rows: 4, placeholder: "One preference per line" }
            ),
            field(
              "avoidPhrases",
              "Phrases or habits to avoid",
              "textarea",
              lineValue(writingVoice.avoidPhrases || writingVoice.avoid_phrases),
              { rows: 4, placeholder: "One preference per line" }
            ),
          ],
        },
        "search-rules": {
          id: "search-rules",
          title: "Edit search rules",
          fields: [
            field("keepSignals", "Positive fit signals", "textarea", lineValue(keepSignals), {
              rows: 5,
              placeholder: "One signal per line",
            }),
            field("cadence", "Search cadence", "select", cadence, {
              options: [
                { value: "daily", label: "Daily" },
                { value: "every-3-days", label: "Every 3 days" },
                { value: "weekly", label: "Weekly" },
                { value: "manual", label: "Manual" },
              ],
            }),
            field("fitFloor", "Minimum fit score", "number", String(displayedFitFloor), {
              min: "0",
              max: "100",
              step: "1",
            }),
          ],
        },
        "application-defaults": {
          id: "application-defaults",
          title: "Application defaults",
          localOnly: true,
          description:
            "Choose how CareerRat handles optional voluntary form questions. This stays local on this computer.",
          preservedAnswers: preservedVoluntaryAnswers,
          fields: [
            field(
              "policy",
              "Voluntary self-identification questions",
              "select",
              voluntaryFormPolicy,
              { options: VOLUNTARY_FORM_POLICY_OPTIONS }
            ),
          ],
        },
      },
    },
    engine: {
      name: runtime?.name || "AI engine",
      connected: Boolean(runtime?.ready && runtime?.selectable !== false),
      presentationState: runtimeSupport.state,
      statusLabel: runtimeSupport.label,
      selectedId: runtimes?.selectedId || null,
      choices: list(runtimes?.runtimes).map((choice) => ({ ...choice })),
    },
    browser: browserModel(automation),
    publicSyncPreference: {
      enabled: publicSyncPreference.enabled !== false,
      source: publicSyncPreference.source || "default",
      updatedAt: publicSyncPreference.updatedAt || null,
    },
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
        providerScope: PERMISSION_PROVIDER_SCOPES.authenticated_search,
        enabled: capabilityEnabled(automation, "authenticated_search"),
        mutable: true,
      },
      {
        id: "authenticated_apply_preparation",
        name: "Prepare application forms",
        description: `${agentName} fills authenticated forms, you press every submit`,
        providerScope: PERMISSION_PROVIDER_SCOPES.authenticated_apply_preparation,
        enabled: capabilityEnabled(automation, "authenticated_apply_preparation"),
        mutable: true,
      },
      {
        id: "mail_access",
        name: "Read job-search email",
        description: "reads recruiting updates and verification codes from connected mail",
        providerScope: PERMISSION_PROVIDER_SCOPES.mail_access,
        enabled: capabilityEnabled(automation, "mail_access"),
        mutable: true,
      },
    ],
    sources: {
      scannedCount: sourceRows.filter((source) => Boolean(source?.lastRunAt)).length,
      pinnedCount,
      blockedCount: sourceRows.filter(
        (source) => source?.blocked === true || String(source?.status).toLowerCase() === "blocked"
      ).length,
      lastSweep:
        sources?.lastSweepAt || sources?.lastSweep || latestSourceSweep(sourceRows) || null,
    },
  };
}

export function profileSectionSavePlan(
  section,
  values = {},
  editor = {},
  { now = () => new Date() } = {}
) {
  if (section === "targets") {
    const existingBuckets = list(editor?.roleBuckets);
    const roleBuckets = existingBuckets.length
      ? existingBuckets.map((bucket, index) => ({
          ...bucket,
          titles: lines(values[index === 0 ? "titles" : `titles:${index}`]),
        }))
      : [
          {
            name: "Primary targets",
            priority: "primary",
            titles: lines(values.titles),
          },
        ];
    if (!roleBuckets.some((bucket) => bucket.titles.length)) {
      throw new UserFacingError("Add at least one target role.");
    }
    return [
      {
        kind: "candidate",
        name: "targeting",
        patch: { role_buckets: roleBuckets },
      },
    ];
  }
  if (section === "compensation") {
    const minimumBase = amountOrNull(values.minimumBase, "Minimum base");
    const targetBase = amountOrNull(values.targetBase, "Target base");
    if (minimumBase !== null && targetBase !== null && targetBase < minimumBase) {
      throw new UserFacingError("Target base must be at least the floor.");
    }
    return [
      {
        kind: "candidate",
        name: "profile",
        patch: {
          compensation: { minimum_base: minimumBase, target_base: targetBase },
        },
      },
    ];
  }
  if (section === "dealbreakers") {
    return [
      {
        kind: "candidate",
        name: "targeting",
        patch: { cut_signals: lines(values.signals) },
      },
    ];
  }
  if (section === "location-policy") {
    const home = String(values.home || "").trim();
    const remoteScope = values.remoteScope === "worldwide" ? "worldwide" : "home-country";
    return [
      {
        kind: "candidate",
        name: "profile",
        patch: {
          candidate: { location: home },
          location: {
            home,
            remote: ["home-country", "worldwide"].includes(values.remoteScope),
            remote_scope: remoteScope,
            hybrid: values.hybrid === true,
            onsite: values.onsite === true,
            max_commute_days_per_week: officeDaysOrNull(values.maxOfficeDays),
            relocation: lines(values.relocation),
            mode_preferences_confirmed: true,
          },
        },
      },
    ];
  }
  if (section === "writing-style") {
    const summary = String(values.summary || "").trim();
    if (!summary) throw new UserFacingError("Describe how drafts should sound.");
    return [
      {
        kind: "deep-ingest",
        lane: "writing_voice",
        id: editor?.itemId || null,
        fields: {
          summary,
          doPhrases: lines(values.doPhrases),
          avoidPhrases: lines(values.avoidPhrases),
        },
      },
    ];
  }
  if (section === "search-rules") {
    const fitFloor = Number(values.fitFloor);
    if (!Number.isFinite(fitFloor) || fitFloor < 0 || fitFloor > 100) {
      throw new UserFacingError("Fit floor must be between 0 and 100.");
    }
    const cadence = new Set(["daily", "every-3-days", "weekly", "manual"]).has(values.cadence)
      ? values.cadence
      : "daily";
    return [
      {
        kind: "candidate",
        name: "targeting",
        patch: {
          keep_signals: lines(values.keepSignals),
          fit_bands: { fit_floor: fitFloor },
          search_preferences: { cadence: { mode: cadence } },
        },
      },
    ];
  }
  if (section === "application-defaults") {
    const declineWhenAvailable = values.policy === "decline_when_available";
    const preservedAnswers =
      editor?.preservedAnswers &&
      typeof editor.preservedAnswers === "object" &&
      !Array.isArray(editor.preservedAnswers)
        ? { ...editor.preservedAnswers }
        : {};
    return [
      {
        kind: "candidate",
        name: "form-defaults",
        patch: {
          voluntary_self_identification: {
            enabled: declineWhenAvailable,
            default_action: declineWhenAvailable ? "decline_when_available" : "leave_blank",
            confirmed_at: now().toISOString(),
            answers: preservedAnswers,
          },
        },
      },
    ];
  }
  throw new Error("That profile section is not editable here.");
}

export function permissionPatch(id, enabled, currentPermissions = []) {
  if (id === "draft_documents") return null;
  const value = Boolean(enabled);
  const platforms = PERMISSION_PLATFORMS[id] || [];
  const providerState = Object.fromEntries(platforms.map((platform) => [platform, value]));
  const consentState = Object.fromEntries(
    platforms.map((platform) => [
      platform,
      value ||
        list(currentPermissions).some((permission) => {
          const permissionId = permission?.id || permission?.capability;
          return (
            permissionId !== id &&
            permission?.enabled === true &&
            list(PERMISSION_PLATFORMS[permissionId]).includes(platform)
          );
        }),
    ])
  );
  return {
    setup_mode: "advanced",
    ...(platforms.length ? { consent: consentState } : {}),
    capabilities: {
      [id]: {
        enabled: value,
        ...(platforms.length ? { platforms: { ...providerState } } : {}),
      },
    },
  };
}
