import type { Fields, Value } from './types.js';
import { serializeError } from './serialize.js';

// A hand-written JSON writer for field values (RFC §13). Strings with nothing to
// escape skip JSON.stringify; everything else is written directly.

// Control characters, quote, backslash, and any surrogate (lone ones must be escaped).
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /[\u0000-\u001F"\\\uD800-\uDFFF]/;

/** How deep nested objects and arrays are written before `"[MaxDepth]"`. */
const MAX_DEPTH = 10;

export function jsonString(value: string): string {
  return NEEDS_ESCAPE.test(value) ? JSON.stringify(value) : `"${value}"`;
}

/** One value as JSON. `undefined` becomes `null` (callers skip undefined members). */
export function jsonValue(value: Value, depth = 0): string {
  switch (typeof value) {
    case 'string': {
      return jsonString(value);
    }
    case 'number': {
      return Number.isFinite(value) ? String(value) : 'null';
    }
    case 'boolean': {
      return value ? 'true' : 'false';
    }
    case 'bigint': {
      return `"${value.toString()}"`;
    }
    case 'undefined': {
      return 'null';
    }
    default: {
      break;
    }
  }
  if (value === null) return 'null';
  if (depth >= MAX_DEPTH) return '"[MaxDepth]"';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'null' : `"${value.toISOString()}"`;
  if (value instanceof Error) return `{${jsonMembers(serializeError(value), depth + 1)}}`;
  if (isValueArray(value)) {
    let out = '[';
    for (const [index, element] of value.entries()) {
      if (index > 0) out += ',';
      out += jsonValue(element, depth + 1);
    }
    return `${out}]`;
  }
  return `{${jsonMembers(value, depth + 1)}}`;
}

/** The members of an object as `"key":value,...`, without braces. Undefined values are skipped. */
export function jsonMembers(fields: Fields, depth = 0): string {
  let out = '';
  for (const key in fields) {
    const value = fields[key];
    if (value === undefined) continue;
    if (out !== '') out += ',';
    out += `${jsonString(key)}:${jsonValue(value, depth)}`;
  }
  return out;
}

/** A value as it appears inside a rendered message: strings as they are, the rest as JSON. */
export function formatValue(value: Value): string {
  switch (typeof value) {
    case 'string': {
      return value;
    }
    case 'number':
    case 'boolean':
    case 'bigint': {
      return String(value);
    }
    case 'undefined': {
      return 'undefined';
    }
    default: {
      break;
    }
  }
  if (value === null) return 'null';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return jsonValue(value);
}

export function isValueArray(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

/** A plain field map: not an array, Date or Error. */
export function isFieldMap(value: Value): value is Fields {
  return (
    typeof value === 'object' &&
    value !== null &&
    !isValueArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Error)
  );
}
