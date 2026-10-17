/**
 * The supervisor end to end. What must hold: a failed preflight starts no
 * runner (a broken app must not serve), a crash is reported once and not
 * retried in a loop, a migration change restarts through the preflight, and
 * stopping leaves no child and no `dev.json` behind.
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { DevEvent } from '../dev-events.js';
import type { RunDevOptions } from '../dev.js';
import { DEV_STATE_PATH } from '../dev-state.js';
import { runDev } from '../dev.js';
import { freePort, isAlive, recordingUi, tempProject, waitFor } from './dev-helpers.js';

const FIXTURE_APP = path.resolve(__dirname, 'fixtures', 'dev-app', 'dot.config.ts');
const CLI_ENTRY = ['bun', path.resolve(__dirname, '..', 'index.ts')] as const;
const DEFINE_APP_PATH = path.resolve(__dirname, '..', '..', 'define-app.ts');
const PLUGIN_CONTRACT_PATH = path.resolve(__dirname, '..', '..', 'plugin-contract.ts');

let workDir: string;

beforeEach(async () => {
  workDir = await tempProject('dot-dev-supervisor-');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function session(overrides: Partial<RunDevOptions> = {}) {
  const { ui, lines } = recordingUi();
  const events: DevEvent[] = [];
  const controller = new AbortController();
  const options: RunDevOptions = {
    app: FIXTURE_APP,
    cwd: workDir,
    db: 'auto',
    allowRemoteDb: false,
    port: await freePort(),
    consolePort: await freePort(),
    console: false,
    open: false,
    once: false,
    ui,
    mode: 'json',
    signal: controller.signal,
    onEvent: event => events.push(event),
    env: { PATH: process.env['PATH'] ?? '' },
    cliEntry: CLI_ENTRY,
    stopGraceMs: 2000,
    ...overrides,
  };
  return { result: runDev(options), events, lines, controller };
}

const kinds = (events: readonly DevEvent[]): string[] => events.map(event => event.kind);
const runners = (events: readonly DevEvent[]) =>
  events.filter((event): event is Extract<DevEvent, { kind: 'runner' }> => event.kind === 'runner');

describe('runDev', () => {
  it('--once reports app, db and preflight, starts nothing, and removes dev.json', async () => {
    const { result } = await session({ once: true });
    const done = await result;
    if (isFailure(done)) throw new Error(done.message);
    expect(kinds(done.items)).toEqual(['app', 'db', 'preflight']);
    expect(done.items[0]).toEqual(expect.objectContaining({ exportName: 'dev', plugins: 1 }));
    expect(done.items[2]).toEqual({ kind: 'preflight', status: 'ok', codes: [] });
    expect(await exists(path.join(workDir, DEV_STATE_PATH))).toBe(false);
  });

  it('a failed preflight returns the failure and spawns no runner', async () => {
    const appFile = path.join(workDir, 'broken.ts');
    await writeFile(
      appFile,
      `import { defineApp } from '${DEFINE_APP_PATH}';
import { plugin } from '${PLUGIN_CONTRACT_PATH}';
const broken = plugin({ name: 'broken', boot: () => { throw new Error('boot failed on purpose'); } });
export const dev = defineApp('broken').use(broken);
`,
    );
    const { result, events } = await session({ app: appFile, run: 'echo started > runner-ran' });
    const done = await result;
    expect(isFailure(done) && done.code).toBe('dot.doctor_failed');
    expect(kinds(events)).toEqual(['app', 'db', 'preflight']);
    expect(events[2]).toEqual(expect.objectContaining({ kind: 'preflight', status: 'failure' }));
    expect(await exists(path.join(workDir, 'runner-ran'))).toBe(false);
    expect(await exists(path.join(workDir, DEV_STATE_PATH))).toBe(false);
  });

  it('under pglite the app never sees DB_URL, not even at import time', async () => {
    const appFile = path.join(workDir, 'reads-env.ts');
    await writeFile(
      appFile,
      `import { defineApp } from '${DEFINE_APP_PATH}';
import { plugin } from '${PLUGIN_CONTRACT_PATH}';
const seenAtImport = process.env['DB_URL'];
const guard = plugin({ name: 'guard', boot: () => {
  if (seenAtImport !== undefined || process.env['DB_URL'] !== undefined) throw new Error('saw a database URL');
} });
export const dev = defineApp('reads-env').use(guard);
`,
    );
    const { result } = await session({
      app: appFile,
      db: 'pglite',
      once: true,
      env: { PATH: process.env['PATH'] ?? '', DB_URL: 'postgres://u:p@localhost/prod' },
    });
    const done = await result;
    if (isFailure(done)) throw new Error(done.message);
    expect(done.items[2]).toEqual({ kind: 'preflight', status: 'ok', codes: [] });
  });

  it('prints the migrations the preflight boot applied, read from the migrations service', async () => {
    // Stands in for `dbMigrations` from `@arki/db/dot`: the kernel matches its service by shape only.
    const appFile = path.join(workDir, 'migrates.ts');
    await writeFile(
      appFile,
      `import { defineApp } from '${DEFINE_APP_PATH}';
import { plugin } from '${PLUGIN_CONTRACT_PATH}';
const migrations = plugin({ name: 'db-migrations', provides: { migrations: () => ({ pending: ['0003_orders', '0004_invoices'] }) } });
export const dev = defineApp('migrates').use(migrations);
`,
    );
    const { result, lines } = await session({ app: appFile, once: true, mode: 'text' });
    const done = await result;
    if (isFailure(done)) throw new Error(done.message);
    expect(kinds(done.items)).toEqual(['app', 'db', 'migrations', 'preflight']);
    expect(done.items[2]).toEqual({ kind: 'migrations', pending: ['0003_orders', '0004_invoices'] });
    expect(lines.some(line => line.includes('migrations: 2 pending (0003_orders, 0004_invoices)'))).toBe(true);
  });

  it('a crashed runner is reported once and not restarted', async () => {
    const { result, events, lines, controller } = await session({ run: 'exit 3' });
    await waitFor(() => lines.some(line => line.includes('app crashed (code 3)')));
    // Long enough for a restart loop to show itself.
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(runners(events)).toHaveLength(1);
    expect(lines.filter(line => line.includes('app crashed'))).toHaveLength(1);
    controller.abort();
    const done = await result;
    if (isFailure(done)) throw new Error(done.message);
    expect(done.items.at(-1)).toEqual({ kind: 'exit', code: 3 });
  });

  it('runs the dev export through _serve, restarts on a migration change, and cleans up on abort', async () => {
    await mkdir(path.join(workDir, 'drizzle'), { recursive: true });
    const { result, events, lines, controller } = await session();
    await waitFor(() => lines.includes('[app] dev-app started'), 20_000);
    expect(await exists(path.join(workDir, DEV_STATE_PATH))).toBe(true);
    const [first] = runners(events);
    if (first === undefined) throw new Error('no runner event');
    expect(first.command).toContain('_serve');

    await writeFile(path.join(workDir, 'drizzle', '0001_init.sql'), 'create table t (id int);');
    await waitFor(() => runners(events).length === 2, 20_000);
    const restartAt = events.findIndex(event => event.kind === 'restart');
    expect(events[restartAt]).toEqual({ kind: 'restart', reason: 'file', path: 'drizzle/0001_init.sql' });
    // A full restart runs the db step and the preflight again before the new runner.
    expect(kinds(events.slice(restartAt))).toEqual(['restart', 'db', 'preflight', 'runner']);
    expect(isAlive(first.pid)).toBe(false);

    const second = runners(events)[1];
    if (second === undefined) throw new Error('no second runner event');
    controller.abort();
    const done = await result;
    if (isFailure(done)) throw new Error(done.message);
    expect(done.items.at(-1)).toEqual({ kind: 'exit', code: 0 });
    expect(isAlive(second.pid)).toBe(false);
    expect(await exists(path.join(workDir, DEV_STATE_PATH))).toBe(false);
  }, 60_000);
});
