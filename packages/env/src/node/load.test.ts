/**
 * Precedence is the contract operators rely on: the real environment (Coolify) beats every file,
 * deeper and later files beat earlier ones, and ciphertext is never mistaken for a value.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encryptValue, envHeader, generateKeypair } from './codec.js';
import { initEnvFile, rotateEnvFiles, setEnvFileValue } from './edit.js';
import { writePrivateKey } from './keys.js';
import { ENV_FILES_ERROR_CODES, envDirs, findRoot, loadEnvFiles, secretValues } from './load.js';

let root: string;
let app: string;
const pair = generateKeypair();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-env-'));
  mkdirSync(path.join(root, '.git'));
  app = path.join(root, 'apps', 'demo');
  mkdirSync(app, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(dir: string, name: string, lines: readonly string[]): string {
  const file = path.join(dir, name);
  writeFileSync(file, `${envHeader(name, pair.publicKey)}\n${lines.join('\n')}\n`);
  return file;
}

function load(initial: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { DOTENV_PRIVATE_KEY_DEVELOPMENT: pair.privateKey, ...initial };
  return { env, report: loadEnvFiles({ cwd: app, environment: 'development', env }) };
}

describe('precedence', () => {
  it('reads from the repository root down to the working directory', () => {
    expect(findRoot(app)).toBe(root);
    expect(envDirs(root, app)).toEqual([root, path.join(root, 'apps'), app]);
  });

  it('lets the deeper file win, and .env.local win over .env.<environment>', () => {
    // WHY: the app file overrides the shared root file, and one machine overrides both.
    write(root, '.env.development', ['A=root', 'B=root']);
    write(app, '.env.development', ['B=app', 'C=app']);
    writeFileSync(path.join(app, '.env.local'), 'C=local\n');
    const { env } = load();
    expect([env['A'], env['B'], env['C']]).toEqual(['root', 'app', 'local']);
  });

  it('lets the real environment win, and reports a different file value as shadowed', () => {
    // WHY: Coolify must override a committed value without a commit; a silent override cost days in listio.
    write(app, '.env.development', ['PORT=3000', 'SAME=x']);
    const { env, report } = load({ PORT: '8080', SAME: 'x' });
    expect(env['PORT']).toBe('8080');
    expect(report.shadowed.map(entry => entry.key)).toEqual(['PORT']);
  });

  it('treats an empty variable as unset', () => {
    // WHY: Coolify and Docker `ENV X=${X}` bake unset variables as "".
    write(app, '.env.development', ['URL=http://x']);
    expect(load({ URL: '' }).env['URL']).toBe('http://x');
  });

  it('skips .env.local under test', () => {
    writeFileSync(path.join(app, '.env.local'), 'A=local\n');
    const env: Record<string, string | undefined> = {};
    loadEnvFiles({ cwd: app, environment: 'test', env });
    expect(env['A']).toBeUndefined();
  });
});

describe('encrypted values', () => {
  it('decrypts with the key from the environment and remembers the value as secret', () => {
    write(app, '.env.development', [`TOKEN=${encryptValue('s3cret-token', pair.publicKey)}`]);
    const { env, report } = load();
    expect(env['TOKEN']).toBe('s3cret-token');
    expect(report.values.find(value => value.key === 'TOKEN')?.kind).toBe('encrypted');
    expect(secretValues()).toContain('s3cret-token');
  });

  it('finds the key in .env.keys at the root when the environment has none', () => {
    write(app, '.env.development', [`TOKEN=${encryptValue('from-keys-file', pair.publicKey)}`]);
    writePrivateKey(path.join(root, '.env.keys'), 'DOTENV_PRIVATE_KEY_DEVELOPMENT', pair.privateKey, '.env.development');
    const env: Record<string, string | undefined> = {};
    loadEnvFiles({ cwd: app, environment: 'development', env });
    expect(env['TOKEN']).toBe('from-keys-file');
  });

  it('replaces ciphertext Bun auto-loaded into the environment', () => {
    // WHY: Bun loads .env files before our code; its ciphertext must never count as a real value.
    const sealed = encryptValue('real', pair.publicKey);
    write(app, '.env.development', [`TOKEN=${sealed}`]);
    const { env, report } = load({ TOKEN: sealed });
    expect(env['TOKEN']).toBe('real');
    expect(report.shadowed).toEqual([]);
  });

  it('reports a missing key by name and never writes the ciphertext', () => {
    write(app, '.env.development', [`TOKEN=${encryptValue('x', pair.publicKey)}`]);
    const env: Record<string, string | undefined> = {};
    const report = loadEnvFiles({ cwd: app, environment: 'development', env });
    expect(report.errors.map(error => error.code)).toEqual([ENV_FILES_ERROR_CODES.missingPrivateKey]);
    expect(report.errors[0]?.message).toContain('DOTENV_PRIVATE_KEY_DEVELOPMENT');
    expect(env['TOKEN']).toBeUndefined();
  });

  it('reports a wrong key per value without leaking it', () => {
    write(app, '.env.development', [`TOKEN=${encryptValue('top-secret', generateKeypair().publicKey)}`]);
    const { report } = load();
    expect(report.errors.map(error => [error.code, error.key])).toEqual([[ENV_FILES_ERROR_CODES.cannotDecrypt, 'TOKEN']]);
    expect(JSON.stringify(report.errors)).not.toContain('top-secret');
  });
});

describe('references', () => {
  it('resolves registered schemes and leaves other URLs plain', () => {
    // WHY: a postgres:// value must never be sent to a secret manager.
    write(app, '.env.development', ['STRIPE=vault://billing/stripe', 'DB_URL=postgres://u:p@h/db']);
    const env: Record<string, string | undefined> = {};
    const report = loadEnvFiles({ cwd: app, environment: 'development', env, references: { vault: reference => `resolved:${reference}` } });
    expect(env['STRIPE']).toBe('resolved:vault://billing/stripe');
    expect(env['DB_URL']).toBe('postgres://u:p@h/db');
    expect(report.values.find(value => value.key === 'STRIPE')?.kind).toBe('reference');
  });

  it('reports a failing provider by scheme', () => {
    write(app, '.env.development', ['STRIPE=vault://x']);
    const report = loadEnvFiles({ cwd: app, environment: 'development', env: {}, references: { vault: () => { throw new Error('not logged in'); } } });
    expect(report.errors.map(error => error.code)).toEqual([ENV_FILES_ERROR_CODES.unresolvedReference]);
    expect(report.errors[0]?.message).toContain('not logged in');
  });
});

describe('editing', () => {
  it('reuses the environment key on init, so every app shares one development key', () => {
    // WHY: a second app's init must not mint a key that overwrites the first one's in .env.keys.
    const first = initEnvFile(path.join(root, '.env.development'), { root, env: {} });
    const second = initEnvFile(path.join(app, '.env.development'), { root, env: {} });
    expect(first.keysWritten).toBe(path.join(root, '.env.keys'));
    expect(second.keysWritten).toBeUndefined();
    expect(second.publicKey).toBe(first.publicKey);
  });

  it('sets an encrypted value that loads back', () => {
    const file = path.join(app, '.env.development');
    initEnvFile(file, { root, env: {} });
    expect(setEnvFileValue(file, 'KEY', 'value-1', { plain: false })).toBe(true);
    const env: Record<string, string | undefined> = {};
    loadEnvFiles({ cwd: app, environment: 'development', env });
    expect(env['KEY']).toBe('value-1');
  });

  it('reports a plain set that changes nothing', () => {
    // WHY: listio's `set` silently wrote nothing; the caller must be told.
    const file = path.join(app, '.env.development');
    initEnvFile(file, { root, env: {} });
    expect(setEnvFileValue(file, 'A', 'x', { plain: true })).toBe(true);
    expect(setEnvFileValue(file, 'A', 'x', { plain: true })).toBe(false);
  });

  it('rotates every file of an environment together', () => {
    const files = [path.join(root, '.env.development'), path.join(app, '.env.development')];
    for (const file of files) {
      initEnvFile(file, { root, env: {} });
      setEnvFileValue(file, 'K', `v-${path.basename(path.dirname(file))}`, { plain: false });
    }
    const result = rotateEnvFiles(files, { root, env: {} });
    expect(result.files.map(file => file.values)).toEqual([1, 1]);
    const env: Record<string, string | undefined> = {};
    const report = loadEnvFiles({ cwd: app, environment: 'development', env });
    expect(report.errors).toEqual([]);
    expect(env['K']).toBe('v-demo');
  });
});

describe('refused entries', () => {
  it('never applies loader-hijacking keys from a file', () => {
    // WHY: a committed NODE_OPTIONS=--require would run code in every process started with this env.
    write(app, '.env.development', ['NODE_OPTIONS=--require ./evil.js', 'DYLD_INSERT_LIBRARIES=x', 'bash_env=./x.sh', 'NODE_EXTRA_CA_CERTS=./mitm.pem', 'OK=1']);
    const { env, report } = load();
    expect([env['NODE_OPTIONS'], env['DYLD_INSERT_LIBRARIES'], env['OK']]).toEqual([undefined, undefined, '1']);
    expect(report.refused.map(entry => entry.key)).toEqual(['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'bash_env', 'NODE_EXTRA_CA_CERTS']);
  });

  it('never resolves a reference into a public key', () => {
    // WHY: a VITE_ key is inlined into the browser bundle; a secret must never reach it.
    write(app, '.env.development', ['VITE_TOKEN=vault://x']);
    let called = false;
    const env: Record<string, string | undefined> = {};
    const report = loadEnvFiles({ cwd: app, environment: 'development', env, references: { vault: () => { called = true; return 's'; } } });
    expect({ called, value: env['VITE_TOKEN'], refused: report.refused.map(entry => entry.key) }).toEqual({ called: false, value: undefined, refused: ['VITE_TOKEN'] });
  });
});

describe('reference paths', () => {
  it('rejects a segment that would read as a CLI flag', async () => {
    const { DEFAULT_RESOLVERS } = await import('./references.js');
    expect(() => DEFAULT_RESOLVERS['doppler']?.('doppler://--token=x/cfg/NAME')).toThrow(/must match/);
  });
});

