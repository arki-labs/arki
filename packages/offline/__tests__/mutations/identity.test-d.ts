import { describe, expectTypeOf, it } from 'vitest';
import type { IdOf } from '@arki/contracts';

import type { queuedMutationId, mutationIdempotencyKey } from '../../src/mutations/identity.ts';
import type { QueuedMutationId, MutationIdempotencyKey } from '../../src/mutations/identity.ts';
import type { QueuedMutation, EnqueueReceipt, OfflineMutationQueue } from '../../src/mutations/queue.ts';
import type { EnqueueFailure, DrainFailure, QueueStorageFailure } from '../../src/mutations/failures.ts';
import type { idempotencyKeyId } from '../../src/orpc/idempotency-id.ts';

it('infers each persisted and returned identity from its canonical declaration', () => {
  expectTypeOf<QueuedMutation['id']>().toEqualTypeOf<IdOf<typeof queuedMutationId>>();
  expectTypeOf<QueuedMutation['idempotencyKey']>().toEqualTypeOf<IdOf<typeof mutationIdempotencyKey>>();
  expectTypeOf<Awaited<ReturnType<OfflineMutationQueue['enqueue']>>>().toEqualTypeOf<EnqueueReceipt | EnqueueFailure>();
  expectTypeOf<Awaited<ReturnType<OfflineMutationQueue['drain']>>>().toEqualTypeOf<void | DrainFailure>();
  expectTypeOf<Awaited<ReturnType<OfflineMutationQueue['deadLetter']['list']>>>().toEqualTypeOf<readonly QueuedMutation[] | QueueStorageFailure>();
});

describe('same representation does not permit cross-kind assignment', () => {
  it('keeps queue identities, transport keys, cache records, and raw strings distinct', () => {
    expectTypeOf<QueuedMutationId>().not.toExtend<MutationIdempotencyKey>();
    expectTypeOf<MutationIdempotencyKey>().not.toExtend<QueuedMutationId>();
    expectTypeOf<QueuedMutationId>().not.toExtend<IdOf<typeof idempotencyKeyId>>();
    expectTypeOf<string>().not.toExtend<QueuedMutationId>();
    expectTypeOf<string>().not.toExtend<MutationIdempotencyKey>();
  });
});
