import assert from "node:assert/strict";
import test, { mock } from "node:test";

import * as sourcedScanner from "../src/core/scoring/sourced-scanner.mjs";
import {
  buildLocationFilter,
  buildTitleFilter,
  extractCompBand,
  extractReqId,
  fetchProvider,
  filterAndDedupeOffers,
  fitFromScore,
  htmlToText,
  inferProvider,
  normalizeCompanyRoleKey,
  scoreSourcedOffer,
} from "../src/core/scoring/sourced-scanner.mjs";

// ---------------------------------------------------------------------------
// Demo persona fixture — mirrors Jane in candidate/example/
// ---------------------------------------------------------------------------
const JANE_TECH_CONFIG = {
  targeting: {
    role_buckets: [
      { name: "Primary", titles: ["Forward Deployed Engineer", "Applied AI Engineer"] },
      { name: "Secondary", titles: ["Solutions Engineer", "Solutions Architect"] },
    ],
    keep_signals: ["forward deployed", "applied ai", "solutions engineer"],
    cut_signals: ["devrel", "developer advocate", "core platform swe", "ml research"],
    excluded_companies: ["palantir", "tesla", "spacex", "xai", "neuralink"],
  },
  profile: {
    compensation: { minimum_base: 200000 },
    location: { home: "new york", relocation: [] },
  },
};

test("compensation parsing separates base pay from annual cash earnings", () => {
  const bands = sourcedScanner.extractCompensationBands(
    "Base pay: $11.35 per hour. Estimated annual earnings including tips: $95,000 - $120,000."
  );

  assert.deepEqual(bands.base, { min: 23_608, max: 23_608, currency: "USD" });
  assert.deepEqual(bands.annualEarnings, { min: 95_000, max: 120_000, currency: "USD" });
});

test("CR5: parsed compensation bands normalize and retain explicit currencies", () => {
  const cases = [
    ["Base salary: $90k-$110k.", { min: 90_000, max: 110_000, currency: "USD" }],
    ["Base salary: £90k-£110k.", { min: 90_000, max: 110_000, currency: "GBP" }],
    ["Base salary: €90k-€110k.", { min: 90_000, max: 110_000, currency: "EUR" }],
    ["Base salary: CAD 90k-110k.", { min: 90_000, max: 110_000, currency: "CAD" }],
    ["Base salary: CAD $90k-$110k.", { min: 90_000, max: 110_000, currency: "CAD" }],
    ["Base salary: $90k-$110k MXN.", { min: 90_000, max: 110_000, currency: "MXN" }],
    ["Base salary: 90k-110k MXN.", { min: 90_000, max: 110_000, currency: "MXN" }],
    ["Base salary: 90k GBP.", { min: 90_000, max: 90_000, currency: "GBP" }],
    ["Base salary: 90k-110k EUR.", { min: 90_000, max: 110_000, currency: "EUR" }],
    ["Pay: 9 EUR per hour.", { min: 18_720, max: 18_720, currency: "EUR" }],
    ["Base salary: 90k-110k CAD annually.", { min: 90_000, max: 110_000, currency: "CAD" }],
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text).base, expected, text);
  }

  assert.deepEqual(sourcedScanner.extractCompensationBands("Base salary: 90k-110k.").base, {
    min: 90_000,
    max: 110_000,
  });
  assert.equal(
    sourcedScanner.extractCompensationBands("Base salary: GBP $90k-$110k per year.").base,
    null
  );
});

test("CR5: base and annual-earnings bands independently preserve currency", () => {
  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Base pay: GBP 11 per hour. Estimated annual earnings: 95,000-120,000 GBP."
    ),
    {
      base: { min: 22_880, max: 22_880, currency: "GBP" },
      annualEarnings: { min: 95_000, max: 120_000, currency: "GBP" },
    }
  );
});

test("CR5: single-digit hourly wages parse and annualize", () => {
  assert.deepEqual(sourcedScanner.extractCompensationBands("Pay: $7 per hour."), {
    base: { min: 14_560, max: 14_560, currency: "USD" },
    annualEarnings: null,
  });
  assert.deepEqual(sourcedScanner.extractCompensationBands("Pay: EUR 9/hour."), {
    base: { min: 18_720, max: 18_720, currency: "EUR" },
    annualEarnings: null,
  });
});

test("CR5: hourly annualization uses regular hours when overtime hours share the clause", () => {
  for (const schedule of [
    "30 regular hours and 10 overtime hours per week",
    "10 overtime hours and 30 regular hours per week",
    "regular schedule is 30 hours per week plus 10 overtime hours",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(`Pay: $20 per hour; schedule is ${schedule}.`),
      {
        base: { min: 31_200, max: 31_200, currency: "USD" },
        annualEarnings: null,
      },
      schedule
    );
  }
});

test("CR5 closeout: guaranteed hourly pay outranks tips, variable pay, and overtime in every order", () => {
  const competingPay = [
    ["tips", "$35 per hour", "Regular pay"],
    ["tips", "$30-$35 per hour", "Regular pay"],
    ["variable pay", "$35 per hour", "Regular pay"],
    ["variable pay", "$30-$35 per hour", "Regular pay"],
    ["overtime pay", "$35 per hour", "Regular rate"],
    ["overtime pay", "$30-$35 per hour", "Regular rate"],
  ];

  for (const [basis, amount, guaranteedLabel] of competingPay) {
    for (const text of [
      `${guaranteedLabel}: $20 per hour. ${basis}: ${amount}.`,
      `${basis}: ${amount}. ${guaranteedLabel}: $20 per hour.`,
    ]) {
      assert.deepEqual(
        sourcedScanner.extractCompensationBands(text),
        {
          base: { min: 41_600, max: 41_600, currency: "USD" },
          annualEarnings: null,
        },
        text
      );
    }
  }
});

test("CR5: bare overtime hourly pay never outranks guaranteed regular pay", () => {
  for (const [label, overtimeAmount] of [
    ["Overtime", "$35 per hour"],
    ["Overtime", "$30-$35 per hour"],
    ["OT pay", "$35 per hour"],
    ["OT pay", "$30-$35 per hour"],
  ]) {
    for (const text of [
      `Regular pay: $20 per hour. ${label}: ${overtimeAmount}.`,
      `${label}: ${overtimeAmount}. Regular pay: $20 per hour.`,
    ]) {
      assert.deepEqual(
        sourcedScanner.extractCompensationBands(text),
        {
          base: { min: 41_600, max: 41_600, currency: "USD" },
          annualEarnings: null,
        },
        text
      );
    }
  }
});

test("CR5: an annual-earnings label survives an intervening hourly amount", () => {
  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Estimated annual earnings including tips: base pay is $11.35 per hour and typical earnings are $95,000-$120,000 per year."
    ),
    {
      base: { min: 23_608, max: 23_608, currency: "USD" },
      annualEarnings: { min: 95_000, max: 120_000, currency: "USD" },
    }
  );
});

test("CR5 closeout: annual-earnings recovery never captures a later explicit base salary", () => {
  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Estimated annual earnings including tips: base pay is $11.35 per hour. Base salary: $60,000-$75,000 per year."
    ),
    {
      base: { min: 60_000, max: 75_000, currency: "USD" },
      annualEarnings: null,
    }
  );

  for (const annualCash of [
    "$95,000-$120,000 per year.",
    "Typical annual cash earnings are $95,000-$120,000 per year.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(
        `Estimated annual earnings including tips: base pay is $11.35 per hour. ${annualCash}`
      ),
      {
        base: { min: 23_608, max: 23_608, currency: "USD" },
        annualEarnings: { min: 95_000, max: 120_000, currency: "USD" },
      },
      annualCash
    );
  }
});

test("annual cash earnings parsing skips only the local hourly amount on a shared line", () => {
  for (const text of [
    "Base pay: $11.35 per hour; estimated annual earnings including tips: $95,000-$120,000.",
    "Estimated annual earnings including tips: $95,000-$120,000; base pay: $11.35 per hour.",
  ]) {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
      base: { min: 23_608, max: 23_608, currency: "USD" },
      annualEarnings: { min: 95_000, max: 120_000, currency: "USD" },
    });
  }
});

test("annual cash earnings parsing ignores adjacent non-cash benefits", () => {
  const bands = sourcedScanner.extractCompensationBands(
    "Estimated annual earnings including tips: $95,000 - $120,000, plus benefits."
  );

  assert.equal(bands.base, null);
  assert.deepEqual(bands.annualEarnings, { min: 95_000, max: 120_000, currency: "USD" });
});

test("hourly base annualization honors the posting's explicit weekly hours", () => {
  const bands = sourcedScanner.extractCompensationBands(
    "Base pay: $40 per hour, 30 hours per week."
  );

  assert.deepEqual(bands.base, { min: 62_400, max: 62_400, currency: "USD" });
  assert.deepEqual(
    sourcedScanner.extractCompensationBands("Base pay: $40 per hour, full-time.").base,
    { min: 83_200, max: 83_200, currency: "USD" }
  );
  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Benefits include medical coverage. Pay: $20/hour, schedule: 30 hours per week."
    ).base,
    { min: 31_200, max: 31_200, currency: "USD" }
  );
});

test("unlabeled hourly pay annualizes as base compensation", () => {
  assert.deepEqual(sourcedScanner.extractCompensationBands("Pay: $18-$22/hour."), {
    base: { min: 37_440, max: 45_760, currency: "USD" },
    annualEarnings: null,
  });
  assert.deepEqual(sourcedScanner.extractCompensationBands("Pay: $20 per hour."), {
    base: { min: 41_600, max: 41_600, currency: "USD" },
    annualEarnings: null,
  });
});

test("unlabeled hourly pay uses weekly hours stated before the wage", () => {
  for (const text of [
    "30 hours per week. Pay: $20 per hour",
    "30 hours per week; Pay: $20 per hour",
  ]) {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
      base: { min: 31_200, max: 31_200, currency: "USD" },
      annualEarnings: null,
    });
  }
});

test("unlabeled hourly pay uses weekly hours stated after the wage", () => {
  assert.deepEqual(
    sourcedScanner.extractCompensationBands("Pay: $20 per hour. Schedule: 30 hours per week."),
    {
      base: { min: 31_200, max: 31_200, currency: "USD" },
      annualEarnings: null,
    }
  );
  assert.deepEqual(
    sourcedScanner.extractCompensationBands("Pay: $18-$22/hour\nSchedule: 30 hours per week"),
    {
      base: { min: 28_080, max: 34_320, currency: "USD" },
      annualEarnings: null,
    }
  );
});

test("hourly annualization ignores adjacent non-schedule weekly-hour qualifiers", () => {
  for (const text of [
    "Overtime: 10 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Volunteer commitment: 10 hours per week.",
    "Benefits eligibility begins at 30 hours per week; Pay: $20/hour.",
    "Pay: $20/hour; benefits begin at 30 hours per week.",
  ]) {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
      base: { min: 41_600, max: 41_600, currency: "USD" },
      annualEarnings: null,
    });
  }
});

test("CR5 closeout: business operating hours are not employee weekly schedules", () => {
  for (const text of [
    "Store operating hours: 30 hours per week. Pay: $20 per hour.",
    "Pay: $20 per hour. The business is open 30 hours per week.",
    "Restaurant hours of operation total 30 hours per week; pay is $20 per hour.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 41_600, max: 41_600, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }

  for (const text of [
    "Employee schedule: 30 hours per week. Pay: $20 per hour.",
    "Pay: $20 per hour. Employees are regularly scheduled for 30 hours per week.",
    "Pay: $20 per hour. The store manager works 30 hours per week.",
    "Pay: $20 per hour. The office employee schedule is 30 hours per week.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 31_200, max: 31_200, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }
});

test("CR5: semantic business operating-hour grammar keeps hourly pay on the default workweek", () => {
  for (const text of [
    "Store operates 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store operates 80 hours per week.",
    "Store operates for 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store operates for 80 hours per week.",
    "Store operates a total of 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store operates a total of 80 hours per week.",
    "Store is operating 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store is operating 80 hours per week.",
    "Store currently operates 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store currently operates 80 hours per week.",
    "Store operates for a total of 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store is currently operating 80 hours per week.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 41_600, max: 41_600, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }
});

test("CR5: business-entity weekly hours are not employee schedules", () => {
  for (const text of [
    "Restaurant stays open 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Restaurant stays open 80 hours per week.",
    "Store runs 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store runs 80 hours per week.",
    "Facility open 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Facility open 80 hours per week.",
    "Restaurant stays open daily, for 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Facility open year-round, 80 hours per week.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 41_600, max: 41_600, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }
});

test("CR5 ownership: employee context must own the matched hours", () => {
  for (const clause of [
    "Restaurant is open 80 hours/week to give employees flexible shifts",
    "Restaurant operates 80 hours/week for staff coverage",
  ]) {
    for (const text of [`${clause}. Pay: $20/hour.`, `Pay: $20/hour. ${clause}.`]) {
      assert.deepEqual(
        sourcedScanner.extractCompensationBands(text),
        {
          base: { min: 41_600, max: 41_600, currency: "USD" },
          annualEarnings: null,
        },
        text
      );
    }
  }

  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Pay: $20/hour. Employees at the restaurant work 30 hours per week."
    ),
    {
      base: { min: 31_200, max: 31_200, currency: "USD" },
      annualEarnings: null,
    }
  );

  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Pay: $20/hour. Employees work flexible shifts and the restaurant operates 80 hours/week."
    ),
    {
      base: { min: 41_600, max: 41_600, currency: "USD" },
      annualEarnings: null,
    }
  );
});

test("CR5 ownership: a business regular schedule stays on the default workweek", () => {
  for (const text of [
    "Store's regular schedule is 80 hours/week. Pay: $20/hour.",
    "Pay: $20/hour. Store's regular schedule is 80 hours/week.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 41_600, max: 41_600, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }
});

test("CR5 next-sentence: explicit regular hours win over overtime hours", () => {
  const text =
    "Pay: $20/hour. The position includes 10 overtime hours and 30 regular hours per week.";

  assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
    base: { min: 31_200, max: 31_200, currency: "USD" },
    annualEarnings: null,
  });
});

test("CR5 large-input: compensation parsing does not restart full-body regex scans per amount", () => {
  const text = `Hourly pay: $9 per hour, volunteer ${"40 hours per week ".repeat(3_500)}`;
  const originalExec = RegExp.prototype.exec;
  let fullBodyRestarts = 0;
  RegExp.prototype.exec = function countedExec(input) {
    if (String(input).length > text.length / 2 && this.lastIndex === 0) fullBodyRestarts += 1;
    return Reflect.apply(originalExec, this, [input]);
  };

  let bands;
  try {
    bands = sourcedScanner.extractCompensationBands(text);
  } finally {
    RegExp.prototype.exec = originalExec;
  }

  assert.deepEqual(bands, {
    base: { min: 18_720, max: 18_720, currency: "USD" },
    annualEarnings: null,
  });
  assert.ok(
    fullBodyRestarts <= 40,
    `expected bounded full-body regex restarts, received ${fullBodyRestarts}`
  );
});

test("CR5 large-input: range membership checks stay linear in posting length", () => {
  const text = `Salary: ${"$1000-$1001 ".repeat(8_000)}`;
  const originalSome = Array.prototype.some;
  let rangeMembershipProbes = 0;
  Array.prototype.some = function countedSome(callback, ...args) {
    if (this.length > 1_000 && Array.isArray(this[0]) && this[0].length === 2) {
      return Reflect.apply(originalSome, this, [
        (value, index, array) => {
          rangeMembershipProbes += 1;
          return callback(value, index, array);
        },
        ...args,
      ]);
    }
    return Reflect.apply(originalSome, this, [callback, ...args]);
  };

  try {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
      base: { min: 1_000, max: 1_001, currency: "USD" },
      annualEarnings: null,
    });
  } finally {
    Array.prototype.some = originalSome;
  }

  assert.ok(
    rangeMembershipProbes <= 32_000,
    `expected linear range membership, received ${rangeMembershipProbes} probes`
  );
});

test("CR5 whole-clause: business hours use the default workweek", () => {
  const businessHoursClauses = [
    "Open 80 hours/week at this restaurant",
    "We are open 80 hours/week",
    "Hours of operation: 80 hours/week",
    "Restaurant operating schedule: 80 hours/week",
    "Store work hours: 80 hours/week",
    "80 hours/week are the restaurant opening hours",
  ];

  for (const clause of businessHoursClauses) {
    for (const text of [`${clause}. Pay: $20/hour.`, `Pay: $20/hour. ${clause}.`]) {
      assert.deepEqual(
        sourcedScanner.extractCompensationBands(text),
        {
          base: { min: 41_600, max: 41_600, currency: "USD" },
          annualEarnings: null,
        },
        text
      );
    }
  }
});

test("CR5 whole-clause: employee hours remain schedules and win mixed clauses", () => {
  for (const text of [
    "This role requires 30 hours/week. Pay: $20/hour.",
    "Pay: $20/hour. Expected commitment is 30 hours/week.",
    "We are open 80 hours/week. This role requires 30 hours/week. Pay: $20/hour.",
    "Pay: $20/hour. Expected commitment is 30 hours/week. We are open 80 hours/week.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 31_200, max: 31_200, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }
});

test("CR5: employee weekly-hours context wins without relying on an employee noun", () => {
  for (const text of [
    "Schedule: 30 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Regularly scheduled 30 hours per week.",
    "Restaurant stays open 80 hours per week, while employees work 30 hours per week. Pay: $20/hour.",
    "Employees work 30 hours per week, while the store runs 80 hours per week. Pay: $20/hour.",
    "Facility open 80 hours per week, with a regular schedule of 30 hours per week. Pay: $20/hour.",
    "Regular schedule: 30 hours per week, while the facility is open 80 hours per week. Pay: $20/hour.",
    "Restaurant stays open daily, for 80 hours per week, while employees work 30 hours per week. Pay: $20/hour.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 31_200, max: 31_200, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }
});

test("CR5: local clause boundaries keep business hours out of employee schedules", () => {
  for (const text of [
    ...["but", "while", "whereas"].map(
      (conjunction) =>
        `Restaurant open 80 hours/week ${conjunction} employees work 30 hours/week. Pay: $20/hour.`
    ),
    "Restaurant open 80 hours/week and employees work 30 hours/week. Pay: $20/hour.",
    "Restaurant open 80 hours/week, employees work 30 hours/week. Pay: $20/hour.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 31_200, max: 31_200, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }
});

test("CR5: active business hours do not hide an employee schedule in the same clause", () => {
  for (const text of [
    "Store operates 80 hours per week, while employees work 30 hours per week. Pay: $20/hour.",
    "Employees work 30 hours per week, while the store operates 80 hours per week. Pay: $20/hour.",
    "Store operates a total of 80 hours per week, while the employee schedule is 30 hours per week. Pay: $20/hour.",
    "This employee works 30 hours per week, while the store is operating 80 hours per week. Pay: $20/hour.",
    "Store operates for a total of 80 hours per week, while employees work 30 hours per week. Pay: $20/hour.",
  ]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(text),
      {
        base: { min: 31_200, max: 31_200, currency: "USD" },
        annualEarnings: null,
      },
      text
    );
  }
});

test("unlabeled hourly pay stays base when a later amount is variable cash", () => {
  assert.deepEqual(
    sourcedScanner.extractCompensationBands("Pay: $20 per hour plus a $200 signing bonus"),
    {
      base: { min: 41_600, max: 41_600, currency: "USD" },
      annualEarnings: null,
    }
  );
  assert.deepEqual(
    sourcedScanner.extractCompensationBands("Pay: $18-$22/hour plus a $200 signing bonus"),
    {
      base: { min: 37_440, max: 45_760, currency: "USD" },
      annualEarnings: null,
    }
  );
  assert.deepEqual(
    sourcedScanner.extractCompensationBands("Pay: $20 per hour plus a signing bonus of $200"),
    {
      base: { min: 41_600, max: 41_600, currency: "USD" },
      annualEarnings: null,
    }
  );
  assert.deepEqual(
    sourcedScanner.extractCompensationBands("Pay: $18-$22/hour plus a signing bonus of $200"),
    {
      base: { min: 37_440, max: 45_760, currency: "USD" },
      annualEarnings: null,
    }
  );
  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Pay: $20 per hour plus an annual bonus of $50,000-$75,000"
    ),
    {
      base: { min: 41_600, max: 41_600, currency: "USD" },
      annualEarnings: null,
    }
  );
  assert.deepEqual(sourcedScanner.extractCompensationBands("Signing bonus: $200 per hour"), {
    base: null,
    annualEarnings: null,
  });
});

test("unlabeled hourly pay survives adjacent unquantified variable-pay language", () => {
  const cases = [
    ["Pay: $20 per hour plus bonus", { min: 41_600, max: 41_600, currency: "USD" }],
    ["Bonus eligible; pay: $20 per hour", { min: 41_600, max: 41_600, currency: "USD" }],
    ["Pay: $18-$22/hour plus bonus", { min: 37_440, max: 45_760, currency: "USD" }],
    ["Bonus eligible; pay: $18-$22/hour", { min: 37_440, max: 45_760, currency: "USD" }],
    ["Wage: $20/hour plus commission", { min: 41_600, max: 41_600, currency: "USD" }],
    ["Commission eligible; wage: $18-$22/hour", { min: 37_440, max: 45_760, currency: "USD" }],
    ["Pay: $20/hour including tips", { min: 41_600, max: 41_600, currency: "USD" }],
    ["Pay: $18-$22/hour including tips", { min: 37_440, max: 45_760, currency: "USD" }],
  ];

  for (const [text, base] of cases) {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
      base,
      annualEarnings: null,
    });
  }
});

test("explicit annual base outranks an adjacent generic hourly rate", () => {
  for (const text of [
    "Base salary: $80,000; hourly rate: $20/hour",
    "Hourly rate: $20/hour; base salary: $80,000",
  ]) {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
      base: { min: 80_000, max: 80_000, currency: "USD" },
      annualEarnings: null,
    });
  }
});

test("an-hour pay units annualize single amounts and ranges", () => {
  assert.deepEqual(sourcedScanner.extractCompensationBands("Pay: $20 an hour"), {
    base: { min: 41_600, max: 41_600, currency: "USD" },
    annualEarnings: null,
  });
  assert.deepEqual(sourcedScanner.extractCompensationBands("Pay: $18-$22 an hour"), {
    base: { min: 37_440, max: 45_760, currency: "USD" },
    annualEarnings: null,
  });
});

test("unlabeled non-dollar hourly pay annualizes single amounts and ranges", () => {
  const cases = [
    ["Pay: £20 per hour", { min: 41_600, max: 41_600, currency: "GBP" }],
    ["Pay: €18-€22/hour", { min: 37_440, max: 45_760, currency: "EUR" }],
    ["Pay: GBP 20 per hour", { min: 41_600, max: 41_600, currency: "GBP" }],
    ["Pay: EUR 18-EUR 22/hour", { min: 37_440, max: 45_760, currency: "EUR" }],
  ];

  for (const [text, base] of cases) {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
      base,
      annualEarnings: null,
    });
  }
});

test("CR5 closeout: adjacent ISO currencies are retained and conflicting markers stay unknown", () => {
  for (const currency of ["CHF", "AUD", "PLN"]) {
    assert.deepEqual(
      sourcedScanner.extractCompensationBands(`Base salary: 90k-110k ${currency}.`).base,
      { min: 90_000, max: 110_000, currency },
      currency
    );
  }

  for (const text of ["Base salary: USD 90k-110k CHF.", "Base salary: AUD 90k-PLN 110k."]) {
    assert.equal(sourcedScanner.extractCompensationBands(text).base, null, text);
  }

  assert.deepEqual(sourcedScanner.extractCompensationBands("Base salary: 90k-110k.").base, {
    min: 90_000,
    max: 110_000,
  });
  assert.deepEqual(sourcedScanner.extractCompensationBands("Base salary: PAY 90k-110k.").base, {
    min: 90_000,
    max: 110_000,
  });
});

test("hourly throughput does not become base compensation", () => {
  for (const text of [
    "Compensation analysts process 20 calls per hour.",
    "Compensation: 20 guests per hour.",
    "Compensation: $20 guests per hour.",
    "Total compensation: $20 per hour plus bonus.",
    "Variable pay: $20 per hour.",
    "Incentive pay: $20 per hour.",
    "Bonus pay: $20 per hour.",
  ]) {
    assert.deepEqual(sourcedScanner.extractCompensationBands(text), {
      base: null,
      annualEarnings: null,
    });
  }
});

test("unquantified tips never turn hourly base pay into annual cash earnings", () => {
  const bands = sourcedScanner.extractCompensationBands(
    "Base pay: $11.35 per hour including tips."
  );

  assert.deepEqual(bands.base, { min: 23_608, max: 23_608, currency: "USD" });
  assert.equal(bands.annualEarnings, null);
});

test("compensation parsing rejects calendar years and unitless shorthand", () => {
  assert.equal(extractCompBand("Salary review cycle: 2025-2026."), null);
  assert.equal(extractCompBand("Salary range: 90-110."), null);
  assert.deepEqual(extractCompBand("Salary range: 90k-110k."), {
    min: 90_000,
    max: 110_000,
  });
});

test("unlabeled compensation stays unclassified instead of becoming guaranteed base", () => {
  assert.deepEqual(sourcedScanner.extractCompensationBands("$95k-$120k"), {
    base: null,
    annualEarnings: null,
  });
  assert.deepEqual(sourcedScanner.extractCompensationBands("Base salary: $95k-$120k per year"), {
    base: { min: 95_000, max: 120_000, currency: "USD" },
    annualEarnings: null,
  });
  assert.deepEqual(sourcedScanner.resolveCompensationEvidence({ comp: "$95k-$120k" }), {
    baseComp: "",
    annualEarningsComp: "",
    unclassifiedComp: "$95k-$120k",
  });
});

test("explicit base compensation labels classify a guaranteed-base band", () => {
  const expected = {
    base: { min: 95_000, max: 120_000, currency: "USD" },
    annualEarnings: null,
  };

  assert.deepEqual(
    [
      "Base compensation: $95k-$120k",
      "Base comp: $95k-$120k",
      "Base: $95k-$120k",
      "$95k-$120k base",
    ].map((text) => sourcedScanner.extractCompensationBands(text)),
    [expected, expected, expected, expected]
  );
});

test("trailing bare base labels remain explicit before compensation prose", () => {
  const expected = {
    base: { min: 95_000, max: 120_000, currency: "USD" },
    annualEarnings: null,
  };

  assert.deepEqual(
    ["$95k-$120k base, depending on experience", "$95k-$120k base, plus bonus and equity"].map(
      (text) => sourcedScanner.extractCompensationBands(text)
    ),
    [expected, expected]
  );
});

test("compensation parsing does not treat a base case forecast as a base-pay label", () => {
  assert.deepEqual(sourcedScanner.extractCompensationBands("$95k-$120k base case forecast"), {
    base: null,
    annualEarnings: null,
  });
});

test("compensation parsing does not treat customer base as a base-pay label", () => {
  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Compensation is $95k-$120k depending on experience while helping expand our customer base"
    ),
    {
      base: null,
      annualEarnings: null,
    }
  );
});

test("compensation parsing does not treat customer base before pay as a base-pay label", () => {
  assert.deepEqual(
    sourcedScanner.extractCompensationBands(
      "Compensation for helping expand our customer base: $95k-$120k"
    ),
    {
      base: null,
      annualEarnings: null,
    }
  );
});

// ---------------------------------------------------------------------------
// Filter + infrastructure tests (unchanged)
// ---------------------------------------------------------------------------

test("title filter accepts target titles and rejects negative keywords", () => {
  const filter = buildTitleFilter({
    positive: [
      "Forward Deployed",
      "Applied AI",
      "Agent",
      "LLM",
      "Director of IT",
      "Head of Information Technology",
      "Workplace Technology",
    ],
    negative: ["Intern", "Developer Advocate"],
  });

  assert.equal(filter("Forward Deployed Engineer, AI"), true);
  assert.equal(filter("LLM Engineer"), true);
  assert.equal(filter("Director of IT Operations"), true);
  assert.equal(filter("Head of Information Technology"), true);
  assert.equal(filter("Director, Workplace Technology"), true);
  assert.equal(filter("Developer Advocate, AI Agents"), false);
  assert.equal(filter("Benefits Enrollment Specialist"), false);
  assert.equal(filter("Finance Manager"), false);
});

test("title filter recognizes bounded infrastructure-title equivalents without admitting adjacent functions", () => {
  const filter = buildTitleFilter({
    positive: [
      "Staff Platform Engineer",
      "Principal Infrastructure Engineer",
      "Staff Backend Engineer",
      "Senior Payments Infrastructure Engineer",
    ],
    negative: ["Intern"],
  });

  assert.equal(filter("Staff Software Engineer, Infrastructure Foundations"), true);
  assert.equal(filter("Senior Software Engineer, Compute (Temporal Cloud)"), true);
  assert.equal(filter("Senior Staff Engineer, Open Source Server"), true);
  assert.equal(filter("Staff Cloud Security Engineer"), false);
  assert.equal(filter("Staff Product Manager, Agent Platform"), false);
  assert.equal(filter("Principal Developer Advocate, AI"), false);
  assert.equal(filter("Account Executive, Platform"), false);
});

test("bounded title equivalence never crosses from staff IC to engineering management", () => {
  const filter = buildTitleFilter({ positive: ["Platform Engineering Manager"] });

  assert.equal(filter("Staff Platform Engineer"), false);
});

test("bounded title equivalence never crosses from engineering management to staff IC", () => {
  const filter = buildTitleFilter({ positive: ["Staff Platform Engineer"] });

  assert.equal(filter("Platform Engineering Manager"), false);
});

test("ranked nursing ladders reject CNA roles while keeping RN and NP roles", () => {
  const targeting = {
    role_buckets: [
      {
        name: "Nursing",
        priority: "primary",
        titles: ["Registered Nurse", "RN"],
        seniority_ladder: [
          { rank: 30, titles: ["Nurse Practitioner", "NP"] },
          { rank: 10, titles: ["Certified Nursing Assistant", "CNA"] },
          { rank: 20, titles: ["Registered Nurse", "RN"] },
        ],
      },
    ],
    keep_signals: [],
    cut_signals: [],
  };
  const result = filterAndDedupeOffers(
    [
      offerForSeniority("cna", "Certified Nursing Assistant"),
      offerForSeniority("rn", "Registered Nurse"),
      offerForSeniority("np", "Nurse Practitioner"),
    ],
    optionsForSeniority(targeting)
  );

  assert.deepEqual(
    result.filteredSeniority.map((offer) => offer.title),
    ["Certified Nursing Assistant"]
  );
  assert.deepEqual(
    result.kept.map((offer) => offer.title),
    ["Registered Nurse", "Nurse Practitioner"]
  );
});

test("ranked trades ladders reject apprentices while keeping journeyman and lead roles", () => {
  const targeting = {
    role_buckets: [
      {
        name: "Electrical",
        priority: "primary",
        titles: ["Journeyman Electrician"],
        seniority_ladder: [
          { rank: 300, titles: ["Lead Electrician"] },
          { rank: 100, titles: ["Apprentice Electrician"] },
          { rank: 200, titles: ["Journeyman Electrician"] },
        ],
      },
    ],
    keep_signals: [],
    cut_signals: [],
  };
  const result = filterAndDedupeOffers(
    [
      offerForSeniority("apprentice", "Apprentice Electrician"),
      offerForSeniority("journeyman", "Journeyman Electrician"),
      offerForSeniority("lead", "Lead Electrician"),
    ],
    optionsForSeniority(targeting)
  );

  assert.deepEqual(
    result.filteredSeniority.map((offer) => offer.title),
    ["Apprentice Electrician"]
  );
  assert.deepEqual(
    result.kept.map((offer) => offer.title),
    ["Journeyman Electrician", "Lead Electrician"]
  );
});

test("ranked bar ladders keep Bar Manager above Lead Bartender without corporate track rules", () => {
  const targeting = {
    role_buckets: [
      {
        name: "Bar",
        priority: "primary",
        titles: ["Lead Bartender"],
        seniority_ladder: [
          { rank: 40, titles: ["Bar Manager"] },
          { rank: 10, titles: ["Barback"] },
          { rank: 30, titles: ["Lead Bartender", "Head Bartender"] },
          { rank: 20, titles: ["Bartender"] },
        ],
      },
    ],
    keep_signals: [],
    cut_signals: [],
  };
  const titleFilter = buildTitleFilter(
    {
      positive: ["Lead Bartender"],
      negative: [],
      below_target: ["Barback", "Bartender"],
    },
    targeting
  );
  const result = filterAndDedupeOffers(
    [
      offerForSeniority("barback", "Barback"),
      offerForSeniority("bartender", "Bartender"),
      offerForSeniority("lead", "Lead Bartender"),
      offerForSeniority("manager", "Bar Manager"),
    ],
    { ...optionsForSeniority(targeting), titleFilter }
  );

  assert.deepEqual(
    [...result.filteredTitle, ...result.filteredSeniority].map((offer) => offer.title),
    ["Barback", "Bartender"]
  );
  assert.deepEqual(
    result.kept.map((offer) => offer.title),
    ["Lead Bartender", "Bar Manager"]
  );
});

test("unconfigured engineering targets retain the legacy junior-title guard", () => {
  const targeting = {
    role_buckets: [
      {
        name: "Platform",
        priority: "primary",
        titles: ["Staff Backend Engineer"],
      },
    ],
    keep_signals: [],
    cut_signals: [],
  };
  const result = filterAndDedupeOffers(
    [offerForSeniority("junior-backend", "Junior Backend Engineer")],
    optionsForSeniority(targeting)
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSeniority[0]?.qualificationReason, "seniority-below-target");
});

function offerForSeniority(id, title) {
  return {
    company: "Example Employer",
    title,
    url: `https://jobs.example.test/${id}`,
    location: "Remote - United States",
  };
}

function optionsForSeniority(targeting) {
  return {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    titleFilter: () => true,
    locationFilter: () => true,
    config: {
      targeting,
      profile: { location: { home: "", remote: true } },
    },
  };
}

test("coarse scoring does not promote a GTM engineer from backend and platform evidence in the body", () => {
  const result = scoreSourcedOffer(
    {
      company: "Anthropic",
      title: "AI Engineer, GTM Claudification",
      location: "Remote - United States",
      comp: "$320,000 - $405,000 base",
      bodyText: `${"Build autonomous agents for go-to-market sellers. ".repeat(8)}Work closely with platform engineering partners.`,
    },
    {
      targeting: {
        role_buckets: [
          { name: "Platform", titles: ["Staff Platform Engineer", "Staff Backend Engineer"] },
        ],
        keep_signals: ["platform engineering"],
      },
      profile: {
        compensation: { minimum_base: 190000 },
        location: { home: "Brooklyn, NY", remote: true },
      },
    }
  );

  assert.equal(result.fit, "stretch");
  assert.equal(result.gate, "review");
  assert.ok(result.score < 65, `expected a sub-medium score, got ${result.score}`);
  assert.ok(result.ruleFlags.includes("title-target-mismatch"));
});

test("coarse scoring recognizes reordered non-engineering target titles", () => {
  const result = scoreSourcedOffer(
    {
      company: "Hospitality Corp",
      title: "Food and Beverage Operations Manager",
      location: "New York, NY",
      bodyText:
        "Lead beverage service, venue operations, training, and day-to-day hospitality workflows.",
    },
    {
      targeting: {
        role_buckets: [
          { name: "Hospitality operations", titles: ["Operations Manager, Food & Beverage"] },
        ],
        fit_bands: { high_min: 85, med_min: 65, fit_floor: 65 },
      },
      profile: {
        compensation: { minimum_base: 85000 },
        location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
      },
    }
  );

  assert.ok(
    result.score >= 65,
    `expected the reordered target to clear fit 65, got ${result.score}`
  );
  assert.match(result.ratingReason, /matches target title/i);
});

test("coarse scoring does not treat a generic staff engineer as a platform title match", () => {
  const result = scoreSourcedOffer(
    {
      company: "GenericCo",
      title: "Staff Engineer",
      location: "Remote - United States",
      comp: "$220,000 - $280,000 base",
      bodyText: `${"Lead high-impact projects across the engineering organization. ".repeat(7)}Partner with the platform engineering team.`,
    },
    {
      targeting: {
        role_buckets: [
          { name: "Platform", titles: ["Staff Platform Engineer", "Staff Backend Engineer"] },
        ],
        keep_signals: ["platform engineering"],
      },
      profile: {
        compensation: { minimum_base: 190000 },
        location: { home: "Brooklyn, NY", remote: true },
      },
    }
  );

  assert.equal(result.fit, "stretch");
  assert.ok(result.ruleFlags.includes("title-target-mismatch"));
});

test("stale generic source filters cannot admit an adjacent GTM title after targeting narrows", () => {
  const titleFilter = buildTitleFilter({ positive: ["Software Engineer"] });
  const config = {
    targeting: {
      role_buckets: [
        { name: "Platform", titles: ["Staff Platform Engineer", "Staff Backend Engineer"] },
      ],
      keep_signals: ["platform engineering"],
    },
    profile: {
      compensation: { minimum_base: 190000 },
      location: { home: "Brooklyn, NY", remote: true },
    },
  };
  const bodyText = `${"Build autonomous agents for go-to-market sellers. ".repeat(8)}Work closely with platform engineering partners.`;
  const result = filterAndDedupeOffers(
    [
      {
        company: "Anthropic",
        title: "AI Engineer, GTM Claudification",
        url: "https://jobs.example.test/gtm-ai-engineer",
        location: "Remote - United States",
        comp: "$320,000 - $405,000 base",
        bodyText,
      },
      {
        company: "PlatformCo",
        title: "Staff Software Engineer, Infrastructure Foundations",
        url: "https://jobs.example.test/infrastructure-foundations",
        location: "Remote - United States",
        comp: "$220,000 - $280,000 base",
        bodyText: `${"Build reliable distributed infrastructure services. ".repeat(8)}Own platform engineering foundations.`,
      },
    ],
    {
      titleFilter,
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    ["PlatformCo"]
  );
  assert.equal(result.filteredTitle.length, 1);
  assert.equal(result.filteredTitle[0].company, "Anthropic");
  assert.equal(result.filteredTitle[0].qualificationReason, "title-relevance-low");
});

test("stale exact source filters cannot admit a different title after targeting narrows", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "GTMCo",
        title: "AI Engineer",
        url: "https://jobs.example.test/ai-engineer",
        location: "Remote - United States",
        bodyText: "Partner with the platform engineering team. ".repeat(10),
      },
    ],
    {
      titleFilter: buildTitleFilter({ positive: ["AI Engineer"] }),
      locationFilter: () => true,
      config: {
        targeting: {
          role_buckets: [{ name: "Platform", titles: ["Staff Platform Engineer"] }],
          keep_signals: ["platform engineering"],
        },
        profile: { location: { home: "Brooklyn, NY", remote: true } },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredTitle.length, 1);
  assert.equal(result.filteredTitle[0].qualificationReason, "title-relevance-low");
});

test("management targets do not treat individual-contributor engineering titles as adjacent", () => {
  const result = scoreSourcedOffer(
    {
      company: "SystemsCo",
      title: "Senior Software Engineer",
      location: "Remote - United States",
      bodyText: "Build distributed systems and guide technical execution. ".repeat(10),
    },
    {
      targeting: {
        role_buckets: [{ name: "Management", titles: ["Engineering Manager"] }],
        keep_signals: ["distributed systems"],
      },
      profile: { location: { home: "Brooklyn, NY", remote: true } },
    }
  );

  assert.equal(result.fit, "stretch");
  assert.ok(result.score < 65);
  assert.ok(result.ruleFlags.includes("title-target-mismatch"));
});

test("location filter blocks foreign roles while allowing home, remote, and unknown-location roles", () => {
  const filter = buildLocationFilter({
    always_allow: ["New York"],
    allow: ["Remote", "New York", "United States", "US"],
    block: ["India", "London"],
  });

  assert.equal(filter("Remote - India or New York"), true);
  assert.equal(filter("Remote - India"), false);
  assert.equal(filter("New York, NY"), true);
  assert.equal(filter("Remote"), true);
  // Providers sometimes omit location entirely. Keep those roles available for
  // later body review rather than treating missing provider data as foreign.
  assert.equal(filter(""), true);
});

test("location filter does not fall through to allow-all when a policy has no allow entries", () => {
  const filter = buildLocationFilter({
    always_allow: ["United States"],
    allow: [],
    block: ["India"],
  });

  assert.equal(filter("United States"), true);
  assert.equal(filter("India"), false);
  assert.equal(filter("France"), false);

  const noPolicy = buildLocationFilter({ always_allow: [], allow: [], block: [] });
  assert.equal(noPolicy("France"), true);
});

test("dedupe filters existing tracker roles by URL and req id, but only flags company-role matches", () => {
  const offers = [
    {
      company: "Writer",
      title: "Software Engineer, Agents",
      url: "https://jobs.example.com/1",
      location: "New York",
    },
    {
      company: "NewCo",
      title: "Forward Deployed Engineer",
      url: "https://jobs.greenhouse.io/newco/jobs/12345",
      location: "Remote US",
    },
    {
      company: "OtherCo",
      title: "Forward Deployed Engineer",
      url: "https://seen.example.com/job",
      location: "Remote US",
    },
    {
      company: "ReqCo",
      title: "Applied AI Engineer",
      url: "https://jobs.greenhouse.io/reqco/jobs/777",
      location: "Remote US",
    },
  ];

  const result = filterAndDedupeOffers(offers, {
    seenUrls: new Set(["https://seen.example.com/job"]),
    seenReqIds: new Set(["greenhouse:777"]),
    seenCompanyRoles: new Set([normalizeCompanyRoleKey("Writer", "Software Engineer Agents")]),
    titleFilter: () => true,
    locationFilter: () => true,
  });

  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    ["Writer", "NewCo"]
  );
  assert.equal(result.duplicates.length, 2);
  assert.equal(result.possibleDuplicates.length, 1);
  assert.equal(result.kept[0].possibleDuplicate, true);
});

test("dedupe presents one canonical role when different URLs carry the same requisition ID", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Twilio",
        title: "Senior Engineering Manager, Conversational Agents",
        url: "https://remote.example.test/twilio-agents",
        location: "Remote - US",
        reqId: "greenhouse:7926887",
      },
      {
        company: "Twilio",
        title: "Senior Engineering Manager Conversational Agents",
        url: "https://job-boards.example.test/twilio/jobs/7926887",
        location: "Remote - US",
        reqId: "greenhouse:7926887",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => offer.url),
    ["https://remote.example.test/twilio-agents"]
  );
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].duplicateReason, "req_id_batch");
  assert.equal(result.possibleDuplicates.length, 0);
});

test("same-run exact duplicates are removed before location rejection counting", () => {
  const repeated = {
    company: "Grafana Labs",
    title: "Staff Software Engineer - Databases",
    url: "https://jobs.example.test/grafana-databases",
    location: "Germany (Remote)",
  };
  const result = filterAndDedupeOffers([repeated, { ...repeated }], {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    titleFilter: () => true,
    locationFilter: buildLocationFilter({ allow: ["Remote", "United States"], block: ["Germany"] }),
  });

  assert.equal(result.filteredLocation.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].duplicateReason, "url_batch");
});

test("same-run canonical dedupe selects the richer copy independent of source order", () => {
  const weak = {
    company: "Acme",
    title: "Staff Platform Engineer",
    url: "https://aggregator.example.test/acme-platform",
    location: "Remote - US",
    bodyText: "Short preview.",
    bodyPartial: true,
    reqId: "greenhouse:acme-platform",
  };
  const rich = {
    ...weak,
    url: "https://jobs.example.test/acme-platform",
    bodyText: "Own a distributed platform and mentor engineers. ".repeat(20),
    bodyPartial: false,
    comp: "$210,000 - $250,000 base",
  };
  const run = (offers) =>
    filterAndDedupeOffers(offers, {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    });

  for (const offers of [
    [weak, rich],
    [rich, weak],
  ]) {
    const result = run(offers);
    assert.deepEqual(
      result.kept.map((offer) => offer.url),
      [rich.url]
    );
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].duplicateReason, "req_id_batch");
  }
});

test("same Hireology requisition dedupes to the richer Hcareers capture independent of source order", () => {
  const weak = {
    company: "Arlo Williamsburg",
    title: "Bar Manager & Floor Manager",
    url: "https://careers.hireology.com/arlo-williamsburg/2838889/description?source=hcareers",
    capturedUrl: "https://www.hcareers.com/jobs/4360243-bar-manager-floor-manager",
    location: "Brooklyn, NY",
    bodyText: "Short preview.",
    bodyPartial: true,
    provider: "hcareers",
  };
  const rich = {
    ...weak,
    url: "https://careers.hireology.com/arlo-williamsburg/2838889/description?source=hcareers&utm_source=hcareers",
    capturedUrl: "https://www.hcareers.com/jobs/4360403-bar-manager-floor-manager",
    bodyText: "Lead the bar program and dining room operations. ".repeat(20),
    bodyPartial: false,
    comp: "$75,000 to $85,000 per year",
  };
  const run = (offers) =>
    filterAndDedupeOffers(offers, {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    });

  for (const offers of [
    [weak, rich],
    [rich, weak],
  ]) {
    const result = run(offers);
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0].url, rich.url);
    assert.equal(result.kept[0].capturedUrl, rich.capturedUrl);
    assert.equal(result.kept[0].bodyText, rich.bodyText);
    assert.equal(result.kept[0].provider, "hcareers");
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].duplicateReason, "req_id_batch");
  }
});

test("distinct Hireology requisitions survive even when their job facts match", () => {
  const shared = {
    company: "Arlo Williamsburg",
    title: "Bar Manager & Floor Manager",
    location: "Brooklyn, NY",
    bodyText: "Lead the bar program and dining room operations. ".repeat(20),
    bodyPartial: false,
    provider: "hcareers",
  };
  const offers = [
    {
      ...shared,
      url: "https://careers.hireology.com/arlo-williamsburg/2838889/description",
      capturedUrl: "https://www.hcareers.com/jobs/4360403-bar-manager-floor-manager",
    },
    {
      ...shared,
      url: "https://careers.hireology.com/arlo-williamsburg/2850254/description",
      capturedUrl: "https://www.hcareers.com/jobs/4363300-events-outlets-operations-manager",
    },
  ];

  const result = filterAndDedupeOffers(offers, {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    titleFilter: () => true,
    locationFilter: () => true,
  });

  assert.deepEqual(
    result.kept.map((offer) => offer.url),
    offers.map((offer) => offer.url)
  );
  assert.equal(result.duplicates.length, 0);
});

test("adjacent engineering titles need strong candidate evidence while blockers stay blocked", () => {
  const titleFilter = buildTitleFilter({
    positive: ["Staff Frontend Engineer"],
    negative: ["Security", "Sales"],
  });
  const config = {
    targeting: {
      role_buckets: [{ titles: ["Staff Frontend Engineer"] }],
      keep_signals: ["accessibility systems"],
    },
    profile: { location: { home: "New York, NY", remote: true } },
  };
  const makeOffer = (id, title) => ({
    company: "Acme",
    title,
    url: `https://jobs.example.test/${id}`,
    location: "Remote - United States",
    bodyText: "Build accessibility systems for a mature product platform. ".repeat(12),
  });
  const result = filterAndDedupeOffers(
    [
      makeOffer("design-systems", "Staff Software Engineer, Design Systems"),
      makeOffer("security", "Staff Security Engineer"),
      makeOffer("marketing", "Product Marketing Manager"),
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter,
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => [offer.title, offer.titleRelevance]),
    [["Staff Software Engineer, Design Systems", "adjacent-signal"]]
  );
  assert.deepEqual(
    result.filteredTitle.map((offer) => offer.qualificationReason),
    ["title-negative-blocker", "title-relevance-low"]
  );
});

test("frontend targeting does not admit a backend role as an adjacent engineering title", () => {
  const config = {
    targeting: {
      role_buckets: [{ titles: ["Staff Frontend Engineer"] }],
      keep_signals: ["accessibility systems"],
    },
    profile: { location: { home: "New York, NY", remote: true } },
  };
  const result = filterAndDedupeOffers(
    [
      {
        company: "Acme",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.test/backend",
        location: "Remote - United States",
        bodyText: "Build accessibility systems for a mature product platform. ".repeat(12),
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: buildTitleFilter({ positive: ["Staff Frontend Engineer"] }),
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(result.kept, []);
  assert.equal(result.filteredTitle[0]?.qualificationReason, "title-relevance-low");
});

test("specialized engineering targets reject adjacent roles missing that specialization", () => {
  const config = {
    targeting: {
      role_buckets: [{ titles: ["Staff Security Engineer"] }],
      keep_signals: ["security infrastructure"],
    },
    profile: { location: { home: "New York, NY", remote: true } },
  };
  const result = filterAndDedupeOffers(
    [
      {
        company: "Acme",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.test/backend-for-security-target",
        location: "Remote - United States",
        bodyText: "Build security infrastructure for a mature product platform. ".repeat(12),
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: buildTitleFilter({ positive: ["Staff Security Engineer"] }),
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(result.kept, []);
  assert.equal(result.filteredTitle[0]?.qualificationReason, "title-relevance-low");
});

test("specialization variants do not admit unrelated adjacent engineering roles", () => {
  for (const targetTitle of ["Staff Solution Engineer", "Staff Cybersecurity Engineer"]) {
    const result = filterAndDedupeOffers(
      [
        {
          company: "Acme",
          title: "Staff Backend Engineer",
          url: `https://jobs.example.test/backend-for-${targetTitle.toLowerCase().replaceAll(" ", "-")}`,
          location: "Remote - United States",
          bodyText: "Build customer and security systems for a mature product platform. ".repeat(
            12
          ),
        },
      ],
      {
        seenUrls: new Set(),
        seenReqIds: new Set(),
        seenCompanyRoles: new Set(),
        titleFilter: buildTitleFilter({ positive: [targetTitle] }),
        locationFilter: () => true,
        config: {
          targeting: {
            role_buckets: [{ titles: [targetTitle] }],
            keep_signals: ["customer and security systems"],
          },
          profile: { location: { home: "New York, NY", remote: true } },
        },
      }
    );

    assert.deepEqual(result.kept, [], targetTitle);
    assert.equal(result.filteredTitle[0]?.qualificationReason, "title-relevance-low", targetTitle);
  }
});

test("dedupe keeps unrelated generic /jobs/<id> URLs from distinct domains", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Alpha",
        title: "Platform Engineer",
        url: "https://careers.alpha.example/jobs/123",
        location: "Remote - US",
      },
      {
        company: "Beta",
        title: "Product Designer",
        url: "https://careers.beta.example/jobs/123",
        location: "New York, NY",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    ["Alpha", "Beta"]
  );
  assert.equal(result.duplicates.length, 0);
});

test("dedupe keeps UUID-shaped paths on unrelated hosts as distinct requisitions", () => {
  const sharedUuid = "17330e14-aaaa-bbbb-cccc-123456789000";
  const result = filterAndDedupeOffers(
    [
      {
        company: "Alpha",
        title: "Platform Engineer",
        url: `https://careers.alpha.example/openings/${sharedUuid}`,
        location: "Remote - US",
      },
      {
        company: "Beta",
        title: "Product Designer",
        url: `https://careers.beta.example/roles/${sharedUuid}`,
        location: "New York, NY",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    ["Alpha", "Beta"]
  );
  assert.equal(result.duplicates.length, 0);
});

test("dedupe still recognizes one Greenhouse requisition across official URL forms", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Acme",
        title: "Platform Engineer",
        url: "https://boards.greenhouse.io/acme/jobs/123456",
        location: "Remote - US",
      },
      {
        company: "Acme",
        title: "Platform Engineer",
        url: "https://job-boards.eu.greenhouse.io/acme/jobs/123456",
        location: "Remote - US",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.duplicates.length, 1);
});

test("dedupe recognizes one Ashby requisition across official URL variants", () => {
  const reqId = "17330e14-aaaa-bbbb-cccc-123456789000";
  const result = filterAndDedupeOffers(
    [
      {
        company: "Acme",
        title: "Platform Engineer",
        url: `https://jobs.ashbyhq.com/acme/${reqId}`,
        location: "Remote - US",
      },
      {
        company: "Acme",
        title: "Platform Engineer",
        url: `https://jobs.ashbyhq.com/acme/${reqId}/application?source=careerrat`,
        location: "Remote - US",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].duplicateReason, "req_id_batch");
});

test("adjacent non-engineering titles require a shared occupation and strong candidate evidence", () => {
  const titleFilter = buildTitleFilter({
    positive: ["Registered Nurse, ICU"],
    negative: ["Travel Nurse"],
  });
  const config = {
    targeting: {
      role_buckets: [{ titles: ["Registered Nurse, ICU"] }],
      keep_signals: ["bedside care"],
    },
    profile: { location: { home: "Columbus, OH", remote: true } },
  };
  const makeOffer = (id, title) => ({
    company: "Regional Health",
    title,
    url: `https://jobs.example.test/${id}`,
    location: "Remote - United States",
    bodyText: "Coordinate bedside care and mentor clinical teams. ".repeat(12),
  });
  const result = filterAndDedupeOffers(
    [
      makeOffer("clinical-nurse", "Clinical Nurse Specialist"),
      makeOffer("finance", "Hospital Finance Manager"),
      makeOffer("travel", "Travel Nurse"),
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter,
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => [offer.title, offer.titleRelevance]),
    [["Clinical Nurse Specialist", "adjacent-signal"]]
  );
  assert.deepEqual(
    result.filteredTitle.map((offer) => offer.qualificationReason),
    ["title-relevance-low", "title-negative-blocker"]
  );
});

test("infers ATS provider from common careers URLs", () => {
  assert.equal(inferProvider({ careers_url: "https://jobs.ashbyhq.com/openai" }), "ashby");
  assert.equal(
    inferProvider({ careers_url: "https://job-boards.greenhouse.io/anthropic" }),
    "greenhouse"
  );
  assert.equal(inferProvider({ careers_url: "https://jobs.lever.co/acme" }), "lever");
});

// fetchProvider("lever", ...) now routes through fetchCareerOpsProvider (the
// SSRF-guarded Career Ops registry) instead of this module's own unguarded
// legacy fetcher — see the comment above fetchProvider's definition. The
// vendored lever.mjs adapter maps `descriptionPlain` (not the legacy
// fetcher's descriptionBodyPlain/additionalPlain/salaryDescriptionPlain/lists
// concatenation) into bodyText and does not surface a comp string at all, so
// this is a real, disclosed behavior change from the pre-fix scanner: comp is
// no longer populated for Lever specifically. bodyText and location (via
// resolveLocation's allLocations dedupe, asserted separately below) still
// carry through correctly.
test("fetchCareerOpsProvider-routed Lever fetch maps descriptionPlain into bodyText", async () => {
  const offers = await fetchProvider(
    "lever",
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              text: "Director of IT",
              hostedUrl: "https://jobs.lever.co/acme/abc",
              categories: { location: "Remote" },
              descriptionPlain: "Own corporate IT, identity, endpoint, and automation.",
            },
          ]),
          { status: 200 }
        ),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.match(offers[0].bodyText, /Own corporate IT/);
  assert.equal(offers[0].comp, "");
});

// #1 review: production scanner bypass. Every provider fetchProvider() knows
// about — including the seven that used to have their own unguarded fetchers
// here — must go through the shared SSRF guard before fetchImpl is ever
// called. A source entry pointing its api/careers_url at a private-resolving
// hostname must be rejected here, on the actual production dispatch path,
// not just in the registry's own unit tests.
test("fetchProvider rejects a greenhouse source whose host resolves to a private address, before ever calling fetchImpl", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      fetchProvider(
        "greenhouse",
        { name: "Acme", careers_url: "https://job-boards.greenhouse.io/acme" },
        {
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not reach fetchImpl");
          },
          resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
        }
      ),
    (error) => {
      assert.match(error.message, /Career Ops request blocked/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

test("fetchProvider rejects a lever source whose host resolves to a private address, before ever calling fetchImpl", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      fetchProvider(
        "lever",
        { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
        {
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not reach fetchImpl");
          },
          resolveHost: async () => [{ address: "169.254.169.254", family: 4 }],
        }
      ),
    (error) => {
      assert.match(error.message, /Career Ops request blocked/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

// #1 review: Lever's allLocations dedupe (resolveLocation() in
// vendor/lever.mjs) is inert on the legacy path because the old fetchLever
// only ever read categories.location. Routing through the guard also routes
// through the real vendored mapping, so a multi-location posting's full
// location set now reaches the offer.
test("fetchProvider dedupes Lever's primary location with allLocations through the guarded path", async () => {
  const offers = await fetchProvider(
    "lever",
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              text: "Staff Engineer",
              hostedUrl: "https://jobs.lever.co/acme/abc",
              categories: { location: "Barcelona", allLocations: ["Barcelona", "Montevideo"] },
              descriptionPlain: "Build reliable systems.",
            },
          ]),
          { status: 200 }
        ),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.equal(offers[0].location, "Barcelona; Montevideo");
  assert.equal(offers[0].company, "Acme");
});

// #1 review: fetchRss (source_type:"rss") took a user-configured URL straight
// to fetchImpl with no host validation at all — same threat model as the ATS
// providers above. It must go through guardedFetch too.
test("fetchProvider rejects an rss source whose host resolves to a private address, before ever calling fetchImpl", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      fetchProvider(
        "rss",
        { rssUrl: "https://feeds.example.test/jobs.xml" },
        {
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not reach fetchImpl");
          },
          resolveHost: async () => [{ address: "10.0.0.5", family: 4 }],
        }
      ),
    (error) => {
      assert.match(error.message, /RSS request blocked/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

// #3 review: fetchRss cleared its abort timer in a `finally` immediately after
// guardedFetch resolved, so once headers arrived the deadline stopped covering
// the body read: a host that returns headers and then stalls the body hung
// `guarded.response.text()` forever. The fix keeps the timer live across the
// body read too, clearing it only once text() settles. This fetchImpl mirrors
// a real fetch by wiring the response body's stream to the same abort signal
// guardedFetch passed it, so aborting on deadline actually errors the pending
// read instead of leaving it stuck with nothing listening.
test("fetchProvider('rss', …) aborts a body that stalls after headers, within the RSS deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fetchImpl = async (_url, init) => {
      const { signal } = init;
      const stream = new ReadableStream({
        start(streamController) {
          if (signal.aborted) {
            streamController.error(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => streamController.error(signal.reason), {
            once: true,
          });
        },
      });
      return new Response(stream, { status: 200 });
    };

    const promise = fetchProvider(
      "rss",
      { rssUrl: "https://feeds.example.test/jobs.xml" },
      {
        fetchImpl,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        dispatcherFactory: () => ({ close: async () => {} }),
      }
    );

    // Flush the guardedFetch chain's own microtasks (DNS resolve, response
    // construction) so the stalled `.text()` read is actually pending before
    // the mocked clock advances past the RSS deadline.
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(15_000);

    await assert.rejects(promise, (error) => {
      assert.match(String(error?.message || error), /abort/i);
      return true;
    });
  } finally {
    mock.timers.reset();
  }
});

test("extracts canonical req ids from common ATS URLs", () => {
  assert.equal(
    extractReqId("https://job-boards.greenhouse.io/acme/jobs/123456").id,
    "greenhouse:123456"
  );
  assert.equal(
    extractReqId("https://jobs.ashbyhq.com/acme/17330e14-aaaa-bbbb-cccc-123456789000").id,
    "ashby:17330e14-aaaa-bbbb-cccc-123456789000"
  );
  assert.equal(
    extractReqId("https://careers.example.com/openings/17330e14-aaaa-bbbb-cccc-123456789000").id,
    null
  );
  assert.equal(
    extractReqId("https://hiring.cafe/job/swfwvwmaq6basefz").id,
    "hiringcafe:swfwvwmaq6basefz"
  );
  assert.equal(
    extractReqId("https://www.linkedin.com/jobs/view/444555666/").id,
    "linkedin:444555666"
  );
  assert.deepEqual(
    extractReqId(
      "https://careers.hireology.com/arlo-williamsburg/2838889/description?source=hcareers"
    ),
    { provider: "hireology", value: "2838889", id: "hireology:2838889" }
  );
  assert.equal(
    extractReqId("https://careers.hireology.com/arlo-williamsburg/not-numeric/description").id,
    null
  );
  for (const requisition of ["JR12269", "JR13123-1", "R100123149", "HB344468-3"]) {
    assert.deepEqual(
      extractReqId(
        `https://shakeshack.wd5.myworkdayjobs.com/en-US/External/job/New-York-NY/Assistant-General-Manager_${requisition}`
      ),
      {
        provider: "workday",
        value: requisition,
        id: `workday:shakeshack:${requisition.toLowerCase()}`,
      }
    );
  }
  assert.equal(
    extractReqId("https://careers.example.com/jobs/Assistant-General-Manager_JR12269").id,
    null
  );
  assert.equal(extractReqId("https://careers.example.com/jobs/123456").id, null);
});

test("scopes Workday requisition identity to its tenant", () => {
  const shakeShack = extractReqId(
    "https://shakeshack.wd5.myworkdayjobs.com/External/job/Manager_JR12269"
  );
  const acme = extractReqId("https://acme.wd3.myworkdayjobs.com/Careers/job/Manager_JR12269");

  assert.equal(shakeShack.id, "workday:shakeshack:jr12269");
  assert.equal(acme.id, "workday:acme:jr12269");
  assert.notEqual(shakeShack.id, acme.id);
});

// ---------------------------------------------------------------------------
// Config-driven scoring — Jane tech persona tests
// (replaces former legacy assertions; now pass JANE_TECH_CONFIG explicitly)
// ---------------------------------------------------------------------------

test("FDE title with JANE config scores in keep territory (high or med fit, likely-keep gate)", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "Forward Deployed Engineer",
      location: "New York City",
      comp: "Base salary: USD 205000-265000",
      bodyText:
        "Build working prototypes with customers using LLM APIs, RAG, agents, MCP connectors, and production integrations. Drive adoption with enterprise teams.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.fit === "high" || result.fit === "med",
    `expected high or med fit, got ${result.fit} (score ${result.score})`
  );
  assert.equal(result.gate, "likely-keep");
});

test("excluded company (palantir) with JANE config gets excluded-company flag and likely-cut gate", () => {
  const result = scoreSourcedOffer(
    {
      company: "Palantir",
      title: "Forward Deployed Engineer",
      location: "Remote - US",
      comp: "$220K-$280K",
      bodyText: "Work with customers on AI workflows.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.includes("excluded-company"),
    `expected excluded-company flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("devrel title with JANE config gets a cut-risk flag and likely-cut gate", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "Developer Advocate, AI Platform",
      location: "Remote - US",
      comp: "$180K-$220K",
      bodyText:
        "Evangelize the platform. Run hackathons, write blog posts, give talks, and build sample apps for community.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.some((f) => f.startsWith("cut-risk")),
    `expected a cut-risk flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("comp posted below $200K floor with JANE config gets comp-below-floor flag and likely-cut gate", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "Applied AI Engineer",
      location: "Remote - US",
      comp: "Base salary: $130,000 - $170,000",
      bodyText: "Build AI-powered solutions for enterprise customers using LLM APIs and agents.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.includes("comp-below-floor"),
    `expected comp-below-floor flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("Solutions Engineer title with JANE config scores as keep (high or med fit)", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "Solutions Engineer",
      location: "New York, NY",
      comp: "$210,000 - $250,000",
      bodyText:
        "Partner with enterprise customers to deploy integrations and prototype workflows using APIs and LLMs.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.fit === "high" || result.fit === "med",
    `expected high or med fit, got ${result.fit} (score ${result.score})`
  );
  assert.notEqual(result.gate, "likely-cut");
});

test("excluded company (tesla) with JANE config gets excluded-company flag", () => {
  const result = scoreSourcedOffer(
    {
      company: "Tesla",
      title: "Applied AI Engineer",
      location: "Austin, TX",
      comp: "$230K-$290K",
      bodyText: "Build AI-powered tools for manufacturing operations.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.includes("excluded-company"),
    `expected excluded-company flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("ml research cut signal with JANE config gets cut-risk flag", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "ML Research Engineer",
      location: "Remote - US",
      comp: "$210,000 - $260,000",
      bodyText:
        "Conduct ML research, fine-tune foundation models, publish papers, run experiments on distributed training clusters.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.some((f) => f.startsWith("cut-risk")),
    `expected a cut-risk flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

// ---------------------------------------------------------------------------
// Bias-gone proof: same FDE offer without config is neutral (no keep boost)
// ---------------------------------------------------------------------------

test("FDE title WITHOUT config scores neutral — no keep boost from baked-in preferences", () => {
  const result = scoreSourcedOffer({
    company: "Acme",
    title: "Forward Deployed Engineer",
    location: "Remote - US",
    comp: "$220K-$280K",
    bodyText:
      "Work with enterprise customers to deploy AI-powered integrations and build prototypes.",
  });

  // Without config there are no keep_signals, so the title cannot set a high base
  // The score should NOT reach high (82+), landing at stretch or med at most
  assert.ok(
    result.fit !== "high",
    `expected no high fit without config, got fit=${result.fit} score=${result.score}`
  );
  // No keep gate without config-driven keep signals
  assert.notEqual(
    result.gate,
    "likely-keep",
    `expected no likely-keep gate without config, got gate=${result.gate}`
  );
});

test("confirmed keep and cut role signals adjust score and report ids outside human rule flags", () => {
  const offer = {
    company: "ExampleCo",
    title: "Applied AI Engineer",
    location: "",
    comp: "",
    bodyText: "Build customer prototypes with agent workflow tooling.",
  };
  const baseConfig = {
    targeting: {
      role_families: [{ name: "Applied AI", patterns: ["applied ai engineer"] }],
      keep_signals: [],
      cut_signals: [],
    },
    profile: {},
  };
  const baseline = scoreSourcedOffer(offer, baseConfig);
  const keep = scoreSourcedOffer(offer, {
    ...baseConfig,
    roleSignals: [
      {
        id: "signal-keep-agent-workflow",
        roleFamily: "applied-ai",
        signalType: "keep",
        text: "agent workflow",
      },
    ],
  });
  const cut = scoreSourcedOffer(offer, {
    ...baseConfig,
    roleSignals: [
      {
        id: "signal-cut-customer-prototypes",
        roleFamily: "Applied AI",
        signalType: "cut",
        text: "customer prototypes",
      },
    ],
  });

  assert.ok(keep.score > baseline.score, `${keep.score} should exceed ${baseline.score}`);
  assert.ok(cut.score < baseline.score, `${cut.score} should be below ${baseline.score}`);
  assert.deepEqual(keep.roleSignalIds, ["signal-keep-agent-workflow"]);
  assert.deepEqual(cut.roleSignalIds, ["signal-cut-customer-prototypes"]);
  assert.equal(keep.ruleFlags.includes("signal-keep-agent-workflow"), false);
  assert.equal(cut.ruleFlags.includes("signal-cut-customer-prototypes"), false);
  assert.ok(cut.ruleFlags.some((flag) => flag.startsWith("cut-risk-")));
});

test("no roleSignals argument is byte-identical to the pre-promotion scanner result", () => {
  const result = scoreSourcedOffer(
    { company: "ExampleCo", title: "Applied AI Engineer" },
    {
      targeting: {
        role_families: [{ name: "Applied AI", patterns: ["applied ai engineer"] }],
        keep_signals: [],
        cut_signals: [],
      },
      profile: {},
    }
  );

  assert.deepEqual(result, {
    fit: "stretch",
    score: 52,
    gate: "review",
    ratingReason: "",
    ruleFlags: ["comp-unposted"],
  });
});

// ---------------------------------------------------------------------------
// Structural (domain-neutral) signals still fire without config
// ---------------------------------------------------------------------------

test("remote/US location adds a bonus without config (neutral structural signal)", () => {
  const remote = scoreSourcedOffer({ title: "Analyst", location: "Remote - United States" });
  const onsite = scoreSourcedOffer({
    title: "Analyst",
    location: "On-site only, in-office 5 days/week",
  });

  assert.ok(
    remote.score > onsite.score,
    `expected remote (${remote.score}) > onsite (${onsite.score})`
  );
});

test("foreign remote locations do not receive the US location bonus", () => {
  const result = scoreSourcedOffer({
    title: "Analyst",
    location: "Remote DE; Aachen; Munich",
  });

  assert.equal(result.ratingReason.includes("remote/US location"), false);
});

test("office-burden flag fires without config (neutral structural signal)", () => {
  const result = scoreSourcedOffer({
    title: "Analyst",
    location: "Chicago",
    bodyText: "This is a fully onsite in-office role, 5 days/week at our headquarters.",
  });

  assert.ok(
    result.ruleFlags.includes("office-burden"),
    `expected office-burden flag, got ${JSON.stringify(result.ruleFlags)}`
  );
});

test("heavy travel flag fires without config (neutral structural signal)", () => {
  const result = scoreSourcedOffer({
    title: "Field Consultant",
    location: "Remote",
    bodyText: "This role requires heavy travel, up to 50%+ travel to customer sites.",
  });

  assert.ok(
    result.ruleFlags.includes("travel"),
    `expected travel flag, got ${JSON.stringify(result.ruleFlags)}`
  );
});

// ---------------------------------------------------------------------------
// Comp extraction and HTML utilities
// ---------------------------------------------------------------------------

test("extracts compensation ranges and strips ATS HTML bodies", () => {
  assert.deepEqual(extractCompBand("The salary range for this role is $200,000 - $300,000 base."), {
    min: 200000,
    max: 300000,
    currency: "USD",
  });
  assert.deepEqual(extractCompBand("USD 180000-230000"), {
    min: 180000,
    max: 230000,
    currency: "USD",
  });
  assert.deepEqual(extractCompBand("$153K – $325K • Offers Equity"), {
    min: 153000,
    max: 325000,
    currency: "USD",
  });
  assert.deepEqual(extractCompBand("$221.7K - $266K • Offers Equity"), {
    min: 221700,
    max: 266000,
    currency: "USD",
  });
  assert.equal(htmlToText("&lt;p&gt;Build &amp; ship&lt;/p&gt;"), "Build & ship");
  assert.deepEqual(
    extractCompBand(
      htmlToText(
        "&lt;span&gt;$258,000&lt;/span&gt;&lt;span&gt;&amp;mdash;&lt;/span&gt;&lt;span&gt;$348,000 USD&lt;/span&gt;"
      )
    ),
    { min: 258000, max: 348000, currency: "USD" }
  );
  assert.deepEqual(
    extractCompBand(
      "Bar Manager\nFull Time • Salary ($70k)\nRole details\nOther jobs you might be interested in\nBar Director\nSalary ($120k - $140k)"
    ),
    { min: 70000, max: 70000, currency: "USD" }
  );
});

test("dedupe attaches fit ratings to kept offers", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "OpenAI",
        title: "AI Deployment Engineer- Codex",
        url: "https://jobs.ashbyhq.com/openai/example",
        location: "Remote - US",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.equal(Number.isFinite(result.kept[0].score), true);
  assert.ok(["high", "med", "stretch"].includes(result.kept[0].fit));
});

test("qualification gate rejects management seniority drift before scoring", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Figma",
        title: "Manager, Software Engineering - Billing",
        url: "https://jobs.example.com/manager",
        location: "New York, NY",
        bodyText: "Lead a backend platform team building reliable distributed systems.",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: {
          role_buckets: [
            { name: "Platform", titles: ["Staff Backend Engineer", "Principal Platform Engineer"] },
          ],
          cut_signals: ["pure people management"],
        },
        profile: {
          location: { home: "Brooklyn, NY", remote: true, hybrid: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSeniority.length, 1);
  assert.equal(result.filteredSeniority[0].qualificationReason, "management-track-mismatch");
});

test("qualification gate enforces remote eligibility and a configured commute radius", () => {
  const offers = [
    {
      company: "Temporal",
      title: "Staff Backend Engineer",
      url: "https://jobs.example.com/nyc",
      location: "Hybrid - New York, NY",
    },
    {
      company: "Temporal",
      title: "Principal Platform Engineer",
      url: "https://jobs.example.com/albany",
      location: "Hybrid - Albany, NY",
    },
    {
      company: "Temporal",
      title: "Staff Software Engineer",
      url: "https://jobs.example.com/remote-us",
      location: "Remote - United States",
    },
    {
      company: "Temporal",
      title: "Staff Software Engineer",
      url: "https://jobs.example.com/remote-ie",
      location: "Remote - Ireland",
    },
    {
      company: "Temporal",
      title: "Staff Software Engineer",
      url: "https://jobs.example.com/unknown",
      location: "",
    },
  ];
  const result = filterAndDedupeOffers(offers, {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    titleFilter: () => true,
    locationFilter: () => true,
    config: {
      targeting: {
        role_buckets: [{ name: "Platform", titles: ["Staff Backend Engineer"] }],
      },
      profile: {
        location: {
          home: "Brooklyn, NY",
          remote: true,
          hybrid: true,
          onsite: false,
          commute_radius_miles: 25,
          relocation: [],
        },
      },
    },
  });

  assert.deepEqual(
    result.kept.map((offer) => offer.url),
    [
      "https://jobs.example.com/nyc",
      "https://jobs.example.com/remote-us",
      "https://jobs.example.com/unknown",
    ]
  );
  assert.equal(result.filteredLocation.length, 2);
  assert.equal(result.kept[2].qualificationUnknowns.includes("location"), true);
});

test("qualification gate recognizes NYC inside a detailed neighborhood label", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Midtown Hospitality",
        title: "General Manager",
        url: "https://jobs.example.com/midtown-general-manager",
        location: "New York, NY (Midtown/Koreatown NYC)",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: {
          role_buckets: [{ name: "Hospitality", titles: ["General Manager"] }],
        },
        profile: {
          location: {
            home: "New York, NY",
            remote: true,
            hybrid: true,
            onsite: true,
            relocation: [],
          },
        },
      },
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.filteredLocation.length, 0);
});

test("qualification gate filters stale, below-floor, and explicit sponsorship-conflict roles", () => {
  const now = Date.parse("2026-08-09T12:00:00Z");
  const result = filterAndDedupeOffers(
    [
      {
        company: "OldCo",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/old",
        location: "Remote - US",
        postedAt: "2026-06-01T00:00:00Z",
      },
      {
        company: "CheapCo",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/cheap",
        location: "Remote - US",
        postedAt: "2026-08-08T00:00:00Z",
        comp: "Base pay: $140,000 - $180,000",
      },
      {
        company: "NoVisaCo",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/no-visa",
        location: "Remote - US",
        postedAt: "2026-08-08T00:00:00Z",
        bodyText: "Candidates must already be authorized. We do not offer visa sponsorship.",
      },
      {
        company: "UnknownCo",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/unknowns",
        location: "",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
      now,
      config: {
        targeting: {
          role_buckets: [{ name: "Platform", titles: ["Staff Backend Engineer"] }],
          search_preferences: { posting_age: { mode: "fixed-days", days: 30 } },
        },
        profile: {
          compensation: { minimum_base: 200000 },
          location: { home: "Brooklyn, NY", remote: true, hybrid: true },
          authorization: { work_authorized: false, requires_sponsorship: true },
        },
      },
    }
  );

  assert.equal(result.filteredAge.length, 1);
  assert.equal(result.filteredSalary.length, 1);
  assert.equal(result.filteredEligibility.length, 1);
  assert.equal(result.kept.length, 1);
  assert.deepEqual(result.kept[0].qualificationUnknowns.sort(), [
    "compensation",
    "location",
    "postedAt",
  ]);
});

test("partial offers enforce location, compensation, and content policy by default", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Partial Location Corp",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/partial-location",
        location: "Remote - United States",
        bodyText: "Location: San Francisco Bay Area, CA (in-person).",
        bodyPartial: true,
      },
      {
        company: "Partial Comp Corp",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/partial-comp",
        location: "Remote - United States",
        bodyText: "Salary Range: $100,000 - $120,000 annually.",
        bodyPartial: true,
      },
      {
        company: "Partial Eligibility Corp",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/partial-eligibility",
        location: "Remote - United States",
        bodyText: "Visa sponsorship is not available for this position.",
        bodyPartial: true,
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Staff Backend Engineer"] }] },
        profile: {
          compensation: { minimum_base: 180000 },
          authorization: { requires_sponsorship: true },
          location: {
            home: "Brooklyn, NY",
            remote: true,
            remote_scope: "home-country",
            hybrid: true,
            onsite: false,
          },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredLocation.length, 1);
  assert.equal(result.filteredSalary.length, 1);
  assert.equal(result.filteredEligibility.length, 1);
});

test("qualification gate caps one company and reconciles every fetched offer", () => {
  const offers = Array.from({ length: 4 }, (_, index) => ({
    company: "FloodCo",
    title: `Staff Backend Engineer ${index + 1}`,
    url: `https://jobs.example.com/flood-${index + 1}`,
    location: "Remote - US",
    postedAt: `2026-08-0${index + 1}T00:00:00Z`,
  }));
  const result = filterAndDedupeOffers(offers, {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    companyPresentationCounts: new Map(),
    perCompanyCap: 2,
    titleFilter: () => true,
    locationFilter: () => true,
    config: {
      targeting: { role_buckets: [{ titles: ["Staff Backend Engineer"] }] },
      profile: { location: { home: "Brooklyn, NY", remote: true } },
    },
  });

  assert.equal(result.kept.length, 2);
  assert.equal(result.overflow.length, 2);
  const reconciled = [
    result.kept,
    result.filteredTitle,
    result.filteredSeniority,
    result.filteredLocation,
    result.filteredAge,
    result.filteredSalary,
    result.filteredEligibility,
    result.duplicates,
    result.invalid,
    result.overflow,
  ].reduce((sum, rows) => sum + rows.length, 0);
  assert.equal(reconciled, offers.length);
});

test("maps score bands to tracker fit buckets", () => {
  assert.equal(fitFromScore(90), "high");
  assert.equal(fitFromScore(84), "med");
  assert.equal(fitFromScore(70), "med");
  assert.equal(fitFromScore(55), "stretch");
});

test("maps score bands through the candidate's saved thresholds", () => {
  assert.equal(fitFromScore(84, { high_min: 85, med_min: 65 }), "med");
  assert.equal(fitFromScore(64, { high_min: 85, med_min: 65 }), "stretch");
  assert.equal(fitFromScore(84, { high_min: "not-a-number", med_min: 70 }), "med");
  assert.equal(fitFromScore(84, { high_min: null, med_min: null }), "med");
});

test("qualification recognizes an annual salary sentence below the saved floor", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Credence",
        title: "AI Software Engineer",
        url: "https://jobs.example.test/credence-ai-software-engineer",
        location: "Tysons Corner, VA (Remote)",
        bodyText: "Salary Range: $120,000 - $150,000 annually.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Software Engineer"] }] },
        profile: {
          compensation: { minimum_base: 180000 },
          location: { home: "Brooklyn, NY", remote: true, hybrid: true, onsite: false },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
});

test("qualification keeps a posted range that overlaps the hard floor for review", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Bazaar Meat",
        title: "Bar Manager",
        url: "https://jobs.example.test/bazaar-meat-bar-manager",
        location: "New York, NY",
        bodyText: "Base salary: $75,000 - $85,000 per year, plus bonus and benefits.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.filteredSalary.length, 0);
  assert.ok(result.kept[0].ruleFlags.includes("top-of-band-only"));
});

test("qualification recognizes a single annual salary below the saved floor", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Single Salary Hospitality",
        title: "Bar Manager",
        url: "https://jobs.example.test/single-salary-hospitality",
        location: "New York, NY",
        bodyText: "Salary: $60,000 per year. Lead a high-volume beverage program in Manhattan.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
  assert.deepEqual(result.filteredSalary[0]?.compBand, {
    min: 60000,
    max: 60000,
    currency: "USD",
  });
});

test("qualification trusts the role compensation before unrelated recommendation salaries", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Hospitality Group",
        title: "Bar Manager",
        url: "https://jobs.example.test/bar-manager-with-recommendations",
        location: "New York, NY",
        comp: "Full Time • Salary ($70k)",
        bodyText:
          "Bar Manager\nFull Time • Salary ($70k)\nLead this beverage program.\nSimilar jobs\nRestaurant Manager\nSalary ($75k - $120k)",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
  assert.deepEqual(result.filteredSalary[0]?.compBand, {
    min: 70000,
    max: 70000,
    currency: "USD",
  });
});

test("qualification uses base salary instead of variable and total compensation ranges", () => {
  const nonBaseRanges = [
    ["OTE Corp", "On-target earnings (OTE): $180,000 - $220,000 per year."],
    ["Bonus Corp", "Annual bonus opportunity: $100,000 - $120,000."],
    ["Equity Corp", "Annual equity value: $150,000 - $250,000."],
    ["Commission Corp", "Annual commission: $120,000 - $180,000."],
    ["Total Comp Corp", "Total compensation: $190,000 - $230,000 per year."],
  ];
  const result = filterAndDedupeOffers(
    nonBaseRanges.map(([company, variableComp], index) => ({
      company,
      title: "Bar Manager",
      url: `https://jobs.example.test/base-pay-${index}`,
      location: "New York, NY",
      bodyText: `${variableComp} Annual base salary: $70,000 - $80,000.`,
    })),
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.deepEqual(
    result.filteredSalary.map((offer) => offer.compBand),
    Array.from({ length: nonBaseRanges.length }, () => ({
      min: 70000,
      max: 80000,
      currency: "USD",
    }))
  );
});

test("qualification selects same-sentence base salary instead of total compensation", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Same Sentence Comp Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/same-sentence-base-pay",
        location: "New York, NY",
        bodyText:
          "Total compensation: $190k-$230k including base salary $70k-$80k plus bonus and equity.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
  assert.deepEqual(result.filteredSalary[0]?.compBand, {
    min: 70000,
    max: 80000,
    currency: "USD",
  });
});

test("qualification treats variable and total compensation without base pay as unknown", () => {
  const nonBaseRanges = [
    ["OTE Only Corp", "On-target earnings (OTE): $180,000 - $220,000 per year."],
    ["Bonus Only Corp", "Annual bonus opportunity: $100,000 - $120,000."],
    ["Equity Only Corp", "Annual equity value: $150,000 - $200,000."],
    ["Commission Only Corp", "Annual commission: $120,000 - $180,000."],
    ["Total Comp Only Corp", "Total compensation: $190,000 - $230,000 per year."],
  ];
  const result = filterAndDedupeOffers(
    nonBaseRanges.map(([company, variableComp], index) => ({
      company,
      title: "Bar Manager",
      url: `https://jobs.example.test/non-base-pay-${index}`,
      location: "New York, NY",
      bodyText: variableComp,
    })),
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 250000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.filteredSalary.length, 0);
  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    nonBaseRanges.map(([company]) => company)
  );
  assert.ok(result.kept.every((offer) => offer.qualificationUnknowns.includes("compensation")));
});

test("qualification keeps an annualized hourly base range that overlaps the floor", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Hourly Base Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/hourly-base-pay",
        location: "New York, NY",
        bodyText: "Base pay: $40.00 - $45.00 per hour.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.filteredSalary.length, 0);
  assert.ok(result.kept[0].ruleFlags.includes("top-of-band-only"));
});

test("qualification annualizes a single explicit hourly base-pay amount", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Single Hourly Base Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/single-hourly-base-pay",
        location: "New York, NY",
        bodyText: "Base pay: $40 per hour.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
  assert.deepEqual(result.filteredSalary[0]?.compBand, {
    min: 83200,
    max: 83200,
    currency: "USD",
  });
});

test("qualification ignores benefit thresholds when annualizing hourly base pay", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Schedule Context Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/schedule-context-hourly-pay",
        location: "New York, NY",
        bodyText: "Benefits eligibility begins at 20 hours per week. Pay: $40 per hour.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 80_000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.filteredSalary.length, 0);
  assert.match(result.kept[0]?.ratingReason || "", /comp clears floor/);
});

test("qualification admits a non-dollar hourly base range", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "International Hourly Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/international-hourly-pay",
        location: "London, UK",
        bodyText: "Pay: GBP 40-GBP 45 per hour.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85_000 },
          location: { home: "London, UK", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.filteredSalary.length, 0);
  assert.ok(result.kept[0]?.ruleFlags.includes("top-of-band-only"));
});

test("CR5: sourced qualification and requalification review foreign-currency bands", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Foreign Currency Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/foreign-currency",
        location: "New York, NY",
        bodyText: "Base salary: GBP 60,000 - 75,000 per year.",
      },
      {
        company: "Legacy Currency Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/legacy-currency",
        location: "New York, NY",
        bodyText: "Base salary: 60k - 75k per year.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { currency: "USD", minimum_base: 85_000 },
          location: { home: "New York, NY", onsite: true },
        },
      },
    }
  );

  assert.deepEqual(
    result.kept.map(({ company }) => company),
    ["Foreign Currency Corp"]
  );
  assert.equal(result.kept[0].gate, "review");
  assert.ok(result.kept[0].qualificationUnknowns.includes("compensation"));
  assert.deepEqual(result.kept[0].compBand, {
    min: 60_000,
    max: 75_000,
    currency: "GBP",
  });
  assert.equal(result.filteredSalary[0]?.company, "Legacy Currency Corp");
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
});

test("annual earnings floor keeps low tipped base pay unverified", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Tipped Bar",
        title: "Lead Bartender",
        url: "https://jobs.example.test/tipped-bar",
        location: "New York, NY",
        bodyText: "Base pay: $11.35 per hour plus tips.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Lead Bartender"] }] },
        profile: {
          compensation: { minimum_annual_earnings: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.filteredSalary.length, 0);
  assert.ok(result.kept[0].qualificationUnknowns.includes("compensation"));
  assert.ok(result.kept[0].ruleFlags.includes("annual-earnings-unverified"));
  assert.equal(result.kept[0].gate, "review");
});

test("annual earnings floor compares explicit tipped earnings without treating them as base", () => {
  const offers = [
    ["Clear Bar", "$95,000 - $120,000", "annual-earnings-clear"],
    ["Overlap Bar", "$80,000 - $95,000", "annual-earnings-overlap"],
    ["Below Bar", "$60,000 - $75,000", "annual-earnings-below-floor"],
  ].map(([company, range]) => ({
    company,
    title: "Lead Bartender",
    url: `https://jobs.example.test/${company.toLowerCase().replaceAll(" ", "-")}`,
    location: "New York, NY",
    bodyText: `Estimated annual earnings including tips: ${range}.`,
  }));
  const result = filterAndDedupeOffers(offers, {
    titleFilter: () => true,
    locationFilter: () => true,
    config: {
      targeting: { role_buckets: [{ titles: ["Lead Bartender"] }] },
      profile: {
        compensation: { minimum_annual_earnings: 85000 },
        location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
      },
    },
  });

  assert.deepEqual(
    result.kept.map((offer) => [offer.company, offer.ruleFlags]),
    [
      ["Clear Bar", []],
      ["Overlap Bar", ["annual-earnings-overlap"]],
    ]
  );
  assert.equal(result.filteredSalary[0]?.company, "Below Bar");
  assert.equal(result.filteredSalary[0]?.qualificationReason, "annual-earnings-below-floor");
  assert.deepEqual(result.filteredSalary[0]?.annualEarningsBand, {
    min: 60000,
    max: 75000,
    currency: "USD",
  });
  assert.equal(result.kept.find((offer) => offer.company === "Overlap Bar")?.gate, "review");
});

test("annual earnings hard gate reads a same-line tipped band beside hourly base pay", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Same Line Tipped Bar",
        title: "Lead Bartender",
        url: "https://jobs.example.test/same-line-tipped-bar",
        location: "New York, NY",
        bodyText:
          "Base pay: $11.35 per hour; estimated annual earnings including tips: $60,000-$75,000.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Lead Bartender"] }] },
        profile: {
          compensation: { minimum_annual_earnings: 85_000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "annual-earnings-below-floor");
  assert.deepEqual(result.filteredSalary[0]?.annualEarningsBand, {
    min: 60_000,
    max: 75_000,
    currency: "USD",
  });
});

test("basis-specific offer fields participate in scanner hard gates", () => {
  const baseResult = filterAndDedupeOffers(
    [
      {
        company: "Structured Base Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/structured-base",
        location: "New York, NY",
        baseComp: "$40 per hour",
        bodyText: "Manage the venue team and daily service operations.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85_000 },
          location: { home: "New York, NY", onsite: true },
        },
      },
    }
  );
  const annualResult = filterAndDedupeOffers(
    [
      {
        company: "Structured Tips Corp",
        title: "Lead Bartender",
        url: "https://jobs.example.test/structured-tips",
        location: "New York, NY",
        annualEarningsComp: "$60,000 - $75,000",
        bodyText: "Lead a polished cocktail service team.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Lead Bartender"] }] },
        profile: {
          compensation: { minimum_annual_earnings: 85_000 },
          location: { home: "New York, NY", onsite: true },
        },
      },
    }
  );

  assert.equal(baseResult.filteredSalary[0]?.qualificationReason, "comp-below-floor");
  assert.deepEqual(baseResult.filteredSalary[0]?.compBand, {
    min: 83_200,
    max: 83_200,
    currency: "USD",
  });
  assert.equal(annualResult.filteredSalary[0]?.qualificationReason, "annual-earnings-below-floor");
  assert.deepEqual(annualResult.filteredSalary[0]?.annualEarningsBand, {
    min: 60_000,
    max: 75_000,
    currency: "USD",
  });
});

test("scanner keeps an unlabeled pay range reviewable above a guaranteed-base floor", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Unknown Basis Corp",
        title: "Bar Manager",
        url: "https://jobs.example.test/unknown-basis",
        location: "New York, NY",
        comp: "$95k-$120k",
        bodyText: "Manage the venue team and daily service operations.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 130_000 },
          location: { home: "New York, NY", onsite: true },
        },
      },
    }
  );

  assert.equal(result.filteredSalary.length, 0);
  assert.equal(result.kept.length, 1);
  assert.ok(result.kept[0].qualificationUnknowns.includes("compensation"));
  assert.ok(result.kept[0].ruleFlags.includes("comp-uncertain"));
  assert.equal(result.kept[0].gate, "review");
});

test("guaranteed base pay can clear an annual earnings floor", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Guaranteed Bar",
        title: "Bar Manager",
        url: "https://jobs.example.test/guaranteed-bar",
        location: "New York, NY",
        bodyText: "Base pay: $50 per hour.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_annual_earnings: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.filteredSalary.length, 0);
  assert.equal(result.kept[0].qualificationUnknowns.includes("compensation"), false);
  assert.equal(result.kept[0].ruleFlags.includes("annual-earnings-unverified"), false);
});

// ---------------------------------------------------------------------------
// Config-driven scoring — domain generality tests (unchanged)
// ---------------------------------------------------------------------------

const nursingConfig = {
  targeting: {
    keep_signals: ["bedside", "registered nurse", "rn"],
    cut_signals: ["travel nursing"],
    excluded_companies: ["BadHealth Staffing"],
  },
  profile: {
    compensation: { minimum_base: 90000 },
    location: { home: "Columbus", relocation: [] },
  },
};

test("config-driven scorer: bedside RN offer scores in keep territory (high or med)", () => {
  const result = scoreSourcedOffer(
    {
      company: "Columbus Regional Hospital",
      title: "Bedside RN - ICU",
      location: "Columbus, OH",
      comp: "$95,000 - $115,000",
      bodyText:
        "Registered nurse bedside care in the ICU unit. Provide direct patient care, medication administration, and coordinate with multidisciplinary teams.",
    },
    nursingConfig
  );

  assert.ok(
    result.fit === "high" || result.fit === "med",
    `expected high or med fit, got ${result.fit} (score ${result.score})`
  );
  assert.notEqual(result.gate, "likely-cut");
});

test("config-driven scorer: travel nursing offer gets cut penalty and cut-risk flag", () => {
  const result = scoreSourcedOffer(
    {
      company: "TravelHealth Inc",
      title: "Travel Nursing Recruiter",
      location: "Remote",
      comp: "$60,000 - $75,000",
      bodyText:
        "Recruit registered nurses for travel nursing assignments across the country. Manage placements for travel nursing contracts at hospitals nationwide.",
    },
    nursingConfig
  );

  assert.ok(
    result.ruleFlags.some((f) => f.startsWith("cut-risk")),
    `expected a cut-risk flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("config-driven scorer: excluded company gets excluded-company flag and penalty", () => {
  const result = scoreSourcedOffer(
    {
      company: "BadHealth Staffing",
      title: "RN Staff Nurse",
      location: "Columbus, OH",
      comp: "$100,000 - $120,000",
      bodyText:
        "Registered nurse position at BadHealth Staffing. Provide bedside care and patient support.",
    },
    nursingConfig
  );

  assert.ok(
    result.ruleFlags.includes("excluded-company"),
    `expected excluded-company flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("config-driven scorer: offer with posted comp below floor gets comp-below-floor", () => {
  const result = scoreSourcedOffer(
    {
      company: "SmallClinic",
      title: "Registered Nurse",
      location: "Columbus, OH",
      comp: "Base salary: $60,000 - $80,000",
      bodyText:
        "RN position providing bedside registered nurse care in outpatient clinic setting. Full time nursing role.",
    },
    nursingConfig
  );

  assert.ok(
    result.ruleFlags.includes("comp-below-floor"),
    `expected comp-below-floor flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("config-driven scorer: nursing offer with config scores differently than without config", () => {
  const offer = {
    company: "Columbus Regional Hospital",
    title: "Bedside RN - ICU",
    location: "Columbus, OH",
    comp: "$95,000 - $115,000",
    bodyText:
      "Registered nurse bedside care in the ICU unit. Provide direct patient care, medication administration, and coordinate with multidisciplinary teams.",
  };
  const withConfig = scoreSourcedOffer(offer, nursingConfig);
  const withoutConfig = scoreSourcedOffer(offer);

  // Config keeps signals (bedside/rn) boost the score; without config, no such boost
  assert.notDeepEqual(
    { score: withConfig.score, ratingReason: withConfig.ratingReason },
    { score: withoutConfig.score, ratingReason: withoutConfig.ratingReason },
    "expected config path and no-config path to produce different scores/reasons for a nursing offer"
  );
});
