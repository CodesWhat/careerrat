import { useState } from "react";

import {
  calculateAnnualCashWorksheet,
  formatAnnualCashAmount,
  normalizeAnnualCashWorksheet,
} from "./annual-cash-worksheet.js";
import "./annual-cash-worksheet.css";

const INPUTS = [
  { id: "hourlyRate", label: "Hourly wage", step: "0.01", placeholder: "15" },
  { id: "hoursPerWeek", label: "Paid hours per week", step: "0.5", placeholder: "35" },
  { id: "weeklyPay", label: "Flat weekly pay", step: "0.01", placeholder: "800" },
  { id: "monthlyPay", label: "Flat monthly pay", step: "0.01", placeholder: "3500" },
  {
    id: "cashPerShift",
    label: "Expected tips, commission, or cash bonuses per shift",
    step: "0.01",
    placeholder: "300",
  },
  { id: "shiftsPerWeek", label: "Shifts per week", step: "0.5", placeholder: "4" },
  { id: "weeksPerYear", label: "Working weeks per year", step: "1", placeholder: "52" },
];

export function AnnualCashWorksheet({
  idPrefix,
  name,
  value,
  onChange,
  disabled = false,
  currency = "USD",
}) {
  const [localValue, setLocalValue] = useState(() => normalizeAnnualCashWorksheet(value));
  const worksheet = onChange ? normalizeAnnualCashWorksheet(value) : localValue;
  const calculation = calculateAnnualCashWorksheet(worksheet, { currency });
  const update = (field, nextValue) => {
    const next = { ...worksheet, [field]: nextValue };
    if (onChange) onChange(next);
    else setLocalValue(next);
  };

  return (
    <fieldset className="cf-annual-cash" disabled={disabled}>
      <legend>Minimum annual cash earnings: hourly and tipped pay worksheet</legend>
      <p>
        Optional. Enter the pieces you know. CareerRat shows the yearly arithmetic before saving
        only the annual cash floor.
      </p>
      <div className="cf-annual-cash__inputs">
        {INPUTS.map((input) => {
          const inputId = `${idPrefix}-${input.id}`;
          return (
            <label htmlFor={inputId} key={input.id}>
              <span>{input.label}</span>
              <input
                id={inputId}
                type="number"
                min="0"
                max={input.id === "weeksPerYear" ? "52" : undefined}
                step={input.step}
                value={worksheet[input.id]}
                placeholder={input.placeholder}
                onChange={(event) => update(input.id, event.target.value)}
              />
            </label>
          );
        })}
      </div>
      <label htmlFor={`${idPrefix}-annualOverride`}>
        <span>Annual cash floor override</span>
        <input
          id={`${idPrefix}-annualOverride`}
          type="text"
          inputMode="decimal"
          value={worksheet.annualOverride}
          placeholder={calculation.annual ? String(calculation.annual) : "85000"}
          onChange={(event) => update("annualOverride", event.target.value)}
        />
      </label>
      <output aria-live="polite">
        {calculation.error
          ? calculation.error
          : calculation.annual
            ? `${formatAnnualCashAmount(calculation.annual, { currency })} estimated annual cash. ${calculation.formula}.`
            : "Add wage details or enter an annual cash floor override."}
      </output>
      {name ? <input type="hidden" name={name} value={JSON.stringify(worksheet)} /> : null}
    </fieldset>
  );
}
