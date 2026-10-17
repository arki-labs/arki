/**
 * The process that serves the app under `dot dev`: `--run "<cmd>"`, else
 * `vite dev` when the project has a Vite config, else the hidden
 * `dot _serve`. The child gets its own process group on POSIX, so stopping
 * it stops whatever it spawned too: SIGTERM to the group, a grace period,
 * then SIGKILL to the group.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';

import type { Failure } from '@arki/failure';
import { getLogger } from '@arki/log';

import { sleep } from './dev-net.js';
import { DevRunnerFailed } from './failures.js';

const debugRunner = getLogger('arki:dot:cli:dev');

export type RunnerKind = 'run' | 'vite' | 'serve';

/** A child process to spawn. `shell` runs `file` as one shell command line (`--run`). */
export type ProcessSpec = {
  /** The command line, for people. */
  readonly command: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly shell: boolean;
};

/** What to spawn as the runner. */
export type RunnerSpec = ProcessSpec & { readonly kind: RunnerKind };

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'] as const;
const VITE_BINARIES = process.platform === 'win32' ? ['vite.exe', 'vite.cmd', 'vite'] : ['vite'];

async function isFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

export type ChooseRunnerOptions = {
  readonly cwd: string;
  readonly run?: string | undefined;
  readonly port: number;
  /** The app file, handed to `_serve`. */
  readonly appFile: string;
  /** How to start the `dot` CLI: the program, then its entry script. */
  readonly cliEntry: readonly [string, ...string[]];
};

/** Pick the runner: `--run` wins, then a Vite config, then `dot _serve`. A Vite config without the binary is `dot.dev_runner_failed`. */
export async function chooseRunner(options: ChooseRunnerOptions): Promise<RunnerSpec | Failure> {
  if (options.run !== undefined && options.run.trim() !== '') {
    return { kind: 'run', command: options.run, file: options.run, args: [], shell: true };
  }
  for (const config of VITE_CONFIGS) {
    if (!(await isFile(path.join(options.cwd, config)))) continue;
    const args = ['dev', '--port', String(options.port), '--strictPort'];
    for (const binary of VITE_BINARIES) {
      const file = path.join(options.cwd, 'node_modules', '.bin', binary);
      if (await isFile(file)) return { kind: 'vite', command: `vite ${args.join(' ')}`, file, args, shell: false };
    }
    return DevRunnerFailed({
      command: `vite ${args.join(' ')}`,
      causeMessage: `${config} exists but node_modules/.bin/vite does not`,
    });
  }
  const [program, ...entry] = options.cliEntry;
  return {
    kind: 'serve',
    command: `dot _serve --app ${options.appFile}`,
    file: program,
    args: [...entry, '_serve', '--app', options.appFile, '--output', 'text'],
    shell: false,
  };
}

/** The last lines of runner output: at most `maxLines` lines and `maxBytes` bytes; the oldest go first. */
export type OutputBuffer = {
  push(line: string): void;
  lines(): readonly string[];
  /** How many lines were dropped to stay within the bounds. */
  readonly dropped: number;
};

export function createOutputBuffer(maxLines = 2000, maxBytes = 2 * 1024 * 1024): OutputBuffer {
  const kept: string[] = [];
  let bytes = 0;
  let dropped = 0;
  return {
    push(line) {
      kept.push(line);
      bytes += Buffer.byteLength(line) + 1;
      while (kept.length > maxLines || (bytes > maxBytes && kept.length > 0)) {
        const oldest = kept.shift() ?? '';
        bytes -= Buffer.byteLength(oldest) + 1;
        dropped += 1;
      }
    },
    lines: () => [...kept],
    get dropped() {
      return dropped;
    },
  };
}

export type RunnerExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type RunnerHandle = {
  readonly pid: number;
  readonly spec: ProcessSpec;
  /** Settles when the child itself exits. */
  readonly exited: Promise<RunnerExit>;
  /** True once `stop` was called: an exit after it is ours, not a crash. */
  readonly stopping: boolean;
  /** SIGTERM the group, wait up to `graceMs`, then SIGKILL the group. Safe to call twice. */
  stop(graceMs?: number): Promise<RunnerExit>;
  /** SIGKILL the group now, synchronously: for a supervisor that is about to die. */
  kill(): void;
};

export type StartRunnerOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Each output line, stdout and stderr, as written. */
  readonly onLine: (line: string) => void;
};

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

const POSIX = process.platform !== 'win32';

/** Signal the child's process group. False when the group is gone. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    // EPERM: the group exists but a member is not ours to signal.
    if (hasCode(error, 'EPERM')) return true;
    throw error;
  }
}

function readLines(child: ChildProcess, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine);
  }
}

/** Spawn the runner. Resolves once the child runs, or with `dot.dev_runner_failed` when it cannot start. */
export function startRunner(spec: ProcessSpec, options: StartRunnerOptions): Promise<RunnerHandle | Failure> {
  const child = spawn(spec.file, [...spec.args], {
    cwd: options.cwd,
    env: options.env,
    shell: spec.shell,
    // Its own process group, so a stop reaches what it spawned (Vite workers, a shell's children).
    detached: POSIX,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  readLines(child, options.onLine);

  const exited = new Promise<RunnerExit>(resolve => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  return new Promise(resolve => {
    child.once('error', error => {
      resolve(DevRunnerFailed({ command: spec.command, causeMessage: error.message }));
    });
    child.once('spawn', () => {
      const pid = child.pid;
      if (pid === undefined) {
        resolve(DevRunnerFailed({ command: spec.command, causeMessage: 'the child has no pid' }));
        return;
      }
      resolve(createHandle(spec, child, pid, exited));
    });
  });
}

function createHandle(spec: ProcessSpec, child: ChildProcess, pid: number, exited: Promise<RunnerExit>): RunnerHandle {
  let stopping = false;
  let done = false;
  exited.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  // Last resort: when the supervisor exits without stopping the runner, the group must not outlive it.
  const killOnExit = (): void => {
    if (POSIX) signalGroup(pid, 'SIGKILL');
    else child.kill('SIGKILL');
  };
  process.once('exit', killOnExit);

  let stopped: Promise<RunnerExit> | undefined;
  const stop = async (graceMs: number): Promise<RunnerExit> => {
    stopping = true;
    try {
      if (!POSIX) {
        if (!done) child.kill();
        if (!(await settlesWithin(exited, graceMs)) && !done) child.kill('SIGKILL');
        return await exited;
      }
      if (!signalGroup(pid, 'SIGTERM')) return await exited;
      const deadline = Date.now() + graceMs;
      // The leader may exit first while its children still drain: wait for the whole group.
      while (Date.now() < deadline && signalGroup(pid, 0)) await sleep(50);
      if (signalGroup(pid, 0)) {
        debugRunner.debug('runner group {pid} ignored SIGTERM for {graceMs} ms; sending SIGKILL', { pid, graceMs });
        signalGroup(pid, 'SIGKILL');
      }
      return await exited;
    } finally {
      process.removeListener('exit', killOnExit);
    }
  };

  return {
    pid,
    spec,
    exited,
    get stopping() {
      return stopping;
    },
    stop(graceMs = 10_000) {
      stopped ??= stop(graceMs);
      return stopped;
    },
    kill() {
      stopping = true;
      killOnExit();
    },
  };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  const watched = promise.then(() => {
    settled = true;
  });
  await Promise.race([watched, sleep(ms)]);
  return settled;
}
