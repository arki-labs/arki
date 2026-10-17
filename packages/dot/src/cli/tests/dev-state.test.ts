/**
 * `dev.json` is how two `dot dev` sessions in one project avoid fighting over
 * the database and the port. A live pid blocks; a dead pid (a crashed
 * session) must not block forever; a release never removes another
 * session's file. The events schema is the contract for `--json` readers.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { DevEvent } from '../dev-events.js';
import { devEventSchema } from '../dev-events.js';
import { claimDevState, DEV_STATE_PATH, devStateSchema, releaseDevState } from '../dev-state.js';
import { tempProject } from './dev-helpers.js';

let workDir: string;

beforeEach(async () => {
  workDir = await tempProject('dot-dev-state-');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** The pid of a process that has exited: spawn one and wait for it. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return child.pid;
}

async function writeState(pid: number): Promise<string> {
  const file = path.join(workDir, DEV_STATE_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
  return file;
}

describe('dev.json', () => {
  it('creates the file with our pid', async () => {
    const claimed = await claimDevState(workDir, process.pid);
    if (isFailure(claimed)) throw new Error(claimed.message);
    const state: unknown = JSON.parse(await readFile(claimed.file, 'utf8'));
    expect(devStateSchema['~standard'].validate(state)).toEqual({
      value: expect.objectContaining({ pid: process.pid }),
    });
  });

  it('refuses a second session while the pid in the file is alive', async () => {
    // The parent of this test process is alive for as long as the test runs.
    await writeState(process.ppid);
    const claimed = await claimDevState(workDir, process.pid);
    expect(isFailure(claimed) && claimed.code).toBe('dot.dev_already_running');
    expect(isFailure(claimed) && claimed.data).toEqual(expect.objectContaining({ pid: process.ppid }));
  });

  it('reclaims a file whose pid is dead', async () => {
    const file = await writeState(deadPid());
    const claimed = await claimDevState(workDir, process.pid);
    expect(isFailure(claimed)).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expect.objectContaining({ pid: process.pid }));
  });

  it('release leaves a file that names another pid', async () => {
    const file = await writeState(process.ppid);
    await releaseDevState(file, process.pid);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expect.objectContaining({ pid: process.ppid }));
    await releaseDevState(file, process.ppid);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});

describe('devEventSchema', () => {
  const events: DevEvent[] = [
    { kind: 'app', file: 'src/app.ts', exportName: 'dev', plugins: 3, features: 1 },
    { kind: 'db', driver: 'pg', target: 'postgres://u:***@localhost:5432/app', owned: true },
    { kind: 'migrations', pending: ['0001_init'] },
    { kind: 'preflight', status: 'warning', codes: ['ARKI_DOT_E003'] },
    { kind: 'runner', command: 'vite dev --port 3000 --strictPort', pid: 42 },
    { kind: 'console', url: 'http://127.0.0.1:4321/' },
    { kind: 'restart', reason: 'file', path: 'drizzle/0002.sql' },
    { kind: 'exit', code: 0 },
  ];

  it('round-trips every kind through JSON', async () => {
    for (const event of events) {
      const wire = JSON.stringify(event);
      const parsed = await devEventSchema['~standard'].validate(JSON.parse(wire));
      expect(parsed).toEqual({ value: event });
    }
  });

  it('rejects an unknown kind and a console event without a URL', async () => {
    const unknown = await devEventSchema['~standard'].validate({ kind: 'reload' });
    const badUrl = await devEventSchema['~standard'].validate({ kind: 'console', url: 'not a url' });
    expect('issues' in unknown).toBe(true);
    expect('issues' in badUrl).toBe(true);
  });
});
