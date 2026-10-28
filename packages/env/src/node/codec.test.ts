/**
 * The codec must stay byte-compatible with dotenvx (so a founder can leave Dot and keep the files)
 * and must edit files without disturbing the lines nobody touched (so a PR diff shows one changed key).
 */
import dotenvx from '@dotenvx/primitives';
import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import {
  decryptValue,
  encryptValue,
  envHeader,
  generateKeypair,
  isEncrypted,
  keyNamesFor,
  parseEnv,
  publicKeyOf,
  readEnvValue,
  removeEnvValue,
  setEnvValue,
} from './codec.js';
import { DecryptionFailed, UnrepresentableValue } from './errors.js';
import { parsePrivateKey, parsePublicKey } from './key-schemas.js';

describe('encryption is interchangeable with dotenvx', () => {
  it('decrypts what dotenvx encrypts', () => {
    // WHY: files written by the dotenvx CLI (listio, 1Password integrations) must load in Dot.
    const pair = dotenvx.keypair();
    const sealed = dotenvx.encrypt(pair.publicKey, 'sk_live_ünicode');
    expect(decryptValue(sealed, orThrow(parsePrivateKey(pair.privateKey)))).toBe('sk_live_ünicode');
  });

  it('writes what dotenvx decrypts', () => {
    // WHY: leaving Dot must not strand a single secret.
    const pair = orThrow(generateKeypair());
    expect(dotenvx.decrypt(pair.privateKey, orThrow(encryptValue('postgres://u:p@h/db', pair.publicKey)))).toBe(
      'postgres://u:p@h/db',
    );
  });

  it('derives the same public key dotenvx does', () => {
    const pair = dotenvx.keypair();
    expect(publicKeyOf(orThrow(parsePrivateKey(pair.privateKey)))).toBe(pair.publicKey);
  });

  it('marks ciphertext and refuses a wrong key', () => {
    const pair = orThrow(generateKeypair());
    const sealed = orThrow(encryptValue('x', pair.publicKey));
    expect(isEncrypted(sealed)).toBe(true);
    expect(DecryptionFailed.is(decryptValue(sealed, orThrow(generateKeypair()).privateKey))).toBe(true);
  });
});

describe('key names follow dotenvx', () => {
  it.each([
    ['.env', 'DOTENV_PRIVATE_KEY'],
    ['.env.production', 'DOTENV_PRIVATE_KEY_PRODUCTION'],
    ['.env.ci.local', 'DOTENV_PRIVATE_KEY_CI_LOCAL'],
  ])('%s -> %s', (file, name) => {
    expect(keyNamesFor(file).privateKey).toBe(name);
  });

  it('writes the dotenvx header byte for byte', () => {
    const publicKey = orThrow(parsePublicKey('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'));
    expect(envHeader('.env.production', publicKey)).toBe(
      [
        '#/-------------------[DOTENV_PUBLIC_KEY]--------------------/',
        '#/            public-key encryption for .env files          /',
        '#/       [how it works](https://dotenvx.com/encryption)     /',
        '#/----------------------------------------------------------/',
        `DOTENV_PUBLIC_KEY_PRODUCTION="${publicKey}"`,
        '',
        '# .env.production',
      ].join('\n'),
    );
  });
});

describe('parsing matches dotenv', () => {
  const text = [
    '# comment',
    'export PLAIN=value # trailing',
    "SINGLE='a \\n b'",
    'DOUBLE="line1\\nline2"',
    'MULTI="first',
    'second"',
    'URL=http://host/#fragment',
    'EMPTY=',
    'DUP=one',
    'DUP=two',
  ].join('\n');
  const document = parseEnv(text);

  it.each([
    ['PLAIN', 'value'],
    ['SINGLE', 'a \\n b'],
    ['DOUBLE', 'line1\nline2'],
    ['MULTI', 'first\nsecond'],
    ['URL', 'http://host/'],
    ['EMPTY', ''],
    ['DUP', 'two'],
  ])('%s', (key, value) => {
    expect(readEnvValue(document, key)).toBe(value);
  });
});

describe('edits touch one entry only', () => {
  const text = '# keep me\nA="1"\n\nB=2 # note\nC="3"\n';

  it('rewrites an existing key in place', () => {
    // WHY: a review diff must show the changed key and nothing else.
    expect(setEnvValue(text, 'B', 'new')).toBe('# keep me\nA="1"\n\nB="new"\nC="3"\n');
  });

  it('appends a new key with a newline', () => {
    expect(setEnvValue('A=1', 'B', 'x')).toBe('A=1\nB="x"\n');
  });

  it('round-trips values that contain quotes and newlines', () => {
    for (const value of ['say "hi"', 'it\'s "both"', 'two\nlines', '']) {
      expect(readEnvValue(parseEnv(orThrow(setEnvValue('', 'K', value))), 'K')).toBe(value);
    }
  });

  it('removes every assignment of a key', () => {
    expect(removeEnvValue('A=1\nB=2\nA=3\n', 'A')).toBe('B=2\n');
  });
});

describe('values cannot inject other keys', () => {
  it('keeps a literal backslash-n as written', () => {
    // WHY: double quotes would turn it into a line break; the value must come back byte for byte.
    expect(readEnvValue(parseEnv(orThrow(setEnvValue('', 'K', 'a\\nb'))), 'K')).toBe('a\\nb');
  });

  it('refuses a value no quoting can carry instead of writing a second key', () => {
    // WHY: a value holding every quote plus a newline could otherwise end the quote and start `EVIL=`.
    expect(UnrepresentableValue.is(setEnvValue('', 'K', 'a"b\'c`\nEVIL=1'))).toBe(true);
  });
});
