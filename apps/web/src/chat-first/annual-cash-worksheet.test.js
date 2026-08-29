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
});
