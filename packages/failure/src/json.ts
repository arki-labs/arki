/**
 * A lossless JSON representation, with sorted object keys for comparison.
 * Unlike JSON.stringify, this rejects values JSON silently drops or transforms.
 * Descriptors keep getters and toJSON hooks from executing at a wire boundary.
 */
export function jsonText(value: unknown, seen = new Set<object>(), depth = 0): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number')
    return Number.isFinite(value) && !Object.is(value, -0) ? JSON.stringify(value) : undefined;
  if (typeof value !== 'object' || depth > 64 || seen.has(value)) return undefined;
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) return undefined;
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return undefined;
    const keys = Object.keys(descriptors).filter(key => !(array && key === 'length'));
    if (array && (keys.length !== descriptors.length?.value || keys.some((key, index) => key !== String(index)))) {
      return undefined;
    }
    const parts: string[] = [];
    for (const key of array ? keys : keys.sort()) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return undefined;
      const text = jsonText(descriptor.value, seen, depth + 1);
      if (text === undefined) return undefined;
      parts.push(array ? text : `${JSON.stringify(key)}:${text}`);
    }
    return array ? `[${parts.join(',')}]` : `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
