import type { Fields, Value } from './types.js';

/** How deep `serializeError` walks causes, aggregate members and nested values. */
export const MAX_ERROR_DEPTH = 8;

const SPECIAL_KEYS = new Set(['name', 'message', 'stack', 'code', 'cause', 'errors']);

/**
 * Turns an `Error` into plain fields (RFC §5.3): `name`, `message`, `stack`,
 * `code`, own enumerable fields, the `cause` chain and `AggregateError.errors`.
 * Depth and cycles are bounded. Own accessors are never called, except the
 * engine's `stack`, `name` and `message`, which are read inside `try`.
 */
export function serializeError(error: Error): Fields {
  return walkError(error, 0, new Set());
}

function walkError(error: Error, depth: number, seen: Set<object>): Fields {
  seen.add(error);
  const out: Record<string, Value> = {
    name: read(() => error.name) ?? 'Error',
    message: read(() => error.message) ?? '',
  };
  const stack = read(() => error.stack);
  if (stack !== undefined) out.stack = stack;
  const code = ownData(error, 'code');
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  for (const key of Object.keys(error)) {
    if (SPECIAL_KEYS.has(key)) continue;
    const value = ownData(error, key);
    const converted = toValue(value, depth + 1, seen);
    if (converted !== undefined) out[key] = converted;
  }
  const cause = ownData(error, 'cause');
  if (cause !== undefined) out.cause = toValue(cause, depth + 1, seen);
  const errors = ownData(error, 'errors');
  if (Array.isArray(errors)) out.errors = toValue(errors, depth + 1, seen);
  seen.delete(error);
  return out;
}

/** Converts anything into a `Value`, bounding depth and cycles and never calling getters. */
export function toValue(value: unknown, depth: number, seen: Set<object>): Value {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined': {
      return value;
    }
    case 'symbol': {
      return value.toString();
    }
    case 'function': {
      return undefined;
    }
    default: {
      break;
    }
  }
  if (value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  if (depth > MAX_ERROR_DEPTH) return '[MaxDepth]';
  if (value instanceof Error) return walkError(value, depth, seen);
  seen.add(value);
  let out: Value;
  if (Array.isArray(value)) {
    const items: Value[] = [];
    for (const item of value) items.push(toValue(item, depth + 1, seen));
    out = items;
  } else {
    const object: Record<string, Value> = {};
    for (const key of Object.keys(value)) {
      const converted = toValue(ownData(value, key), depth + 1, seen);
      if (converted !== undefined) object[key] = converted;
    }
    out = object;
  }
  seen.delete(value);
  return out;
}

/** An own data property's value; `undefined` for accessors and missing keys. */
function ownData(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function read(get: () => unknown): string | undefined {
  try {
    const value = get();
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
