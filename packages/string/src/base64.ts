import { defineFailure, isFailure } from '@arki/failure';

/**
 * Base64 and UTF-8 without `Buffer`, `atob`, or `btoa`, so the same code runs
 * in Node, Bun, browsers, and Hermes. Text functions are UTF-8; byte functions
 * take and return `Uint8Array`. Decoding is strict: malformed base64 returns
 * `InvalidBase64`, invalid UTF-8 returns `InvalidUtf8`. Successes are unwrapped.
 */

/** Invalid UTF-8. No submitted text or bytes are exposed.
 * @fix Pass well-formed text or valid UTF-8 bytes.
 * @verify bun run test
 */
export const InvalidUtf8 = defineFailure('string.invalid_utf8', {
  status: 400,
  message: 'Text or bytes are not valid UTF-8.',
  remediation: 'Pass well-formed text without lone surrogates or valid UTF-8 bytes.',
});

/** Noncanonical base64. No submitted input is exposed.
 * @fix Use the selected alphabet, correct padding, and zero unused bits.
 * @verify bun run test
 */
export const InvalidBase64 = defineFailure('string.invalid_base64', {
  status: 400,
  message: 'Input is not strict base64.',
  remediation: 'Use the selected base64 alphabet, correct padding, and zero unused bits without whitespace.',
});

export type Base64Options = Readonly<{
  /** `standard` uses `+` and `/`; `url` uses `-` and `_` (RFC 4648 §5). Defaults to `standard`. */
  alphabet?: 'standard' | 'url';
  /** Whether `=` padding must be present or absent. Defaults to `required` for `standard`, `forbidden` for `url`. */
  padding?: 'required' | 'forbidden';
}>;

const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function lookupTable(alphabet: string): Int16Array {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.codePointAt(index) ?? 0] = index;
  return table;
}

const STANDARD_LOOKUP = lookupTable(STANDARD_ALPHABET);
const URL_LOOKUP = lookupTable(URL_ALPHABET);

function resolve(options: Base64Options): { alphabet: string; lookup: Int16Array; padded: boolean } {
  const url = options.alphabet === 'url';
  const padded = options.padding === undefined ? !url : options.padding === 'required';
  return { alphabet: url ? URL_ALPHABET : STANDARD_ALPHABET, lookup: url ? URL_LOOKUP : STANDARD_LOOKUP, padded };
}

/** UTF-8 byte length of `text`. Returns `InvalidUtf8` on an unpaired surrogate. */
export function byteLength(text: string) {
  let total = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 0xd8_00 && cp <= 0xdf_ff) return InvalidUtf8();
    total += cp < 0x80 ? 1 : cp < 0x8_00 ? 2 : cp < 0x1_00_00 ? 3 : 4;
  }
  return total;
}

/** Encodes `text` as UTF-8. Returns `InvalidUtf8` on an unpaired surrogate. */
export function utf8Encode(text: string) {
  const length = byteLength(text);
  if (isFailure(length)) return length;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      bytes[offset++] = cp;
    } else if (cp < 0x8_00) {
      bytes[offset++] = 0xc0 | (cp >> 6);
      bytes[offset++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x1_00_00) {
      bytes[offset++] = 0xe0 | (cp >> 12);
      bytes[offset++] = 0x80 | ((cp >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (cp & 0x3f);
    } else {
      bytes[offset++] = 0xf0 | (cp >> 18);
      bytes[offset++] = 0x80 | ((cp >> 12) & 0x3f);
      bytes[offset++] = 0x80 | ((cp >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (cp & 0x3f);
    }
  }
  return bytes;
}

function continuation(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined || (byte & 0xc0) !== 0x80) return -1;
  return byte & 0x3f;
}

/** Decodes strict UTF-8. Overlong forms, surrogates, and truncated sequences return `InvalidUtf8`. A leading BOM is kept. */
export function utf8Decode(bytes: Uint8Array) {
  const codePoints: number[] = [];
  let output = '';
  const flush = (): void => {
    output += String.fromCodePoint(...codePoints);
    codePoints.length = 0;
  };

  let index = 0;
  while (index < bytes.length) {
    const b0 = bytes[index] ?? 0;
    const b1 = continuation(bytes, index + 1);
    const b2 = continuation(bytes, index + 2);
    const b3 = continuation(bytes, index + 3);
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      index += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      if (b1 < 0) return InvalidUtf8();
      cp = ((b0 & 0x1f) << 6) | b1;
      if (cp < 0x80) return InvalidUtf8();
      index += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      if (b1 < 0 || b2 < 0) return InvalidUtf8();
      cp = ((b0 & 0x0f) << 12) | (b1 << 6) | b2;
      if (cp < 0x8_00) return InvalidUtf8();
      if (cp >= 0xd8_00 && cp <= 0xdf_ff) return InvalidUtf8();
      index += 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      if (b1 < 0 || b2 < 0 || b3 < 0) return InvalidUtf8();
      cp = ((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
      if (cp < 0x1_00_00 || cp > 0x10_ff_ff) return InvalidUtf8();
      index += 4;
    } else {
      return InvalidUtf8();
    }
    codePoints.push(cp);
    if (codePoints.length >= 4096) flush();
  }
  flush();
  return output;
}

/** Encodes bytes as base64. */
export function bytesToBase64(bytes: Uint8Array, options: Base64Options = {}): string {
  const { alphabet, padded } = resolve(options);
  let output = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const triple = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    output +=
      alphabet.charAt((triple >> 18) & 0x3f) +
      alphabet.charAt((triple >> 12) & 0x3f) +
      alphabet.charAt((triple >> 6) & 0x3f) +
      alphabet.charAt(triple & 0x3f);
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const value = (bytes[index] ?? 0) << 16;
    output += alphabet.charAt((value >> 18) & 0x3f) + alphabet.charAt((value >> 12) & 0x3f) + (padded ? '==' : '');
  } else if (remaining === 2) {
    const value = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    output +=
      alphabet.charAt((value >> 18) & 0x3f) +
      alphabet.charAt((value >> 12) & 0x3f) +
      alphabet.charAt((value >> 6) & 0x3f) +
      (padded ? '=' : '');
  }
  return output;
}

/**
 * Decodes base64 to bytes. Rejects whitespace, characters outside the selected
 * alphabet, misplaced or missing padding, impossible lengths, and nonzero
 * unused bits, returning `InvalidBase64`.
 */
export function base64ToBytes(encoded: string, options: Base64Options = {}) {
  const { lookup, padded } = resolve(options);

  let body = encoded;
  if (padded) {
    if (encoded.length % 4 !== 0) return InvalidBase64();
    const padLength = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    body = encoded.slice(0, encoded.length - padLength);
    if ((4 - (body.length % 4)) % 4 !== padLength) return InvalidBase64();
  } else if (body.length % 4 === 1) {
    return InvalidBase64();
  }

  const remainder = body.length % 4;
  const bytes = new Uint8Array(Math.floor(body.length / 4) * 3 + (remainder === 0 ? 0 : remainder - 1));
  let offset = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.codePointAt(index) ?? 128;
    const value = code < 128 ? (lookup[code] ?? -1) : -1;
    if (value < 0) return InvalidBase64();
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return InvalidBase64();
  return bytes;
}

/** Encodes `text` (UTF-8) as base64. */
export function toBase64(text: string, options: Base64Options = {}) {
  const bytes = utf8Encode(text);
  return isFailure(bytes) ? bytes : bytesToBase64(bytes, options);
}

/** Decodes base64 to text. Returns `InvalidBase64` for malformed base64 and `InvalidUtf8` for invalid UTF-8. */
export function fromBase64(encoded: string, options: Base64Options = {}) {
  const bytes = base64ToBytes(encoded, options);
  return isFailure(bytes) ? bytes : utf8Decode(bytes);
}

/** Alias of `fromBase64`. Breaking: returns the same failures, never null. */
export const tryFromBase64 = fromBase64;
