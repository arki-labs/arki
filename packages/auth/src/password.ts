/**
 * Password hashing with scrypt, in pure JavaScript (`@noble/hashes`), so it runs
 * in every runtime without a native module.
 *
 * The parameters and the stored format match Better Auth's own hasher
 * (`@better-auth/utils/password`): N=16384, r=16, p=1, a 64-byte key, a random
 * 16-byte salt, NFKC-normalised input, stored as `<salt hex>:<key hex>`. A hash
 * made here verifies in Better Auth and the other way round, so these two
 * functions can be passed straight to `emailAndPassword.password`.
 */
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { z } from '@arki/contracts';

import { debugPassword } from './debug';

const SCRYPT = { N: 16_384, r: 16, p: 1, dkLen: 64 } as const;
const SALT_BYTES = 16;

/** `<32 hex chars of salt>:<128 hex chars of key>`, the only format this module writes or reads. */
const storedHashSchema = z
  .string()
  .regex(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
  .transform(value => {
    const [salt = '', key = ''] = value.split(':');
    return { salt, key: hexToBytes(key) };
  });

function deriveKey(password: string, salt: string): Promise<Uint8Array> {
  // Better Auth feeds the salt's hex text (not its raw bytes) into scrypt; do the same so hashes interoperate.
  return scryptAsync(utf8ToBytes(password.normalize('NFKC')), utf8ToBytes(salt), {
    ...SCRYPT,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
}

/** Compare two byte arrays in time that depends only on their length, never on where they differ. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (const [i, byte] of a.entries()) {
    diff |= byte ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Hash a password. Returns `<salt hex>:<key hex>`, safe to store as-is. */
export async function hashPassword(password: string): Promise<string> {
  const salt = bytesToHex(randomBytes(SALT_BYTES));
  const key = await deriveKey(password, salt);
  debugPassword.debug('[hashPassword] Hashed password with scrypt');
  return `${salt}:${bytesToHex(key)}`;
}

/**
 * Check a password against a stored hash. Returns `false` for a wrong password
 * and for a hash that is empty or not in the expected format. Never throws.
 */
export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const parsed = storedHashSchema.safeParse(hash);
  if (!parsed.success || !password) {
    debugPassword.debug('[verifyPassword] Invalid input (hasPassword: {hasPassword}, validHash: {validHash})', {
      hasPassword: !!password,
      validHash: parsed.success,
    });
    return false;
  }
  const candidate = await deriveKey(password, parsed.data.salt);
  return constantTimeEqual(candidate, parsed.data.key);
}
