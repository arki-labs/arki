/**
 * A value as JSON text for a log line or an assertion message. Never throws, so a helper that only
 * reports a value cannot fail on it: a bigint prints as `12n`, and a value JSON cannot hold (a cycle, a
 * throwing `toJSON`) prints as its tag, such as `[object Object]`. Internal: not a package export.
 */
export function formatValue(value: unknown, indent?: number): string {
  // JSON has no text for these: `JSON.stringify` returns `undefined`, though its type says `string`.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return String(value);
  try {
    return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item), indent);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
