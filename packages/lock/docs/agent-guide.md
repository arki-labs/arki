# @arki/lock for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. `createLocks({ store, namespace })` returns a manager. `mutex(key)`, `semaphore(key, { limit })` and `readWrite(key)` give lock handles.
2. Four verbs on a handle: `tryRun`, `run`, `tryAcquire`, `acquire`. `try*` makes one attempt. The others wait up to `wait`.
3. A busy lock is the returned failure `LockHeld` (`lock.held`). Other problems throw `LockError`.
4. A store lives on its own subpath and declares `guarantees`. The handle types follow them.
5. A lease renews itself and aborts the callback's `signal` when ownership is lost.
6. Leases give a fence: a number that only grows. Hand it to the resource you protect.
7. The memory store runs everywhere. The other stores need a server runtime and their client.

## Task map

### Run a job once at a time

1. Create a manager with a store and a namespace.
2. Call `mutex(key).tryRun(fn)`.
3. Check `LockHeld.is(result)` before using the value.

```ts from="examples/nightly.ts#run-once"
import { createLocks, LockHeld } from '@arki/lock';
import { memoryStore } from '@arki/lock/memory';

const locks = createLocks({ store: memoryStore(), namespace: 'billing' });

/** Send invoices unless another caller is already doing it. */
export async function sendInvoices(send: () => Promise<number>): Promise<string> {
  const result = await locks.mutex('send-invoices').tryRun(async ({ signal }) => {
    signal.throwIfAborted(); // aborts if the lock is lost
    return send();
  });
  if (LockHeld.is(result)) return 'skipped: another caller holds the lock';
  return `sent ${result}`;
}
```

### Wait for the lock

1. Call `mutex(key).run(fn, { wait: '10s' })`.
2. Expect `LockHeld` when the wait ends with the lock still busy.

### Limit concurrency

1. Call `semaphore(key, { limit: 3 })`.
2. Use the same verbs. At most three callers run at once.

### Protect a write that cannot be undone

1. Use a lease store: `pgLease` or `redisStore`.
2. Read `fence` from the callback context.
3. Put the fence in the same statement as the write, and refuse an older number.

### Elect a leader

1. Use a lease store.
2. Call `mutex(key).lead(fn)`.

### Wire it into a Dot app

1. Add the `locks()` plugin from `@arki/lock/dot`.
2. Depend on the `locks` service in a feature.

### Test a multi-replica job

1. Use `manualScheduler` and `testStore` from `@arki/lock/testing`.
2. Advance the clock to expire a lease.

## Rules that bite

- Contention is a value. `try { await run(...) } catch` never sees a busy lock.
- A callback that itself returns `LockHeld` cannot be told apart from its own lock being busy. Handle the inner lock inside the callback.
- If your callback throws, that error wins. A loss that happened at the same time rides along as `suppressed`.
- `run` and `tryRun` throw `lost` when the callback returns after ownership was lost. Pass `onLost: 'ignore'` to keep the value.
- `pgTransaction` acquire has no timer. A silent connection can hang it.
- A `ttl` below `1s` throws `config`.
- Keys are namespaced and encoded. `mutex('a')` and `semaphore('a')` do not block each other.

## Errors

| Code             | Meaning                                             | What to do                                                     |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `lock.held`      | The lock is busy. A returned failure, status 409.   | Skip the work, retry later, or raise `wait`.                   |
| `ARKI_LOCK_E002` | The caller's signal aborted the wait.               | Stop. Do not retry with the same signal.                       |
| `ARKI_LOCK_E003` | Ownership was lost while the callback ran.          | Check what finished. Do not blindly retry.                     |
| `ARKI_LOCK_E004` | The store failed. Never read as free or held.       | Check the store. Wait out the lease when `outcome` is unknown. |
| `ARKI_LOCK_E005` | `guard.release()` failed or answered unknown.       | Check the store. A lease store frees the key after `ttl`.      |
| `ARKI_LOCK_E006` | Bad input or setup.                                 | Fix the call named in the message.                             |
| `ARKI_LOCK_E007` | A store lacks a capability the types could not see. | Use a store that declares it in `guarantees`.                  |

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs

# In an app that mounts the locks() plugin: the plugin graph, then the booted app's health.
dot explain --json | jq '.data'
dot doctor --json | jq '.data'
```
