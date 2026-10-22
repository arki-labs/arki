/** Handler events: `$handlers` is on every hook context, and the event union keeps `completed` and `failed` apart. */
import { expectTypeOf } from 'vitest';

import type { Failure } from '@arki/failure';

import type {
  DotHandlerCompletedEvent,
  DotHandlerFailedEvent,
  DotHandlerLifecycleEvent,
  DotLifecycleEvent,
} from '../lifecycle-observer.js';
import type { DotHandlerObserver, DotHandlerRef, KernelCtx } from '../unit-contract.js';
import { infra } from '../unit.js';

expectTypeOf<KernelCtx['$handlers']>().toEqualTypeOf<DotHandlerObserver>();
infra({
  name: 'typed',
  boot(ctx) {
    expectTypeOf(ctx.$handlers).toEqualTypeOf<DotHandlerObserver>();
  },
});

declare const handlers: DotHandlerObserver;
expectTypeOf(handlers.run({ transport: 'rpc', name: 'a.b' }, () => 1)).toEqualTypeOf<number>();
expectTypeOf(handlers.run({ transport: 'job', name: 'x' }, () => Promise.resolve('v'))).toEqualTypeOf<
  Promise<string>
>();
// @ts-expect-error A transport is one of rpc, http, job, schedule.
handlers.run({ transport: 'grpc', name: 'x' } satisfies DotHandlerRef, () => 1);

declare const event: DotLifecycleEvent;
if (event.kind === 'handler') {
  expectTypeOf(event).toEqualTypeOf<DotHandlerLifecycleEvent>();
  expectTypeOf(event.transport).toEqualTypeOf<'rpc' | 'http' | 'job' | 'schedule'>();
  if (event.status === 'completed') {
    expectTypeOf(event).toEqualTypeOf<DotHandlerCompletedEvent>();
    expectTypeOf(event.outcome).toEqualTypeOf<'ok' | 'refused'>();
    expectTypeOf(event.failure).toEqualTypeOf<Failure | undefined>();
    expectTypeOf(event.error).toEqualTypeOf<undefined>();
  }
  if (event.status === 'failed') {
    expectTypeOf(event).toEqualTypeOf<DotHandlerFailedEvent>();
    expectTypeOf(event.error).toBeUnknown();
    expectTypeOf(event.failure).toEqualTypeOf<undefined>();
  }
  if (event.status === 'starting') {
    expectTypeOf(event.durationMs).toEqualTypeOf<undefined>();
  }
}
