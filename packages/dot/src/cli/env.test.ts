/**
 * `dot env` end to end, against a throwaway git repository. The properties that matter: a value
 * never appears in a JSON envelope (agents read envelopes), a write that changes nothing fails
 * loudly (listio's silent no-op), and `run` hands the child's output through untouched except for
 * secrets.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRedactor } from './env-redact.js';
import { program } from './index.js';

const SECRET = 'sk_live_0123456789abcdef';
const CLI = fileURLToPath(new URL('index.ts', import.meta.url));

/** Warnings go to stderr; these tests assert on the envelope only. */
function ignoreStderr(): void {
  // Intentionally empty.
}

let root: string;
let app: string;

async function dot(...argv: string[]): Promise<{ code: number; out: string; json: { ok: boolean; data: unknown; error?: { code: string } } }> {
  let out = '';
  const code = await program.main([...argv, '--cwd', app, '--json'], { stdout: text => (out += text), stderr: ignoreStderr, tty: false });
  return { code, out, json: out === '' ? { ok: code === 0, data: null } : JSON.parse(out) };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dot-env-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(path.join(root, '.claude'));
  app = path.join(root, 'apps', 'demo');
  mkdirSync(app, { recursive: true });
  vi.stubEnv('NODE_ENV', 'development');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** `dot env run` as a real process: the child writes to the real stdout, not to the test's io. */
function run(...args: string[]) {
  return spawnSync('bun', [CLI, 'env', 'run', '--cwd', app, ...args], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development' } });
}

describe('dot env init', () => {
  it('writes the header, a private key, the gitignore line and the agent read-deny', async () => {
    const { code, json } = await dot('env', 'init');
    expect(code).toBe(0);
    expect(json.data).toMatchObject({ file: 'apps/demo/.env.development', headerAdded: true, keysWritten: '.env.keys', gitignore: 'added', agentDeny: 'added' });
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('.env.keys*');
    expect(readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).toContain('Read(**/.env.keys)');
    const again = await dot('env', 'init');
    expect(again.json.data).toMatchObject({ headerAdded: false, gitignore: 'present', agentDeny: 'present' });
  });

  it("adds the read-deny without reordering the user's settings", async () => {
    // WHY: init edits a file the user owns; a reshuffled settings.json is a noisy, unreviewable diff.
    const settings = path.join(root, '.claude', 'settings.json');
    writeFileSync(settings, JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm)'], ask: [] } }));
    await dot('env', 'init');
    const written = JSON.parse(readFileSync(settings, 'utf8'));
    expect(Object.keys(written)).toEqual(['model', 'permissions']);
    expect(Object.keys(written.permissions)).toEqual(['allow', 'deny', 'ask']);
    expect(written.permissions.deny).toEqual(['Bash(rm)', 'Read(**/.env.keys)', 'Read(**/.env.keys.*)']);
  });
});

describe('set, get, ls never leak a value', () => {
  beforeEach(async () => {
    await dot('env', 'init');
    await dot('env', 'set', 'TOKEN', SECRET);
    await dot('env', 'set', 'PORT', '3000', '--plain');
  });

  it('stores the secret encrypted and the plain value as written', () => {
    const text = readFileSync(path.join(app, '.env.development'), 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('PORT="3000"');
  });

  it('get prints the shape, and refuses --reveal outside a terminal', async () => {
    const get = await dot('env', 'get', 'TOKEN');
    expect(get.json.data).toMatchObject({ key: 'TOKEN', kind: 'encrypted', length: SECRET.length });
    expect(get.out).not.toContain(SECRET);
    const reveal = await dot('env', 'get', 'TOKEN', '--reveal');
    expect(reveal.json.error?.code).toBe('dot.env_reveal_refused');
    expect(reveal.out).not.toContain(SECRET);
  });

  it('ls lists keys without values', async () => {
    const ls = await dot('env', 'ls');
    expect(ls.out).not.toContain(SECRET);
    expect(ls.json.data).toMatchObject({ keys: [{ key: 'TOKEN', kind: 'encrypted', secret: true }, { key: 'PORT', kind: 'plain', secret: false }] });
  });

  it('fails loudly when a plain set changes nothing', async () => {
    // WHY: listio's `set` reported success and wrote nothing.
    const same = await dot('env', 'set', 'PORT', '3000', '--plain');
    expect(same.json.error?.code).toBe('dot.env_no_change');
  });

  it('explain names the file and the key source, not the value', async () => {
    const explain = await dot('env', 'explain', 'TOKEN');
    expect(explain.json.data).toMatchObject({ winner: { file: 'apps/demo/.env.development', kind: 'encrypted' }, privateKey: 'DOTENV_PRIVATE_KEY_DEVELOPMENT in .env.keys' });
    expect(explain.out).not.toContain(SECRET);
  });
});

describe('dot env check', () => {
  it('passes on a clean repository and fails when .env.keys is tracked', async () => {
    await dot('env', 'init');
    const clean = await dot('env', 'check');
    expect(clean.code).toBe(0);
    execFileSync('git', ['add', '-f', '.env.keys'], { cwd: root });
    const failed = await dot('env', 'check');
    expect(failed.json.error?.code).toBe('dot.env_check_failed');
    expect(failed.out).toContain('dot.env.tracked_keys');
  });

  it('warns about a legacy bare .env file', async () => {
    await dot('env', 'init');
    writeFileSync(path.join(app, '.env'), 'A=1\n');
    const legacy = await dot('env', 'check');
    expect(legacy.json.data).toMatchObject({ findings: [{ code: 'dot.env.legacy_file', severity: 'warning' }] });
  });

  it('reads secret() keys from an env module whose values are not set', async () => {
    // WHY: the files are not loaded when check imports src/env.ts; validation must not stop it.
    await dot('env', 'init');
    mkdirSync(path.join(app, 'src'));
    writeFileSync(
      path.join(app, 'src', 'env.ts'),
      [
        // The temp dir has no node_modules: import the very files dot resolves, so the registry is shared.
        `import { z } from '${import.meta.resolve('zod')}';`,
        `import { defineEnv, secret } from '${import.meta.resolve('@arki/env/core')}';`,
        "export const env = defineEnv({ server: { STRIPE_SECRET_KEY: secret(z.string().min(1)) }, runtimeEnv: process.env });",
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(app, '.env.development'), `${readFileSync(path.join(app, '.env.development'), 'utf8')}STRIPE_SECRET_KEY=${SECRET}\n`);
    execFileSync('git', ['add', '.env.development'], { cwd: app });
    const result = await dot('env', 'check');
    expect(result.json.error?.code).toBe('dot.env_check_failed');
    expect(result.out).toContain('dot.env.plaintext_secret');
    expect(result.out).not.toContain(SECRET);
  });

  it('reports an env schema that cannot be imported instead of crashing', async () => {
    // WHY: under Node, importing src/env.ts throws; check must still run and say what it skipped.
    await dot('env', 'init');
    mkdirSync(path.join(app, 'src'));
    writeFileSync(path.join(app, 'src', 'env.ts'), "throw new Error('cannot load');\n");
    const result = await dot('env', 'check');
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ findings: [{ code: 'dot.env.schema_unavailable', severity: 'warning' }] });
  });
});

describe('dot env encrypt --from', () => {
  it('encrypts secret-looking keys, keeps the rest plain, and lists both', async () => {
    await dot('env', 'init');
    writeFileSync(path.join(app, '.env'), `STRIPE_SECRET_KEY=${SECRET}\nDB_URL=postgres://u:p@h/db\nPORT=3000\n`);
    const result = await dot('env', 'encrypt', '--from', '.env');
    expect(result.json.data).toMatchObject({ encrypted: ['STRIPE_SECRET_KEY', 'DB_URL'], plain: ['PORT'] });
    expect(readFileSync(path.join(app, '.env.development'), 'utf8')).not.toContain(SECRET);
  });
});

describe('dot env encrypt --from --all', () => {
  it('encrypts every imported value, so an oddly named secret cannot land in git as plaintext', async () => {
    await dot('env', 'init');
    writeFileSync(path.join(app, '.env'), 'ODD_NAME=hunter2-really-secret\nPORT=3000\n');
    const result = await dot('env', 'encrypt', '--from', '.env', '--all');
    expect(result.json.data).toMatchObject({ encrypted: ['ODD_NAME', 'PORT'], plain: [] });
    expect(readFileSync(path.join(app, '.env.development'), 'utf8')).not.toContain('hunter2');
  });
});

describe('dot env run', () => {
  beforeEach(async () => {
    await dot('env', 'init');
    await dot('env', 'set', 'TOKEN', SECRET);
  });

  it('hands the decrypted value to the child and redacts it in piped output', () => {
    const result = run('--', 'node', '-e', 'console.log(process.env.TOKEN.length, process.env.TOKEN)');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${String(SECRET.length)} [redacted]\n`);
  });

  it('prints the value with --no-redact, and passes the exit code through with no envelope', () => {
    expect(run('--no-redact', '--', 'node', '-e', 'console.log(process.env.TOKEN)').stdout).toBe(`${SECRET}\n`);
    const exit = run('--', 'node', '-e', 'process.exit(7)');
    expect({ status: exit.status, stdout: exit.stdout }).toEqual({ status: 7, stdout: '' });
  });

  it('redacts an inherited value of an encrypted key too', () => {
    // WHY: when the environment already sets the key, the child gets that value, not the file one.
    const result = spawnSync('bun', [CLI, 'env', 'run', '--cwd', app, '--', 'node', '-e', 'console.log(process.env.TOKEN)'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development', TOKEN: 'inherited-secret-value' },
    });
    expect(result.stdout).toBe('[redacted]\n');
  });

  it('never hands the private key to the child', () => {
    // WHY: `dot env run -- <agent>` must not give the agent the key that decrypts everything.
    const keys = readFileSync(path.join(root, '.env.keys'), 'utf8');
    const key = /DOTENV_PRIVATE_KEY_DEVELOPMENT=(\w+)/.exec(keys)?.[1] ?? '';
    const result = spawnSync('bun', [CLI, 'env', 'run', '--cwd', app, '--no-redact', '--', 'node', '-e', 'console.log(process.env.DOTENV_PRIVATE_KEY_DEVELOPMENT ?? "absent")'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development', DOTENV_PRIVATE_KEY_DEVELOPMENT: key },
    });
    expect(result.stdout).toBe('absent\n');
  });

  it('fails with an envelope, before starting anything, when the key is missing', () => {
    rmSync(path.join(root, '.env.keys'));
    const result = run('--', 'node', '-e', 'console.log("started")');
    expect(result.status).toBe(3);
    expect(result.stdout).not.toContain('started');
    expect(result.stdout).toContain('dot.env_load_failed');
  });
});

describe('the redactor', () => {
  it('catches a secret split across chunks and holds back only a possible prefix', () => {
    let out = '';
    const redactor = createRedactor([SECRET], text => (out += text));
    redactor.write(Buffer.from(`token=${SECRET.slice(0, 10)}`));
    expect(out).toBe('token=');
    redactor.write(Buffer.from(`${SECRET.slice(10)} done`));
    redactor.write(Buffer.from(' sk_'));
    redactor.end();
    expect(out).toBe('token=[redacted] done sk_');
  });
});

it('keeps .env.keys out of the working directory listing of an app', () => {
  expect(existsSync(path.join(app, '.env.keys'))).toBe(false);
});
