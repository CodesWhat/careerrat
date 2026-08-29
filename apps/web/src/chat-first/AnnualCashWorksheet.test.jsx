import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnnualCashWorksheet } from "./AnnualCashWorksheet.jsx";

describe("AnnualCashWorksheet", () => {
  it("shows the derivation and keeps the annual result editable", () => {
    const html = renderToStaticMarkup(
      <AnnualCashWorksheet
        idPrefix="pay"
        name="annualCashWorksheet"
        value={{
          hourlyRate: "15",
          hoursPerWeek: "35",
          cashPerShift: "300",
          shiftsPerWeek: "4",
          weeksPerYear: "52",
          annualOverride: "",
        }}
      />
    );

    expect(html).toContain("Minimum annual cash earnings: hourly and tipped pay worksheet");
    expect(html).toContain("$89,700 estimated annual cash");
    expect(html).toContain("$15/hr × 35 hrs/week");
    expect(html).toContain("Annual cash floor override");
    expect(html).toContain('name="annualCashWorksheet"');
  });

  it("uses the canonical profile currency for the editable result", () => {
    const html = renderToStaticMarkup(
      <AnnualCashWorksheet
        currency="EUR"
        idPrefix="pay-eur"
        value={{
          hourlyRate: "15",
          hoursPerWeek: "35",
          weeksPerYear: "52",
        }}
      />
    );

    expect(html).toContain("€27,300 estimated annual cash");
    expect(html).toContain("€15/hr × 35 hrs/week");
  });

  it("shows positive-floor validation instead of a hidden zero derivation", () => {
    const html = renderToStaticMarkup(
      <AnnualCashWorksheet
        idPrefix="pay-zero"
        value={{
          hourlyRate: "0",
          hoursPerWeek: "35",
          weeksPerYear: "52",
        }}
      />
    );

    expect(html).toContain("Minimum annual cash earnings must be a positive amount.");
    expect(html).not.toContain("estimated annual cash");
    expect(html).not.toContain("$0/hr × 35 hrs/week");
  });

  it("keeps a sub-unit override visible while rejecting its rounded zero", () => {
    const html = renderToStaticMarkup(
      <AnnualCashWorksheet
        idPrefix="pay-sub-unit"
        value={{
          annualOverride: "0.4",
        }}
      />
    );

    expect(html).toContain('value="0.4"');
    expect(html).toContain("Minimum annual cash earnings must be a positive amount.");
    expect(html).not.toContain("Annual cash floor set to $0");
  });

  it("keeps malformed legacy override text visible while validation explains it", () => {
    const html = renderToStaticMarkup(
      <AnnualCashWorksheet
        idPrefix="pay-legacy"
        value={{
          annualOverride: "not-an-amount",
        }}
      />
    );

    expect(html).toContain('type="text"');
    expect(html).toContain('value="not-an-amount"');
    expect(html).toContain("Minimum annual cash earnings must be a positive amount.");
  });
});
