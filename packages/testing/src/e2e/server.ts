/**
 * The app server under test: the built production artifact, started as a child process with the
 * worker's own env. Building is cached by a hash of the source files, so a re-run does not rebuild.
 */
import { spawn  } from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getLogger } from '@arki/log';

const log = getLogger('arki:testing:e2e');

export type ServerOptions = {
  readonly build: {
    /** For example `['bun', 'run', 'build']`. */
    readonly command: readonly [string, ...string[]];
    readonly cwd: string;
    /** Files and folders whose change means the build is stale. */
    readonly inputs: readonly string[];
    /** A file the build writes; the build is skipped when it is newer than the inputs' hash. */
    readonly output: string;
  };
  readonly serve: {
    /** For example `['bun', '.output/server/index.mjs']`. */
    readonly command: readonly [string, ...string[]];
    readonly cwd: string;
    /** A path that answers 200 once the server is ready. */
    readonly readyPath: string;
  };
};

const IGNORED = new Set(['node_modules', 'dist', '.output', '.turbo', '.cache', '.git', 'test-results', 'playwright-report']);

function hashOf(inputs: readonly string[]): string {
  let size = 0;
  let newest = 0;
  let count = 0;
  const visit = (target: string): void => {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(target)) if (!IGNORED.has(entry)) visit(path.join(target, entry));
      return;
    }
    count += 1;
    size += stat.size;
    newest = Math.max(newest, stat.mtimeMs);
  };
  for (const input of inputs) visit(input);
  return `${count}:${size}:${Math.round(newest)}`;
}

function run(command: readonly [string, ...string[]], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = command;
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    const keep = (chunk: Buffer) => {
      tail.push(...chunk.toString().split('\n'));
      tail.splice(0, Math.max(0, tail.length - 50));
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`BUILD_FAILED: ${command.join(' ')} exited ${code}. Last lines:\n${tail.join('\n')}`)),
    );
  });
}

/** Builds the app unless the sources are unchanged since the last build. Returns whether it built. */
export async function ensureBuilt(build: ServerOptions['build']): Promise<boolean> {
  const stamp = `${build.output}.arki-hash`;
  const hash = hashOf(build.inputs);
  if (existsSync(build.output) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) {
    log.debug('Build is current: {output}', { output: path.relative(process.cwd(), build.output) });
    return false;
  }
  log.debug('Building: {command}', { command: build.command.join(' ') });
  await run(build.command, build.cwd);
  writeFileSync(stamp, hashOf(build.inputs));
  return true;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Only what a server needs to find its tools. Nothing from the developer's shell leaks in. */
export function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'];
  return Object.fromEntries(keep.flatMap(key => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
}

export type RunningServer = {
  readonly url: string;
  /** Stops the process, starts it again with the same env and waits until it is ready. Returns how long it took. */
  restart(): Promise<number>;
  /** The last 200 lines the server printed. */
  logs(): string;
  stop(): Promise<void>;
};

async function waitReady(url: string, child: ChildProcess, lines: readonly string[], budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`SERVER_NOT_READY: ${url} did not answer in ${budgetMs} ms. Last server lines:\n${lines.slice(-50).join('\n')}`);
}

export async function startServer(options: {
  readonly serve: ServerOptions['serve'];
  readonly env: Readonly<Record<string, string>>;
  readonly port: number;
}): Promise<RunningServer> {
  const url = `http://localhost:${options.port}`;
  const lines: string[] = [];
  let child: ChildProcess | undefined;

  const launch = async (): Promise<void> => {
    const [file, ...args] = options.serve.command;
    const spawned = spawn(file, args, {
      cwd: options.serve.cwd,
      env: { ...baseEnv(), ...options.env, PORT: String(options.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (chunk: Buffer) => {
      lines.push(...chunk.toString().split('\n'));
      lines.splice(0, Math.max(0, lines.length - 200));
    };
    spawned.stdout.on('data', keep);
    spawned.stderr.on('data', keep);
    child = spawned;
    await waitReady(`${url}${options.serve.readyPath}`, spawned, lines, 30_000).catch(async error => {
      await halt();
      throw error;
    });
  };

  const halt = async (): Promise<void> => {
    const running = child;
    child = undefined;
    if (running === undefined || running.exitCode !== null) return;
    const closed = new Promise<void>(resolve => running.once('close', () => resolve()));
    running.kill('SIGTERM');
    const killer = setTimeout(() => running.kill('SIGKILL'), 5000);
    await closed;
    clearTimeout(killer);
  };

  await launch();
  return {
    url,
    async restart() {
      const started = performance.now();
      await halt();
      await launch();
      return Math.round(performance.now() - started);
    },
    logs: () => lines.join('\n'),
    stop: halt,
  };
}
