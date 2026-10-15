/**
 * Canonical keys. `full` is length-delimited and versioned, so two different
 * `(namespace, name)` pairs can never collide the way `${ns}:${name}` can
 * (`('a:b', 'c')` vs `('a', 'b:c')`). The digest is a pure-TS 64-bit FNV-1a, so
 * it runs on every runtime, Hermes included.
 *
 * Each primitive has its own encoding tag, so `mutex('a')`, `semaphore('a')` and
 * `readWrite('a')` are three independent locks on every store:
 *
 * - mutex:     `1:<len>:<ns>:<len>:<name>`   (unchanged: live apps depend on these digests)
 * - semaphore: `1s:<len>:<ns>:<len>:<name>`
 * - readWrite: `1rw:<len>:<ns>:<len>:<name>`
 */
import type { Key } from './types.js';
import { LockError } from './errors.js';
import { keyNameSchema } from './types.js';

/** Which lock family a key names. Part of the encoding, so families never share a lock. */
export type Primitive = 'mutex' | 'semaphore' | 'readWrite';

const PRIMITIVE_TAGS = { mutex: '1', semaphore: '1s', readWrite: '1rw' } as const satisfies Record<Primitive, string>;
const MAX_NAME_BYTES = 512;

/**
 * The UTF-8 length of a valid part, or -1 when `keyNameSchema` would refuse it (empty, a
 * lone surrogate, over 512 bytes). One pass, no `TextEncoder`: every handle builds a key.
 */
function partBytes(value: string): number {
  if (typeof value !== 'string' || value.length === 0) return -1;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    // A surrogate pair reads as one code point above U+FFFF; a lone surrogate reads as itself.
    const point = value.codePointAt(index) ?? 0;
    if (point < 0x80) bytes += 1;
    else if (point < 0x8_00) bytes += 2;
    else if (point > 0xFF_FF) {
      bytes += 4;
      index += 1;
    } else if (isSurrogate(point)) return -1;
    else bytes += 3;
  }
  return bytes <= MAX_NAME_BYTES ? bytes : -1;
}

function isSurrogate(point: number): boolean {
  return point >= 0xD8_00 && point <= 0xDF_FF;
}

function checkedPart(label: 'namespace' | 'name', value: string): number {
  const bytes = partBytes(value);
  if (bytes !== -1) return bytes;
  // Only a refusal pays for the schema, which words the message.
  const parsed = keyNameSchema.safeParse(value);
  throw new LockError({
    code: 'config',
    message: `lock ${label} ${parsed.error?.issues.map(issue => issue.message).join(', ') ?? 'is invalid'}`,
    remediation: `Pass a non-empty ${label} of at most 512 UTF-8 bytes.`,
  });
}

/** Build the canonical key. Throws `LockError{code:'config'}` for an empty, oversized or ill-formed part. */
export function createKey(namespace: string, name: string, primitive: Primitive = 'mutex'): Key {
  const nsLength = checkedPart('namespace', namespace);
  const nameLength = checkedPart('name', name);
  const full = `${PRIMITIVE_TAGS[primitive]}:${nsLength}:${namespace}:${nameLength}:${name}`;
  return { namespace, name, full };
}

const FNV64_OFFSET = 0xCB_F2_9C_E4_84_22_23_25n;
const FNV64_PRIME = 0x1_00_00_00_01_B3n;

function fnvStep(hash: bigint, byte: number): bigint {
  return BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV64_PRIME);
}

/** 64-bit FNV-1a over raw bytes, as an unsigned bigint. */
export function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV64_OFFSET;
  for (const byte of bytes) hash = fnvStep(hash, byte);
  return hash;
}

/**
 * {@link fnv1a64} over the UTF-8 bytes of `text`, encoded inline exactly as `TextEncoder`
 * does: a lone surrogate becomes U+FFFD (EF BF BD).
 */
export function fnv1a64Utf8(text: string): bigint {
  let hash = FNV64_OFFSET;
  for (let index = 0; index < text.length; index++) {
    let point = text.codePointAt(index) ?? 0;
    if (point > 0xFF_FF) index += 1;
    else if (isSurrogate(point)) point = 0xFF_FD;
    if (point < 0x80) {
      hash = fnvStep(hash, point);
    } else if (point < 0x8_00) {
      hash = fnvStep(hash, 0xC0 | (point >> 6));
      hash = fnvStep(hash, 0x80 | (point & 0x3F));
    } else if (point < 0x1_00_00) {
      hash = fnvStep(hash, 0xE0 | (point >> 12));
      hash = fnvStep(hash, 0x80 | ((point >> 6) & 0x3F));
      hash = fnvStep(hash, 0x80 | (point & 0x3F));
    } else {
      hash = fnvStep(hash, 0xF0 | (point >> 18));
      hash = fnvStep(hash, 0x80 | ((point >> 12) & 0x3F));
      hash = fnvStep(hash, 0x80 | ((point >> 6) & 0x3F));
      hash = fnvStep(hash, 0x80 | (point & 0x3F));
    }
  }
  return hash;
}

/** The 64-bit digest of `key.full` (UTF-8). */
export function digest64(key: Key): bigint {
  return fnv1a64Utf8(key.full);
}

/** The digest split into two signed 32-bit integers, the shape of `pg_advisory_lock(int4, int4)`. */
export function toPgPair(key: Key): { readonly hi: number; readonly lo: number } {
  const digest = digest64(key);
  return {
    hi: Number(BigInt.asIntN(32, digest >> 32n)),
    lo: Number(BigInt.asIntN(32, digest)),
  };
}

/** The text today's code hashes with `hashtext(...)`, for `legacyKeys: true`. */
export function legacyPgText(key: Key): string {
  return `${key.namespace}:${key.name}`;
}
