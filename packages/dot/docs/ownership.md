# Ownership

A constructing plugin owns each acquired resource immediately. The app receives that ownership only after construction succeeds. Services publish together; a refused provider never becomes a service.

Return a `resource` descriptor from a provider. The provider's handle exposes the successful resource type, while boot and disposal infer the failure types from its callbacks.

```ts run
import { resource } from '@arki/async';
import { defineApp, plugin } from '@arki/dot';
import { defineFailure, isFailure } from '@arki/failure';

const Unavailable = defineFailure('ownership_example.unavailable');
let closed = false;
const database = plugin({
  name: 'database',
  provides: {
    db: () => resource(
      () => ({ query: () => ['one'] }),
      () => { closed = true; },
    ),
  },
});
const unavailable = plugin({
  name: 'unavailable',
  provides: { remote: () => Unavailable() },
});
const result = await defineApp('ownership').use(database).use(unavailable).boot();
if (!isFailure(result) || !Unavailable.is(result) || !closed) {
  throw new Error('Refusal must unwind previously acquired resources.');
}
```

For private work, return a descriptor plan from `boot`: `{ connection: resource(open, close), worker: child(run), flush: cleanup(flush) }`. No public service key is needed. Dependencies between resources use nested `scoped(plan, body)` calls, where the inner closure captures successful outer resources.

Closing follows one order:

1. Close admission and request cancellation.
2. Observe all admitted children and acquisitions, including late settlements.
3. Run the plugin's legacy disposal hook while its resources remain available.
4. Run owned finalizers in reverse registration order, attempting every finalizer.
5. Continue through earlier plugins in reverse declaration order.

A partially constructed plugin closes its descriptors before earlier plugins unwind. Its legacy `dispose` hook runs only after its boot completed. Register partial resource cleanup through descriptors.

## Failure values

Use `isFailure` before reading a boot/start result. A single refusal is returned unchanged if cleanup succeeds. Multiple failures become `ScopeFailed`: public data contains counts, while its local typed `cause` preserves the exact primary and cleanup members. Serialization deliberately omits private causes. A revived `ScopeFailed` is a summary; it does not have the local member types.

Unknown exceptions become `UnexpectedDefect`. External cancellation and deadlines become `Cancelled` and `Deadline`; unrelated exceptions during cancellation remain defects. An admitted acquisition failure belongs to its scope even if the body ignores that result. Recover before admission or use a separate attempt when refusal should not fail the owner.

## Deadlines and children

A deadline requests cancellation. JavaScript cannot forcibly stop a callback. Ownership stays open until admitted work settles, and a late successful acquisition still receives cleanup. A noncooperative child that never settles keeps close pending. Process shutdown may separately enforce an exit deadline.

`scoped` is the same lifetime primitive for an app task, request, job or workflow attempt. Create a fresh scope at each execution boundary and await its outcome. Request and durable-execution adapters adopt this boundary in their respective migrations; declaring a scope does not make detached work owned automatically.

## Lazy services

`lazy(init, { dispose })` starts at most one attempt for concurrent `get()` calls. A returned failure or thrown defect never marks the handle ready, and `peek()` exposes successful values only. A later explicit `get()` may retry; there is no hidden retry loop.

Disposal closes admission immediately, joins an in-flight initializer and finalizes a late success exactly once. Repeated disposal returns the cached complete outcome, including cleanup failures. A closed get returns `LazyClosed`. `lazyOf(value)` is borrowed: it never owns or disposes the value.

## HMR

`createAppRuntime` caches only successful starts. Replacements wait for the previous disposal outcome. Failed cleanup returns `RuntimeReleaseFailed` and blocks a new owner, avoiding overlapping exclusive resources. Calls on the replaced module return `RuntimeReplaced`.
