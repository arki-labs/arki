import type { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';

import { instant } from '@arki/date';
import { orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { money } from '@arki/money';

import type { CoreWrites } from '../core/journal.js';
import type { PaymentId } from '../core/types.js';
import type { RefundWrites } from '../refunds/journal.js';
import type { RefundId } from '../refunds/primitives.js';
import type { AppDb, AppTx } from '../test-support.js';
import { PaymentRepository } from '../core/repository.js';
import { createRefundEffects } from '../refunds/effects.js';
import { createRefundsJournal } from '../refunds/journal.js';
import { createRefundId } from '../refunds/primitives.js';
import { createRefundRepository, refundAmountOf, RefundRepository } from '../refunds/repository.js';
import { createRefundService, RefundService } from '../refunds/service.js';
import { createRefundsTables } from '../refunds/tables.js';
import { createRefundWorkflow, refundRunId } from '../refunds/workflow.js';
import { coreReads, refundServiceOf, runnerOn, seedPayment } from '../service-test-support.js';
import {
  adminId,
  core,
  journalTablesInSchema,
  metaSchema,
  openDb,
  refundsTables,
  schema,
  typed,
  userId,
  users,
} from '../test-support.js';
import { area, args, op } from './engine.js';

type Ctx = {
  db: AppDb;
  client: PGlite;
  coreWrites: CoreWrites;
  writes: RefundWrites;
  repo: RefundRepository;
  service: RefundService;
  /** The refund the latest `arrange` made, for `valid` to look for. */
  last: { refundId: RefundId; paymentId: PaymentId };
};

const noArgs = (): [] => [];
const usd = (amount: string) => ({ amount, currency: 'USD' });
let counter = 0;

/** Fresh journal definitions and the refunds journal on them, the way an app boots. */
function freshJournal() {
  const j = initJournal.tx<AppTx>().db<AppDb>().create({ tables: journalTablesInSchema, meta: metaSchema });
  const refunds = createRefundsJournal(j, { refunds: refundsTables.refunds, payments: core.payments });
  return { j, refunds };
}

/** A pending refund of 10 USD on a new payment of 25 USD, through the refund command. */
async function pending(ctx: Ctx) {
  const payment = await seedPayment(ctx.coreWrites, null, '25');
  const refund = await orThrow(
    ctx.writes.requestRefund({
      paymentId: payment.id,
      originalAmount: usd('25'),
      refundAmount: usd('10'),
      reason: 'customer_request',
      requestedBy: userId,
    }),
  );
  ctx.last = { refundId: refund.id, paymentId: payment.id };
  return refund;
}

async function approved(ctx: Ctx) {
  const refund = await pending(ctx);
  return orThrow(ctx.writes.approveRefund({ refundId: refund.id, approvedBy: adminId }));
}

async function processing(ctx: Ctx) {
  const refund = await approved(ctx);
  return orThrow(ctx.writes.processRefund({ refundId: refund.id }));
}

async function completed(ctx: Ctx) {
  counter += 1;
  const refund = await processing(ctx);
  return orThrow(ctx.writes.completeRefund({ refundId: refund.id, providerRefundId: `re_fuzz_${counter}` }));
}

async function pendingId(ctx: Ctx) {
  const refund = await pending(ctx);
  return refund.id;
}
async function pendingPaymentId(ctx: Ctx) {
  const refund = await pending(ctx);
  return refund.paymentId;
}
async function approvedId(ctx: Ctx) {
  const refund = await approved(ctx);
  return refund.id;
}
async function processingId(ctx: Ctx) {
  const refund = await processing(ctx);
  return refund.id;
}

const serviceConfig = () => ({
  systemUserId: adminId,
  refundWindowMs: 90 * 24 * 60 * 60 * 1000,
  autoApproveLimits: { USD: '10.00' },
});

const inRange = () => [instant('2000-01-01T00:00:00Z'), instant('2100-01-01T00:00:00Z')] as const;

export const refundsArea = area<Ctx>({
  area: 'refunds',
  async open() {
    const { db, client } = await openDb();
    const writes = typed.refunds.writes(runnerOn(db));
    const repo = new RefundRepository(db, refundsTables);
    const service = refundServiceOf(repo, writes, new PaymentRepository(db, core), serviceConfig());
    return {
      db,
      client,
      coreWrites: typed.core.writes(runnerOn(db)),
      writes,
      repo,
      service,
      last: { refundId: orThrow(createRefundId()), paymentId: 'pay_unset' },
    };
  },
  close: ctx => ctx.client.close(),
  exempt: {},
  cases: [
    // ------------------------------------------------------------ primitives, tables
    op('refunds/primitives.ts::createRefundId', {
      arrange: noArgs,
      call: () => createRefundId(),
      valid: result => expect(String(result)).toMatch(/^rfnd/),
    }),
    op('refunds/tables.ts::createRefundsTables', {
      arrange: () =>
        args({
          schema,
          paymentIdRef: () => core.payments.id,
          userIdRef: () => users.id,
        }),
      call: (_ctx, deps) => createRefundsTables(deps),
      valid: result => expect(result).toHaveProperty('refunds'),
      keep: {
        'args[0].schema': 'a dependency, not input',
        'args[0].paymentIdRef': 'a callback',
        'args[0].userIdRef': 'a callback',
      },
    }),
    // ------------------------------------------------------------ repository
    op('refunds/repository.ts::refundAmountOf', {
      arrange: () => args({ refundAmountMinor: 1000, currency: 'USD' }),
      call: (_ctx, refund) => refundAmountOf(refund),
      valid: result => expect(String(result)).toContain('10'),
    }),
    op('refunds/repository.ts::createRefundRepository', {
      arrange: ctx => args(ctx.db, { refunds: refundsTables.refunds }),
      call: (_ctx, db, tables) => createRefundRepository(db, tables),
      valid: result => expect(result).toBeInstanceOf(RefundRepository),
      keep: { 'args[0]': 'the database, a dependency' },
    }),
    op('refunds/repository.ts::RefundRepository', {
      arrange: ctx => args(ctx.db, { refunds: refundsTables.refunds }),
      call: (_ctx, db, tables) => new RefundRepository(db, tables),
      valid: result => expect(result).toBeInstanceOf(RefundRepository),
      keep: { 'args[0]': 'the database, a dependency' },
    }),
    op('refunds/repository.ts::RefundRepository.findById', {
      arrange: async ctx => args(await pendingId(ctx)),
      call: (ctx, id) => ctx.repo.findById(id),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'pending' }),
    }),
    op('refunds/repository.ts::RefundRepository.findByProviderRefundId', {
      arrange: async ctx => {
        const refund = await completed(ctx);
        return args(refund.providerRefundId ?? 'missing');
      },
      call: (ctx, providerRefundId) => ctx.repo.findByProviderRefundId(providerRefundId),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'completed' }),
    }),
    op('refunds/repository.ts::RefundRepository.findByPaymentId', {
      arrange: async ctx => args(await pendingPaymentId(ctx)),
      call: (ctx, paymentId) => ctx.repo.findByPaymentId(paymentId),
      valid: (result, ctx) => expect(result).toMatchObject([{ id: ctx.last.refundId }]),
    }),
    op('refunds/repository.ts::RefundRepository.findByStatus', {
      arrange: async ctx => {
        await pending(ctx);
        return args('pending' as const);
      },
      call: (ctx, status) => ctx.repo.findByStatus(status),
      valid: (result, ctx) =>
        expect(Array.isArray(result) && result.some(row => row.id === ctx.last.refundId)).toBe(true),
    }),
    op('refunds/repository.ts::RefundRepository.findPending', {
      arrange: ctx => pending(ctx).then(noArgs),
      call: (ctx, ..._none) => ctx.repo.findPending(),
      valid: (result, ctx) =>
        expect(Array.isArray(result) && result.some(row => row.id === ctx.last.refundId)).toBe(true),
    }),
    op('refunds/repository.ts::RefundRepository.findByUser', {
      arrange: async ctx => {
        await pending(ctx);
        return args(userId);
      },
      call: (ctx, user) => ctx.repo.findByUser(user),
      valid: (result, ctx) =>
        expect(Array.isArray(result) && result.some(row => row.id === ctx.last.refundId)).toBe(true),
    }),
    op('refunds/repository.ts::RefundRepository.getTotalRefundedAmount', {
      arrange: async ctx => {
        const refund = await completed(ctx);
        return args(refund.paymentId, 'USD');
      },
      call: (ctx, paymentId, currency) => ctx.repo.getTotalRefundedAmount(paymentId, currency),
      valid: result => expect(String(result)).toBe('10.00 USD'),
    }),
    op('refunds/repository.ts::RefundRepository.getRefundMetrics', {
      arrange: async ctx => {
        await pending(ctx);
        const [from, to] = inRange();
        return args(from, to);
      },
      call: (ctx, from, to) => ctx.repo.getRefundMetrics(from, to),
      valid: result => expect(result).toMatchObject({ totalCount: expect.any(Number) }),
    }),
    op('refunds/repository.ts::RefundRepository.getAverageProcessingTime', {
      arrange: ctx => completed(ctx).then(noArgs),
      call: (ctx, ..._none) => ctx.repo.getAverageProcessingTime(),
      valid: result => expect(result).toBeGreaterThanOrEqual(0),
    }),
    op('refunds/repository.ts::RefundRepository.searchRefunds', {
      arrange: async ctx => {
        await pending(ctx);
        const [startDate, endDate] = inRange();
        return args({
          status: 'pending' as const,
          reason: 'customer_request' as const,
          userId,
          startDate,
          endDate,
          minAmount: money('1', 'USD'),
          maxAmount: money('100', 'USD'),
        });
      },
      call: (ctx, filters) => ctx.repo.searchRefunds(filters),
      valid: (result, ctx) =>
        expect(Array.isArray(result) && result.some(row => row.id === ctx.last.refundId)).toBe(true),
    }),
    // ------------------------------------------------------------ service
    op('refunds/service.ts::createRefundService', {
      arrange: ctx =>
        args(
          ctx.db,
          { refunds: refundsTables.refunds },
          ctx.writes,
          new PaymentRepository(ctx.db, core),
          serviceConfig(),
        ),
      call: (_ctx, db, tables, writes, payments, config) => createRefundService(db, tables, writes, payments, config),
      valid: result => expect(result).toBeInstanceOf(RefundService),
      keep: {
        'args[0]': 'the database, a dependency',
        'args[2]': 'the refund writes, a dependency of functions',
      },
    }),
    op('refunds/service.ts::RefundService.create', {
      arrange: ctx => args(ctx.repo, ctx.writes, coreReads(ctx.db), serviceConfig()),
      call: (_ctx, refunds, writes, payments, config) => RefundService.create(refunds, writes, payments, config),
      valid: result => expect(result).toBeInstanceOf(RefundService),
      keep: {
        'args[1]': 'the refund writes, a dependency of functions',
        'args[2]': 'the payment reads, a dependency of functions',
      },
    }),
    op('refunds/service.ts::RefundService.requestRefund', {
      arrange: async ctx => {
        const payment = await seedPayment(ctx.coreWrites, null, '100');
        ctx.last = { refundId: ctx.last.refundId, paymentId: payment.id };
        return args({
          paymentId: payment.id,
          amount: money('40', 'USD'),
          reason: 'customer_request' as const,
          customerNote: 'please',
          internalNotes: 'checked',
          requestedBy: userId,
        });
      },
      call: (ctx, data) => ctx.service.requestRefund(data),
      valid: (result, ctx) =>
        expect(result).toMatchObject({ status: 'pending', paymentId: ctx.last.paymentId, refundAmountMinor: 4000 }),
    }),
    op('refunds/service.ts::RefundService.approveRefund', {
      arrange: async ctx => args({ refundId: await pendingId(ctx), approvedBy: adminId, notes: 'fine' }),
      call: (ctx, data) => ctx.service.approveRefund(data),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'approved' }),
    }),
    op('refunds/service.ts::RefundService.rejectRefund', {
      arrange: async ctx => args({ refundId: await pendingId(ctx), rejectedBy: adminId, reason: 'Not eligible' }),
      call: (ctx, data) => ctx.service.rejectRefund(data),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'rejected' }),
    }),
    op('refunds/service.ts::RefundService.getRefundMetrics', {
      arrange: async ctx => {
        await pending(ctx);
        const [from, to] = inRange();
        return args(from, to);
      },
      call: (ctx, from, to) => ctx.service.getRefundMetrics(from, to),
      valid: result => expect(result).toMatchObject({ totalCount: expect.any(Number) }),
    }),
    op('refunds/service.ts::RefundService.getAverageProcessingTime', {
      arrange: ctx => completed(ctx).then(noArgs),
      call: (ctx, ..._none) => ctx.service.getAverageProcessingTime(),
      valid: result => expect(result).toBeGreaterThanOrEqual(0),
    }),
    op('refunds/service.ts::RefundService.searchRefunds', {
      arrange: async ctx => {
        await pending(ctx);
        const [startDate, endDate] = inRange();
        return args({ status: 'pending' as const, reason: 'customer_request' as const, userId, startDate, endDate });
      },
      call: (ctx, filters) => ctx.service.searchRefunds(filters),
      valid: (result, ctx) =>
        expect(Array.isArray(result) && result.some(row => row.id === ctx.last.refundId)).toBe(true),
    }),
    // ------------------------------------------------------------ journal
    op('refunds/journal.ts::createRefundsJournal', {
      arrange: () => {
        const { j } = freshJournal();
        return args(j, { refunds: refundsTables.refunds, payments: core.payments });
      },
      call: (_ctx, j, tables) => createRefundsJournal(j, tables),
      valid: result => expect(result).toHaveProperty('commands.requestRefund'),
      surface: true,
      keep: { 'args[0]': 'the journal definitions, a dependency of functions' },
    }),
    op('refunds/journal.ts::createRefundsJournal().writes', {
      arrange: ctx => args(runnerOn(ctx.db)),
      call: (_ctx, run) => typed.refunds.writes(run),
      valid: result => expect(result).toHaveProperty('requestRefund'),
      surface: true,
    }),
    op('refunds/journal.ts::createRefundsJournal().writes().requestRefund', {
      arrange: async ctx => {
        const payment = await seedPayment(ctx.coreWrites, null, '25');
        return args({
          refundId: orThrow(createRefundId()),
          paymentId: payment.id,
          originalAmount: usd('25'),
          refundAmount: usd('10'),
          reason: 'customer_request' as const,
          customerNote: 'please',
          internalNotes: 'checked',
          requestedBy: userId,
          metadata: '{"a":1}',
        });
      },
      call: (ctx, input) => ctx.writes.requestRefund(input),
      valid: result => expect(result).toMatchObject({ status: 'pending', refundAmountMinor: 1000 }),
    }),
    op('refunds/journal.ts::createRefundsJournal().writes().approveRefund', {
      arrange: async ctx => args({ refundId: await pendingId(ctx), approvedBy: adminId, notes: 'fine' }),
      call: (ctx, input) => ctx.writes.approveRefund(input),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'approved' }),
    }),
    op('refunds/journal.ts::createRefundsJournal().writes().rejectRefund', {
      arrange: async ctx =>
        args({ refundId: await pendingId(ctx), rejectedBy: adminId, rejectionReason: 'Not eligible' }),
      call: (ctx, input) => ctx.writes.rejectRefund(input),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'rejected' }),
    }),
    op('refunds/journal.ts::createRefundsJournal().writes().processRefund', {
      arrange: async ctx => args({ refundId: await approvedId(ctx) }),
      call: (ctx, input) => ctx.writes.processRefund(input),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'processing' }),
    }),
    op('refunds/journal.ts::createRefundsJournal().writes().completeRefund', {
      arrange: async ctx => {
        counter += 1;
        return args({
          refundId: await processingId(ctx),
          providerRefundId: `re_fuzz_c${counter}`,
          providerResponse: '{"ok":true}',
        });
      },
      call: (ctx, input) => ctx.writes.completeRefund(input),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'completed' }),
    }),
    op('refunds/journal.ts::createRefundsJournal().writes().failRefund', {
      arrange: async ctx => args({ refundId: await processingId(ctx), errorMessage: 'card closed' }),
      call: (ctx, input) => ctx.writes.failRefund(input),
      valid: (result, ctx) => expect(result).toMatchObject({ id: ctx.last.refundId, status: 'failed' }),
    }),
    // ------------------------------------------------------------ effects, workflow
    op('refunds/effects.ts::createRefundEffects', {
      arrange: () => {
        const { j, refunds } = freshJournal();
        return args(j, refunds);
      },
      call: (_ctx, j, refunds) => createRefundEffects(j, refunds),
      valid: result => expect(result).toHaveLength(2),
      keep: {
        'args[0]': 'the journal definitions, a dependency of functions',
        'args[1]': 'the refunds journal, a dependency of functions',
      },
    }),
    op('refunds/workflow.ts::createRefundWorkflow', {
      arrange: () => {
        const { j, refunds } = freshJournal();
        return args(j, refunds);
      },
      call: (_ctx, j, refunds) => createRefundWorkflow(j, refunds),
      valid: result => expect(result).toBeTruthy(),
      keep: {
        'args[0]': 'the journal definitions, a dependency of functions',
        'args[1]': 'the refunds journal, a dependency of functions',
      },
    }),
    op('refunds/workflow.ts::refundRunId', {
      arrange: () => args(orThrow(createRefundId())),
      call: (_ctx, refundId) => refundRunId(refundId),
      valid: result => expect(result).toMatch(/^refund:rfnd/),
    }),
  ],
});
