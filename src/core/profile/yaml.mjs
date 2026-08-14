// Dependency-free YAML reader/writer for CareerRat's candidate-config subset.
// Supports: block mappings, block sequences (scalars and mapping-items),
// nested structures, quoted/unquoted scalars, booleans, numbers, null,
// empty/flow empties ([] {}), and full-line / inline comments.

// ---------------------------------------------------------------------------
// parseYaml
// ---------------------------------------------------------------------------

export function parseYaml(text) {
  if (text == null) return null; // empty document
  if (typeof text !== "string") {
    throw new TypeError(`parseYaml expects a string, got ${typeof text}`);
  }
  const lines = text.split("\n");
  const tokens = tokenize(lines);
  if (tokens.length === 0) return null;
  const result = parseValue(tokens, 0);
  return result.value;
}

// ---------------------------------------------------------------------------
// Tokenizer: converts raw lines into structured tokens
// ---------------------------------------------------------------------------

function tokenize(lines) {
  const tokens = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Count leading spaces for indent level.
    const indent = countIndent(raw);
    const trimmed = raw.trim();

    // Skip blank lines.
    if (trimmed === "") continue;

    // Skip full-line comments.
    if (trimmed.startsWith("#")) continue;

    // Determine if this is a sequence item line.
    if (trimmed.startsWith("- ") || trimmed === "-") {
      const afterDash = trimmed.slice(2); // may be empty
      tokens.push({ kind: "seq-item", indent, content: stripInlineComment(afterDash), raw });
    } else {
      // Mapping or scalar.
      const colonIdx = findMappingColon(trimmed);
      if (colonIdx !== -1) {
        const key = trimmed.slice(0, colonIdx).trim();
        const afterColon = trimmed.slice(colonIdx + 1).trim();
        const value = stripInlineComment(afterColon);
        tokens.push({ kind: "mapping", indent, key, value, raw });
      } else {
        // Plain scalar (shouldn't appear at top level in our subset, but handle it).
        tokens.push({ kind: "scalar", indent, content: stripInlineComment(trimmed), raw });
      }
    }
  }
  return tokens;
}

// Find the colon that separates key: value in a mapping line.
// Must be `key:` where the colon is followed by space, end-of-string, or comment.
// Keys may not contain colons (in this subset).
function findMappingColon(s) {
  // Walk character by character; skip quoted strings.
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++;
        i++;
      }
      i++; // closing quote
    } else if (ch === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") break;
        i++;
      }
      i++; // closing quote
    } else if (ch === ":") {
      const next = s[i + 1];
      if (next === undefined || next === " " || next === "\t" || next === "#") {
        return i;
      }
      i++;
    } else {
      i++;
    }
  }
  return -1;
}

// Strip an inline comment: text after ` #` that is not inside a quoted string.
// Also handles the case where the entire value is a comment (starts with `#`).
function stripInlineComment(s) {
  if (s === "") return s;
  // If the entire value after the colon is a comment, treat as empty.
  if (s.startsWith("#")) return "";
  // Walk to find first unquoted ` #` or `\t#`.
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++;
        i++;
      }
      i++;
    } else if (ch === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") break;
        i++;
      }
      i++;
    } else if ((ch === " " || ch === "\t") && s[i + 1] === "#") {
      return s.slice(0, i).trim();
    } else {
      i++;
    }
  }
  return s;
}

function countIndent(line) {
  let count = 0;
  while (count < line.length && line[count] === " ") count++;
  return count;
}

// ---------------------------------------------------------------------------
// Recursive descent over tokens
// ---------------------------------------------------------------------------

// parseValue: starting at tokens[pos], parse a value.
// Returns { value, nextPos }.
// We look ahead at the first token to decide what to parse.
function parseValue(tokens, pos) {
  if (pos >= tokens.length) return { value: null, nextPos: pos };

  const tok = tokens[pos];
  const indent = tok.indent;

  if (tok.kind === "seq-item") {
    return parseSequence(tokens, pos, indent);
  }
  if (tok.kind === "mapping") {
    return parseMapping(tokens, pos, indent);
  }
  // scalar
  return { value: parseScalar(tok.content), nextPos: pos + 1 };
}

// Parse a block mapping starting at tokens[pos], all at `indent` level.
function parseMapping(tokens, pos, indent) {
  const obj = {};
  while (pos < tokens.length) {
    const tok = tokens[pos];
    if (tok.indent !== indent) break;
    if (tok.kind !== "mapping") break;

    const key = tok.key;
    const rawVal = tok.value;
    pos++;

    // Determine the value.
    if (rawVal === "" || rawVal === null) {
      // Could be a nested block or null.
      // Peek at next token.
      if (pos < tokens.length && tokens[pos].indent > indent) {
        const next = tokens[pos];
        if (next.kind === "seq-item") {
          const r = parseSequence(tokens, pos, next.indent);
          obj[key] = r.value;
          pos = r.nextPos;
        } else if (next.kind === "mapping") {
          const r = parseMapping(tokens, pos, next.indent);
          obj[key] = r.value;
          pos = r.nextPos;
        } else {
          obj[key] = parseScalar(next.content);
          pos++;
        }
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = parseScalar(rawVal);
    }
  }
  return { value: obj, nextPos: pos };
}

// Parse a block sequence starting at tokens[pos], all at `indent` level.
function parseSequence(tokens, pos, indent) {
  const arr = [];
  while (pos < tokens.length) {
    const tok = tokens[pos];
    if (tok.indent !== indent) break;
    if (tok.kind !== "seq-item") break;

    const content = tok.content;
    pos++;

    if (content === "" || content === null) {
      // Sequence item with no inline content — check for nested block.
      if (pos < tokens.length && tokens[pos].indent > indent) {
        const next = tokens[pos];
        if (next.kind === "seq-item") {
          const r = parseSequence(tokens, pos, next.indent);
          arr.push(r.value);
          pos = r.nextPos;
        } else {
          const r = parseMapping(tokens, pos, next.indent);
          arr.push(r.value);
          pos = r.nextPos;
        }
      } else {
        arr.push(null);
      }
    } else {
      // Inline content after `- `. Could be a scalar or start of a mapping.
      const colonIdx = findMappingColon(content);
      if (colonIdx !== -1) {
        // Mapping item: `- key: value` with optional continuation lines.
        const itemObj = {};
        const firstKey = content.slice(0, colonIdx).trim();
        const firstVal = stripInlineComment(content.slice(colonIdx + 1).trim());
        // The continuation lines have indent = tok.indent + 2 (aligned past the dash).
        const contIndent = indent + 2;

        if (firstVal === "" || firstVal === null) {
          // Nested block under the first key.
          if (pos < tokens.length && tokens[pos].indent > indent) {
            const next = tokens[pos];
            if (next.kind === "seq-item") {
              const r = parseSequence(tokens, pos, next.indent);
              itemObj[firstKey] = r.value;
              pos = r.nextPos;
            } else {
              const r = parseMapping(tokens, pos, next.indent);
              itemObj[firstKey] = r.value;
              pos = r.nextPos;
            }
          } else {
            itemObj[firstKey] = null;
          }
        } else {
          itemObj[firstKey] = parseScalar(firstVal);
        }

        // Continuation: mapping keys at contIndent level.
        while (
          pos < tokens.length &&
          tokens[pos].indent === contIndent &&
          tokens[pos].kind === "mapping"
        ) {
          const ct = tokens[pos];
          pos++;
          if (ct.value === "" || ct.value === null) {
            // Nested block under this key.
            if (pos < tokens.length && tokens[pos].indent > contIndent) {
              const next = tokens[pos];
              if (next.kind === "seq-item") {
                const r = parseSequence(tokens, pos, next.indent);
                itemObj[ct.key] = r.value;
                pos = r.nextPos;
              } else {
                const r = parseMapping(tokens, pos, next.indent);
                itemObj[ct.key] = r.value;
                pos = r.nextPos;
              }
            } else {
              itemObj[ct.key] = null;
            }
          } else {
            itemObj[ct.key] = parseScalar(ct.value);
          }
        }

        arr.push(itemObj);
      } else {
        // Plain scalar item.
        arr.push(parseScalar(content));
      }
    }
  }
  return { value: arr, nextPos: pos };
}

// Parse a scalar string to its JS value.
function parseScalar(s) {
  if (s === null || s === undefined) return null;
  const t = s.trim();

  // Flow empties.
  if (t === "[]") return [];
  if (t === "{}") return {};

  // Empty / explicit null.
  if (t === "" || t === "null" || t === "~") return null;

  // Double-quoted string.
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    const inner = t.slice(1, -1);
    return inner.replace(/\\(["\\n])/g, (_, c) => (c === "n" ? "\n" : c));
  }

  // Single-quoted string.
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }

  // A scalar that opens with a quote but did not close as a valid quoted string
  // (e.g. a truncated `"Alice`) is malformed — throw loudly instead of silently
  // returning a string with a stray quote, which fails confusingly downstream.
  if (t.startsWith('"') || t.startsWith("'")) {
    throw new SyntaxError(`Unterminated quoted string in YAML scalar: ${t}`);
  }

  // Boolean.
  if (t === "true") return true;
  if (t === "false") return false;

  // Number: integer or decimal, optional leading minus.
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);

  // Fallback: plain string.
  return t;
}

// ---------------------------------------------------------------------------
// stringifyYaml
// ---------------------------------------------------------------------------

export function stringifyYaml(value) {
  return stringifyValue(value, 0);
}

function stringifyValue(value, indent) {
  if (value === null || value === undefined) {
    // Inline null is handled by caller for mapping values; top-level null → empty string.
    return "";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return quoteString(value);
  }
  if (Array.isArray(value)) {
    return stringifyArray(value, indent);
  }
  if (typeof value === "object") {
    return stringifyObject(value, indent);
  }
  return String(value);
}

function stringifyObject(obj, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    lines.push(...stringifyKeyValue(key, val, indent, pad));
  }
  return lines.join("\n");
}

function stringifyKeyValue(key, val, indent, pad) {
  const lines = [];
  if (val === null || val === undefined) {
    lines.push(`${pad}${key}:`);
  } else if (Array.isArray(val)) {
    if (val.length === 0) {
      lines.push(`${pad}${key}: []`);
    } else {
      lines.push(`${pad}${key}:`);
      const childPad = " ".repeat(indent + 2);
      for (const item of val) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          // Sequence of mappings: first key on dash line, rest indented.
          const entries = Object.entries(item);
          if (entries.length === 0) {
            lines.push(`${childPad}-`);
          } else {
            const [firstKey, firstVal] = entries[0];
            const firstValStr = inlineScalar(firstVal);
            if (firstValStr === null) {
              // Nested object/array for first key — put key on dash line with empty, block after.
              lines.push(`${childPad}- ${firstKey}:`);
              const nested = stringifyValue(firstVal, indent + 4);
              for (const nl of nested.split("\n")) {
                lines.push(nl);
              }
            } else {
              lines.push(`${childPad}- ${firstKey}: ${firstValStr}`);
            }
            for (let i = 1; i < entries.length; i++) {
              const [k, v] = entries[i];
              const sub = " ".repeat(indent + 4);
              const subLines = stringifyKeyValue(k, v, indent + 4, sub);
              lines.push(...subLines);
            }
          }
        } else {
          // Scalar item.
          lines.push(`${childPad}- ${stringifyValue(item, indent + 2)}`);
        }
      }
    }
  } else if (typeof val === "object") {
    const entries = Object.entries(val);
    if (entries.length === 0) {
      lines.push(`${pad}${key}: {}`);
    } else {
      lines.push(`${pad}${key}:`);
      const nested = stringifyObject(val, indent + 2);
      for (const nl of nested.split("\n")) {
        lines.push(nl);
      }
    }
  } else {
    lines.push(`${pad}${key}: ${stringifyValue(val, indent)}`);
  }
  return lines;
}

// Returns the inline string for a scalar value, or null if the value is
// an object/array that needs a block.
function inlineScalar(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  if (typeof val === "string") return quoteString(val);
  return null; // object/array — caller must handle as block
}

function stringifyArray(arr, indent) {
  if (arr.length === 0) return "[]";
  const pad = " ".repeat(indent);
  const lines = [];
  for (const item of arr) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (entries.length === 0) {
        lines.push(`${pad}-`);
      } else {
        const [firstKey, firstVal] = entries[0];
        const firstValStr = inlineScalar(firstVal);
        if (firstValStr === null) {
          lines.push(`${pad}- ${firstKey}:`);
          const nested = stringifyValue(firstVal, indent + 2);
          for (const nl of nested.split("\n")) lines.push(nl);
        } else {
          lines.push(`${pad}- ${firstKey}: ${firstValStr}`);
        }
        for (let i = 1; i < entries.length; i++) {
          const [k, v] = entries[i];
          const sub = " ".repeat(indent + 2);
          const subLines = stringifyKeyValue(k, v, indent + 2, sub);
          lines.push(...subLines);
        }
      }
    } else {
      lines.push(`${pad}- ${stringifyValue(item, indent)}`);
    }
  }
  return lines.join("\n");
}

// Determine if a string needs quoting, and return the quoted/bare form.
function quoteString(s) {
  if (needsQuotes(s)) {
    const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    return `"${escaped}"`;
  }
  return s;
}

function needsQuotes(s) {
  if (s === "") return true;
  if (s.trim() !== s) return true; // leading/trailing whitespace
  // Would parse as a special scalar type.
  if (s === "true" || s === "false") return true;
  if (s === "null" || s === "~") return true;
  if (/^-?\d+$/.test(s)) return true;
  if (/^-?\d+\.\d+$/.test(s)) return true;
  if (s === "[]" || s === "{}") return true;
  // Contains characters that are problematic unquoted.
  if (s.includes(":")) return true;
  if (s.includes("#")) return true;
  if (s.startsWith("-")) return true;
  if (s.startsWith('"') || s.startsWith("'")) return true;
  return false;
}
