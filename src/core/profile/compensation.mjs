const ARRANGEMENT_FLOOR_KEYS = ["remote", "hybrid", "onsite", "relocation"];

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function hasConfiguredCompensationFloor(compensation = {}) {
  if (positiveNumber(compensation.minimum_base)) return true;
  if (positiveNumber(compensation.minimum_annual_earnings)) return true;
  const floors = compensation.comp_floors ?? {};
  return ARRANGEMENT_FLOOR_KEYS.some((key) => positiveNumber(floors[key]));
}

export function compareCompensationBandToFloor(band, floor) {
  if (!positiveNumber(floor)) return "no-floor";
  const min = Number(band?.min);
  const max = Number(band?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "unknown";
  if (max < Number(floor)) return "below";
  if (min < Number(floor)) return "overlap";
  return "clear";
}

export function assessCompensationFloors({
  baseBand,
  annualEarningsBand,
  minimumBase,
  minimumAnnualEarnings,
} = {}) {
  const base = compareCompensationBandToFloor(baseBand, minimumBase);
  let annualEarnings = compareCompensationBandToFloor(annualEarningsBand, minimumAnnualEarnings);
  if (annualEarnings === "unknown" && baseBand) {
    const guaranteedStanding = compareCompensationBandToFloor(baseBand, minimumAnnualEarnings);
    annualEarnings = guaranteedStanding === "below" ? "unknown" : guaranteedStanding;
  }
  return { base, annualEarnings };
}
