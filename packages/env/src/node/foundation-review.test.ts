import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { InvalidInput, orThrow } from '@arki/failure';

import { decryptEnvFile, encryptEnvFile, initEnvFile, publicKeyIn, rotateEnvFiles, setEnvFileValue } from './edit.js';
import { encryptValue, envHeader, generateKeypair, publicKeyOf } from './codec.js';
import { DecryptionFailed, EncryptionFailed, EnvFilesFailed, FileReadFailed, FileWriteFailed, MissingPublicKey } from './errors.js';
import { findPrivateKey, writePrivateKey } from './keys.js';
import { loadEnvFiles } from './load.js';
import { parsePrivateKey, parsePublicKey } from './key-schemas.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'env-foundation-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('returns MissingPublicKey when an encrypted set or encrypt targets a file with no public key', () => {
  const file = path.join(root, '.env.development');
  writeFileSync(file, 'A=1\n');
  expect(MissingPublicKey.is(setEnvFileValue(file, 'B', '2', { plain: false }))).toBe(true);
  expect(MissingPublicKey.is(encryptEnvFile(file))).toBe(true);
});

it('returns InvalidInput for a malformed key text instead of throwing', () => {
  expect(InvalidInput.is(parsePublicKey('nope'))).toBe(true);
  expect(InvalidInput.is(parsePrivateKey('0'.repeat(64)))).toBe(true);
  expect(InvalidInput.is(parsePrivateKey('zz'))).toBe(true);
});

it('findPrivateKey returns InvalidInput for a malformed key in the environment', () => {
  const found = findPrivateKey(path.join(root, '.env.development'), { root, env: { DOTENV_PRIVATE_KEY_DEVELOPMENT: 'bad' } });
  expect(InvalidInput.is(found)).toBe(true);
});

it('decryptEnvFile returns DecryptionFailed when no key matches', () => {
  const file = path.join(root, '.env.development');
  const pair = orThrow(generateKeypair());
  writeFileSync(file, `${envHeader('.env.development', pair.publicKey)}\nA=1\n`);
  orThrow(encryptEnvFile(file));
  const other = orThrow(generateKeypair());
  expect(DecryptionFailed.is(decryptEnvFile(file, [other.privateKey]))).toBe(true);
});

it('publicKeyOf accepts every key the private key schema accepts', () => {
  const pair = orThrow(generateKeypair());
  expect(publicKeyOf(pair.privateKey)).toBe(pair.publicKey);
});

it('loadEnvFiles reports a bad provider reference as EnvFilesFailed without applying values', () => {
  writeFileSync(path.join(root, '.env.development'), 'A=1\nB=op://x/y/z\n');
  const env: Record<string, string | undefined> = {};
  const result = loadEnvFiles({ cwd: root, root, env, references: { op: () => undefined } });
  expect(EnvFilesFailed.is(result)).toBe(true);
  expect(env.A).toBeUndefined();
});

it('rotateEnvFiles throws a plain Error for an empty file list (precondition)', () => {
  expect(() => rotateEnvFiles([], { root, env: {} })).toThrow('no files to rotate');
});

it('encryptValue returns EncryptionFailed for a public key the curve rejects', () => {
  expect(EncryptionFailed.is(Reflect.apply(encryptValue, null, ['value', 'not-a-key']))).toBe(true);
});

it('publicKeyIn returns InvalidInput for a bad key line and FileReadFailed for an unreadable file', () => {
  const file = path.join(root, '.env.development');
  writeFileSync(file, 'DOTENV_PUBLIC_KEY_DEVELOPMENT="bad"\n');
  expect(InvalidInput.is(publicKeyIn(file))).toBe(true);
  const directory = path.join(root, '.env.test');
  mkdirSync(directory);
  expect(FileReadFailed.is(publicKeyIn(directory))).toBe(true);
});

it('initEnvFile returns FileReadFailed when the key store is a directory', () => {
  mkdirSync(path.join(root, '.env.keys'));
  expect(FileReadFailed.is(initEnvFile(path.join(root, '.env.development'), { root, env: {} }))).toBe(true);
});

it('findPrivateKey returns FileReadFailed for an unreadable key file and writePrivateKey FileWriteFailed for a missing folder', () => {
  mkdirSync(path.join(root, '.env.keys'));
  expect(FileReadFailed.is(findPrivateKey(path.join(root, '.env.development'), { root, env: {} }))).toBe(true);
  const pair = orThrow(generateKeypair());
  expect(FileWriteFailed.is(writePrivateKey(path.join(root, 'missing', '.env.keys'), 'DOTENV_PRIVATE_KEY', pair.privateKey, 'c'))).toBe(true);
});
