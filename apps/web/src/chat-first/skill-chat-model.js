import {
  hasPersistedSourceReviewTable,
  normalizeSourceReviewArtifact,
  parsePersistedSourceReviewTable,
  parseSourceReviewOutput,
} from "../../../../src/core/discovery/source-review-artifact.mjs";
import { resolveErrorCopy } from "../lib/errorCopy.js";

const DISCOVERY_FENCE = /```careerrat:discovery\s*\r?\n([\s\S]*?)\r?\n```/g;
const VISIBLE_SKILLS = new Set([
  "research-boards",
  "research-company",
  "research-comp",
  "company-health",
]);
const TERMINAL_TURN_STATES = new Set(["awaiting-user", "failed", "completed"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function cleanString(value, max = 500) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max ? text : "";
}

function publicHttpUrl(value) {
  const text = cleanString(value, 4_000);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function safeObject(value, max = 200_000) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.stringify(value).length <= max ? value : null;
  } catch {
    return null;
  }
}

function normalizeDiscovery(value) {
  const kind = cleanString(value?.kind, 80);
  if (kind === "source_review") return normalizeSourceReviewArtifact(value);
  if (kind === "source_proposal") {
    const label = cleanString(value.label, 240);
    const url = publicHttpUrl(value.url);
    if (!label || !url) return null;
    return {
      kind,
      label,
      url,
      why: cleanString(value.why, 1_000),
      confidence: ["high", "borderline"].includes(value.confidence)
        ? value.confidence
        : "borderline",
    };
  }
  if (kind === "company_research_result") {
    const company = cleanString(value.company, 240);
    const slug = cleanString(value.slug, 240);
    const markdown = cleanString(value.markdown, 1_000_000);
    if (!company || !slug || !markdown) return null;
    return { kind, company, slug, markdown };
  }
  if (kind === "comp_benchmark_result") {
    const role = cleanString(value.role, 240);
    const location = cleanString(value.location, 240);
    const stem = cleanString(value.stem, 240);
    const markdown = cleanString(value.markdown, 1_000_000);
    const benchmark = safeObject(value.benchmark, 20_000);
    if (!role || !location || !stem || !markdown || !benchmark) return null;
    return { kind, role, location, stem, benchmark, markdown };
  }
  if (kind === "company_health_result") {
    const targetType = cleanString(value.targetType, 40);
    const targetId = cleanString(value.targetId, 240);
    const company = cleanString(value.company, 240);
    const companyHealth = safeObject(value.companyHealth);
    if (!["application", "sourced"].includes(targetType) || !targetId || !companyHealth) {
      return null;
    }
    return { kind, targetType, targetId, company, companyHealth };
  }
  if (kind === "discovery_complete" && value.step === "research-boards") {
    return { kind, step: "research-boards" };
  }
  return null;
}

function discoveryIdentity(item) {
  if (item.kind === "source_review") return item.id;
  if (item.kind === "source_proposal") return item.url;
  if (item.kind === "company_research_result") return item.slug;
  if (item.kind === "comp_benchmark_result") return item.stem;
  if (item.kind === "company_health_result") {
    return `${item.targetType}:${item.targetId}:${item.companyHealth?.asOf || "current"}`;
  }
  if (item.kind === "discovery_complete") return item.step;
  return item.kind;
}

function skillChatDiscoveryId(skill, item) {
  const safeSkill = cleanString(skill, 100) || "research";
  return `discovery:${safeSkill}:${item.kind}:${encodeURIComponent(discoveryIdentity(item)).slice(0, 320)}`;
}

export function parseSkillChatText(value, skill) {
  const text = String(value || "");
  if (
    skill === "research-boards" &&
    /```careerrat:discovery[\s\S]*?"kind"\s*:\s*"source_review"/.test(text)
  ) {
    const parsed = parseSourceReviewOutput(text);
    return { text: parsed.text, discoveries: parsed.artifacts };
  }
  const discoveries = [];
  const visibleText = text.replace(DISCOVERY_FENCE, (_block, raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "";
    }
    const discovery = normalizeDiscovery(parsed);
    if (!discovery || (discovery.kind === "discovery_complete" && skill !== "research-boards")) {
      return "";
    }
    const item = { ...discovery, id: skillChatDiscoveryId(skill, discovery) };
    if (!discoveries.some((candidate) => candidate.id === item.id)) discoveries.push(item);
    return "";
  });
  return {
    text: visibleText.replace(/\n{3,}/g, "\n\n").trim(),
    discoveries,
  };
}

export function discoveryIntentFor(item) {
  if (item?.kind === "source_proposal") {
    return {
      type: "source.add",
      entity: { type: "workspace", id: "workspace-main" },
      input: { url: item.url, label: item.label },
    };
  }
  if (item?.kind === "company_research_result") {
    return {
      type: "research.record",
      entity: { type: "workspace", id: "workspace-main" },
      input: {
        type: "company-research",
        name: item.company,
        slug: item.slug,
        markdown: item.markdown,
      },
    };
  }
  if (item?.kind === "comp_benchmark_result") {
    return {
      type: "research.record",
      entity: { type: "workspace", id: "workspace-main" },
      input: {
        type: "comp-benchmark",
        name: item.role,
        slug: item.stem,
        markdown: item.markdown,
      },
    };
  }
  if (item?.kind === "company_health_result") {
    return {
      type: "company.health-record",
      entity: { type: item.targetType, id: item.targetId },
      input: { company: item.company, companyHealth: item.companyHealth },
    };
  }
  return null;
}

function assistantText(data) {
  return list(data?.message?.content)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function eventMessageId(chatId, eventId) {
  return `skill-${chatId}-event-${eventId}`;
}

function activityText(data) {
  const name = cleanString(data?.name, 100);
  if (/websearch/i.test(name)) return "Searching the web";
  if (/webfetch/i.test(name)) return "Reading a source";
  return name ? `Using ${name}` : "Researching";
}

function parseRaw(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function assistantMessageIdentity(message) {
  if (message?.role !== "assistant" || message?.kind !== "text") return null;
  return JSON.stringify({
    text: String(message.text || ""),
    artifactIds: list(message.artifacts).map((artifact) =>
      String(artifact?.id || `${artifact?.kind || "artifact"}:${discoveryIdentity(artifact)}`)
    ),
  });
}

function currentAssistantTurn(messages) {
  const items = list(messages);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "user") return items.slice(index + 1);
  }
  return items;
}

export function reduceSkillChatEvent(state, { chatId, type, raw, eventId } = {}) {
  const nextId = Number(eventId);
  if (
    !chatId ||
    !Number.isSafeInteger(nextId) ||
    nextId < 0 ||
    (state?.chatId === chatId && nextId <= Number(state?.cursor || 0))
  ) {
    return state;
  }
  const data = parseRaw(raw);
  const next = { ...state, chatId, cursor: nextId };
  if (type === "chat_state") return { ...next, state: data?.state || next.state };

  let message = null;
  if (type === "assistant") {
    const parsed = parseSkillChatText(assistantText(data), state?.skill);
    const runtimeArtifacts = list(data?.artifacts).flatMap((artifact) => {
      const review = normalizeSourceReviewArtifact(artifact);
      return review ? [review] : [];
    });
    const discoveries = runtimeArtifacts.length ? runtimeArtifacts : parsed.discoveries;
    if (parsed.text || discoveries.length) {
      message = {
        id: eventMessageId(chatId, nextId),
        role: "assistant",
        kind: "text",
        text: parsed.text,
        artifacts: discoveries,
        ...(data?.answerMode === "yes-no" ? { metadata: { answerMode: "yes-no" } } : {}),
      };
    }
  } else if (type === "tool_use") {
    message = {
      id: eventMessageId(chatId, nextId),
      role: "system",
      kind: "status",
      text: activityText(data),
      metadata: { mark: "◐", toolUseId: data?.id || null },
    };
  } else if (type === "error") {
    message = {
      id: eventMessageId(chatId, nextId),
      role: "assistant",
      kind: "agent_error",
      text: cleanString(data?.message, 20_000) || "This research run could not finish.",
    };
  }

  const identity = assistantMessageIdentity(message);
  const messages = list(state?.messages);
  if (
    !message ||
    messages.some((candidate) => candidate.id === message.id) ||
    (identity !== null &&
      currentAssistantTurn(messages).some(
        (candidate) => assistantMessageIdentity(candidate) === identity
      ))
  ) {
    return next;
  }
  return { ...next, messages: [...messages, message] };
}

function discoveryTitle(item) {
  if (item.kind === "source_review") return `${item.proposalCount} sources found`;
  if (item.kind === "source_proposal") return item.label;
  if (item.kind === "company_research_result") return `${item.company} research`;
  if (item.kind === "comp_benchmark_result") return `${item.role} comp benchmark`;
  if (item.kind === "company_health_result") return `${item.company} company health`;
  if (item.kind === "discovery_complete") return "Board discovery review complete";
  return "Research result";
}

function discoverySubtitle(item) {
  if (item.kind === "source_review") {
    return `${item.highConfidenceCount} strong matches · ${item.borderlineCount} need a closer look`;
  }
  if (item.kind === "source_proposal") {
    return [item.confidence === "high" ? "high confidence" : "review carefully", item.why]
      .filter(Boolean)
      .join(" · ");
  }
  if (item.kind === "comp_benchmark_result") return item.location;
  if (item.kind === "company_health_result") return item.companyHealth?.rating || "ready to review";
  if (item.kind === "discovery_complete") return "finish after every source proposal is decided";
  return "cited research ready to review";
}

export function skillChatDiscoveryPresentation(item) {
  return { title: discoveryTitle(item), subtitle: discoverySubtitle(item) };
}

export function skillChatCompletionFor(messages) {
  const artifacts = list(messages).flatMap((message) => list(message?.artifacts));
  const review = [...artifacts].reverse().find((artifact) => artifact?.kind === "source_review");
  const item =
    review?.completion ||
    artifacts.find(
      (artifact) => artifact?.kind === "discovery_complete" && artifact?.step === "research-boards"
    );
  if (!item) return null;
  const proposals = new Map();
  for (const artifact of artifacts) {
    if (artifact?.kind === "source_review") {
      for (const candidate of list(artifact.candidates)) {
        if (candidate?.status !== "proposed") continue;
        proposals.set(candidate.id, candidate);
      }
      continue;
    }
    if (artifact?.kind !== "source_proposal") continue;
    const id = artifact.id || artifact.url;
    if (!id) continue;
    const existing = proposals.get(id);
    if (!existing || artifact?.decision?.status === "completed") proposals.set(id, artifact);
  }
  const pendingCount = [...proposals.values()].filter(
    (artifact) => artifact?.decision?.status !== "completed"
  ).length;
  return {
    item,
    pendingCount,
    ready: pendingCount === 0 && item?.decision?.status !== "completed",
  };
}

export function hydrateSkillChatMessages(thread) {
  const decisions = new Map(list(thread?.decisions).map((decision) => [decision.id, decision]));
  const messages = list(thread?.messages).flatMap((message, index) => {
    if (message?.visibility === "internal") return [];
    if (message?.role !== "assistant") {
      return [{ ...message, id: message?.id || `${thread?.id || "skill"}-message-${index + 1}` }];
    }
    if (message?.kind === "agent_error") {
      return [
        {
          ...message,
          id: message?.id || `${thread?.id || "skill"}-message-${index + 1}`,
          kind: "agent_error",
        },
      ];
    }
    const persistedTable =
      thread?.skill === "research-boards" && hasPersistedSourceReviewTable(message.text)
        ? parsePersistedSourceReviewTable(message.text)
        : null;
    const parsed = persistedTable
      ? { text: persistedTable.text, discoveries: persistedTable.artifacts }
      : parseSkillChatText(message.text, thread?.skill);
    const persistedArtifacts = list(message?.artifacts).flatMap((artifact) => {
      const review = normalizeSourceReviewArtifact(artifact);
      return review ? [review] : [];
    });
    const discoveries = persistedArtifacts.length ? persistedArtifacts : parsed.discoveries;
    return [
      {
        ...message,
        id: message?.id || `${thread?.id || "skill"}-message-${index + 1}`,
        kind: "text",
        text: parsed.text,
        artifacts: discoveries.map((item) => {
          const candidates =
            item.kind === "source_review"
              ? item.candidates.map((candidate) => ({
                  ...candidate,
                  decision: decisions.get(candidate.id) || null,
                }))
              : undefined;
          return {
            ...item,
            ...(candidates ? { candidates } : {}),
            completion:
              item.kind === "source_review"
                ? {
                    ...item.completion,
                    decision: decisions.get(item.completion.id) || null,
                  }
                : item.completion,
            title: discoveryTitle(item),
            subtitle: discoverySubtitle(item),
            decision: decisions.get(item.id) || null,
          };
        }),
      },
    ];
  });
  for (const decision of list(thread?.decisions)) {
    messages.push({
      id: `decision-result:${decision.id}`,
      role: decision.status === "failed" ? "assistant" : "system",
      kind: decision.status === "failed" ? "action_error" : "action_result",
      text:
        decision.resultText ||
        (decision.action === "discard" ? "Discarded. Nothing was saved." : "Saved to workspace."),
      createdAt: decision.updatedAt,
    });
  }
  return messages;
}

function visibleLaunchArtifacts(mainThread) {
  return list(mainThread?.messages).flatMap((message) =>
    list(message?.artifacts).filter(
      (artifact) =>
        ["research_chat", "board_discovery_chat"].includes(artifact?.kind) &&
        VISIBLE_SKILLS.has(artifact?.skill) &&
        cleanString(artifact?.chatId, 500)
    )
  );
}

function defaultThreadTitle(skill) {
  return {
    "research-boards": "Job board discovery",
    "research-company": "Company research",
    "research-comp": "Market comp research",
    "company-health": "Company health",
  }[skill];
}

export function buildSkillChatThreads(mainThread, persistedThreads) {
  const bySkill = new Map();
  for (const thread of list(persistedThreads)) {
    if (!VISIBLE_SKILLS.has(thread?.skill)) continue;
    bySkill.set(thread.skill, {
      ...thread,
      id: `skill:${thread.skill}`,
      title: thread.title || defaultThreadTitle(thread.skill),
      state: thread.turnState || thread.state || "idle",
      messages: list(thread.messages),
      decisions: list(thread.decisions),
    });
  }
  for (const artifact of visibleLaunchArtifacts(mainThread)) {
    const existing = bySkill.get(artifact.skill) || {
      id: `skill:${artifact.skill}`,
      skill: artifact.skill,
      messages: [],
      decisions: [],
    };
    bySkill.set(artifact.skill, {
      ...existing,
      title: artifact.title || existing.title || defaultThreadTitle(artifact.skill),
      chatId: artifact.chatId,
      state: TERMINAL_TURN_STATES.has(existing.state)
        ? existing.state
        : artifact.state || existing.state || "running",
    });
  }
  return [...bySkill.values()].sort((left, right) =>
    String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
  );
}

export function skillChatFromWorkspaceResult(result) {
  const messages = list(result?.data?.messages).length
    ? list(result.data.messages)
    : list(result?.messages);
  const artifact = list(messages.at(-1)?.artifacts).find(
    (candidate) =>
      ["research_chat", "board_discovery_chat"].includes(candidate?.kind) &&
      VISIBLE_SKILLS.has(candidate?.skill) &&
      cleanString(candidate?.chatId, 500)
  );
  return artifact ? { ...artifact, id: `skill:${artifact.skill}` } : null;
}

export async function resolveSkillChatSession(api, thread, inFlight) {
  const skill = cleanString(thread?.skill, 100);
  if (!skill) throw new Error("Research thread is missing its skill.");
  const existing = inFlight?.get(skill);
  if (existing) return existing;
  const resolution = (async () => {
    const live = await api.findChatBySkill(skill);
    if (live?.chatId) return live;
    try {
      return await api.startChat(skill);
    } catch (error) {
      const chatId = error?.status === 409 ? cleanString(error?.body?.chatId, 500) : "";
      if (chatId) return { chatId, skill, state: "running" };
      throw error;
    }
  })();
  if (!inFlight) return resolution;
  inFlight.set(skill, resolution);
  try {
    return await resolution;
  } finally {
    if (inFlight.get(skill) === resolution) inFlight.delete(skill);
  }
}

export function skillChatSubmitBlocked(thread) {
  return Boolean(thread && !cleanString(thread.chatId, 500));
}

export function skillChatEventNeedsHydration(type, raw) {
  if (type === "result" || type === "error") return true;
  return type === "assistant" && parseRaw(raw)?.answerMode === "yes-no";
}

export function skillChatStreamUrl(thread) {
  const chatId = cleanString(thread?.chatId, 500);
  if (!chatId || thread?.state === "closed") return null;
  return `/api/chat/events?id=${encodeURIComponent(chatId)}&after=${Number(thread?.streamAfter || 0)}`;
}

function skillChatDecisionCopy(item, action) {
  if (action === "discard") {
    return `Discarded ${discoveryTitle(item)}. Nothing was saved.`;
  }
  return `Saved ${discoveryTitle(item)} to your workspace.`;
}

function actionResultText(result, fallback) {
  const messages = list(result?.data?.messages).length
    ? list(result.data.messages)
    : list(result?.messages);
  return cleanString(messages.at(-1)?.text, 50_000) || fallback;
}

function actionErrorText(error) {
  return resolveErrorCopy(error).message;
}

export async function commitSkillChatDecision({ api, skill, item, action } = {}) {
  if (!skill || !item?.id || !["save", "discard"].includes(action)) {
    throw new Error("Research decision is invalid.");
  }

  let resultText = skillChatDecisionCopy(item, action);
  try {
    if (action === "save") {
      const intent = discoveryIntentFor(item);
      if (!intent) throw new Error("This research result cannot be saved.");
      const result = await api.runWorkspaceIntent(intent.type, intent.entity, intent.input);
      resultText = actionResultText(result, resultText);
    }
    await api.recordSkillChatDecision({
      skill,
      decisionId: item.id,
      action,
      status: "completed",
      resultText,
    });
    return resultText;
  } catch (error) {
    await api
      .recordSkillChatDecision({
        skill,
        decisionId: item.id,
        action,
        status: "failed",
        resultText: actionErrorText(error),
      })
      .catch(() => undefined);
    throw error;
  }
}

export async function commitSkillChatCompletion({ api, skill, item } = {}) {
  if (
    skill !== "research-boards" ||
    item?.kind !== "discovery_complete" ||
    item?.step !== "research-boards" ||
    !item?.id
  ) {
    throw new Error("Board discovery completion is invalid.");
  }
  const resultText = "Board discovery is complete.";
  try {
    await api.completeDiscovery(item.step);
    await api.recordSkillChatDecision({
      skill,
      decisionId: item.id,
      action: "save",
      status: "completed",
      resultText,
    });
    return resultText;
  } catch (error) {
    await api
      .recordSkillChatDecision({
        skill,
        decisionId: item.id,
        action: "save",
        status: "failed",
        resultText: actionErrorText(error),
      })
      .catch(() => undefined);
    throw error;
  }
}
