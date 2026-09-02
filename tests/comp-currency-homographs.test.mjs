// CR10 regression coverage: ordinary words that collide with ISO 4217 currency
// codes must not be read as currency markers, in either of the two
// implementations that parse a currency out of a comp string, while a
// genuine lowercase currency code (a UK posting writing "gbp 80,000") must
// still be read as one. The discriminator is case PLUS whether the token is
// one of the small, closed set of ISO codes that collide with common English
// words (see CURRENCY_CODE_ENGLISH_HOMOGRAPHS in sourced-scanner.mjs), not
// case alone.
import assert from "node:assert/strict";
import test from "node:test";

import { isIsoCurrencyCode } from "../src/core/currency-format.mjs";
import {
  extractCompBand,
  hasConflictingCompensationCurrency,
} from "../src/core/scoring/sourced-scanner.mjs";
import {
  buildDashboardViewModel,
  compensationCurrency,
} from "../src/core/tracker/dashboard-data.js";

// Sanity check on the trap itself: these are real ISO codes for lesser-known
// currencies that also happen to be ordinary English words, which is exactly
// why a bare three-letter-word scan misreads them. If this ever stops being
// true (an Intl data update drops one of them), the scanner assertions below
// would pass for the wrong reason, so pin it here.
test("ISO currency set contains the reported homograph codes", () => {
  for (const code of [
    "TOP",
    "TRY",
    "ALL",
    "PEN",
    "COP",
    "BOB",
    "CUP",
    "GEL",
    "SOS",
    "LAK",
    "YER",
    "RON",
    "BAM",
    "MAD",
    "MOP",
    "RUB",
  ]) {
    assert.equal(isIsoCurrencyCode(code), true, `${code} should be a real ISO code`);
  }
  // The dashboard's false positives are not ISO codes at all. Its bug is
  // never validating against the ISO set in the first place.
  for (const code of ["DOE", "OTE", "RSU", "TBD"]) {
    assert.equal(isIsoCurrencyCode(code), false, `${code} should not be a real ISO code`);
  }
});

// --- Scanner path (src/core/scoring/sourced-scanner.mjs) -------------------

test("scanner: a lowercase sentence word matching an ISO code is not a currency conflict", () => {
  // "try" (Turkish Lira) sits immediately before the amount, in genuine
  // currency position, and is a real ISO code, the same shape a real code
  // has. Only its case distinguishes it: written currency codes are
  // conventionally all caps, ordinary sentence words are not.
  assert.equal(hasConflictingCompensationCurrency("you could try $70,000 as your ask"), false);
  assert.equal(
    hasConflictingCompensationCurrency("Salary: you could try $70,000 as your ask"),
    false
  );
  assert.deepEqual(extractCompBand("Salary: you could try $70,000 as your ask"), {
    min: 70000,
    max: 70000,
    currency: "USD",
  });
});

test("scanner: a title-case sentence-initial word matching an ISO code is not a currency conflict", () => {
  // "Top" (Tongan Paʻanga) only differs from a real code by case (a genuine
  // code is written in full caps regardless of sentence position).
  assert.equal(
    hasConflictingCompensationCurrency("Base pay Top: $70,000 for experienced staff."),
    false
  );
  assert.deepEqual(extractCompBand("Base pay Top: $70,000 for experienced staff."), {
    min: 70000,
    max: 70000,
    currency: "USD",
  });
});

test("scanner: a real currency code still resolves in prefix or suffix position", () => {
  assert.deepEqual(extractCompBand("Base salary EUR 70,000"), {
    min: 70000,
    max: 70000,
    currency: "EUR",
  });
  assert.deepEqual(extractCompBand("Base salary 70,000 EUR"), {
    min: 70000,
    max: 70000,
    currency: "EUR",
  });
  assert.deepEqual(extractCompBand("Base salary CAD 85,000"), {
    min: 85000,
    max: 85000,
    currency: "CAD",
  });
  assert.deepEqual(extractCompBand("Base salary $70,000 USD"), {
    min: 70000,
    max: 70000,
    currency: "USD",
  });
});

test("scanner: a genuinely mixed currency is still flagged as conflicting", () => {
  assert.equal(hasConflictingCompensationCurrency("Base salary $70,000 EUR"), true);
  assert.equal(extractCompBand("Base salary $70,000 EUR"), null);
  assert.equal(hasConflictingCompensationCurrency("Base salary $70,000 - $90,000 EUR"), true);
});

test("scanner: a lowercase currency code that is not an English-word collision still resolves", () => {
  // "gbp"/"cad" are not in the closed collision list, so lowercase writing
  // (a UK or Canadian posting that didn't bother with caps) still counts.
  assert.deepEqual(extractCompBand("gbp 80,000 - gbp 90,000"), {
    min: 80000,
    max: 90000,
    currency: "GBP",
  });
  assert.deepEqual(extractCompBand("GBP 80,000 - GBP 90,000"), {
    min: 80000,
    max: 90000,
    currency: "GBP",
  });
  assert.deepEqual(extractCompBand("Base salary cad 85,000"), {
    min: 85000,
    max: 85000,
    currency: "CAD",
  });
});

test("scanner: an English-word collision only reads as a currency code in full caps", () => {
  assert.equal(hasConflictingCompensationCurrency("Top pay $70,000 for experienced staff."), false);
  assert.equal(hasConflictingCompensationCurrency("you could try $70,000 as your ask"), false);
  // TRY uppercase is still a real code. The collision list only suppresses
  // the lowercase/title-case reading, never the uppercase one.
  assert.deepEqual(extractCompBand("Base salary TRY 70,000"), {
    min: 70000,
    max: 70000,
    currency: "TRY",
  });
});

test("scanner: a lowercase 'mad' next to an amount is not read as the Moroccan dirham", () => {
  assert.equal(
    hasConflictingCompensationCurrency("Salary: you'd be mad to turn down $70,000 here"),
    false
  );
  assert.deepEqual(extractCompBand("Salary: you'd be mad to turn down $70,000 here"), {
    min: 70000,
    max: 70000,
    currency: "USD",
  });
  // Full caps MAD is still the real code.
  assert.deepEqual(extractCompBand("Base salary MAD 70,000"), {
    min: 70000,
    max: 70000,
    currency: "MAD",
  });
});

// --- Dashboard path (src/core/tracker/dashboard-data.js) -------------------

function dashboardCurrencyFor(base) {
  const vm = buildDashboardViewModel(
    {
      applications: [],
      sourced: [{ id: "role", company: "Co", role: "R", status: "sourced", base }],
      sources: [],
      communications: [],
    },
    { now: new Date("2026-06-15T13:30:00.000Z") }
  );
  return vm.jobs.rows.find(({ id }) => id === "role")?.drawer;
}

test("dashboard: DOE, OTE, RSU, and TBD suffixes no longer shadow the dollar sign", () => {
  assert.equal(dashboardCurrencyFor("$120K-$150K DOE")?.currency, "USD");
  assert.equal(dashboardCurrencyFor("$130,000 OTE")?.currency, "USD");
  assert.equal(dashboardCurrencyFor("$120K base + RSU")?.currency, "USD");
  assert.equal(dashboardCurrencyFor("Comp TBD, $90K-$110K")?.currency, "USD");
});

test("dashboard: figures survive alongside the corrected currency", () => {
  const doe = dashboardCurrencyFor("$120K-$150K DOE");
  assert.equal(doe?.marketLo, 120);
  assert.equal(doe?.marketHi, 150);

  const tbd = dashboardCurrencyFor("Comp TBD, $90K-$110K");
  assert.equal(tbd?.marketLo, 90);
  assert.equal(tbd?.marketHi, 110);
});

test("dashboard: a bare dollar figure and a real symbol still resolve correctly", () => {
  assert.equal(dashboardCurrencyFor("$120,000")?.currency, "USD");
  assert.equal(dashboardCurrencyFor("£80,000")?.currency, "GBP");
});

test("dashboard: a real currency code still resolves in prefix or suffix position", () => {
  assert.equal(dashboardCurrencyFor("EUR 70,000")?.currency, "EUR");
  assert.equal(dashboardCurrencyFor("70,000 EUR")?.currency, "EUR");
  assert.equal(dashboardCurrencyFor("CAD 85,000")?.currency, "CAD");
  assert.equal(dashboardCurrencyFor("$70,000 USD")?.currency, "USD");
});

// CR11 follow-up: a valid ISO code must win over the $ fallback (a real code
// beats an unlabeled symbol), but a homograph code must never win over a real
// symbol that IS present in the same text, or "$120K ALL IN" would read as
// Albanian lek instead of the dollar sign sitting right there.
test("dashboard: a valid code resolves ahead of the dollar sign, but a homograph never outranks a real symbol", () => {
  const cases = [
    ["$70,000 CAD", "CAD"],
    ["$70,000 USD", "USD"],
    ["$120K ALL IN", "USD"],
    ["$120K-$150K DOE", "USD"],
    ["$130,000 OTE", "USD"],
    ["$120K base + RSU", "USD"],
    ["Comp TBD, $90K-$110K", "USD"],
    ["£80,000", "GBP"],
    ["EUR 70,000", "EUR"],
    ["No comp listed", null],
  ];
  for (const [base, expected] of cases) {
    assert.equal(compensationCurrency(base), expected, base);
  }
});

test("dashboard: the ALL IN homograph resolves correctly through the full drawer pipeline too", () => {
  assert.equal(dashboardCurrencyFor("$120K ALL IN")?.currency, "USD");
});
