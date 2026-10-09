/**
 * Base64 and UTF-8 without `Buffer`, `atob`, or `btoa`, so the same code runs
 * in Node, Bun, browsers, and Hermes. Text functions are UTF-8; byte functions
 * take and return `Uint8Array`. Decoding is strict: malformed base64 throws
 * `SyntaxError`, invalid UTF-8 throws `TypeError`.
 */

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

/** UTF-8 byte length of `text`. Throws `TypeError` on an unpaired surrogate. */
export function byteLength(text: string): number {
  let total = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 0xd8_00 && cp <= 0xdf_ff) throw new TypeError(`Unpaired surrogate U+${cp.toString(16).toUpperCase()}`);
    total += cp < 0x80 ? 1 : cp < 0x8_00 ? 2 : cp < 0x1_00_00 ? 3 : 4;
  }
  return total;
}

/** Encodes `text` as UTF-8. Throws `TypeError` on an unpaired surrogate. */
export function utf8Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(byteLength(text));
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
  if (byte === undefined || (byte & 0xc0) !== 0x80)
    throw new TypeError(`Invalid UTF-8 continuation at byte ${String(index)}`);
  return byte & 0x3f;
}

/** Decodes strict UTF-8. Overlong forms, surrogates, and truncated sequences throw `TypeError`. A leading BOM is kept. */
export function utf8Decode(bytes: Uint8Array): string {
  const codePoints: number[] = [];
  let output = '';
  const flush = (): void => {
    output += String.fromCodePoint(...codePoints);
    codePoints.length = 0;
  };

  let index = 0;
  while (index < bytes.length) {
    const b0 = bytes[index] ?? 0;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      index += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = ((b0 & 0x1f) << 6) | continuation(bytes, index + 1);
      if (cp < 0x80) throw new TypeError(`Overlong UTF-8 sequence at byte ${String(index)}`);
      index += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = ((b0 & 0x0f) << 12) | (continuation(bytes, index + 1) << 6) | continuation(bytes, index + 2);
      if (cp < 0x8_00) throw new TypeError(`Overlong UTF-8 sequence at byte ${String(index)}`);
      if (cp >= 0xd8_00 && cp <= 0xdf_ff) throw new TypeError(`UTF-8 encoded surrogate at byte ${String(index)}`);
      index += 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp =
        ((b0 & 0x07) << 18) |
        (continuation(bytes, index + 1) << 12) |
        (continuation(bytes, index + 2) << 6) |
        continuation(bytes, index + 3);
      if (cp < 0x1_00_00 || cp > 0x10_ff_ff) throw new TypeError(`Invalid UTF-8 sequence at byte ${String(index)}`);
      index += 4;
    } else {
      throw new TypeError(`Invalid UTF-8 lead byte at byte ${String(index)}`);
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
 * unused bits, throwing `SyntaxError`.
 */
export function base64ToBytes(encoded: string, options: Base64Options = {}): Uint8Array {
  const { lookup, padded } = resolve(options);

  let body = encoded;
  if (padded) {
    if (encoded.length % 4 !== 0) throw new SyntaxError('Base64 length must be a multiple of 4');
    const padLength = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    body = encoded.slice(0, encoded.length - padLength);
    if ((4 - (body.length % 4)) % 4 !== padLength) throw new SyntaxError('Invalid base64 padding');
  } else if (body.length % 4 === 1) {
    throw new SyntaxError('Impossible base64 length');
  }

  const remainder = body.length % 4;
  const bytes = new Uint8Array(Math.floor(body.length / 4) * 3 + (remainder === 0 ? 0 : remainder - 1));
  let offset = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.codePointAt(index) ?? 128;
    const value = code < 128 ? (lookup[code] ?? -1) : -1;
    if (value < 0) throw new SyntaxError(`Invalid base64 character at index ${String(index)}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new SyntaxError('Nonzero unused bits in base64 input');
  return bytes;
}

/** Encodes `text` (UTF-8) as base64. */
export function toBase64(text: string, options: Base64Options = {}): string {
  return bytesToBase64(utf8Encode(text), options);
}

/** Decodes base64 to text. Throws `SyntaxError` for malformed base64 and `TypeError` for invalid UTF-8. */
export function fromBase64(encoded: string, options: Base64Options = {}): string {
  return utf8Decode(base64ToBytes(encoded, options));
}

/** Like `fromBase64`, but returns `null` instead of throwing. */
export function tryFromBase64(encoded: string, options: Base64Options = {}): string | null {
  try {
    return fromBase64(encoded, options);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === 'string') return utf8Encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Object-style API kept for existing consumers. `decode`/`urlDecode` return
 * `null` for malformed input; use `fromBase64` when you want an exception.
 */
export const base64 = {
  encode(data: string | Uint8Array | ArrayBuffer): string {
    return bytesToBase64(toBytes(data));
  },
  urlEncode(data: string | Uint8Array | ArrayBuffer): string {
    return bytesToBase64(toBytes(data), { alphabet: 'url' });
  },
  decode(encoded: string): string | null {
    return tryFromBase64(encoded);
  },
  urlDecode(encoded: string): string | null {
    return tryFromBase64(encoded, { alphabet: 'url' });
  },
} as const;
