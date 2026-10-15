/**
 * Lock files for processes on one host. A lock is a directory
 * `<dir>/<name>-<hash>.lock` with an `owner` file inside that holds the
 * owner's token. It is built under a private name and moved into place with an
 * atomic `rename`, so it never shows up half-made.
 *
 * Kind is `lease`, not `hold`. The lock's liveness is the directory's mtime.
 * The manager already renews a lease every `ttl / 3` through `extend`, and
 * `extend` is what touches the mtime. So there is one heartbeat, the
 * manager's, and no second timer in the store that could disagree with it.
 * That is also how a live holder is never taken for dead: while its callback
 * runs, the manager keeps the mtime fresh. `stale` is the lease length.
 *
 * Rules that close the bug in the lock this replaces (a live owner looked
 * stale, was stolen, and then the old owner deleted the new owner's lock by
 * path):
 * - Nothing is ever deleted by path. A lock is moved aside with an atomic
 *   `rename` and the mover checks whose token it moved.
 * - Only takers holding the guard of one dead lock may move that lock, and a
 *   guard is never removed by anyone but its maker. A taker that crashed
 *   inside a guard is stepped past (`.0`, `.1`, …), never cleared by path,
 *   because clearing by path can hit a guard someone made a moment ago.
 * - An owner only releases a lock that is still fresh. An expired lock
 *   belongs to the takers, which may be moving it right now.
 * - Private names use a hash of the token, never the token itself.
 */
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { pid } from 'node:process';
import type { FSWatcher } from 'node:fs';

import { getLogger } from '@arki/log';

import type { Scheduler } from '../scheduler.js';
import type { AcquireRequest, Grant, Guarantees, Key, ReleaseOutcome, Store } from '../types.js';
import { LockError } from '../errors.js';
import { defaultScheduler } from '../scheduler.js';

const log = getLogger('arki:lock');

const guarantees = {
  kind: 'lease',
  scope: 'host',
  // fs.watch wakes a waiter where the platform offers it, but it is only a hint:
  // a timer bounds every wait, so the honest word is "poll".
  wait: 'poll',
  shared: false,
  permits: false,
  fence: false,
  releasedOnCrash: 'after-ttl',
  clock: 'host',
  poolerSafe: true,
  runtimes: ['node', 'bun', 'deno'],
} as const satisfies Guarantees;

export type FileGuarantees = typeof guarantees;

export type FileStoreOptions = {
  /** A lock whose mtime is older than this is dead and may be taken over. It is the lease length. Default 10 s. */
  readonly stale?: number;
  /** How often a blocked `waitFor` looks again when `fs.watch` says nothing. Default 250 ms. */
  readonly pollMs?: number;
  /** Wall-clock milliseconds, compared with file mtimes. Default `Date.now`. Tests move it. */
  readonly now?: () => number;
  /** Timers for `waitFor`. Default: the global timers. */
  readonly scheduler?: Scheduler;
};

export type FileStore = Store<FileGuarantees> & {
  /** The lock directory of `key`. For tests and debugging. */
  lockPath(key: Key): string;
};

type Owner = { readonly token: string; readonly pid: number; readonly key: string };

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_POLL_MS = 250;

function ignore(): void {
  // Best-effort cleanup: nothing to do when it fails.
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

function digest(text: string, length: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

/** A readable prefix plus a hash of the whole key: unique, and short enough for any file system. */
function lockName(key: Key): string {
  const readable = key.name.replaceAll(/[^\w-]/g, '_').slice(0, 40);
  return `${readable}-${digest(key.full, 32)}.lock`;
}

/** A token as it may appear in a file name: tokens are any string, and a `/` or a long one must never reach a path. */
function tokenTag(token: string): string {
  return digest(token, 24);
}

function parseOwner(text: string): Owner | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    if (!('token' in value) || typeof value.token !== 'string') return undefined;
    return {
      token: value.token,
      pid: 'pid' in value && typeof value.pid === 'number' ? value.pid : 0,
      key: 'key' in value && typeof value.key === 'string' ? value.key : '',
    };
  } catch {
    return undefined;
  }
}

async function readOwner(path: string): Promise<Owner | undefined> {
  try {
    return parseOwner(await readFile(nodePath.join(path, 'owner'), 'utf8'));
  } catch (error) {
    if (hasCode(error, 'ENOENT', 'ENOTDIR')) return undefined;
    throw error;
  }
}

/**
 * Delete a lock directory. A lock holds one `owner` file, so `unlink` then
 * `rmdir` is two calls where a recursive `rm` is four or more; anything
 * unexpected in it falls back to the recursive form.
 */
async function removeLockDir(path: string): Promise<void> {
  try {
    await unlink(nodePath.join(path, 'owner'));
    await rmdir(path);
  } catch {
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * Move the lock at `path` aside and delete it, if it is `owner`'s. Moving
 * first means a successor's lock is never deleted by path; if the move caught
 * someone else's lock after all, it is put back.
 */
async function remove(path: string, owner: string, mover: string): Promise<boolean> {
  const dead = `${path}.dead-${tokenTag(mover)}`;
  try {
    await rename(path, dead);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
  const moved = await readOwner(dead);
  if ((moved?.token ?? '') !== owner) {
    log.warn('file lock: moved a lock that was not the one judged; restoring', { store: 'file' });
    await rename(dead, path).catch(ignore);
    return false;
  }
  await removeLockDir(dead);
  return true;
}

export function fileStore(dir: string, options: FileStoreOptions = {}): FileStore {
  const staleMs = options.stale ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? defaultScheduler;
  if (!Number.isFinite(staleMs) || staleMs < 1) {
    throw new LockError({
      code: 'config',
      message: `fileStore: stale must be at least 1 ms, got ${staleMs}`,
      remediation: 'pass a positive number of milliseconds as `stale`',
    });
  }

  const lockPath = (key: Key): string => nodePath.join(dir, lockName(key));
  let dirReady = false;

  async function ensureDir(): Promise<void> {
    if (dirReady) return;
    await mkdir(dir, { recursive: true });
    dirReady = true;
  }

  /** Age of a path's mtime against our clock; `undefined` when it does not exist. */
  async function ageOf(path: string): Promise<number | undefined> {
    try {
      const info = await stat(path);
      return now() - info.mtimeMs;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async function touch(path: string): Promise<void> {
    const seconds = now() / 1000;
    await utimes(path, seconds, seconds);
  }

  /**
   * Build a directory with an `owner` file and a fresh mtime under a private
   * name, then `rename` it into place. The rename is the atomic step: it fails
   * when the target is there already, because the target always holds its
   * `owner` file (`rename` would replace an empty directory). Nothing is ever
   * visible half-made, so no one can judge a half-made one stale.
   */
  async function place(path: string, owner: Owner): Promise<boolean> {
    const building = `${path}.tmp-${tokenTag(owner.token)}`;
    await mkdir(building);
    try {
      await writeFile(nodePath.join(building, 'owner'), JSON.stringify(owner));
      await touch(building);
      await rename(building, path);
    } catch (error) {
      await removeLockDir(building);
      if (hasCode(error, 'ENOTEMPTY', 'EEXIST')) return false;
      throw error;
    }
    return true;
  }

  async function create(key: Key, path: string, token: string): Promise<Grant | undefined> {
    if (!(await place(path, { token, pid, key: key.full }))) return undefined;
    log.debug('file lock created', { store: 'file' });
    return { key, token };
  }

  /**
   * Take over a dead lock. The takers of one dead lock queue on its own guard,
   * so only one of them judges and moves it. A guard older than `stale` means
   * its taker crashed: the next taker steps to the next guard instead of
   * clearing it, and sweeps the guards it stepped past once the dead lock is
   * gone (no one can need them then: a late taker in one finds a new owner and
   * leaves).
   */
  async function reap(key: Key, path: string, token: string): Promise<Grant | undefined> {
    const dead = await readOwner(path);
    const victim = dead?.token ?? '';
    const guards = `${path}.reap-${tokenTag(victim)}`;
    const passed: string[] = [];
    for (let step = 0; ; step += 1) {
      const guard = `${guards}.${step}`;
      if (await place(guard, { token, pid, key: key.full })) {
        try {
          return await takeOver(key, path, token, victim, passed);
        } finally {
          await rm(guard, { recursive: true, force: true });
        }
      }
      const age = await ageOf(guard);
      // A live taker is on it, or one just finished: either way, look again later.
      if (age === undefined || age <= staleMs) return undefined;
      passed.push(guard);
    }
  }

  async function takeOver(
    key: Key,
    path: string,
    token: string,
    victim: string,
    passed: readonly string[],
  ): Promise<Grant | undefined> {
    // Judge again inside the guard: the lock may be gone, fresh, or already someone else's.
    const age = await ageOf(path);
    if (age === undefined) return create(key, path, token);
    if (age <= staleMs) return undefined;
    const current = await readOwner(path);
    if ((current?.token ?? '') !== victim) return undefined;
    if (!(await remove(path, victim, token))) return undefined;
    log.debug('file lock taken over after stale', { store: 'file' });
    await Promise.all(passed.map(guard => rm(guard, { recursive: true, force: true })));
    return create(key, path, token);
  }

  const store: FileStore = {
    name: 'file',
    guarantees,
    ttlMs: staleMs,
    lockPath,

    async acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
      await ensureDir();
      const path = lockPath(key);
      const created = await create(key, path, req.token);
      if (created !== undefined) return created;
      const age = await ageOf(path);
      // Gone between our mkdir and our stat: the key is free right now, so try again once.
      if (age === undefined) return create(key, path, req.token);
      if (age <= staleMs) return undefined;
      return reap(key, path, req.token);
    },

    async extend(grant: Grant): Promise<boolean> {
      const path = lockPath(grant.key);
      const age = await ageOf(path);
      // Expired is expired: a late heartbeat never revives a lease.
      if (age === undefined || age > staleMs) return false;
      const owner = await readOwner(path);
      if (owner?.token !== grant.token) return false;
      try {
        await touch(path);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) return false;
        throw error;
      }
      return true;
    },

    async release(grant: Grant): Promise<ReleaseOutcome> {
      const path = lockPath(grant.key);
      const owner = await readOwner(path);
      if (owner?.token !== grant.token) return 'not-owner';
      // An expired lease is not ours to move: a taker may be moving it this instant, and our
      // move could catch the lock that replaces it. Takers clear it.
      const age = await ageOf(path);
      if (age === undefined || age > staleMs) return 'not-owner';
      return (await remove(path, grant.token, grant.token)) ? 'released' : 'not-owner';
    },

    waitFor(key: Key, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.resolve();
      const name = lockName(key);
      return new Promise<void>(resolve => {
        let watcher: FSWatcher | undefined;
        const done = (): void => {
          signal.removeEventListener('abort', done);
          scheduler.clearTimeout(timer);
          watcher?.close();
          resolve();
        };
        const timer = scheduler.setTimeout(done, pollMs, { ref: true });
        signal.addEventListener('abort', done, { once: true });
        try {
          watcher = watch(dir, (_event, filename) => {
            if (filename === null || filename === name) done();
          });
          watcher.on('error', done);
        } catch {
          // No fs.watch here (or the directory is not there yet): the timer alone wakes us.
        }
      });
    },
  };
  return store;
}
