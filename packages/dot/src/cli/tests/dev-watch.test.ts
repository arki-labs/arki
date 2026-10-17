/**
 * The watch decides what a save costs: a migration or env change must
 * re-run the preflight (it migrates and validates env), a source change
 * under Vite must cost nothing (Vite reloads it), and a burst of saves must
 * end in one restart, plus exactly one more if they land mid-restart.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RestartRequest } from '../dev-watch.js';
import { classifyChange, createRestartScheduler, watchProject } from '../dev-watch.js';
import { tempProject, waitFor } from './dev-helpers.js';

describe('classifyChange', () => {
  const cases: readonly [string, 'vite' | 'run' | 'serve', string][] = [
    ['drizzle/0001_init.sql', 'vite', 'full'],
    ['drizzle/meta/_journal.json', 'serve', 'full'],
    ['.env', 'vite', 'full'],
    ['.env.local', 'run', 'full'],
    ['src/app.ts', 'vite', 'full'],
    ['src/routes/index.tsx', 'vite', 'ignore'],
    ['src/routes/index.tsx', 'run', 'ignore'],
    ['src/routes/index.tsx', 'serve', 'runner'],
    ['src/.local/cache.json', 'serve', 'ignore'],
    ['src/node_modules/x.js', 'serve', 'ignore'],
    ['README.md', 'serve', 'ignore'],
    ['config/.env', 'serve', 'ignore'],
  ];
  it.each(cases)('%s under %s → %s', (relative, runner, expected) => {
    expect(classifyChange(relative, { appFile: 'src/app.ts', runner })).toBe(expected);
  });
});

describe('watchProject', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await tempProject('dot-dev-watch-');
    await mkdir(path.join(workDir, 'src'), { recursive: true });
    await mkdir(path.join(workDir, 'drizzle'), { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('debounces a burst of saves into one call that names every path', async () => {
    const batches: (readonly string[])[] = [];
    const watcher = watchProject({
      cwd: workDir,
      appFile: 'src/app.ts',
      onChanges: paths => batches.push(paths),
      // Wide on purpose: under a loaded test run, FSEvents can deliver one burst
      // over a few hundred ms. 150 ms (the default) made this test flaky.
      debounceMs: 1000,
    });
    try {
      // Let the watchers settle before writing.
      await new Promise(resolve => setTimeout(resolve, 500));
      await writeFile(path.join(workDir, 'src', 'a.ts'), 'a');
      await writeFile(path.join(workDir, 'drizzle', '0001.sql'), 'select 1');
      await writeFile(path.join(workDir, '.env'), 'A=1');
      await writeFile(path.join(workDir, 'README.md'), 'not watched');
      await waitFor(() => batches.length > 0);
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(batches).toHaveLength(1);
      expect(new Set(batches[0])).toEqual(new Set(['src/a.ts', 'drizzle/0001.sql', '.env']));
    } finally {
      watcher.close();
    }
  });
});

/** For schedulers whose restarts never throw. */
function failOnError(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

describe('createRestartScheduler', () => {
  it('reports a restart that throws, and keeps taking requests', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = createRestartScheduler(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('preflight blew up')) : Promise.resolve();
      },
      error => errors.push(error),
    );
    scheduler.request({ kind: 'full', reason: 'file', path: '.env' });
    await scheduler.idle();
    expect(errors).toEqual([new Error('preflight blew up')]);
    scheduler.request({ kind: 'runner', reason: 'key' });
    await scheduler.idle();
    expect(calls).toBe(2);
  });

  it('runs one more restart for changes during a restart, however many there were', async () => {
    const runs: RestartRequest[] = [];
    const gate: { open?: () => void } = {};
    const scheduler = createRestartScheduler(request => {
      runs.push(request);
      return runs.length === 1
        ? new Promise<void>(resolve => {
            gate.open = resolve;
          })
        : Promise.resolve();
    }, failOnError);
    scheduler.request({ kind: 'runner', reason: 'file', path: 'src/a.ts' });
    // Three changes while the first restart runs: one dirty flag.
    scheduler.request({ kind: 'runner', reason: 'file', path: 'src/b.ts' });
    scheduler.request({ kind: 'full', reason: 'file', path: 'drizzle/0001.sql' });
    scheduler.request({ kind: 'runner', reason: 'key' });
    gate.open?.();
    await scheduler.idle();
    expect(runs).toHaveLength(2);
    // The full restart is not lost to the later runner request.
    expect(runs[1]).toEqual({ kind: 'full', reason: 'file', path: 'drizzle/0001.sql' });
  });

  it('runs nothing more when nothing changed during the restart', async () => {
    let count = 0;
    const scheduler = createRestartScheduler(() => {
      count += 1;
      return Promise.resolve();
    }, failOnError);
    scheduler.request({ kind: 'runner', reason: 'key' });
    await scheduler.idle();
    expect(count).toBe(1);
  });
});
