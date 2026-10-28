/** Real synthetic op processes prove privacy and recovery without contacting a vault. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { writeVaultItem } from './commands/env/keys-shared.js';
import type { EnvVaultWriteUnconfirmed } from './env-failures.js';
import { op, vaultItemTitle } from './commands/env/keys-shared.js';
import { EnvVaultFailed } from './env-failures.js';
import { program } from './index.js';

const privateKey = '1'.repeat(64);
const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL';
const id = 'a'.repeat(26);
let root: string;

function item() {
  return {
    id,
    title: vaultItemTitle(root, 'development'),
    category: 'PASSWORD',
    tags: ['keep'],
    sections: [{ id: 'details', label: 'Keep section' }],
    fields: [
      { id: 'password', purpose: 'PASSWORD', type: 'CONCEALED', value: 'old-key', label: 'Keep label' },
      { id: 'notesPlain', type: 'STRING', value: 'Keep notes' },
    ],
  };
}

function state(items: ReturnType<typeof item>[], mode = 'success') {
  writeFileSync(path.join(root, 'provider.json'), JSON.stringify({ items, mode }));
}

function calls(): string[][] {
  return readFileSync(path.join(root, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function dot(command: string, ...args: string[]) {
  let out = '';
  let stderr = '';
  const code = await program.main(['env', 'keys', command, '--vault', 'Synthetic', '--cwd', root, '--json', ...args], {
    stdout: text => (out += text),
    stderr: text => (stderr += text),
    tty: false,
  });
  return { code, out, stderr };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dot-env-vault-'));
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, 'calls.jsonl'), '');
  // Fixture storage represents the remote provider, and contains synthetic data only.
  writeFileSync(
    path.join(root, 'op'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, 'provider.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const operation = args[0] === 'read' ? 'read' : args[1];
if (state.mode === operation + '-refuse') {
  process.stderr.write('${sentinel}'); process.exit(1);
}
if (operation === 'list') {
  process.stdout.write(state.mode === 'malformed-list' ? '${sentinel}' : JSON.stringify(state.items));
} else if (operation === 'get') {
  process.stdout.write(JSON.stringify(state.items.find(item => item.id === args[2])));
} else if (operation === 'create' || operation === 'edit') {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const item = { ...input, id: input.id || '${id}' };
  state.items = operation === 'create' ? [...state.items, item] : state.items.map(old => old.id === args[2] ? item : old);
  fs.writeFileSync(file, JSON.stringify(state));
  if (state.mode === 'commit-refuse') { process.stderr.write('${sentinel}'); process.exit(1); }
  process.stdout.write(state.mode === 'commit-malformed' ? '${sentinel}' : JSON.stringify(item));
} else { process.stderr.write('${sentinel}'); process.exit(1); }
`,
    { mode: 0o700 },
  );
  vi.stubEnv('PATH', root);
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DOTENV_PRIVATE_KEY_DEVELOPMENT', privateKey);
  state([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('vault privacy and confirmed lookup', () => {
  it.each(['pull', 'push'])('keeps %s provider stderr out of the public command envelope', async command => {
    state([], command === 'pull' ? 'read-refuse' : 'list-refuse');
    const actual = await dot(command, ...(command === 'push' ? ['--force'] : []));
    expect(actual.code).not.toBe(0);
    expect(actual.out).toContain('dot.env_vault_failed');
    expect(actual.out + actual.stderr).not.toContain(sentinel);
    expect(calls().every(args => !args.includes('create') && !args.includes('edit'))).toBe(true);
  });

  it.each(['get-refuse', 'malformed-list'])('refuses %s before any write', async mode => {
    state([item()], mode);
    const result = await dot('push', '--force');
    expect(result.out).toContain('dot.env_vault_failed');
    expect(result.out + result.stderr).not.toContain(sentinel);
    expect(calls().map(args => args[1])).toEqual(mode === 'get-refuse' ? ['list', 'get'] : ['list']);
  });

  it('refuses ambiguous titles before retrieving or changing either backup', async () => {
    state([item(), { ...item(), id: 'b'.repeat(26) }]);
    const result = await dot('push', '--force');
    expect(result.out).toContain('dot.env_vault_failed');
    expect(calls().map(args => args[1])).toEqual(['list']);
  });

  it('rejects invalid provider item IDs before selecting a mutation target', async () => {
    state([{ ...item(), id: '--unsafe' }]);
    const result = await dot('push', '--force');
    expect(result.out).toContain('dot.env_vault_failed');
    expect(calls().map(args => args[1])).toEqual(['list']);
  });

  it('refuses a Login item whose passkey would be lost by a JSON edit', async () => {
    state([{ ...item(), category: 'LOGIN' }]);
    const result = await dot('push', '--force');
    expect(result.out).toContain('dot.env_vault_failed');
    expect(calls().map(args => args[1])).toEqual(['list', 'get']);
  });

  it('retains native diagnostics only in the private failure cause', () => {
    state([], 'read-refuse');
    const result = op(['read', 'synthetic']);
    expect(EnvVaultFailed.is(result)).toBe(true);
    if (!EnvVaultFailed.is(result)) throw new Error('Expected vault failure');
    expect(String(result.cause)).toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});

describe('vault writes and reconciliation', () => {
  it('updates the existing item in place while preserving its other fields', async () => {
    const before = item();
    state([before]);
    const result = await dot('push', '--force');
    expect(result.code).toBe(0);
    expect(calls().map(args => args[1])).toEqual(['list', 'get', 'edit']);
    expect(calls()[2]?.[2]).toBe(id);
    expect(JSON.parse(readFileSync(path.join(root, 'provider.json'), 'utf8')).items).toEqual([
      {
        ...before,
        fields: before.fields.map(field => (field.id === 'password' ? { ...field, value: privateKey } : field)),
      },
    ]);
    expect(JSON.stringify(calls()) + result.out + result.stderr).not.toContain(privateKey);
  });

  it('creates only after confirmed absence', async () => {
    const result = await dot('push');
    expect(result.code).toBe(0);
    expect(calls().map(args => args[1])).toEqual(['list', 'create']);
  });

  it('does not replace a different key without force', async () => {
    state([item()]);
    const result = await dot('push');
    expect(result.out).toContain('dot.env_vault_failed');
    expect(calls().map(args => args[1])).toEqual(['list', 'get']);
  });

  it.each(['create', 'edit'])('retains the backup after a rejected %s', async operation => {
    const before = operation === 'edit' ? [item()] : [];
    state(before, operation + '-refuse');
    const result = await dot('push', '--force');
    expect(result.out).toContain('dot.env_vault_write_unconfirmed');
    expect(result.out + result.stderr).not.toContain(sentinel);
    expect(JSON.parse(readFileSync(path.join(root, 'provider.json'), 'utf8')).items).toEqual(before);
    expect(calls().some(args => args.includes('delete'))).toBe(false);
  });

  it.each([
    ['create', 'commit-refuse'],
    ['edit', 'commit-refuse'],
    ['create', 'commit-malformed'],
    ['edit', 'commit-malformed'],
  ])('reconciles an ambiguous %s (%s) before retry and never repeats the mutation', async (operation, mode) => {
    state(operation === 'edit' ? [item()] : [], mode);
    const first = await dot('push', '--force');
    expect(first.out).toContain('dot.env_vault_write_unconfirmed');
    expect(first.out).toContain('Reconcile');
    expect(first.out + first.stderr).not.toContain(sentinel);
    const second = await dot('push');
    expect(second.code).toBe(0);
    expect(calls().map(args => args[1])).toEqual(
      operation === 'edit' ? ['list', 'get', 'edit', 'list', 'get'] : ['list', 'create', 'list', 'get'],
    );
    expect(JSON.stringify(calls()) + first.out + second.out).not.toContain(privateKey);
  });

  it('keeps the helper failure unions exact', () => {
    expectTypeOf<ReturnType<typeof op>>().toEqualTypeOf<string | ReturnType<typeof EnvVaultFailed>>();
    expectTypeOf<Extract<ReturnType<typeof writeVaultItem>, { code: string }>>().toEqualTypeOf<
      ReturnType<typeof EnvVaultWriteUnconfirmed>
    >();
  });
});
