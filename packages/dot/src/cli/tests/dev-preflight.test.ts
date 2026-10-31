/**
 * The preflight runs in a fresh process (`dot _preflight`). Two promises are
 * under test. First, every preflight sees the app as it is now: an edit
 * between two restarts reaches the second check (an in-process preflight
 * kept booting the module cached at the first import). Second, only a valid
 * report is a pass: a child that crashes, hangs or prints garbage fails the
 * preflight and starts no runner, and a stop kills it.
 */
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { DevEvent } from '../dev-events.js';
import type { RunDevOptions } from '../dev.js';
import { runDev } from '../dev.js';
import { freePort, isAlive, recordingUi, tempProject, waitFor } from './dev-helpers.js';

const CLI = path.resolve(__dirname, '..', 'index.ts');
const DEFINE_APP_PATH = path.resolve(__dirname, '..', '..', 'define-app.ts');
const UNIT_CONTRACT_PATH = path.resolve(__dirname, '..', '..', 'unit-contract.ts');

let workDir: string;

beforeEach(async () => {
  workDir = await tempProject('dot-dev-preflight-');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

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
    once: true,
    ui,
    mode: 'json',
    signal: controller.signal,
    onEvent: event => events.push(event),
    env: { PATH: process.env['PATH'] ?? '' },
    cliEntry: ['bun', CLI],
    stopGraceMs: 2000,
    ...overrides,
  });
  return { result, events, lines, controller };
}

/** An app whose `migrations` service reports `pending`: the version the preflight booted. */
const versionedApp = (version: string): string => `import { defineApp } from '${DEFINE_APP_PATH}';
import { infra } from '${UNIT_CONTRACT_PATH}';
const migrations = infra({ name: 'db-migrations', provides: { migrations: () => ({ pending: ['${version}'] }) } });
const serving = infra({ name: 'serving', start: () => { process.stdout.write('serving ${version}\\n'); } });
export const dev = defineApp('versioned').infra(migrations).infra(serving);
`;

/** A stand-in for `dot _preflight`: a script that records its pid, then misbehaves. */
async function fakeChild(
  body: string,
): Promise<{ readonly entry: readonly [string, ...string[]]; readonly pidFile: string }> {
  const pidFile = path.join(workDir, 'child.pid');
  const script = path.join(workDir, 'fake-preflight.ts');
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${body}\n`,
  );
  return { entry: ['bun', script], pidFile };
}

const migrationsOf = (events: readonly DevEvent[]): string[][] =>
  events.flatMap(event => (event.kind === 'migrations' ? [event.pending] : []));

describe('the preflight process', () => {
  it('retains an app failure reported in an exit-3 error envelope', async () => {
    const message = {
      app: null,
      migrations: null,
      report: null,
      failure: { code: 'app.configure_refused', message: 'Configure refused.', data: null },
    };
    const envelope = { ok: false, error: { code: 'dot.preflight_failed', data: message } };
    const { entry } = await fakeChild(
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(envelope)}\n`)}); process.exitCode = 3;`,
    );
    const { result, events } = await session({ cliEntry: entry });
    expect(await result).toMatchObject({ code: 'dot.preflight_failed', data: message });
    expect(events).toContainEqual({ kind: 'preflight', status: 'failure', codes: ['app.configure_refused'] });
  });

  it('refuses an app export that is already configured, with the exact dev_app_started code', async () => {
    const appFile = path.join(workDir, 'started.ts');
    await writeFile(
      appFile,
      `import { defineApp } from '${DEFINE_APP_PATH}';
import { infra } from '${UNIT_CONTRACT_PATH}';
export const dev = defineApp('started').infra(infra({ name: 'serving' })).configure();
`,
    );
    const { result, events } = await session({ app: appFile });
    expect(await result).toMatchObject({
      code: 'dot.dev_app_started',
      data: { exportName: 'dev', filePath: appFile },
    });
    expect(events).toContainEqual({ kind: 'preflight', status: 'failure', codes: ['dot.dev_app_started'] });
  });

  it('answers dot.dev_port_in_use when something already listens on the app port, and starts no runner', async () => {
    const appFile = path.join(workDir, 'app.ts');
    await writeFile(appFile, versionedApp('v1'));
    const { result, events } = await session({ app: appFile, once: false, run: 'echo unreachable', probe: () => Promise.resolve(true) });
    const done = await result;
    expect(isFailure(done) && done.code).toBe('dot.dev_port_in_use');
    expect(events.some(event => event.kind === 'runner')).toBe(false);
  }, 60_000);

  it('sees an edit to the app file made between two restarts', async () => {
    const appFile = path.join(workDir, 'app.ts');
    await writeFile(appFile, versionedApp('v1'));
    const { result, events, lines, controller } = await session({ app: appFile, once: false });

    await waitFor(() => lines.includes('[app] serving v1'), 20_000);
    expect(migrationsOf(events)).toEqual([['v1']]);

    await writeFile(appFile, versionedApp('v2'));
    await waitFor(() => lines.includes('[app] serving v2'), 20_000);
    // The second preflight booted the edited module, not the one cached at the first import.
    expect(migrationsOf(events)).toEqual([['v1'], ['v2']]);

    controller.abort();
    expect(isFailure(await result)).toBe(false);
  }, 60_000);

  it('a child that prints garbage fails the preflight', async () => {
    const { entry } = await fakeChild('process.stdout.write(\'{"ok":true,"data":"not a report"}\\nhello\\n\');');
    const { result } = await session({ cliEntry: entry });
    const done = await result;
    expect(isFailure(done) && done.code).toBe('dot.dev_preflight_failed');
    expect(isFailure(done) && done.data).toMatchObject({ reason: 'it printed no valid report', exitCode: 0 });
  });

  it('a child that crashes fails the preflight with its exit code', async () => {
    const { entry } = await fakeChild('process.exit(3);');
    const { result } = await session({ cliEntry: entry });
    const done = await result;
    expect(isFailure(done) && done.data).toMatchObject({ reason: 'it exited without a report', exitCode: 3 });
  });

  it('a child that crashes after a passing report fails the preflight', async () => {
    // A dispose that throws after the boot passed still leaves a broken app: the report alone must not pass it.
    const { entry } = await fakeChild(
      'process.stdout.write(\'{"ok":true,"data":{"app":null,"migrations":null,"report":null,"failure":null}}\\n\');\nprocess.exitCode = 1;',
    );
    const { result } = await session({ cliEntry: entry });
    const done = await result;
    expect(isFailure(done) && done.data).toMatchObject({
      reason: 'it exited with code 1 after its report',
      exitCode: 1,
    });
  });

  it('a child that hangs past the timeout is killed and fails the preflight', async () => {
    const { entry, pidFile } = await fakeChild('setInterval(() => {}, 1000);');
    const { result } = await session({ cliEntry: entry, preflightTimeoutMs: 1500 });
    const done = await result;
    expect(isFailure(done) && done.data).toMatchObject({ reason: 'no report within 1500 ms' });
    expect(isAlive(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  });

  it('stopping dot dev during a preflight kills the child', async () => {
    const { entry, pidFile } = await fakeChild('setInterval(() => {}, 1000);');
    const { result, controller } = await session({ cliEntry: entry });
    await waitFor(() => {
      try {
        return isAlive(Number(readFileSync(pidFile, 'utf8')));
      } catch {
        return false;
      }
    }, 10_000);
    controller.abort();
    const done = await result;
    expect(isFailure(done) && done.code).toBe('dot.dev_preflight_failed');
    expect(isAlive(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  });
});
