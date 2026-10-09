/**
 * Non-negative 32-bit hash of `text` over its UTF-16 code units: the classic `h * 31 + unit`
 * (Java `String.hashCode`) with the sign dropped. Stable across runtimes and releases, so it is safe
 * for picking a deterministic variant (`hashCode(id) % variants.length`) or a cache key. Not
 * cryptographic and not collision-resistant.
 */
export function hashCode(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    // eslint-disable-next-line unicorn/prefer-math-trunc, unicorn/prefer-code-point -- int32 wrap-around over UTF-16 units is the Java contract
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}
