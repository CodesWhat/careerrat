const FALLBACK_CURRENCY_CODES = ["AUD", "CAD", "CHF", "EUR", "GBP", "MXN", "PLN", "USD"];
const CURRENCY_CODES = Object.freeze(
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("currency")
    : FALLBACK_CURRENCY_CODES
);
const CURRENCY_CODE_SET = new Set(CURRENCY_CODES);

export function normalizeCurrencyCode(value, fallback = "USD") {
  const code = String(value || fallback)
    .trim()
    .toUpperCase();
  return code || fallback;
}

export function isIsoCurrencyCode(value) {
  return CURRENCY_CODE_SET.has(
    String(value || "")
      .trim()
      .toUpperCase()
  );
}

export function currencyCodePatternSource() {
  return `(?:${CURRENCY_CODES.join("|")})`;
}

function currencyMarker(currency) {
  const code = normalizeCurrencyCode(currency);
  return code === "USD" ? "$" : `${code} `;
}

export function formatCurrencyAmount(value, currency) {
  return `${currencyMarker(currency)}${Number(value).toLocaleString("en-US")}`;
}

export function formatCurrencyThousands(value, currency, { unit = "K" } = {}) {
  return `${currencyMarker(currency)}${Math.round(Number(value))}${unit}`;
}
