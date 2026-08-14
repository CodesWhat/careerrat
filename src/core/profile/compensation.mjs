const ARRANGEMENT_FLOOR_KEYS = ["remote", "hybrid", "onsite", "relocation"];

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function hasConfiguredCompensationFloor(compensation = {}) {
  if (positiveNumber(compensation.minimum_base)) return true;
  const floors = compensation.comp_floors ?? {};
  return ARRANGEMENT_FLOOR_KEYS.some((key) => positiveNumber(floors[key]));
}
