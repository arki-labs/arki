/**
 * The review fixes of `dot dev`, each pinned by what goes wrong without it:
 * a second configure that trips the logging slot, a preflight that boots
 * with another env than the runner, a Bun child that reloads `.env`, a
 * throw that leaves the runner running, and a SIGHUP or second Ctrl-C that
 * orphans the runner's process group.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { DevEvent } from '../dev-events.js';
import type { RunDevOptions } from '../dev.js';
import { DEV_STATE_PATH } from '../dev-state.js';
import { defaultCliEntry, runDev } from '../dev.js';
import { freePort, isAlive, recordingUi, tempProject, waitFor } from './dev-helpers.js';

const CLI = path.resolve(__dirname, '..', 'index.ts');
const FIXTURE_APP = path.resolve(__dirname, 'fixtures', 'dev-app', 'dot.config.ts');
const DEFINE_APP_PATH = path.resolve(__dirname, '..', '..', 'define-app.ts');
const UNIT_CONTRACT_PATH = path.resolve(__dirname, '..', '..', 'unit-contract.ts');

let workDir: string;
const leftovers: number[] = [];

beforeEach(async () => {
  workDir = await tempProject('dot-dev-hardening-');
});

afterEach(async () => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone: the test passed.
    }
  }
  await rm(workDir, { recursive: true, force: true });
});

async function appFile(name: string, body: string): Promise<string> {
  const file = path.join(workDir, `${name}.ts`);
  await writeFile(
    file,
    `import { defineApp } from '${DEFINE_APP_PATH}';\nimport { infra } from '${UNIT_CONTRACT_PATH}';\n${body}\n`,
  );
  return file;
}

async function session(overrides: Partial<RunDevOptions>) {
  const { ui, lines } = recordingUi();
  const events: DevEvent[] = [];
  const controller = new AbortController();
  const result = runDev({
    cwd: workDir,
    db: 'pglite',
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
    // The preflight and `_serve` run the CLI from source, so under Bun.
    cliEntry: ['bun', CLI],
    stopGraceMs: 2000,
    ...overrides,
  });
  return { result, events, lines, controller };
}

const runnerPids = (events: readonly DevEvent[]): number[] =>
  events.flatMap(event => (event.kind === 'runner' ? [event.pid] : []));

describe('dot dev hardening', () => {
  it('an app with a logging slot passes the first preflight and a full restart', async () => {
    const app = await appFile(
      'slot-app',
      `let active = false;
const slot = infra({
  name: 'slot',
  logging: () => {
    if (active) throw new Error('Logging is already configured');
    active = true;
    return { close: () => { active = false; return Promise.resolve(); } };
  },
});
export const dev = defineApp('slot-app').infra(slot);`,
    );
    await mkdir(path.join(workDir, 'drizzle'));
    const { result, events, lines, controller } = await session({ app, run: 'sleep 30' });
    await waitFor(() => runnerPids(events).length === 1, 15_000);
    // FSEvents needs a moment after the watcher starts before it delivers changes.
    await waitFor(() => lines.some(line => line.includes('dot dev ▸ watching')), 15_000);
    await new Promise(resolve => setTimeout(resolve, 500));
    await writeFile(path.join(workDir, 'drizzle', '0001.sql'), 'select 1;');
    await waitFor(() => runnerPids(events).length === 2, 15_000);
    controller.abort();
    const done = await result;
    if (isFailure(done)) throw new Error(done.message);
    const preflights = events.filter(event => event.kind === 'preflight');
    expect(preflights).toEqual([
      { kind: 'preflight', status: 'ok', codes: [] },
      { kind: 'preflight', status: 'ok', codes: [] },
    ]);
  }, 40_000);

  it('the preflight boots with the env the runner gets', async () => {
    const port = await freePort();
    const app = await appFile(
      'env-app',
      `const check = infra({ name: 'check', boot: () => {
  const env = process.env;
  if (env['DOT_DEV'] !== '1' || env['PORT'] !== '${String(port)}' || !String(env['DOT_DEV_STATE']).endsWith('dev.json')) {
    throw new Error('the preflight env is not the runner env');
  }
} });
export const dev = defineApp('env-app').infra(check);`,
    );
    const { result } = await session({ app, port, once: true });
    const done = await result;
    if (isFailure(done)) throw new Error(done.message);
    expect(done.items.at(-1)).toEqual({ kind: 'preflight', status: 'ok', codes: [] });
  });

  it('a Bun _serve child skips the env files; a Node one needs no flag', () => {
    expect(defaultCliEntry(true).slice(1, 2)).toEqual(['--no-env-file']);
    expect(defaultCliEntry(false)).toHaveLength(2);
  });

  it('a throw after the runner started still stops it and removes dev.json', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (): never => {
        throw new Error('the terminal refused raw mode');
      },
    });
    const { result, events } = await session({ app: FIXTURE_APP, run: 'sleep 30', mode: 'text', stdin });
    await expect(result).rejects.toThrow('the terminal refused raw mode');
    const [pid] = runnerPids(events);
    if (pid === undefined) throw new Error('no runner event');
    leftovers.push(pid);
    expect(isAlive(pid)).toBe(false);
    await expect(readFile(path.join(workDir, DEV_STATE_PATH))).rejects.toThrow();
  });

  it('SIGHUP starts the normal stop; a second signal kills the runner group at once', async () => {
    const pidFile = path.join(workDir, 'runner.pid');
    // A runner that ignores SIGTERM: without the escalation the supervisor would wait the full grace.
    const runnerScript = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const supervisor: ChildProcess = spawn(
      'bun',
      [
        CLI,
        'dev',
        '--app',
        FIXTURE_APP,
        '--cwd',
        workDir,
        '--port',
        String(await freePort()),
        '--no-console',
        '--no-open',
        '--run',
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(runnerScript)}`,
        '-o',
        'json',
      ],
      { cwd: workDir, stdio: 'ignore' },
    );
    const exited = new Promise<number | null>(resolve => supervisor.once('exit', code => resolve(code)));
    let runnerPid = 0;
    await waitFor(() => {
      void readFile(pidFile, 'utf8').then(
        text => {
          runnerPid = Number(text);
        },
        () => {
          // Not written yet.
        },
      );
      return runnerPid > 0;
    }, 20_000);
    leftovers.push(runnerPid);
    supervisor.kill('SIGHUP');
    await new Promise(resolve => setTimeout(resolve, 500));
    // Still stopping: the runner ignored SIGTERM and the grace is 10 s.
    expect(supervisor.exitCode).toBeNull();
    supervisor.kill('SIGINT');
    const started = Date.now();
    expect(await exited).toBe(130);
    expect(Date.now() - started).toBeLessThan(3000);
    await waitFor(() => !isAlive(runnerPid), 2000);
  }, 40_000);
});
