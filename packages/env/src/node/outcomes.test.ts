import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenvx from '@dotenvx/primitives';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import type { Failure, FailureOf } from '@arki/failure';
import type { SchemaOutput } from '@arki/schema';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';

import type { KeyGenerationFailed } from './errors.js';
import type { EnvPrivateKey, envPrivateKeySchema, EnvPublicKey, envPublicKeySchema } from './key-schemas.js';
import { defineEnv } from '../core/define-env.js';
import { commonPresets } from '../presets/common.js';
import { parsePresets } from '../presets/parsing.js';
import {
  decryptValue,
  encryptValue,
  envHeader,
  generateKeypair,
  parseEnv,
  publicKeyOf,
  readEnvValue,
  setEnvValue,
} from './codec.js';
import { decryptEnvFile, encryptEnvFile, initEnvFile, publicKeyIn, rotateEnvFiles, setEnvFileValue } from './edit.js';
import {
  DecryptionFailed,
  EncryptionFailed,
  EnvCancelled,
  EnvDeadline,
  EnvFilesFailed,
  FileReadFailed,
  FileWriteFailed,
  MissingPublicKey,
  ReferenceFailed,
  RotationIncomplete,
  UnrepresentableValue,
} from './errors.js';
import { parsePrivateKey, parsePublicKey } from './key-schemas.js';
import { findPrivateKey, writePrivateKey } from './keys.js';
import { loadEnvFiles } from './load.js';
import { DEFAULT_RESOLVERS } from './references.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-env-outcomes-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('bounds the real subprocess boundary and keeps its stderr only as a private cause', () => {
  const executable = path.join(root, 'op');
  vi.stubEnv('PATH', root);
  writeFileSync(executable, '#!/bin/sh\nprintf SYNTHETIC_SECRET_VALUE >&2\nexit 1\n', { mode: 0o700 });
  const resolver = DEFAULT_RESOLVERS.op;
  if (resolver === undefined) return expect.fail('missing default provider');
  const rejected = resolver('op://synthetic/vault/field');
  if (!ReferenceFailed.is(rejected)) return expect.fail('expected a canonical provider rejection');
  expect(rejected.cause instanceof Error).toBe(true);
  expect(JSON.stringify(rejected).includes('SYNTHETIC_SECRET_VALUE')).toBe(false);
  writeFileSync(executable, '#!/bin/sh\nexec /bin/sleep 1\n', { mode: 0o700 });
  expect(EnvDeadline.is(resolver('op://synthetic/vault/field', { timeoutMs: 10 }))).toBe(true);
});

it('force-stops a provider that ignores graceful termination', () => {
  const executable = path.join(root, 'op');
  vi.stubEnv('PATH', root);
  writeFileSync(executable, '#!/bin/sh\ntrap "" TERM\nexec /bin/sleep 1\n', { mode: 0o700 });
  const resolver = DEFAULT_RESOLVERS.op;
  if (resolver === undefined) return expect.fail('missing default provider');
  const result = resolver('op://synthetic/vault/field', { timeoutMs: 100 });
  expect(EnvDeadline.is(result)).toBe(true);
  expect(result).toMatchObject({ cause: { signal: 'SIGKILL' } });
});

describe('presets preserve schema rejection semantics', () => {
  it('honors zero/empty defaults rather than failing a boot with an explicit fallback', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- Zod requires the explicit missing input to exercise its default.
    expect(commonPresets.number(0).parse(undefined)).toBe(0);
    // eslint-disable-next-line unicorn/no-useless-undefined -- Zod requires the explicit missing input to exercise its default.
    expect(commonPresets.string('').parse(undefined)).toBe('');
  });
  it('reports JSON syntax and output-shape rejection as issues rather than validator defects', () => {
    const schema = parsePresets.json(z.object({ count: z.number() }));
    expect(schema.safeParse('{').success).toBe(false);
    expect(schema.safeParse('{"count":"wrong"}').success).toBe(false);
    const env = defineEnv({
      server: { CONFIG: schema },
      runtimeEnv: { CONFIG: '{' },
      options: {
        onValidationError: () => {
          throw new Error('configuration rejected');
        },
      },
    });
    expect(() => env.CONFIG).toThrow('configuration rejected');
  });
});

it('keeps crypto key domains distinct and failure unions exact', () => {
  const pair = orThrow(generateKeypair());
  expect(orThrow(parsePublicKey(pair.publicKey))).toBe(pair.publicKey);
  expect(orThrow(parsePrivateKey(pair.privateKey))).toBe(pair.privateKey);
  const invalid = parsePrivateKey('SYNTHETIC_SECRET_VALUE');
  expect(InvalidInput.is(invalid)).toBe(true);
  expect(JSON.stringify(invalid)).not.toContain('SYNTHETIC_SECRET_VALUE');
  expectTypeOf<EnvPrivateKey>().not.toExtend<EnvPublicKey>();
  expectTypeOf<EnvPublicKey>().not.toExtend<EnvPrivateKey>();
  expectTypeOf<SchemaOutput<typeof envPrivateKeySchema>>().toEqualTypeOf<EnvPrivateKey>();
  expectTypeOf<SchemaOutput<typeof envPublicKeySchema>>().toEqualTypeOf<EnvPublicKey>();
  expectTypeOf<Extract<ReturnType<typeof encryptValue>, Failure>>().toEqualTypeOf<FailureOf<typeof EncryptionFailed>>();
  expectTypeOf<Extract<ReturnType<typeof decryptValue>, Failure>>().toEqualTypeOf<FailureOf<typeof DecryptionFailed>>();
  expectTypeOf<Extract<ReturnType<typeof generateKeypair>, Failure>>().toEqualTypeOf<
    FailureOf<typeof KeyGenerationFailed>
  >();
  expectTypeOf<Extract<ReturnType<typeof setEnvValue>, Failure>>().toEqualTypeOf<
    FailureOf<typeof UnrepresentableValue>
  >();
  expectTypeOf<Extract<ReturnType<typeof loadEnvFiles>, Failure>>().toEqualTypeOf<
    FailureOf<typeof EnvFilesFailed> | FailureOf<typeof EnvCancelled> | FailureOf<typeof EnvDeadline>
  >();
});

it('returns rejected ciphertext and quoting limits as final typed outcomes', () => {
  const pair = orThrow(generateKeypair());
  const sealed = orThrow(encryptValue('synthetic plaintext', pair.publicKey));
  expect(DecryptionFailed.is(decryptValue(sealed, orThrow(generateKeypair()).privateKey))).toBe(true);
  expect(UnrepresentableValue.is(setEnvValue('', 'TOKEN', '"\'`\n'))).toBe(true);
  expect(decryptValue(sealed, pair.privateKey)).toBe('synthetic plaintext');
});

it('returns bad-file errors before applying otherwise valid entries', () => {
  writeFileSync(path.join(root, '.env.development'), 'A=synthetic\n');
  mkdirSync(path.join(root, '.env.local'));
  const env: Record<string, string | undefined> = {};
  const result = loadEnvFiles({ cwd: root, root, env });
  if (!EnvFilesFailed.is(result)) return expect.fail('expected a load failure');
  expect(result.data.errors.map(error => error.code)).toEqual([FileReadFailed.code]);
  expect(env).toEqual({});
});

it('keeps provider error text private and preserves its original cause', () => {
  writeFileSync(path.join(root, '.env.development'), 'TOKEN=vault://synthetic\n');
  const cause = new Error('SYNTHETIC_SECRET_VALUE');
  const result = loadEnvFiles({
    cwd: root,
    root,
    env: {},
    references: {
      vault: () => {
        throw cause;
      },
    },
  });
  if (!EnvFilesFailed.is(result)) return expect.fail('expected a provider failure');
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_VALUE');
  expect(result.cause).toEqual([expect.objectContaining({ cause })]);
});

it('returns write failure rather than creating a partial file', () => {
  expect(
    FileWriteFailed.is(
      setEnvFileValue(path.join(root, 'missing', '.env.development'), 'TOKEN', 'synthetic', { plain: true }),
    ),
  ).toBe(true);
});

it('honors pre-cancellation and the aggregate reference budget', () => {
  writeFileSync(path.join(root, '.env.development'), 'TOKEN=vault://synthetic\n');
  const signal = AbortSignal.abort('private synthetic reason');
  let calls = 0;
  const references = {
    vault: () => {
      calls++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      return 'synthetic';
    },
  };
  expect(EnvCancelled.is(loadEnvFiles({ cwd: root, root, env: {}, signal, references }))).toBe(true);
  expect(calls).toBe(0);
  expect(EnvDeadline.is(loadEnvFiles({ cwd: root, root, env: {}, timeoutMs: 10, references }))).toBe(true);
  expect(calls).toBe(1);
});

it('does not rewrite ciphertext when recovery-key storage fails', () => {
  const pair = orThrow(generateKeypair());
  const target = path.join(root, '.env.development');
  const original = `${envHeader('.env.development', pair.publicKey)}\nTOKEN=${orThrow(encryptValue('synthetic', pair.publicKey))}\n`;
  writeFileSync(target, original);
  mkdirSync(path.join(root, '.env.keys'));
  expect(
    FileReadFailed.is(rotateEnvFiles([target], { root, env: { DOTENV_PRIVATE_KEY_DEVELOPMENT: pair.privateKey } })),
  ).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(original);
});

it('recovers both generations after a real second-file write failure and supports retry', () => {
  const pair = orThrow(generateKeypair());
  const other = path.join(root, 'other');
  mkdirSync(other);
  const files = [path.join(root, '.env.development'), path.join(other, '.env.development')];
  for (const file of files)
    writeFileSync(
      file,
      `${envHeader('.env.development', pair.publicKey)}\nTOKEN=${orThrow(encryptValue('synthetic', pair.publicKey))}\n`,
    );
  chmodSync(other, 0o500);
  try {
    const result = rotateEnvFiles(files, { root, env: { DOTENV_PRIVATE_KEY_DEVELOPMENT: pair.privateKey } });
    if (!RotationIncomplete.is(result)) return expect.fail('expected a recoverable partial rotation');
    expect(result.data).toMatchObject({ completedFiles: 1, totalFiles: 2 });
    expect(statSync(path.join(root, '.env.keys')).mode & 0o777).toBe(0o600);
    for (const file of files) {
      const found = orThrow(findPrivateKey(file, { root, env: {} }));
      expect(found?.keys).toHaveLength(2);
      const value = readEnvValue(parseEnv(readFileSync(file, 'utf8')), 'TOKEN');
      expect(found?.keys.some(key => !isFailure(decryptValue(value ?? '', key)))).toBe(true);
      const document = parseEnv(readFileSync(file, 'utf8'));
      const publicKey = readEnvValue(document, 'DOTENV_PUBLIC_KEY_DEVELOPMENT');
      const keyring = dotenvx.keyringSync({ fk: path.join(root, '.env.keys'), processEnv: {} });
      const privateKey = keyring[publicKey ?? ''];
      if (privateKey === undefined) return expect.fail('dotenvx could not select a staged generation');
      expect(dotenvx.decrypt(privateKey, value ?? '') === 'synthetic').toBe(true);
      const loaded = orThrow(loadEnvFiles({ root, cwd: path.dirname(file), env: {} }));
      expect(loaded.values.find(entry => entry.key === 'TOKEN')?.value).toBe('synthetic');
    }
  } finally {
    chmodSync(other, 0o700);
  }
  orThrow(rotateEnvFiles(files, { root, env: {} }));
  expect(orThrow(loadEnvFiles({ root, cwd: other, env: {} })).values.find(value => value.key === 'TOKEN')?.value).toBe(
    'synthetic',
  );
  expect(orThrow(findPrivateKey(files[0] ?? '', { root, env: {} }))?.keys).toHaveLength(1);
});

it('rotates local key stores as well as root so nearest-key precedence cannot hide the new key', () => {
  const other = path.join(root, 'other');
  mkdirSync(other);
  const files = [path.join(root, '.env.development'), path.join(other, '.env.development')];
  for (const file of files) {
    const pair = orThrow(generateKeypair());
    writeFileSync(
      file,
      `${envHeader('.env.development', pair.publicKey)}\nTOKEN=${orThrow(encryptValue('synthetic', pair.publicKey))}\n`,
    );
    orThrow(
      writePrivateKey(
        path.join(path.dirname(file), '.env.keys'),
        'DOTENV_PRIVATE_KEY_DEVELOPMENT',
        pair.privateKey,
        '.env.development',
      ),
    );
  }
  orThrow(rotateEnvFiles(files, { root, env: {} }));
  for (const file of files) {
    const result = orThrow(loadEnvFiles({ root, cwd: path.dirname(file), env: {} }));
    expect(result.values.find(value => value.key === 'TOKEN')?.value).toBe('synthetic');
    expect(orThrow(findPrivateKey(file, { root, env: {} }))?.keys).toHaveLength(1);
  }
});

it('stops before any ciphertext rewrite if staging a later local key store fails', () => {
  const other = path.join(root, 'other');
  mkdirSync(other);
  const files = [path.join(root, '.env.development'), path.join(other, '.env.development')];
  const original: string[] = [];
  for (const file of files) {
    const pair = orThrow(generateKeypair());
    const text = `${envHeader('.env.development', pair.publicKey)}\nTOKEN=${orThrow(encryptValue('synthetic', pair.publicKey))}\n`;
    original.push(text);
    writeFileSync(file, text);
    orThrow(
      writePrivateKey(
        path.join(path.dirname(file), '.env.keys'),
        'DOTENV_PRIVATE_KEY_DEVELOPMENT',
        pair.privateKey,
        '.env.development',
      ),
    );
  }
  chmodSync(other, 0o500);
  try {
    expect(FileWriteFailed.is(rotateEnvFiles(files, { root, env: {} }))).toBe(true);
    expect(files.every((file, index) => readFileSync(file, 'utf8') === original[index])).toBe(true);
    for (const file of files) {
      const loaded = orThrow(loadEnvFiles({ root, cwd: path.dirname(file), env: {} }));
      expect(loaded.values.find(value => value.key === 'TOKEN')?.value).toBe('synthetic');
    }
  } finally {
    chmodSync(other, 0o700);
  }
});

describe('foundation outcomes: failures returned, never thrown', () => {
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
    const result = loadEnvFiles({ cwd: root, root, env, references: { op: () => ReferenceFailed({ scheme: 'op' }) } });
    expect(EnvFilesFailed.is(result)).toBe(true);
    expect(env.A).toBeUndefined();
  });

  it('rotateEnvFiles returns InvalidInput for an empty list and for files of two environments', () => {
    const development = path.join(root, '.env.development');
    const production = path.join(root, '.env.production');
    expect(InvalidInput.is(rotateEnvFiles([], { root, env: {} }))).toBe(true);
    expect(InvalidInput.is(rotateEnvFiles([development, production], { root, env: {} }))).toBe(true);
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
});
