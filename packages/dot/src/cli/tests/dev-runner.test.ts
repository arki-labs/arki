/**
 * The runner must never outlive `dot dev`: a child that ignores SIGTERM is
 * killed after the grace period. Its output is kept, but bounded, so a
 * chatty app cannot grow the supervisor without limit.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { chooseRunner, createOutputBuffer, startRunner } from '../dev-runner.js';
import { isAlive, tempProject, waitFor } from './dev-helpers.js';

let workDir: string;

beforeEach(async () => {
  workDir = await tempProject('dot-dev-runner-');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const base = { port: 3100, appFile: '/project/src/app.ts', cliEntry: ['bun', '/dot/cli/index.ts'] as const };

describe('chooseRunner', () => {
  it('--run wins over a Vite config', async () => {
    await writeFile(path.join(workDir, 'vite.config.ts'), 'export default {}\n');
    const spec = await chooseRunner({ ...base, cwd: workDir, run: 'bun run serve.ts' });
    expect(isFailure(spec) ? spec.code : [spec.kind, spec.file, spec.shell]).toEqual(['run', 'bun run serve.ts', true]);
  });

  it('a Vite config runs the project vite with the port, strictly', async () => {
    await writeFile(path.join(workDir, 'vite.config.mts'), 'export default {}\n');
    await mkdir(path.join(workDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(path.join(workDir, 'node_modules', '.bin', 'vite'), '#!/bin/sh\n');
    const spec = await chooseRunner({ ...base, cwd: workDir });
    if (isFailure(spec)) throw new Error(spec.message);
    expect(spec.kind).toBe('vite');
    expect(spec.file).toBe(path.join(workDir, 'node_modules', '.bin', 'vite'));
    expect(spec.args).toEqual(['dev', '--port', '3100', '--strictPort']);
  });

  it('a Vite config without the vite binary is dot.dev_runner_failed', async () => {
    await writeFile(path.join(workDir, 'vite.config.js'), 'export default {}\n');
    const spec = await chooseRunner({ ...base, cwd: workDir });
    expect(isFailure(spec) && spec.code).toBe('dot.dev_runner_failed');
  });

  it('no Vite config and no --run is dot _serve through the given CLI entry', async () => {
    const spec = await chooseRunner({ ...base, cwd: workDir });
    if (isFailure(spec)) throw new Error(spec.message);
    expect([spec.kind, spec.file, ...spec.args]).toEqual([
      'serve',
      'bun',
      '/dot/cli/index.ts',
      '_serve',
      '--app',
      '/project/src/app.ts',
      '--output',
      'text',
    ]);
  });
});

describe('createOutputBuffer', () => {
  it('keeps the newest lines within the line cap and counts the dropped ones', () => {
    const buffer = createOutputBuffer(3, 1024);
    for (const line of ['a', 'b', 'c', 'd', 'e']) buffer.push(line);
    expect(buffer.lines()).toEqual(['c', 'd', 'e']);
    expect(buffer.dropped).toBe(2);
  });

  it('keeps the newest lines within the byte cap', () => {
    const buffer = createOutputBuffer(100, 10);
    for (const line of ['1234', '5678', 'abcd']) buffer.push(line);
    // Each line costs its bytes plus a newline: 5 + 5 + 5 > 10.
    expect(buffer.lines()).toEqual(['5678', 'abcd']);
    expect(buffer.dropped).toBe(1);
  });
});

describe('startRunner', () => {
  it('escalates to SIGKILL when the child ignores SIGTERM, and prefixes nothing itself', async () => {
    const lines: string[] = [];
    const handle = await startRunner(
      {
        kind: 'run',
        command: 'stubborn',
        file: process.execPath,
        args: [
          '-e',
          "process.on('SIGTERM', () => console.log('ignored')); console.log('ready'); setInterval(() => {}, 1000);",
        ],
        shell: false,
      },
      { cwd: workDir, env: { PATH: process.env['PATH'] ?? '' }, onLine: line => lines.push(line) },
    );
    if (isFailure(handle)) throw new Error(handle.message);
    await waitFor(() => lines.includes('ready'));
    const started = Date.now();
    const exit = await handle.stop(400);
    expect(exit.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(lines).toContain('ignored');
    expect(handle.stopping).toBe(true);
    expect(isAlive(handle.pid)).toBe(false);
  });

  it('stops the whole process group, not only the shell', async () => {
    const pidFile = path.join(workDir, 'grandchild.pid');
    const handle = await startRunner(
      {
        kind: 'run',
        command: 'sleeper',
        file: `sleep 30 & echo $! > ${pidFile}; wait`,
        args: [],
        shell: true,
      },
      {
        cwd: workDir,
        env: { PATH: process.env['PATH'] ?? '' },
        onLine: () => {
          // The output is not under test here.
        },
      },
    );
    if (isFailure(handle)) throw new Error(handle.message);
    let grandchild = 0;
    await waitFor(() => {
      try {
        grandchild = Number(readFileSync(pidFile, 'utf8'));
      } catch {
        return false;
      }
      return grandchild > 0;
    });
    await handle.stop(2000);
    await waitFor(() => !isAlive(grandchild), 3000);
  });
});
