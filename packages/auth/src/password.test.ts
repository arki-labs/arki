import { hashPassword as betterAuthHash, verifyPassword as betterAuthVerify } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password';

const PASSWORD = 'correct horse battery staple';

describe('password hashing (pure-JS scrypt)', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash, password: `${PASSWORD}!` })).toBe(false);
  });

  it('stores salt and key as hex, never the password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(hash).not.toContain(PASSWORD);
  });

  it('uses a fresh salt per hash, so equal passwords get different hashes', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  // Apps hand these functions to Better Auth, and existing users already have
  // Better Auth hashes in the db. Both directions must work or sign-in breaks.
  it('reads hashes Better Auth wrote, and Better Auth reads ours', async () => {
    const fromBetterAuth = await betterAuthHash(PASSWORD);
    expect(await verifyPassword({ hash: fromBetterAuth, password: PASSWORD })).toBe(true);

    const fromUs = await hashPassword(PASSWORD);
    expect(await betterAuthVerify({ hash: fromUs, password: PASSWORD })).toBe(true);
  });

  it('treats NFKC-equivalent passwords as the same password, like Better Auth', async () => {
    const hash = await hashPassword('Å'); // Angstrom sign, normalises to Å
    expect(await verifyPassword({ hash, password: 'Å' })).toBe(true);
  });

  it('returns false, without throwing, for an empty or malformed hash or empty password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword({ hash: '', password: PASSWORD })).toBe(false);
    expect(await verifyPassword({ hash: 'not-a-hash', password: PASSWORD })).toBe(false);
    expect(await verifyPassword({ hash: '$2b$12$abcdefghijklmnopqrstuuOldBcryptHashValue', password: PASSWORD })).toBe(
      false,
    );
    expect(await verifyPassword({ hash: hash.toUpperCase(), password: PASSWORD })).toBe(false);
    expect(await verifyPassword({ hash, password: '' })).toBe(false);
  });
});
