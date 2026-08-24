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
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? String(amount) : "";
}

function amountOrNull(value, label) {
  if (String(value ?? "").trim() === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label} must be a valid amount.`);
  return amount;
}

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
  const keepSignals = list(targeting.keep_signals).map(signalLabel).filter(Boolean);
  const compensation = profile.compensation || {};
  const location = profile.location || {};
  const writingVoice = voiceRows[0] || {};
  const pinnedCount = companySources.filter((source) => source?.enabled !== false).length;
  const cadence = targeting.search_preferences?.cadence?.mode || "daily";
  const fitFloor = Number(targeting.fit_bands?.fit_floor);
  const displayedFitFloor = Number.isFinite(fitFloor) ? fitFloor : 70;

  return {
    agentName: data.modes?.agent_name || "Paul",
    profile: {
      targets,
      compensation: {
        floor: money(compensation.minimum_base ?? compensation.oe_min_base),
        target: money(compensation.target_base ?? compensation.expected_base),
      },
      locationPolicy: buildLocationPolicy(location),
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
      editors: {
        targets: {
          id: "targets",
          title: "Edit targets",
          fields: [
            field("titles", "Target role titles", "textarea", lineValue(targets), {
              rows: 6,
              placeholder: "One role title per line",
            }),
          ],
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
            field("remote", "Remote", "checkbox", "", { checked: location.remote === true }),
            field("hybrid", "Hybrid", "checkbox", "", { checked: location.hybrid === true }),
            field("onsite", "On-site", "checkbox", "", { checked: location.onsite === true }),
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
      },
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
      pinnedCount,
      blockedCount: sourceRows.filter(
        (source) => source?.blocked === true || String(source?.status).toLowerCase() === "blocked"
      ).length,
      lastSweep:
        sources?.lastSweepAt || sources?.lastSweep || latestSourceSweep(sourceRows) || null,
    },
  };
}

export function profileSectionSavePlan(section, values = {}, editor = {}) {
  if (section === "targets") {
    const titles = lines(values.titles);
    if (!titles.length) throw new Error("Add at least one target role.");
    return [
      {
        kind: "candidate",
        name: "targeting",
        patch: {
          role_buckets: [{ name: "Primary targets", priority: "primary", titles }],
        },
      },
    ];
  }
  if (section === "compensation") {
    const minimumBase = amountOrNull(values.minimumBase, "Minimum base");
    const targetBase = amountOrNull(values.targetBase, "Target base");
    if (minimumBase !== null && targetBase !== null && targetBase < minimumBase) {
      throw new Error("Target base must be at least the floor.");
    }
    return [
      {
        kind: "candidate",
        name: "profile",
        patch: { compensation: { minimum_base: minimumBase, target_base: targetBase } },
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
    return [
      {
        kind: "candidate",
        name: "profile",
        patch: {
          candidate: { location: home },
          location: {
            home,
            remote: values.remote === true,
            hybrid: values.hybrid === true,
            onsite: values.onsite === true,
            relocation: lines(values.relocation),
            mode_preferences_confirmed: true,
          },
        },
      },
    ];
  }
  if (section === "writing-style") {
    const summary = String(values.summary || "").trim();
    if (!summary) throw new Error("Describe how drafts should sound.");
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
      throw new Error("Fit floor must be between 0 and 100.");
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
  throw new Error("That profile section is not editable here.");
}

export function permissionPatch(id, enabled) {
  if (id === "draft_documents") return null;
  return {
    setup_mode: "advanced",
    capabilities: { [id]: { enabled: Boolean(enabled) } },
  };
}
