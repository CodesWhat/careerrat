import { createHash } from "node:crypto";

const CHOICE_MODES = new Set(["binary", "single", "multi", "confirm"]);
const CHOICE_STATES = new Set(["pending", "resolved", "stale"]);
const DEFAULT_ACTION_TYPES = new Set(["chat.reply"]);
const MAX_OPTIONS = 8;
const MAX_ALIASES = 8;

function choiceError(message, code = "BAD_CHOICE_PROMPT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredText(value, label, max) {
  const text = String(value ?? "").trim();
  if (!text) throw choiceError(`${label} is required`);
  if (text.length > max || text.includes("\0")) {
    throw choiceError(`${label} is invalid`);
  }
  return text;
}

function choiceId(threadId, messageId) {
  return `choice-${createHash("sha256")
    .update(`${threadId}\0${messageId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function positiveVersion(value) {
  const version = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw choiceError("choice version is invalid");
  }
  return version;
}

function normalizeAlias(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function jsonClone(value, label, max = 12_000) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw choiceError(`${label} must be JSON-serializable`);
  }
  if (encoded === undefined || encoded.length > max) {
    throw choiceError(`${label} is invalid`);
  }
  return JSON.parse(encoded);
}

function normalizeActionRef(value, allowedActionTypes) {
  const type = requiredText(value?.type, "choice action type", 120);
  if (!allowedActionTypes.has(type)) {
    throw choiceError(`unsupported choice action: ${type}`, "UNSUPPORTED_CHOICE_ACTION");
  }
  if (type === "chat.reply") {
    const text = requiredText(value?.input?.text, "choice reply text", 500);
    if (
      Object.keys(value).some((key) => key !== "type" && key !== "input") ||
      Object.keys(value.input || {}).some((key) => key !== "text")
    ) {
      throw choiceError("chat reply choice action is invalid");
    }
    return { type, input: { text } };
  }

  const actionRef = { type };
  if (value?.entity !== undefined) {
    actionRef.entity = {
      type: requiredText(value.entity?.type, "choice action entity type", 120),
      id: requiredText(value.entity?.id, "choice action entity id", 500),
    };
  }
  if (value?.expectedVersion !== undefined) {
    const expectedVersion = Number(value.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw choiceError("choice action expected version is invalid");
    }
    actionRef.expectedVersion = expectedVersion;
  }
  if (value?.input !== undefined) actionRef.input = jsonClone(value.input, "choice action input");
  return actionRef;
}

function normalizedOptions(options, { actionRefs, allowedActionTypes, trustedActions }) {
  if (!Array.isArray(options) || options.length < 1 || options.length > MAX_OPTIONS) {
    throw choiceError(`choice options must contain 1 to ${MAX_OPTIONS} items`);
  }
  const seenIds = new Set();
  const seenAliases = new Set();
  return options.map((value) => {
    if (!trustedActions && value?.actionRef !== undefined) {
      throw choiceError(
        "choice actions must be attached by server code",
        "UNTRUSTED_CHOICE_ACTION"
      );
    }
    const id = requiredText(value?.id, "choice option id", 120);
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(id) || seenIds.has(id)) {
      throw choiceError("choice option id is invalid or duplicated");
    }
    seenIds.add(id);
    const label = requiredText(value?.label, "choice option label", 120);
    const description =
      value?.description === undefined
        ? undefined
        : requiredText(value.description, "choice option description", 240);
    const rawAliases = value?.aliases === undefined ? [] : value.aliases;
    if (!Array.isArray(rawAliases) || rawAliases.length > MAX_ALIASES) {
      throw choiceError(`choice option aliases must contain at most ${MAX_ALIASES} items`);
    }
    const aliases = [...new Set([label, ...rawAliases].map(normalizeAlias).filter(Boolean))];
    for (const alias of aliases) {
      if (seenAliases.has(alias)) throw choiceError("choice option aliases must be unambiguous");
      seenAliases.add(alias);
    }
    const rawAction = trustedActions ? value.actionRef : actionRefs?.[id];
    if (!rawAction) throw choiceError(`choice option ${id} is missing a server action`);
    const actionRef = normalizeActionRef(rawAction, allowedActionTypes);
    return {
      id,
      label,
      ...(description ? { description } : {}),
      aliases: aliases.filter((alias) => alias !== normalizeAlias(label)),
      actionRef,
    };
  });
}

function selectionLimits(mode, optionCount, minValue, maxValue) {
  if (mode === "binary" && optionCount !== 2) {
    throw choiceError("binary choice prompts require exactly 2 options");
  }
  const defaultMin = 1;
  const defaultMax = mode === "multi" ? optionCount : 1;
  const minSelections = minValue === undefined ? defaultMin : Number(minValue);
  const maxSelections = maxValue === undefined ? defaultMax : Number(maxValue);
  if (
    !Number.isSafeInteger(minSelections) ||
    !Number.isSafeInteger(maxSelections) ||
    minSelections < 1 ||
    maxSelections < minSelections ||
    maxSelections > optionCount ||
    (mode !== "multi" && (minSelections !== 1 || maxSelections !== 1))
  ) {
    throw choiceError("choice selection limits are invalid");
  }
  return { minSelections, maxSelections };
}

function buildChoicePrompt(
  value,
  { actionRefs, allowedActionTypes = DEFAULT_ACTION_TYPES, trustedActions = false } = {}
) {
  const threadId = requiredText(value?.threadId, "choice thread id", 500);
  const messageId = requiredText(value?.messageId, "choice message id", 500);
  const question = requiredText(value?.question, "choice question", 12_000);
  const mode = requiredText(value?.mode, "choice mode", 20);
  if (!CHOICE_MODES.has(mode)) throw choiceError(`unsupported choice mode: ${mode}`);
  const actionTypes =
    allowedActionTypes instanceof Set ? allowedActionTypes : new Set(allowedActionTypes || []);
  const options = normalizedOptions(value.options, {
    actionRefs,
    allowedActionTypes: actionTypes,
    trustedActions,
  });
  const limits = selectionLimits(mode, options.length, value?.minSelections, value?.maxSelections);
  const expectedId = choiceId(threadId, messageId);
  if (value?.id !== undefined && value.id !== expectedId) {
    throw choiceError("choice id does not match its message context");
  }
  const state = value?.state === undefined ? "pending" : String(value.state);
  if (!CHOICE_STATES.has(state)) throw choiceError("choice state is invalid");
  const prompt = {
    id: expectedId,
    version: positiveVersion(value?.version),
    threadId,
    messageId,
    question,
    mode,
    ...limits,
    allowText: value?.allowText === undefined ? true : value.allowText === true,
    options,
    state,
  };
  if (value?.submitLabel !== undefined) {
    prompt.submitLabel = requiredText(value.submitLabel, "choice submit label", 80);
  }
  if (state === "resolved") {
    const selectedOptionIds = Array.isArray(value?.selectedOptionIds)
      ? [...new Set(value.selectedOptionIds.map(String))]
      : [];
    if (
      selectedOptionIds.length < limits.minSelections ||
      selectedOptionIds.length > limits.maxSelections ||
      selectedOptionIds.some((id) => !options.some((option) => option.id === id))
    ) {
      throw choiceError("resolved choice selection is invalid");
    }
    const resolvedAt = new Date(value?.resolvedAt);
    if (!Number.isFinite(resolvedAt.getTime()))
      throw choiceError("choice resolution date is invalid");
    prompt.selectedOptionIds = selectedOptionIds;
    prompt.resolvedAt = resolvedAt.toISOString();
  }
  return prompt;
}

export function createChoicePrompt(value, options = {}) {
  return buildChoicePrompt({ ...value, state: "pending" }, { ...options, trustedActions: false });
}

export function validateChoicePrompt(value, options = {}) {
  return buildChoicePrompt(value, { ...options, trustedActions: true });
}

export function createBinaryChoicePrompt({ threadId, messageId, question } = {}) {
  return createChoicePrompt(
    {
      threadId,
      messageId,
      question,
      mode: "binary",
      minSelections: 1,
      maxSelections: 1,
      allowText: true,
      options: [
        { id: "yes", label: "Yes", aliases: ["yeah", "yep", "sure", "please do"] },
        { id: "no", label: "No", aliases: ["nope", "not now", "please don't"] },
      ],
    },
    {
      actionRefs: {
        yes: { type: "chat.reply", input: { text: "Yes" } },
        no: { type: "chat.reply", input: { text: "No" } },
      },
    }
  );
}

function selectionFromText(prompt, text) {
  if (!prompt.allowText)
    throw choiceError("this choice does not accept typed answers", "BAD_CHOICE_OPTION");
  const normalized = normalizeAlias(text);
  if (!normalized) throw choiceError("choice answer is required", "BAD_CHOICE_OPTION");
  const byAlias = new Map();
  for (const option of prompt.options) {
    for (const alias of [option.label, ...(option.aliases || [])]) {
      byAlias.set(normalizeAlias(alias), option.id);
    }
  }
  const exact = byAlias.get(normalized);
  if (exact) return [exact];
  if (prompt.mode !== "multi") {
    throw choiceError("typed answer does not match a choice option", "BAD_CHOICE_OPTION");
  }
  if (normalized.length > 2_000) {
    throw choiceError("typed answer does not match the available choices", "BAD_CHOICE_OPTION");
  }
  const memo = new Map();
  function resolvePart(value) {
    const part = value.trim();
    if (!part) return null;
    if (memo.has(part)) return memo.get(part);
    const direct = byAlias.get(part);
    if (direct) {
      const match = [direct];
      memo.set(part, match);
      return match;
    }
    memo.set(part, null);
    const separators = /\s*(?:,|;|\/|&|\band\b)\s*/gi;
    let checked = 0;
    while (checked < 32) {
      const separator = separators.exec(part);
      if (!separator) break;
      checked += 1;
      const left = resolvePart(part.slice(0, separator.index));
      if (!left) continue;
      const right = resolvePart(part.slice(separator.index + separator[0].length));
      if (!right) continue;
      const combined = [...new Set([...left, ...right])];
      if (combined.length === left.length + right.length) {
        memo.set(part, combined);
        return combined;
      }
    }
    return null;
  }
  const optionIds = resolvePart(normalized);
  if (!optionIds?.length) {
    throw choiceError("typed answer does not match the available choices", "BAD_CHOICE_OPTION");
  }
  return optionIds;
}

function resolutionDate(now) {
  const date = now instanceof Date ? now : now ? new Date(now) : new Date();
  if (!Number.isFinite(date.getTime())) throw choiceError("choice resolution date is invalid");
  return date.toISOString();
}

export function resolveChoicePrompt(value, reply = {}, { now } = {}) {
  const prompt = validateChoicePrompt(value);
  if (prompt.state === "resolved") {
    throw choiceError("this choice was already answered", "CHOICE_ALREADY_RESOLVED");
  }
  if (prompt.state === "stale") {
    throw choiceError("this choice is no longer current", "STALE_CHOICE_PROMPT");
  }
  if (reply?.promptId !== undefined && String(reply.promptId) !== prompt.id) {
    throw choiceError("choice prompt id is stale", "STALE_CHOICE_PROMPT");
  }
  if (reply?.version !== undefined && Number(reply.version) !== prompt.version) {
    throw choiceError("choice prompt version is stale", "STALE_CHOICE_PROMPT");
  }
  let optionIds;
  if (reply?.optionIds !== undefined) {
    if (!Array.isArray(reply.optionIds)) {
      throw choiceError("choice option ids are invalid", "BAD_CHOICE_OPTION");
    }
    optionIds = [...new Set(reply.optionIds.map((id) => String(id).trim()).filter(Boolean))];
  } else {
    optionIds = selectionFromText(prompt, reply?.text);
  }
  if (
    optionIds.length < prompt.minSelections ||
    optionIds.length > prompt.maxSelections ||
    optionIds.some((id) => !prompt.options.some((option) => option.id === id))
  ) {
    throw choiceError("choice selection is invalid", "BAD_CHOICE_OPTION");
  }
  const selected = optionIds.map((id) => prompt.options.find((option) => option.id === id));
  const resolvedAt = resolutionDate(now);
  const resolution = {
    promptId: prompt.id,
    promptVersion: prompt.version,
    optionIds,
    labels: selected.map((option) => option.label),
    text: selected.map((option) => option.actionRef.input?.text || option.label).join(", "),
    actions: selected.map((option) => option.actionRef),
    resolvedAt,
  };
  return {
    prompt: {
      ...prompt,
      state: "resolved",
      selectedOptionIds: optionIds,
      resolvedAt,
    },
    resolution,
  };
}

export function choiceMetadataForMessage({ metadata, role, threadId, messageId, text } = {}) {
  const source =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  const next = { ...source };
  const answerMode = next.answerMode;
  delete next.answerMode;
  delete next.choiceResolution;
  if (role !== "assistant") {
    delete next.choicePrompt;
    return next;
  }
  if (next.choicePrompt !== undefined) {
    const prompt = validateChoicePrompt(next.choicePrompt);
    if (
      prompt.threadId !== threadId ||
      prompt.messageId !== messageId ||
      prompt.question !== String(text ?? "").trim()
    ) {
      throw choiceError("choice prompt does not match its assistant message");
    }
    next.choicePrompt = prompt;
  } else if (answerMode === "yes-no") {
    next.choicePrompt = createBinaryChoicePrompt({ threadId, messageId, question: text });
  }
  return next;
}

export function resolvePendingMessageChoice(messages, { text, choice, now } = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const explicit = choice && typeof choice === "object" && !Array.isArray(choice) ? choice : null;
  const latestPending = [...rows]
    .reverse()
    .find(
      (message) =>
        message?.role === "assistant" && message?.metadata?.choicePrompt?.state === "pending"
    );
  let target = null;
  if (explicit?.promptId) {
    target =
      rows.find((message) => message?.metadata?.choicePrompt?.id === explicit.promptId) || null;
    if (!target) throw choiceError("choice prompt is no longer available", "STALE_CHOICE_PROMPT");
    if (
      latestPending &&
      latestPending.metadata.choicePrompt.id !== target.metadata.choicePrompt.id
    ) {
      throw choiceError("choice prompt is no longer current", "STALE_CHOICE_PROMPT");
    }
  } else {
    target = latestPending;
  }
  if (!target) return null;
  let resolved;
  try {
    resolved = resolveChoicePrompt(
      target.metadata.choicePrompt,
      explicit ? { ...explicit, text } : { text },
      { now }
    );
  } catch (error) {
    if (!explicit && error?.code === "BAD_CHOICE_OPTION") return null;
    throw error;
  }
  return {
    message: {
      ...target,
      metadata: { ...target.metadata, choicePrompt: resolved.prompt },
    },
    resolution: resolved.resolution,
  };
}
