import { describe, expectTypeOf, it } from 'vitest';

import type { ActionSource } from '@arki/dot/plugin';
import { z } from '@arki/contracts';

import type { ForemanDotAction, ForemanModule, Permit } from './module';
import { defineAction, defineModule, defineRead, describeModule } from './module';

type Ctx = { tenant: string };

const failedJobs = defineRead({
  id: 'queue.failedJobs',
  summary: 'Failed jobs',
  permission: 'queue:read',
  input: z.object({ queue: z.string().optional(), limit: z.number().default(50) }),
  output: z.array(z.object({ id: z.string() })),
  load: async (input, ctx: Ctx) => {
    // Defaults are applied before load runs: `limit` is always a number here.
    expectTypeOf(input).toEqualTypeOf<{ queue?: string | undefined; limit: number }>();
    expectTypeOf(ctx).toEqualTypeOf<Ctx>();
    return [{ id: 'job_1' }];
  },
});

const retryJob = defineAction({
  id: 'queue.retryJob',
  summary: 'Retry',
  permission: 'queue:write',
  risk: 'low',
  input: z.object({ jobId: z.string() }),
  previewOutput: z.object({ revision: z.string(), jobId: z.string() }),
  output: z.object({ requeued: z.boolean() }),
  preview: async ({ jobId }) => ({ revision: 'r1', jobId }),
  execute: async (input, ctx: Ctx, permit) => {
    expectTypeOf(input).toEqualTypeOf<{ jobId: string }>();
    expectTypeOf(permit).toEqualTypeOf<Permit>();
    return { requeued: ctx.tenant.length > 0 };
  },
});

describe('module contract types', () => {
  it('infers the context from the definitions and keeps per-key types', () => {
    const module = defineModule({ id: '@arki/queue', version: '1.0.0', reads: { failedJobs }, actions: { retryJob } });
    expectTypeOf(module).toExtend<ForemanModule<Ctx>>();
    expectTypeOf(module.reads.failedJobs.run).returns.resolves.toEqualTypeOf<{ id: string }[]>();
    expectTypeOf(module.actions.retryJob.runPreview).returns.resolves.toEqualTypeOf<{
      revision: string;
      jobId: string;
    }>();
    expectTypeOf(module.actions.retryJob.runExecute).parameter(1).toEqualTypeOf<Ctx>();
    expectTypeOf(describeModule).parameter(0).toExtend<object>();
    expectTypeOf(module).toExtend<Parameters<typeof describeModule>[0]>();
  });

  it('is an ActionSource for @arki/dot plugin and feature `actions`', () => {
    expectTypeOf<ForemanDotAction>().toExtend<ActionSource>();
    expectTypeOf(failedJobs).toExtend<ActionSource>();
    expectTypeOf(retryJob).toExtend<ActionSource>();
  });

  it('rejects contract violations at compile time', () => {
    // Type-level only: never called, because the runtime checks would (rightly) throw too.
    const violations = () => {
      defineAction({
        id: 'queue.purge',
        summary: 'Purge',
        permission: 'queue:write',
        risk: 'high',
        input: z.object({}),
        // @ts-expect-error — a preview must output a `revision` string.
        previewOutput: z.object({ count: z.number() }),
        output: z.object({}),
        preview: async () => ({ count: 1 }),
        execute: async () => ({}),
      });

      defineAction({
        id: 'queue.purge',
        summary: 'Purge',
        permission: 'queue:write',
        // @ts-expect-error — `read` is the risk class of reads only.
        risk: 'read',
        input: z.object({}),
        previewOutput: z.object({ revision: z.string() }),
        output: z.object({}),
        preview: async () => ({ revision: 'r' }),
        execute: async () => ({}),
      });

      defineRead({
        id: 'queue.depth',
        summary: 'Depth',
        // @ts-expect-error — permissions are `area:verb`.
        permission: 'queue',
        input: z.object({}),
        output: z.number(),
        load: async () => 1,
      });

      defineModule({
        id: '@arki/queue',
        version: '1.0.0',
        reads: { failedJobs },
        actions: { retryJob },
        // @ts-expect-error — panels may only name reads the module defines.
        panels: [{ id: 'jobs', renderer: 'arki.queue.jobs', read: 'missing', actions: [] }],
      });

      const otherCtx = defineRead({
        id: 'billing.invoices',
        summary: 'Invoices',
        permission: 'billing:read',
        input: z.object({}),
        output: z.array(z.string()),
        load: async (_input, ctx: { stripe: string }) => [ctx.stripe],
      });
      // @ts-expect-error — every read and action of a module must accept the module's context.
      defineModule<Ctx>({ id: '@arki/queue', version: '1.0.0', reads: { failedJobs, otherCtx }, actions: {} });
    };
    expectTypeOf(violations).toBeFunction();
  });
});
