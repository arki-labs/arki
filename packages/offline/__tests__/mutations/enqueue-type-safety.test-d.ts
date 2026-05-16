import { describe, it, expectTypeOf } from 'vitest';
import type { OfflineSafeMeta } from '../../src/orpc/offline-safe-marker';
import type { OfflineMutationQueue } from '../../src/mutations/queue';

describe('queue.enqueue type safety', () => {
  it('only accepts procedures marked offlineSafe', () => {
    type SafeProc = { readonly meta: OfflineSafeMeta; input: { title: string } };
    type UnsafeProc = { readonly meta: { something: 'else' }; input: { title: string } };

    const queue = {} as OfflineMutationQueue;

    // safe: compiles
    queue.enqueue<SafeProc>({} as SafeProc, { title: 'x' });

    // unsafe: must NOT compile — missing OfflineSafeMeta
    // @ts-expect-error -- unsafe procedure missing OfflineSafeMeta
    queue.enqueue<UnsafeProc>({} as UnsafeProc, { title: 'x' });

    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});
