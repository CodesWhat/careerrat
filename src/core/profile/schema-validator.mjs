// Dependency-free JSON Schema (draft-2020-12 subset) validator for CareerRat.
// Supports the exact keyword subset used by config/*.schema.json.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * validate(data, schema) → { valid: boolean, errors: Array<{ path, message }> }
 */
export function validate(data, schema) {
  const errors = [];
  validateNode(data, schema, "", errors);
  return { valid: errors.length === 0, errors };
}

/**
 * formatErrors(errors) → string, one "path: message" per line.
 * A path of "" is shown as "(root)".
 */
export function formatErrors(errors) {
  return errors.map((e) => `${e.path === "" ? "(root)" : e.path}: ${e.message}`).join("\n");
}

// ---------------------------------------------------------------------------
// Core recursive validator
// ---------------------------------------------------------------------------

function validateNode(data, schema, path, errors) {
  if (schema === true || schema == null) return; // permissive
  if (schema === false) {
    errors.push({ path, message: "schema is false: no value is valid" });
    return;
  }

  // Keywords we intentionally ignore:
  // $schema, $id, title, default, description

  // --- type ---
  if (schema.type !== undefined) {
    if (!checkType(data, schema.type)) {
      const got = jsType(data);
      const expected = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
      errors.push({ path, message: `expected type ${expected}, got ${got}` });
      // Still continue to validate other keywords where possible.
    }
  }

  // --- enum ---
  if (schema.enum !== undefined) {
    const match = schema.enum.some((allowed) => deepEqual(data, allowed));
    if (!match) {
      errors.push({
        path,
        message: `value ${JSON.stringify(data)} is not one of the allowed values`,
      });
    }
  }

  // --- const ---
  if (schema.const !== undefined && !deepEqual(data, schema.const)) {
    errors.push({
      path,
      message: `value ${JSON.stringify(data)} must equal ${JSON.stringify(schema.const)}`,
    });
  }

  // --- numeric range ---
  if (typeof data === "number" && Number.isFinite(data)) {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push({ path, message: `must be at least ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push({ path, message: `must be at most ${schema.maximum}` });
    }
  }

  // --- string length ---
  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push({ path, message: `must have at least ${schema.minLength} characters` });
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      errors.push({ path, message: `must have at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(data)) {
      errors.push({
        path,
        message: `must match pattern ${JSON.stringify(schema.pattern)}`,
      });
    }
    if (schema.format === "date-time" && !isRfc3339DateTime(data)) {
      errors.push({ path, message: "must be a valid date-time" });
    }
  }

  // --- properties + required + additionalProperties ---
  if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const knownKeys = new Set(schema.properties ? Object.keys(schema.properties) : []);

      // required
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!(key in data)) {
            errors.push({
              path,
              message: `missing required property "${key}"`,
            });
          }
        }
      }

      // properties — validate present keys against their subschemas
      if (schema.properties) {
        for (const [key, subschema] of Object.entries(schema.properties)) {
          if (key in data) {
            validateNode(data[key], subschema, joinPath(path, key), errors);
          }
        }
      }

      // propertyNames
      if (schema.propertyNames !== undefined) {
        for (const key of Object.keys(data)) {
          const propertyErrors = [];
          validateNode(key, schema.propertyNames, path, propertyErrors);
          for (const error of propertyErrors) {
            errors.push({
              path,
              message: `property name ${JSON.stringify(key)} ${error.message}`,
            });
          }
        }
      }

      // additionalProperties
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        for (const key of Object.keys(data)) {
          if (knownKeys.has(key)) continue;
          if (schema.additionalProperties === false) {
            errors.push({
              path: joinPath(path, key),
              message: `unexpected property "${key}"`,
            });
          } else if (typeof schema.additionalProperties === "object") {
            // Validate each additional property against the subschema.
            validateNode(data[key], schema.additionalProperties, joinPath(path, key), errors);
          }
        }
      }
    }
  }

  // --- array length ---
  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items` });
    }
  }

  // --- items ---
  if (schema.items !== undefined) {
    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        validateNode(data[i], schema.items, `${path}[${i}]`, errors);
      }
    }
  }

  // --- anyOf ---
  if (schema.anyOf !== undefined) {
    let matched = false;
    for (const subschema of schema.anyOf) {
      const sub = [];
      validateNode(data, subschema, path, sub);
      if (sub.length === 0) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      errors.push({
        path,
        message: "does not match any of the allowed shapes (anyOf)",
      });
    }
  }

  // --- allOf ---
  if (schema.allOf !== undefined) {
    for (const subschema of schema.allOf) {
      validateNode(data, subschema, path, errors);
    }
  }

  // --- if / then / else ---
  if (schema.if !== undefined) {
    const conditionErrors = [];
    validateNode(data, schema.if, path, conditionErrors);
    if (conditionErrors.length === 0) {
      if (schema.then !== undefined) validateNode(data, schema.then, path, errors);
    } else if (schema.else !== undefined) {
      validateNode(data, schema.else, path, errors);
    }
  }
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

function jsType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "string", "number", "boolean", "object"
}

function checkType(value, typeSpec) {
  const types = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
  const actual = jsType(value);
  for (const t of types) {
    if (t === "number" && actual === "number") return true;
    if (t === "integer" && actual === "number") return true; // treat integer as number
    if (t === actual) return true;
  }
  return false;
}

function isRfc3339DateTime(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/
  );
  if (!match) return false;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zoneHourText,
    zoneMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneHour = zoneHourText === undefined ? 0 : Number(zoneHourText);
  const zoneMinute = zoneMinuteText === undefined ? 0 : Number(zoneMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    zoneHour <= 23 &&
    zoneMinute <= 59
  );
}

// ---------------------------------------------------------------------------
// Deep equality for enum checks
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function joinPath(parent, key) {
  if (parent === "") return String(key);
  return `${parent}.${key}`;
}
