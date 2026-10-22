/** The image formats every image-capable adapter here takes. */
export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The media type an image's first bytes announce, or `undefined` for a format no provider here takes. */
export function imageMimeType(bytes: Uint8Array): string | undefined {
  const starts = (...prefix: number[]): boolean => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4E, 0x47)) return 'image/png';
  if (starts(0xFF, 0xD8, 0xFF)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  // RIFF, a 4-byte size, then WEBP.
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}
