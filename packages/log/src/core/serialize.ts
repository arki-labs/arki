import type { FailureLike, Fields, Value } from './types.js';

/** How deep `serializeError` walks causes, aggregate members and nested values. */
export const MAX_ERROR_DEPTH = 8;

/** Longest cause chain `serializeFailure` lists: the limit `findCause` in `@arki/failure` walks. */
export const MAX_CAUSE_LINKS = 64;

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
  const out = errorFields(error, depth, seen);
  const cause = ownData(error, 'cause');
  if (cause !== undefined) out.cause = toValue(cause, depth + 1, seen);
  seen.delete(error);
  return out;
}

/** An error's fields without its `cause`: the caller decides how the chain is shown. */
function errorFields(error: Error, depth: number, seen: Set<object>): Record<string, Value> {
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
  const errors = ownData(error, 'errors');
  if (Array.isArray(errors)) out.errors = toValue(errors, depth + 1, seen);
  return out;
}

/**
 * True for a failure value from `@arki/failure`. Seen by its brand, the
 * `'~failure'` key on its prototype, so `@arki/log` keeps zero dependencies.
 * The same check as `isFailure`.
 */
export function isFailureLike(value: unknown): value is FailureLike {
  return typeof value === 'object' && value !== null && '~failure' in value;
}

/**
 * Turns a failure from `@arki/failure` into plain fields: `code`, `message`,
 * `status`, `data`, `remediation`, and `causes`, its cause chain as a list
 * from nearest to root. A link is a failure's fields or an error's fields;
 * an error's own causes join the same list. The list stops after
 * {@link MAX_CAUSE_LINKS} links (`'[MaxDepth]'`) or at a cycle (`'[Circular]'`).
 */
export function serializeFailure(failure: FailureLike): Fields {
  return walkFailure(failure, 0, new Set());
}

function walkFailure(failure: FailureLike, depth: number, seen: Set<object>): Fields {
  seen.add(failure);
  const out = ownFields(failure, depth, seen);
  const links: object[] = [];
  const causes: Value[] = [];
  let link = failureCause(failure);
  while (link !== undefined) {
    if (causes.length === MAX_CAUSE_LINKS) {
      causes.push('[MaxDepth]');
      break;
    }
    if (typeof link === 'object' && link !== null && seen.has(link)) {
      causes.push('[Circular]');
      break;
    }
    if (isFailureLike(link)) {
      seen.add(link);
      links.push(link);
      causes.push(ownFields(link, depth + 1, seen));
      link = failureCause(link);
    } else if (link instanceof Error) {
      seen.add(link);
      links.push(link);
      causes.push(errorFields(link, depth + 1, seen));
      link = ownData(link, 'cause');
    } else {
      causes.push(toValue(link, depth + 1, seen));
      break;
    }
  }
  if (causes.length > 0) out.causes = causes;
  for (const visited of links) seen.delete(visited);
  seen.delete(failure);
  return out;
}

/** A failure's `cause`. It is a getter on the failure's prototype, so read it inside `try`. */
function failureCause(failure: FailureLike): unknown {
  try {
    return failure.cause;
  } catch {
    return undefined;
  }
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
  if (isFailureLike(value)) return walkFailure(value, depth, seen);
  seen.add(value);
  let out: Value;
  if (Array.isArray(value)) {
    const items: Value[] = [];
    for (const item of value) items.push(toValue(item, depth + 1, seen));
    out = items;
  } else {
    out = ownFields(value, depth, seen);
  }
  seen.delete(value);
  return out;
}

/** An object's own enumerable data fields, each converted. */
function ownFields(value: object, depth: number, seen: Set<object>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const key of Object.keys(value)) {
    const converted = toValue(ownData(value, key), depth + 1, seen);
    if (converted !== undefined) out[key] = converted;
  }
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
