const DEFAULT_WEEKS_PER_YEAR = "52";
const POSITIVE_ANNUAL_CASH_ERROR = "Minimum annual cash earnings must be a positive amount.";

function positiveAnnualCashError() {
  return {
    annual: null,
    error: POSITIVE_ANNUAL_CASH_ERROR,
    formula: null,
    source: null,
  };
}

function stringValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseWorksheet(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function emptyAnnualCashWorksheet(savedAnnualFloor = null) {
  return {
    hourlyRate: "",
    hoursPerWeek: "",
    cashPerShift: "",
    shiftsPerWeek: "",
    weeksPerYear: DEFAULT_WEEKS_PER_YEAR,
    annualOverride: stringValue(savedAnnualFloor),
  };
}

export function normalizeAnnualCashWorksheet(value) {
  const parsed = parseWorksheet(value);
  return {
    hourlyRate: stringValue(parsed.hourlyRate),
    hoursPerWeek: stringValue(parsed.hoursPerWeek),
    cashPerShift: stringValue(parsed.cashPerShift),
    shiftsPerWeek: stringValue(parsed.shiftsPerWeek),
    weeksPerYear: stringValue(parsed.weeksPerYear) || DEFAULT_WEEKS_PER_YEAR,
    annualOverride: stringValue(parsed.annualOverride),
  };
}

function optionalAmount(value, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === "") return { value: null, valid: true };
  const number = Number(value);
  return {
    value: number,
    valid: Number.isFinite(number) && number >= 0 && number <= maximum,
  };
}

function supportedCurrency(value) {
  const currency = String(value || "USD")
    .trim()
    .toUpperCase();
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(0);
    return currency;
  } catch {
    return "USD";
  }
}

export function formatAnnualCashAmount(value, { currency = "USD", digits = 0 } = {}) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: supportedCurrency(currency),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function calculateAnnualCashWorksheet(value, { currency = "USD" } = {}) {
  const worksheet = normalizeAnnualCashWorksheet(value);
  const annualOverride = optionalAmount(worksheet.annualOverride, { maximum: 100_000_000 });
  if (!annualOverride.valid || annualOverride.value === 0) {
    return positiveAnnualCashError();
  }
  if (annualOverride.value !== null) {
    const annual = Math.round(annualOverride.value);
    if (annual <= 0) return positiveAnnualCashError();
    return {
      annual,
      error: null,
      formula: `Annual cash floor set to ${formatAnnualCashAmount(annual, { currency })}`,
      source: "override",
    };
  }

  const hourlyRate = optionalAmount(worksheet.hourlyRate, { maximum: 10_000 });
  const hoursPerWeek = optionalAmount(worksheet.hoursPerWeek, { maximum: 168 });
  const cashPerShift = optionalAmount(worksheet.cashPerShift, { maximum: 1_000_000 });
  const shiftsPerWeek = optionalAmount(worksheet.shiftsPerWeek, { maximum: 21 });
  const weeksPerYear = optionalAmount(worksheet.weeksPerYear, { maximum: 52 });
  if (
    !hourlyRate.valid ||
    !hoursPerWeek.valid ||
    !cashPerShift.valid ||
    !shiftsPerWeek.valid ||
    !weeksPerYear.valid ||
    weeksPerYear.value === 0
  ) {
    return {
      annual: null,
      error: "Use non-negative pay amounts and valid weekly or yearly quantities.",
      formula: null,
      source: null,
    };
  }

  const hourlyStarted = hourlyRate.value !== null || hoursPerWeek.value !== null;
  if (hourlyStarted && (hourlyRate.value === null || hoursPerWeek.value === null)) {
    return {
      annual: null,
      error:
        hourlyRate.value === null
          ? "Add an hourly wage to annualize paid hours."
          : "Add paid hours per week to annualize the hourly wage.",
      formula: null,
      source: null,
    };
  }
  const shiftCashStarted = cashPerShift.value !== null || shiftsPerWeek.value !== null;
  if (shiftCashStarted && (cashPerShift.value === null || shiftsPerWeek.value === null)) {
    return {
      annual: null,
      error:
        cashPerShift.value === null
          ? "Add expected cash per shift to annualize shift earnings."
          : "Add shifts per week to annualize expected shift cash.",
      formula: null,
      source: null,
    };
  }
  if (!hourlyStarted && !shiftCashStarted) {
    return { annual: null, error: null, formula: null, source: null };
  }

  const weeklyHourly = hourlyStarted ? hourlyRate.value * hoursPerWeek.value : 0;
  const weeklyShiftCash = shiftCashStarted ? cashPerShift.value * shiftsPerWeek.value : 0;
  const annual = Math.round((weeklyHourly + weeklyShiftCash) * weeksPerYear.value);
  if (annual <= 0) return positiveAnnualCashError();
  const terms = [
    hourlyStarted
      ? `${formatAnnualCashAmount(hourlyRate.value, {
          currency,
          digits: Number.isInteger(hourlyRate.value) ? 0 : 2,
        })}/hr × ${hoursPerWeek.value} hrs/week`
      : null,
    shiftCashStarted
      ? `${formatAnnualCashAmount(cashPerShift.value, { currency })}/shift × ${shiftsPerWeek.value} shifts/week`
      : null,
  ].filter(Boolean);
  return {
    annual,
    error: null,
    formula: `(${terms.join(" + ")}) × ${weeksPerYear.value} weeks`,
    source: "derived",
  };
}
