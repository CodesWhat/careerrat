// Credentials for the search providers that need a free API key. They come from
// the environment only, never from search-sources.yml, so a key can't end up in
// a synced or exported config. A missing key throws a MissingCredentialsError
// that names the variables and the signup page; the scanner shows it as the
// source's error row instead of returning an empty list.

export const KEYED_PROVIDERS = Object.freeze({
  usajobs: Object.freeze({
    label: "USAJobs",
    vars: Object.freeze(["USAJOBS_API_KEY", "USAJOBS_USER_AGENT"]),
    signup: "https://developer.usajobs.gov/apirequest/",
    hint: "USAJOBS_USER_AGENT is the email address you registered the key with.",
  }),
  adzuna: Object.freeze({
    label: "Adzuna",
    vars: Object.freeze(["ADZUNA_APP_ID", "ADZUNA_APP_KEY"]),
    signup: "https://developer.adzuna.com/signup",
    hint: "",
  }),
});

export const KEYED_PROVIDER_IDS = Object.freeze(Object.keys(KEYED_PROVIDERS));

export class MissingCredentialsError extends Error {
  constructor(provider, missing) {
    const spec = KEYED_PROVIDERS[provider];
    super(
      `${provider}: missing ${missing.join(" and ")}. ${spec.label} needs a free API key: ` +
        `sign up at ${spec.signup}, then set ${spec.vars.join(" and ")} in the environment CareerRat runs in.` +
        (spec.hint ? ` ${spec.hint}` : "")
    );
    this.name = "MissingCredentialsError";
    this.code = "MISSING_CREDENTIALS";
    this.provider = provider;
    this.missing = missing;
  }
}

export function isKeyedProvider(provider) {
  return KEYED_PROVIDER_IDS.includes(String(provider || "").toLowerCase());
}

// Whether every variable the provider needs is set to a non-blank value.
export function hasCredentials(provider, env = process.env) {
  const spec = KEYED_PROVIDERS[String(provider || "").toLowerCase()];
  return Boolean(spec) && spec.vars.every((name) => String(env?.[name] ?? "").trim() !== "");
}

export function requireCredentials(provider, env = process.env) {
  const spec = KEYED_PROVIDERS[provider];
  const values = {};
  const missing = [];
  for (const name of spec.vars) {
    const value = String(env?.[name] ?? "").trim();
    if (value) values[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) throw new MissingCredentialsError(provider, missing);
  return values;
}
