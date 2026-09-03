import { describe, expect, it } from "vitest";

import { calculateAnnualCashWorksheet, emptyAnnualCashWorksheet } from "./annual-cash-worksheet.js";

describe("annual cash worksheet", () => {
  it("derives a visible annual floor from hourly wages and per-shift cash", () => {
    expect(
      calculateAnnualCashWorksheet({
        hourlyRate: "15",
        hoursPerWeek: "35",
        cashPerShift: "300",
        shiftsPerWeek: "4",
        weeksPerYear: "52",
      })
    ).toEqual({
      annual: 89_700,
      error: null,
      formula: "($15/hr × 35 hrs/week + $300/shift × 4 shifts/week) × 52 weeks",
      source: "derived",
    });
  });

  it("lets an explicit annual amount override the worksheet", () => {
    expect(
      calculateAnnualCashWorksheet({
        hourlyRate: "15",
        hoursPerWeek: "35",
        weeksPerYear: "52",
        annualOverride: "85000",
      })
    ).toEqual({
      annual: 85_000,
      error: null,
      formula: "Annual cash floor set to $85,000",
      source: "override",
    });
  });

  it("rejects a positive override when its canonical integer is zero", () => {
    expect(calculateAnnualCashWorksheet({ annualOverride: "0.4" })).toEqual({
      annual: null,
      error: "Minimum annual cash earnings must be a positive amount.",
      formula: null,
      source: null,
    });
  });

  it("rounds valid positive decimal overrides to the nearest canonical integer", () => {
    for (const [annualOverride, annual] of [
      ["0.5", 1],
      ["85000.4", 85_000],
      ["85000.5", 85_001],
    ]) {
      expect(calculateAnnualCashWorksheet({ annualOverride })).toEqual({
        annual,
        error: null,
        formula: `Annual cash floor set to $${annual.toLocaleString("en-US")}`,
        source: "override",
      });
    }
  });

  it("formats the visible derivation in the candidate's currency", () => {
    expect(
      calculateAnnualCashWorksheet(
        {
          hourlyRate: "15",
          hoursPerWeek: "35",
          weeksPerYear: "52",
        },
        { currency: "EUR" }
      )
    ).toEqual({
      annual: 27_300,
      error: null,
      formula: "(€15/hr × 35 hrs/week) × 52 weeks",
      source: "derived",
    });
  });

  it("falls back to USD when the stored currency is not supported", () => {
    expect(
      calculateAnnualCashWorksheet(
        {
          annualOverride: "85000",
        },
        { currency: "not-a-currency" }
      )
    ).toEqual({
      annual: 85_000,
      error: null,
      formula: "Annual cash floor set to $85,000",
      source: "override",
    });
  });

  it("keeps partial wage inputs reviewable instead of guessing", () => {
    expect(calculateAnnualCashWorksheet({ hourlyRate: "18", weeksPerYear: "52" })).toEqual({
      annual: null,
      error: "Add paid hours per week to annualize the hourly wage.",
      formula: null,
      source: null,
    });
  });

  it("rejects a complete worksheet that derives a zero annual floor", () => {
    expect(
      calculateAnnualCashWorksheet({
        hourlyRate: "0",
        hoursPerWeek: "35",
        weeksPerYear: "52",
      })
    ).toEqual({
      annual: null,
      error: "Minimum annual cash earnings must be a positive amount.",
      formula: null,
      source: null,
    });
  });

  it("preloads a saved annual floor as an editable override", () => {
    expect(emptyAnnualCashWorksheet(90_000)).toEqual({
      hourlyRate: "",
      hoursPerWeek: "",
      weeklyPay: "",
      monthlyPay: "",
      cashPerShift: "",
      shiftsPerWeek: "",
      weeksPerYear: "52",
      annualOverride: "90000",
    });
  });

  it("preserves invalid legacy floor text for visible validation", () => {
    for (const value of [0, -5000, "not-an-amount"]) {
      expect(emptyAnnualCashWorksheet(value).annualOverride).toBe(String(value));
    }
  });

  it("annualizes a flat weekly amount by 52 weeks when weeks per year is not overridden", () => {
    expect(calculateAnnualCashWorksheet({ weeklyPay: "800" })).toEqual({
      annual: 41_600,
      error: null,
      formula: "$800/week × 52 weeks",
      source: "derived",
    });
  });

  it("annualizes a flat weekly amount by the worksheet's own weeks per year, not a fixed 52", () => {
    expect(calculateAnnualCashWorksheet({ weeklyPay: "800", weeksPerYear: "40" })).toEqual({
      annual: 32_000,
      error: null,
      formula: "$800/week × 40 weeks",
      source: "derived",
    });
  });

  it("annualizes a flat monthly amount by 12 months", () => {
    expect(calculateAnnualCashWorksheet({ monthlyPay: "3500" })).toEqual({
      annual: 42_000,
      error: null,
      formula: "$3,500/month × 12 months",
      source: "derived",
    });
  });

  it("adds tips or commission per shift on top of a flat weekly amount", () => {
    expect(
      calculateAnnualCashWorksheet({
        weeklyPay: "800",
        cashPerShift: "50",
        shiftsPerWeek: "3",
        weeksPerYear: "52",
      })
    ).toEqual({
      annual: 49_400,
      error: null,
      formula: "$800/week × 52 weeks + $50/shift × 3 shifts/week × 52 weeks",
      source: "derived",
    });
  });

  it("rejects two base pay shapes supplied at once", () => {
    expect(
      calculateAnnualCashWorksheet({
        hourlyRate: "15",
        hoursPerWeek: "35",
        weeklyPay: "800",
      })
    ).toEqual({
      annual: null,
      error:
        "Enter pay one way: hourly wage, flat weekly pay, or flat monthly pay, not more than one.",
      formula: null,
      source: null,
    });
    expect(
      calculateAnnualCashWorksheet({
        weeklyPay: "800",
        monthlyPay: "3500",
      })
    ).toEqual({
      annual: null,
      error:
        "Enter pay one way: hourly wage, flat weekly pay, or flat monthly pay, not more than one.",
      formula: null,
      source: null,
    });
  });

  it("rejects a negative flat weekly or monthly amount", () => {
    expect(calculateAnnualCashWorksheet({ weeklyPay: "-100" })).toEqual({
      annual: null,
      error: "Use non-negative pay amounts and valid weekly or yearly quantities.",
      formula: null,
      source: null,
    });
    expect(calculateAnnualCashWorksheet({ monthlyPay: "-100" })).toEqual({
      annual: null,
      error: "Use non-negative pay amounts and valid weekly or yearly quantities.",
      formula: null,
      source: null,
    });
  });
});
