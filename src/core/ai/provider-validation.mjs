import { readEnv } from "../env-compat.mjs";

const ANTHROPIC_VERSION = "2023-06-01";

export function normalizeAiProvider(provider) {
  const value = String(provider || "anthropic")
    .trim()
    .toLowerCase();
  return value || "anthropic";
}

export function isAnthropicApiKeyShape(value) {
  const key = String(value || "").trim();
  return key.startsWith("sk-ant-") && key.length >= 24 && !/\s/.test(key);
}

function statusToAnthropicError(status) {
  if (status === 401) {
    return {
      code: "authentication_error",
      message: "Anthropic did not accept that API key.",
    };
  }
  if (status === 402) {
    return {
      code: "billing_error",
      message: "Anthropic accepted the key, but billing is not ready for API calls.",
    };
  }
  if (status === 403) {
    return {
      code: "permission_error",
      message: "Anthropic accepted the key, but it does not have permission to use the API.",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limit_error",
      message: "Anthropic is rate limiting validation right now. Try again in a moment.",
    };
  }
  return {
    code: "provider_error",
    message: "Anthropic could not validate the key right now.",
  };
}

export async function validateAnthropicApiKey({
  apiKey,
  baseUrl = "https://api.anthropic.com",
  fetchImpl = fetch,
} = {}) {
  const key = String(apiKey || "").trim();
  if (!isAnthropicApiKeyShape(key)) {
    return {
      ok: false,
      provider: "anthropic",
      status: 400,
      code: "invalid_shape",
      message: "Anthropic keys start with sk-ant- and cannot contain spaces.",
    };
  }

  let res;
  try {
    res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/v1/models?limit=1`, {
      method: "GET",
      headers: {
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": key,
      },
    });
  } catch {
    return {
      ok: false,
      provider: "anthropic",
      status: 502,
      code: "network_error",
      message: "Could not reach Anthropic to validate the key.",
    };
  }

  if (res.ok) {
    return {
      ok: true,
      provider: "anthropic",
      status: res.status,
    };
  }

  const mapped = statusToAnthropicError(res.status);
  return {
    ok: false,
    provider: "anthropic",
    status: res.status,
    ...mapped,
  };
}

export async function validateAiProviderKey({
  provider = "anthropic",
  apiKey,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const normalized = normalizeAiProvider(provider);
  if (normalized !== "anthropic") {
    return {
      ok: false,
      provider: normalized,
      status: 400,
      code: "unsupported_provider",
      message: `Unsupported AI provider: ${normalized}`,
    };
  }

  return validateAnthropicApiKey({
    apiKey,
    baseUrl: String(readEnv("CAREERRAT_ANTHROPIC_BASE_URL", { env }) || "").trim() || undefined,
    fetchImpl,
  });
}
