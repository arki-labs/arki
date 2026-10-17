/**
 * The db step is the safety gate of `dot dev`: the preflight boots the app,
 * and boot applies migrations. A database that is not on this machine (or a
 * compose service) must be refused unless the user says so, and under
 * pglite no URL may leak through to the app.
 */
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { Exec } from '../dev-db.js';
import { prepareDb } from '../dev-db.js';
import { tempProject } from './dev-helpers.js';

let workDir: string;

beforeEach(async () => {
  workDir = await tempProject('dot-dev-db-');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const closed = (): Promise<boolean> => Promise.resolve(false);
const open = (): Promise<boolean> => Promise.resolve(true);

function recordingExec(answers: (args: readonly string[]) => { code: number; stdout: string }): {
  readonly exec: Exec;
  readonly calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args]);
    return Promise.resolve({ ...answers(args), stderr: '' });
  };
  return { exec, calls };
}

const COMPOSE_JSON = JSON.stringify({
  name: 'shop',
  services: {
    web: { image: 'node' },
    db: { image: 'postgres:17', ports: [{ mode: 'ingress', target: 5432, published: '5433', protocol: 'tcp' }] },
  },
});

describe('prepareDb', () => {
  it('refuses a remote host, and never shows its password', async () => {
    const result = await prepareDb({
      cwd: workDir,
      db: 'auto',
      allowRemoteDb: false,
      env: { DB_URL: 'postgres://admin:s3cret@db.example.com:5432/prod' },
      probe: open,
    });
    expect(isFailure(result) && result.code).toBe('dot.dev_remote_db_refused');
    expect(JSON.stringify(isFailure(result) ? [result.message, result.data] : result)).not.toContain('s3cret');
  });

  it('refuses a remote host hidden in the host query parameter', async () => {
    const result = await prepareDb({
      cwd: workDir,
      db: 'pg',
      allowRemoteDb: false,
      env: { DB_URL: 'postgres://admin@localhost/prod?host=db.example.com' },
      probe: open,
    });
    expect(isFailure(result) && result.code).toBe('dot.dev_remote_db_refused');
  });

  it('accepts the remote host with --allow-remote-db, password redacted', async () => {
    const result = await prepareDb({
      cwd: workDir,
      db: 'auto',
      allowRemoteDb: true,
      env: { DB_URL: 'postgres://admin:s3cret@db.example.com:5432/prod' },
      probe: open,
    });
    if (isFailure(result)) throw new Error(result.message);
    expect(result.event).toEqual({
      kind: 'db',
      driver: 'pg',
      target: 'postgres://admin:***@db.example.com:5432/prod',
      owned: false,
    });
  });

  it('pglite removes DB_URL and DATABASE_URL from both .env and the process env', async () => {
    await writeFile(path.join(workDir, '.env'), 'DB_URL=postgres://u:p@localhost/app\nAPP_NAME=shop\n');
    const result = await prepareDb({
      cwd: workDir,
      db: 'pglite',
      allowRemoteDb: false,
      env: { DATABASE_URL: 'postgres://u:p@127.0.0.1/app', PATH: '/bin' },
    });
    if (isFailure(result)) throw new Error(result.message);
    expect(result.event).toEqual({ kind: 'db', driver: 'pglite', target: 'embedded', owned: false });
    expect(result.env).toEqual({ APP_NAME: 'shop', PATH: '/bin' });
  });

  it('auto without a URL is pglite; the process env overrides .env', async () => {
    await writeFile(path.join(workDir, '.env'), 'APP_NAME=from-file\n');
    const result = await prepareDb({ cwd: workDir, db: 'auto', allowRemoteDb: false, env: { APP_NAME: 'from-env' } });
    if (isFailure(result)) throw new Error(result.message);
    expect(result.event.driver).toBe('pglite');
    expect(result.env['APP_NAME']).toBe('from-env');
  });

  it('starts the compose service that publishes the port when it is closed, and owns it', async () => {
    await writeFile(path.join(workDir, 'docker-compose.yml'), 'services: {}\n');
    const { exec, calls } = recordingExec(args => ({ code: 0, stdout: args.includes('config') ? COMPOSE_JSON : '' }));
    let probes = 0;
    const result = await prepareDb({
      cwd: workDir,
      db: 'pg',
      allowRemoteDb: false,
      env: { DB_URL: 'postgres://u:p@localhost:5433/app' },
      exec,
      // Closed at the first probe and the first poll, open at the second poll.
      probe: () => {
        probes += 1;
        return Promise.resolve(probes >= 3);
      },
      pollIntervalMs: 5,
    });
    if (isFailure(result)) throw new Error(result.message);
    expect(calls).toContainEqual(['docker', 'compose', 'up', '-d', 'db']);
    expect(calls.some(call => call.includes('down') || call.includes('-v'))).toBe(false);
    expect(probes).toBe(3);
    expect(result.event).toEqual({
      kind: 'db',
      driver: 'pg',
      target: 'postgres://u:***@localhost:5433/app',
      owned: true,
    });
  });

  it('accepts a compose service name as the host', async () => {
    await writeFile(path.join(workDir, 'compose.yaml'), 'services: {}\n');
    const { exec } = recordingExec(() => ({ code: 0, stdout: COMPOSE_JSON }));
    const result = await prepareDb({
      cwd: workDir,
      db: 'pg',
      allowRemoteDb: false,
      env: { DB_URL: 'postgres://u@db:5432/app' },
      exec,
      probe: open,
      lookup: () => Promise.resolve(null),
    });
    expect(isFailure(result)).toBe(false);
  });

  it('refuses a compose service name that this machine resolves to a remote address', async () => {
    await writeFile(path.join(workDir, 'compose.yaml'), 'services: {}\n');
    const { exec } = recordingExec(() => ({ code: 0, stdout: COMPOSE_JSON }));
    const lookups = { remote: ['10.1.2.3'], local: ['127.0.0.1', '::1'] };
    const run = (addresses: readonly string[]) =>
      prepareDb({
        cwd: workDir,
        db: 'pg',
        allowRemoteDb: false,
        env: { DB_URL: 'postgres://u@db:5432/app' },
        exec,
        probe: open,
        lookup: () => Promise.resolve(addresses),
      });
    const remote = await run(lookups.remote);
    expect(isFailure(remote) && remote.code).toBe('dot.dev_remote_db_refused');
    expect(isFailure(await run(lookups.local))).toBe(false);
  });

  it('refuses a remote host in a repeated host parameter: drivers disagree on which one wins', async () => {
    const result = await prepareDb({
      cwd: workDir,
      db: 'pg',
      allowRemoteDb: false,
      env: { DB_URL: 'postgres://u@localhost/app?host=localhost&host=db.example.com' },
      probe: open,
    });
    expect(isFailure(result) && result.code).toBe('dot.dev_remote_db_refused');
  });

  it('under pglite still refuses a remote URL in any env file: the runner may load them again', async () => {
    await writeFile(path.join(workDir, '.env.local'), 'DATABASE_URL=postgres://u:p@db.example.com/prod\n');
    const result = await prepareDb({ cwd: workDir, db: 'pglite', allowRemoteDb: false, env: {} });
    expect(isFailure(result) && result.code).toBe('dot.dev_remote_db_refused');
    expect(isFailure(result) && result.data).toEqual(
      expect.objectContaining({ source: 'DATABASE_URL in .env.local', host: 'db.example.com' }),
    );
    // Shadowed by a local value in a later file, the remote one still counts.
    await writeFile(path.join(workDir, '.env.development.local'), 'DATABASE_URL=postgres://u@localhost/app\n');
    const shadowed = await prepareDb({ cwd: workDir, db: 'pglite', allowRemoteDb: false, env: {} });
    expect(isFailure(shadowed) && shadowed.code).toBe('dot.dev_remote_db_refused');
  });

  it('reads the four env files in Vite order; the process env wins over all of them', async () => {
    await writeFile(path.join(workDir, '.env'), 'A=env\nB=env\nC=env\nD=env\nE=env\n');
    await writeFile(path.join(workDir, '.env.local'), 'B=local\nC=local\nD=local\nE=local\n');
    await writeFile(path.join(workDir, '.env.development'), 'C=development\nD=development\nE=development\n');
    await writeFile(path.join(workDir, '.env.development.local'), 'D=development.local\nE=development.local\n');
    const result = await prepareDb({ cwd: workDir, db: 'pglite', allowRemoteDb: false, env: { E: 'process' } });
    if (isFailure(result)) throw new Error(result.message);
    expect(result.env).toEqual({ A: 'env', B: 'local', C: 'development', D: 'development.local', E: 'process' });
  });

  it('is unreachable when the port is closed and there is no compose file', async () => {
    const { exec, calls } = recordingExec(() => ({ code: 0, stdout: '' }));
    const result = await prepareDb({
      cwd: workDir,
      db: 'pg',
      allowRemoteDb: false,
      env: { DB_URL: 'postgres://u@localhost:5432/app' },
      exec,
      probe: closed,
    });
    expect(isFailure(result) && result.code).toBe('dot.dev_db_unreachable');
    expect(calls).toEqual([]);
  });

  it('is unreachable under --db pg without a URL', async () => {
    const result = await prepareDb({ cwd: workDir, db: 'pg', allowRemoteDb: false, env: {} });
    expect(isFailure(result) && result.code).toBe('dot.dev_db_unreachable');
  });
});
