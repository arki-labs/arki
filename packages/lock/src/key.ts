/**
 * Canonical keys. `full` is length-delimited and versioned, so two different
 * `(namespace, name)` pairs can never collide the way `${ns}:${name}` can
 * (`('a:b', 'c')` vs `('a', 'b:c')`). The digest is a pure-TS 64-bit FNV-1a, so
 * it runs on every runtime, Hermes included.
 */
import { LockError } from './errors.js';
import { keyNameSchema } from './types.js';
import type { Key } from './types.js';

const ENCODING_VERSION = 1;
const encoder = new TextEncoder();

function checkPart(label: 'namespace' | 'name', value: string): void {
  const parsed = keyNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new LockError({
      code: 'config',
      message: `lock ${label} ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
      remediation: `Pass a non-empty ${label} of at most 512 UTF-8 bytes.`,
    });
  }
}

/** Build the canonical key. Throws `LockError{code:'config'}` for an empty, oversized or ill-formed part. */
export function createKey(namespace: string, name: string): Key {
  checkPart('namespace', namespace);
  checkPart('name', name);
  const nsLength = encoder.encode(namespace).length;
  const nameLength = encoder.encode(name).length;
  const full = `${ENCODING_VERSION}:${nsLength}:${namespace}:${nameLength}:${name}`;
  return { namespace, name, full };
}

const FNV64_OFFSET = 0xCB_F2_9C_E4_84_22_23_25n;
const FNV64_PRIME = 0x1_00_00_00_01_B3n;

/** 64-bit FNV-1a over raw bytes, as an unsigned bigint. */
export function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV64_OFFSET;
  for (const byte of bytes) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV64_PRIME);
  }
  return hash;
}

/** The 64-bit digest of `key.full` (UTF-8). */
export function digest64(key: Key): bigint {
  return fnv1a64(encoder.encode(key.full));
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
