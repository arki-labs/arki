import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Key } from '../types.js';
import type { FileStore } from './index.js';
import { LockError } from '../errors.js';
import { createKey } from '../key.js';
import { createLocks } from '../locks.js';
import { chaos, describeCases, describeStoreContract, manualScheduler, replicaCases } from '../testing/index.js';
import { fileStore } from './index.js';

const STORE_SOURCE = fileURLToPath(new URL('index.ts', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const key = (name: string) => createKey('file-test', name);
/** Lease length of the orchestrated takeover tests: long enough that the whole schedule runs inside one lease. */
const STALE = 1000;

let dir = '';
const children: ChildProcess[] = [];

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'arki-lock-file-'));
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
});

/** A store on its own fake wall clock: `advance` moves "now" and the scheduler together. */
function fakeClockStore(stale = 1000) {
  let offset = 0;
  const advance = (ms: number): Promise<void> => {
    offset += ms;
    return Promise.resolve();
  };
  const store = fileStore(dir, { stale, now: () => Date.now() + offset });
  return { store, advance };
}

// The contract and the replica property run each case on a fresh store in the same temp dir.
// Every case uses a unique key, so cases never see each other's locks.
describe('file store conformance', () => {
  // Contract: real timers (the store does real file I/O); only the wall clock the store judges staleness by is moved.
  let offset = 0;
  const make = () => fileStore(dir, { stale: 1000, now: () => Date.now() + offset });
  const contractOptions = {
    ttl: 1000,
    advanceTime: (ms: number): Promise<void> => {
      offset += ms;
      return Promise.resolve();
    },
  };
  describeStoreContract('file', make, contractOptions);
  describeCases('file chaos hooks', chaos(make, { killHolder: () => Promise.resolve() }, contractOptions));
  // Replicas: one manual clock drives the manager timers and the store's wall clock together.
  const clock = manualScheduler();
  const base = Date.now();
  describeCases(
    'file replicas',
    replicaCases(() => fileStore(dir, { stale: 1000, now: () => base + clock.now(), scheduler: clock }), {
      scheduler: clock,
      numRuns: 20,
    }),
  );
});

describe('file store', () => {
  it('declares a host-scope lease with polled waits, as the 05 table says', () => {
    expect(fileStore(dir).guarantees).toMatchObject({
      kind: 'lease',
      scope: 'host',
      wait: 'poll',
      fence: false,
      releasedOnCrash: 'after-ttl',
    });
  });

  it('keeps a live holder with a callback of 3x stale: the old lock was stolen after 10 s with no heartbeat', async () => {
    const stale = 1000;
    const holder = createLocks({ store: fileStore(dir, { stale }), namespace: 'file-test' });
    const rival = fileStore(dir, { stale });
    const target = key('slow');
    let stolen = 0;
    let signalAborted = false;
    const result = holder.mutex('slow').run(
      async ({ signal }) => {
        const deadline = Date.now() + stale * 3;
        while (Date.now() < deadline) {
          if ((await rival.acquire(target, { token: `rival-${stolen}`, ttlMs: stale })) !== undefined) stolen += 1;
          await sleep(20);
        }
        signalAborted = signal.aborted;
        return 'done';
      },
      { wait: '1s' },
    );
    expect(await result).toBe('done');
    expect({ stolen, signalAborted }).toEqual({ stolen: 0, signalAborted: false });
  });

  it('never lets an old owner remove its successor: removal by path destroyed the new owner lock', async () => {
    const { store, advance } = fakeClockStore(1000);
    const target = key('successor');
    const old = await store.acquire(target, { token: 'old', ttlMs: 1000 });
    await advance(1001);
    const successor = await store.acquire(target, { token: 'new', ttlMs: 1000 });
    expect(old).toBeDefined();
    expect(successor).toBeDefined();
    if (old === undefined || successor === undefined) return;
    expect(await store.release(old)).toBe('not-owner');
    expect(await store.extend?.(old, 1000)).toBe(false);
    const owner: unknown = JSON.parse(await readFile(nodePath.join(store.lockPath(target), 'owner'), 'utf8'));
    expect(owner).toMatchObject({ token: 'new' });
    expect(await store.release(successor)).toBe('released');
  });

  it('lets exactly one of many racing takers take over a stale lock', async () => {
    const { store, advance } = fakeClockStore(1000);
    const target = key('reap-race');
    await store.acquire(target, { token: 'dead', ttlMs: 1000 });
    await advance(1001);
    const grants = await Promise.all(
      Array.from({ length: 24 }, (_unused, index) => store.acquire(target, { token: `taker-${index}`, ttlMs: 1000 })),
    );
    expect(grants.filter(grant => grant !== undefined)).toHaveLength(1);
  });

  it('takes any token string: a token with "/" or 300 chars was spliced into a private path and broke acquire', async () => {
    const store = fileStore(dir);
    for (const token of ['a/b', '../../escape', 'x'.repeat(300)]) {
      const grant = await store.acquire(key(`token-${token.length}`), { token });
      expect(grant).toBeDefined();
      if (grant !== undefined) expect(await store.release(grant)).toBe('released');
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('takes over a stale lock directory that lost its owner file: a half-deleted lock must not block the key for good', async () => {
    const store = fileStore(dir, { stale: STALE });
    const target = await staleLock(store, 'ownerless');
    await rm(nodePath.join(store.lockPath(target), 'owner'));
    expect(await store.acquire(target, { token: 'taker' })).toBeDefined();
  });

  it('keeps lock names within file-system limits for a 512-byte key', async () => {
    const store = fileStore(dir);
    const grant = await store.acquire(createKey('file-test', 'é'.repeat(256)), { token: 't' });
    expect(grant).toBeDefined();
    const names = await readdir(dir);
    expect(names.every(name => name.length < 200)).toBe(true);
  });
});

describe('file store chaos', () => {
  it('frees a SIGKILLed holder only after stale: a crashed process must not block the key forever, nor be stolen early', async () => {
    const stale = 800;
    const target = key('sigkill');
    const child = startChild(`
      import { fileStore } from ${JSON.stringify(STORE_SOURCE)};
      import { createKey } from ${JSON.stringify(STORE_SOURCE.replace('file/index.ts', 'key.ts'))};
      const store = fileStore(${JSON.stringify(dir)}, { stale: ${stale} });
      const grant = await store.acquire(createKey('file-test', 'sigkill'), { token: 'child' });
      console.log(grant ? 'ACQUIRED' : 'FAILED');
      setInterval(() => {}, 1000);
    `);
    await child.line('ACQUIRED');
    child.process.kill('SIGKILL');
    const store = fileStore(dir, { stale });
    expect(await store.acquire(target, { token: 'early' })).toBeUndefined();
    const killedAt = Date.now();
    let taken = await store.acquire(target, { token: 'late' });
    while (taken === undefined && Date.now() - killedAt < stale * 5) {
      await sleep(25);
      taken = await store.acquire(target, { token: 'late' });
    }
    expect(taken).toBeDefined();
  });

  // Takers in child processes freeze at their Nth clock read, swept over every N, so each step of a
  // takeover meets the bad interleaving without the test knowing the store's internal steps or names.
  const STEPS = [1, 2, 3, 4, 5, 6, 7, 8];
  // Up to 32 child processes per test: ~10 s alone, but a full parallel run on a busy host needs far more.
  const RACE_TIMEOUT_MS = 120_000;

  it('keeps one owner when a taker crashed mid-takeover and others stall around its leftovers', async () => {
    const store = fileStore(dir, { stale: STALE });
    const outcomes = await Promise.all(
      STEPS.map(async step => {
        const target = await staleLock(store, `crashed-taker-${step}`);
        const crashed = startTaker(target.name, step);
        await crashed.start();
        await crashed.reached();
        await crashed.kill();
        await sleep(STALE + 100); // whatever the crashed taker left behind is now old too
        const first = startTaker(target.name, step);
        const second = startTaker(target.name, step);
        await first.start();
        await first.reached();
        const a = await tryAcquire(store, target, `a-${step}`);
        await second.start();
        await second.reached();
        await first.resume();
        const firstOutcome = await first.done();
        const b = await tryAcquire(store, target, `b-${step}`);
        await second.resume();
        return holders(store, target, [a, b, firstOutcome, await second.done()]);
      }),
    );
    expect(outcomes).toEqual(STEPS.map(() => ({ granted: 1, valid: 1, errors: [] })));
  }, RACE_TIMEOUT_MS);

  it('keeps one owner when an expired owner releases while a taker stalls mid-takeover', async () => {
    const store = fileStore(dir, { stale: STALE });
    const outcomes = await Promise.all(
      STEPS.map(async step => {
        const target = await staleLock(store, `late-release-${step}`);
        const taker = startTaker(target.name, step);
        await taker.start();
        await taker.reached();
        await store.release({ key: target, token: `dead-${target.name}` });
        const rival = await tryAcquire(store, target, `rival-${step}`);
        await taker.resume();
        return holders(store, target, [rival, await taker.done()]);
      }),
    );
    expect(outcomes).toEqual(STEPS.map(() => ({ granted: 1, valid: 1, errors: [] })));
  }, RACE_TIMEOUT_MS);

  it('reports lost and aborts the signal when the lock directory is deleted under a live holder', async () => {
    const stale = 1000;
    const store = fileStore(dir, { stale });
    const locks = createLocks({ store, namespace: 'file-test' });
    const guard = await locks.mutex('vanish').acquire({ wait: '1s' });
    await rm(store.lockPath(createKey('file-test', 'vanish')), { recursive: true, force: true });
    const deadline = Date.now() + stale * 5;
    while (!guard.signal.aborted && Date.now() < deadline) await sleep(20);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.held).toBe(false);
    expect(guard.signal.reason).toBeInstanceOf(LockError);
    expect(guard.signal.reason).toMatchObject({ code: 'lost' });
    await guard.release().catch(() => 0);
  });

  it('never lets two processes own the key at once over 2 x 200 contended rounds', async () => {
    const script = `
      import { fileStore } from ${JSON.stringify(STORE_SOURCE)};
      import { createKey } from ${JSON.stringify(STORE_SOURCE.replace('file/index.ts', 'key.ts'))};
      import { readFile, writeFile, rm } from 'node:fs/promises';
      const root = ${JSON.stringify(dir)};
      const store = fileStore(root, { stale: 20000, pollMs: 5 });
      const target = createKey('file-test', 'contend');
      const probe = root + '/probe';
      const me = String(process.pid);
      let violations = 0;
      for (let round = 0; round < 200; round++) {
        let grant;
        while (!(grant = await store.acquire(target, { token: me + '-' + round }))) {
          await new Promise((r) => setTimeout(r, 1));
        }
        const before = await readFile(probe, 'utf8').catch(() => '');
        if (before !== '') violations++;
        await writeFile(probe, grant.token);
        await new Promise((r) => setTimeout(r, Math.random() * 2));
        if ((await readFile(probe, 'utf8')) !== grant.token) violations++;
        await rm(probe, { force: true });
        if ((await store.release(grant)) !== 'released') violations++;
      }
      console.log('DONE ' + violations);
    `;
    const first = startChild(script);
    const second = startChild(script);
    const results = await Promise.all([first.line('DONE'), second.line('DONE')]);
    expect(results).toEqual(['DONE 0', 'DONE 0']);
  }, 120_000);
});

/** A lock whose holder died long ago: `dead-<name>` owns it and its mtime is far past `stale`. */
async function staleLock(store: FileStore, name: string): Promise<Key> {
  const target = key(name);
  await store.acquire(target, { token: `dead-${name}` });
  const longAgo = (Date.now() - 60_000) / 1000;
  await utimes(store.lockPath(target), longAgo, longAgo);
  return target;
}

/** One acquire, reported as a token, `'none'`, or the error code. */
function tryAcquire(store: FileStore, target: Key, token: string): Promise<string> {
  return store.acquire(target, { token }).then(
    grant => grant?.token ?? 'none',
    (error: unknown) => `error ${String(error)}`,
  );
}

/** How many of the outcomes were granted, how many still own a live lock now, and what threw. */
async function holders(store: FileStore, target: Key, outcomes: string[]) {
  const tokens = outcomes.filter(outcome => outcome !== 'none' && !outcome.startsWith('error'));
  const checks = await Promise.all(
    tokens.map(token => store.extend?.({ key: target, token }, STALE) ?? Promise.resolve(false)),
  );
  return {
    granted: tokens.length,
    valid: checks.filter(Boolean).length,
    errors: outcomes.filter(outcome => outcome.startsWith('error')),
  };
}

/**
 * A taker in its own process that freezes at its `step`th clock read. `start` lets it try to
 * acquire; `reached` settles once it froze (or finished before that step); `resume` thaws it and
 * `kill` SIGKILLs it there; `done` is its outcome, as `tryAcquire` reports it.
 */
function startTaker(name: string, step: number) {
  const startFile = nodePath.join(dir, `start-${name}-${step}-${children.length}`);
  const goFile = `${startFile}.go`;
  const child = startChild(`
    import { existsSync, writeSync } from 'node:fs';
    import { fileStore } from ${JSON.stringify(STORE_SOURCE)};
    import { createKey } from ${JSON.stringify(STORE_SOURCE.replace('file/index.ts', 'key.ts'))};
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const waitFor = (file) => { while (!existsSync(file)) Atomics.wait(cell, 0, 0, 2); };
    let reads = 0;
    const now = () => {
      reads += 1;
      if (reads === ${step}) {
        writeSync(1, 'FROZEN\\n');
        waitFor(${JSON.stringify(goFile)});
      }
      return Date.now();
    };
    const store = fileStore(${JSON.stringify(dir)}, { stale: ${STALE}, now });
    waitFor(${JSON.stringify(startFile)});
    const outcome = await store.acquire(createKey('file-test', ${JSON.stringify(name)}), { token: 'taker-' + process.pid }).then(
      (grant) => grant?.token ?? 'none',
      (error) => 'error ' + String(error),
    );
    if (reads < ${step}) writeSync(1, 'FROZEN\\n');
    writeSync(1, 'DONE ' + outcome + '\\n');
    process.exit(0);
  `);
  return {
    start: (): Promise<void> => writeFile(startFile, ''),
    reached: (): Promise<string> => child.line('FROZEN'),
    resume: (): Promise<void> => writeFile(goFile, ''),
    done: (): Promise<string> => child.line('DONE ').then(line => line.slice('DONE '.length)),
    kill: async (): Promise<void> => {
      const exited = new Promise(resolve => child.process.once('exit', resolve));
      child.process.kill('SIGKILL');
      await exited;
    },
  };
}

/** Run TypeScript in a `bun` child (the repo's toolchain), so it can import the store source as it is. */
function startChild(code: string) {
  const child = spawn('bun', ['--eval', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  let buffer = '';
  const waiting: { prefix: string; resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  const lines: string[] = [];
  const flush = (): void => {
    for (const waiter of waiting) {
      const hit = lines.find(line => line.startsWith(waiter.prefix));
      if (hit !== undefined) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve(hit);
      }
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    lines.push(...parts);
    flush();
  });
  child.on('exit', (code, signal) => {
    for (const waiter of waiting.splice(0))
      waiter.reject(new Error(`child exited (${code ?? signal}) before printing ${waiter.prefix}`));
  });
  return {
    process: child,
    line: (prefix: string): Promise<string> =>
      new Promise((resolve, reject) => {
        waiting.push({ prefix, resolve, reject });
        flush();
      }),
  };
}
