import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenvx from '@dotenvx/primitives';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import type { Failure, FailureOf } from '@arki/failure';
import type { SchemaOutput } from '@arki/schema';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';

import type { EncryptionFailed, KeyGenerationFailed } from './errors.js';
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
  readEnvValue,
  setEnvValue,
} from './codec.js';
import { rotateEnvFiles, setEnvFileValue } from './edit.js';
import {
  DecryptionFailed,
  EnvCancelled,
  EnvDeadline,
  EnvFilesFailed,
  FileReadFailed,
  FileWriteFailed,
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
