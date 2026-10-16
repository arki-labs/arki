/**
 * Reading values of unknown shape (response bodies, SDK errors, template input) without casts.
 * Each helper returns `undefined` when the value does not have the expected shape.
 */

/** `value[key]` when `value` is an object that has `key`; otherwise `undefined`. */
export function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key);
}

/** `value` when it is a string. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `value` when it is an array of strings. Non-string items are dropped. */
export function stringsOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item: unknown): item is string => typeof item === 'string');
}
