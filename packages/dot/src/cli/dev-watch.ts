/**
 * What `dot dev` watches and what a change does.
 *
 *   - `drizzle/**`, `.env*` or the app file: a full restart (stop the
 *     runner, then the db step, the preflight and the runner again).
 *   - other `src/` files: nothing under Vite or `--run` (they reload
 *     themselves); a runner restart under `dot _serve`.
 *
 * Changes are debounced (150 ms). A change that lands while a restart runs
 * marks the scheduler dirty, which schedules exactly one more restart.
 */
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';

import { getLogger } from '@arki/log';

import type { RunnerKind } from './dev-runner.js';

const debugWatch = getLogger('arki:dot:cli:dev');

export type ChangeKind = 'full' | 'runner' | 'ignore';

const IGNORED_SEGMENTS = new Set(['.local', 'node_modules', 'dist', '.output']);

/** A path relative to the project, with `/` separators. */
function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

function isIgnored(relative: string): boolean {
  return relative.split('/').some(segment => IGNORED_SEGMENTS.has(segment));
}

function isEnvFile(relative: string): boolean {
  return !relative.includes('/') && relative.startsWith('.env');
}

/**
 * What a change to `relative` (project-relative, `/` separators) does.
 * `appFile` is the app file, project-relative the same way.
 */
export function classifyChange(
  relative: string,
  context: { readonly appFile: string; readonly runner: RunnerKind },
): ChangeKind {
  if (isIgnored(relative)) return 'ignore';
  if (relative === 'drizzle' || relative.startsWith('drizzle/')) return 'full';
  if (isEnvFile(relative) || relative === context.appFile) return 'full';
  if (relative.startsWith('src/')) return context.runner === 'serve' ? 'runner' : 'ignore';
  return 'ignore';
}

export type ProjectWatcher = { close(): void };

export type WatchOptions = {
  readonly cwd: string;
  /** The app file, project-relative with `/` separators: watched when it sits at the project root. */
  readonly appFile: string;
  /** Called once per quiet period with every path that changed in it. */
  readonly onChanges: (paths: readonly string[]) => void;
  readonly debounceMs?: number;
};

/** Watch `src/` and `drizzle/` recursively and the project root for `.env*` and the app file. */
export function watchProject(options: WatchOptions): ProjectWatcher {
  const debounceMs = options.debounceMs ?? 150;
  const watchers = new Map<string, FSWatcher>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const changed = (relative: string): void => {
    if (closed || relative === '' || isIgnored(relative)) return;
    pending.add(relative);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const paths = [...pending];
      pending.clear();
      options.onChanges(paths);
    }, debounceMs);
  };

  const watchDir = (dir: 'src' | 'drizzle'): boolean => {
    if (watchers.has(dir)) return false;
    try {
      const root = path.join(options.cwd, dir);
      const watcher = watch(root, { recursive: true }, (_event, name) => {
        if (name === null) return;
        // macOS (FSEvents) reports a change of the watched directory itself under its own
        // basename (`src` → `src/src`); the entries it gained are reported on their own.
        if (name === dir && !existsSync(path.join(root, name))) return;
        changed(`${dir}/${toPosix(name)}`);
      });
      watcher.on('error', error => {
        debugWatch.debug('watcher on {dir} failed', { dir, error });
      });
      watchers.set(dir, watcher);
      return true;
    } catch (error) {
      debugWatch.debug('not watching {dir}', { dir, error: error instanceof Error ? error : String(error) });
      return false;
    }
  };

  watchDir('src');
  watchDir('drizzle');
  const rootFile = options.appFile.includes('/') ? undefined : options.appFile;
  try {
    const root = watch(options.cwd, (_event, name) => {
      if (name === null) return;
      const relative = toPosix(name);
      if (isEnvFile(relative) || relative === rootFile) changed(relative);
      // A directory created after the start (a first `drizzle-kit generate`) is watched from then on.
      if ((relative === 'src' || relative === 'drizzle') && watchDir(relative)) changed(relative);
    });
    root.on('error', error => {
      debugWatch.debug('watcher on the project root failed', { error });
    });
    watchers.set('.', root);
  } catch (error) {
    debugWatch.debug('not watching the project root', { error: error instanceof Error ? error : String(error) });
  }

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

export type RestartRequest = {
  /** `full`: db step, preflight and runner; `runner`: the runner only. */
  readonly kind: 'full' | 'runner';
  readonly reason: 'file' | 'key';
  readonly path?: string | undefined;
};

export type RestartScheduler = {
  request(request: RestartRequest): void;
  /** Resolves once no restart runs and none is pending. */
  idle(): Promise<void>;
};

/** The stronger of two requests: a full restart covers a runner one. */
function merge(current: RestartRequest | undefined, next: RestartRequest): RestartRequest {
  if (current === undefined) return next;
  if (current.kind === 'full' && next.kind === 'runner') return current;
  return next;
}

/**
 * Run restarts one at a time. Requests that arrive while one runs collapse
 * into a single pending one (the dirty flag), run once the current one ends.
 */
export function createRestartScheduler(
  restart: (request: RestartRequest) => Promise<void>,
  onError: (error: unknown) => void,
): RestartScheduler {
  let pending: RestartRequest | undefined;
  let running: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    while (pending !== undefined) {
      const next = pending;
      pending = undefined;
      try {
        await restart(next);
      } catch (error) {
        debugWatch.debug('restart threw', { error: error instanceof Error ? error : String(error) });
        onError(error);
      }
    }
    running = undefined;
  };

  return {
    request(request) {
      pending = merge(pending, request);
      running ??= drain();
    },
    idle: () => running ?? Promise.resolve(),
  };
}
