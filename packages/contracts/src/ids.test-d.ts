import { expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { FailureOf, UnexpectedDefect } from '@arki/failure';

import type { RandomSourceUnavailable } from './errors.js';
import type { ID_GENERATION_FAILURES, IdDeclaration, IdGenerationFailure, IdOf } from './ids.js';
import { defineId } from './ids.js';

it('ID generation exposes exact canonical failures while schema and IdOf remain success-only', () => {
  const storyId = defineId('sty_');
  expectTypeOf<IdDeclaration<'sty_'>>().toEqualTypeOf<typeof storyId>();
  expectTypeOf(storyId).toEqualTypeOf<Readonly<typeof storyId>>();
  expectTypeOf<IdOf<typeof storyId>>().toEqualTypeOf<`sty_${string}`>();
  expectTypeOf<z.output<typeof storyId.schema>>().toEqualTypeOf<IdOf<typeof storyId>>();
  expectTypeOf<ReturnType<typeof storyId.create>>().toEqualTypeOf<`sty_${string}` | IdGenerationFailure>();
  expectTypeOf<IdGenerationFailure>().toEqualTypeOf<FailureOf<(typeof ID_GENERATION_FAILURES)[number]>>();
  expectTypeOf<FailureOf<typeof storyId.create>>().toEqualTypeOf<
    FailureOf<typeof RandomSourceUnavailable> | FailureOf<typeof UnexpectedDefect>
  >();
});

it('IdOf reads schema output so transforms and brands cannot be erased by a prefix', () => {
  const _domain = { schema: z.string().brand<'RefundId'>() };
  expectTypeOf<IdOf<typeof _domain>>().toEqualTypeOf<z.output<typeof _domain.schema>>();
  expectTypeOf<IdOf<typeof _domain>>().not.toEqualTypeOf<string>();
  const _transformed = { schema: z.string().transform(value => value.length) };
  expectTypeOf<IdOf<typeof _transformed>>().toEqualTypeOf<number>();
  // @ts-expect-error A prefix without a canonical schema cannot establish a domain type.
  type _Unvalidated = IdOf<{ prefix: 'refund_' }>;
});

it('same-format domain kinds reject cross-kind and unvalidated values', () => {
  const refundId = defineId('id_', { kind: 'billing.refund' });
  const _paymentId = defineId('id_', { kind: 'billing.payment' });
  type RefundId = IdOf<typeof refundId>;
  type PaymentId = IdOf<typeof _paymentId>;
  expectTypeOf<RefundId>().not.toExtend<PaymentId>();
  expectTypeOf<PaymentId>().not.toExtend<RefundId>();
  expectTypeOf<`id_${string}`>().not.toExtend<RefundId>();
  expectTypeOf<string>().not.toExtend<RefundId>();
  expectTypeOf<RefundId>().toExtend<`id_${string}`>();
  expectTypeOf<typeof refundId>().toExtend<IdDeclaration<'id_'>>();
  expectTypeOf<z.output<typeof refundId.schema>>().toEqualTypeOf<RefundId>();
  expectTypeOf<ReturnType<typeof refundId.create>>().toEqualTypeOf<RefundId | IdGenerationFailure>();
  expectTypeOf<FailureOf<typeof refundId.create>>().toEqualTypeOf<IdGenerationFailure>();
  const raw: unknown = 'id_1';
  if (refundId.is(raw)) expectTypeOf(raw).toEqualTypeOf<RefundId>();
  const dynamicKind = String('billing.refund');
  // @ts-expect-error A widened name cannot establish distinct identity kinds.
  defineId('id_', { kind: dynamicKind });
  const multipleKinds: 'billing.refund' | 'billing.payment' = Math.random() ? 'billing.refund' : 'billing.payment';
  // @ts-expect-error One declaration cannot claim two identity kinds simultaneously.
  defineId('id_', { kind: multipleKinds });
  // @ts-expect-error Every domain kind needs a name.
  defineId('id_', { kind: '' });
});

it('unprefixed domains remain distinct and external numeric IDs derive their brands from schemas', () => {
  const _externalUserId = { schema: z.number().int().positive().brand<'provider.user'>() };
  const _externalTeamId = { schema: z.number().int().positive().brand<'provider.team'>() };
  expectTypeOf<IdOf<typeof _externalUserId>>().not.toExtend<IdOf<typeof _externalTeamId>>();
  expectTypeOf<IdOf<typeof _externalUserId>>().toEqualTypeOf<z.output<typeof _externalUserId.schema>>();
  const _traceId = defineId('', { kind: 'trace' });
  const _leaseId = defineId('', { kind: 'lease' });
  expectTypeOf<IdOf<typeof _traceId>>().not.toExtend<IdOf<typeof _leaseId>>();
  expectTypeOf<string>().not.toExtend<IdOf<typeof _traceId>>();
});

it('requires a finite literal kind rather than an open template pattern', () => {
  const _rejectPatterns = (kind: `billing.${string}`, numeric: `${number}`) => {
    // @ts-expect-error A pattern does not identify one domain.
    defineId('id_', { kind });
    // @ts-expect-error An infinite numeric pattern does not identify one domain.
    defineId('id_', { kind: numeric });
  };
  expectTypeOf(_rejectPatterns).toBeFunction();
});

it('UUID generation retains exact domain types and literal kind guards', () => {
  const _jobId = defineId('', { kind: 'queue.job', format: 'uuid' });
  const _otherId = defineId('', { kind: 'queue.other', format: 'uuid' });
  type JobId = IdOf<typeof _jobId>;
  expectTypeOf<JobId>().toEqualTypeOf<z.output<typeof _jobId.schema>>();
  expectTypeOf<ReturnType<typeof _jobId.create>>().toEqualTypeOf<JobId | IdGenerationFailure>();
  expectTypeOf<FailureOf<typeof _jobId.create>>().toEqualTypeOf<IdGenerationFailure>();
  const _prefixedJobId = defineId('job_', { kind: 'queue.prefixed-job', format: 'uuid' });
  expectTypeOf<ReturnType<typeof _prefixedJobId.create>>().toEqualTypeOf<
    IdOf<typeof _prefixedJobId> | IdGenerationFailure
  >();
  expectTypeOf<FailureOf<typeof _prefixedJobId.create>>().toEqualTypeOf<IdGenerationFailure>();
  expectTypeOf<JobId>().not.toExtend<IdOf<typeof _otherId>>();
  expectTypeOf<string>().not.toExtend<JobId>();
  expectTypeOf<JobId>().toExtend<string>();
  expectTypeOf<typeof _jobId>().toExtend<IdDeclaration<''>>();
  // @ts-expect-error Unsupported format is static misuse.
  defineId('', { kind: 'queue.job', format: 'cuid' });
  // @ts-expect-error UUID generation cannot erase the literal kind guard.
  defineId('', { kind: String('queue.job'), format: 'uuid' });
  const multipleKinds: 'queue.job' | 'queue.other' = Math.random() ? 'queue.job' : 'queue.other';
  // @ts-expect-error UUID generation cannot brand one value as multiple kinds.
  defineId('', { kind: multipleKinds, format: 'uuid' });
  const _rejectUuidPattern = (kind: `queue.${string}`) => {
    // @ts-expect-error Open template patterns cannot name one UUID domain.
    defineId('', { kind, format: 'uuid' });
  };
  expectTypeOf(_rejectUuidPattern).toBeFunction();
  // @ts-expect-error Empty kinds cannot establish a UUID domain.
  defineId('', { kind: '', format: 'uuid' });
});
