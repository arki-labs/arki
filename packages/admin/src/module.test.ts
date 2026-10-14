import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import type { AdminErrorCode, ModuleDescription, Permit } from './module';
import {
  ADMIN_ERROR_CODES,
  AdminError,
  canonicalJson,
  defineAction,
  defineModule,
  defineRead,
  defineSignal,
  describeModule,
  moduleDescriptionSchema,
  schemaHash,
} from './module';

type Ctx = { tenant: string };

const failedJob = z.object({ id: z.string(), queue: z.string(), attempts: z.number().int() });

function buildModule(overrides: { retrySummary?: string; retryRisk?: 'low' | 'high' } = {}) {
  const jobs = [{ id: 'job_1', queue: 'mail', attempts: 3, secret: 'smtp-password' }];
  const writes: { jobId: string; permit: Permit; tenant: string }[] = [];

  const failedJobs = defineRead({
    id: 'queue.failedJobs',
    summary: 'Failed jobs, newest first',
    permission: 'queue:read',
    input: z.object({ queue: z.string().optional(), limit: z.number().int().max(200).default(50) }),
    output: z.array(failedJob),
    load: async ({ queue, limit }, _ctx: Ctx) => jobs.filter(job => !queue || job.queue === queue).slice(0, limit),
  });

  const retryJob = defineAction({
    id: 'queue.retryJob',
    summary: overrides.retrySummary ?? 'Retry one failed job',
    permission: 'queue:write',
    risk: overrides.retryRisk ?? 'low',
    input: z.object({ jobId: z.string().min(1) }),
    previewOutput: z.object({ revision: z.string(), jobId: z.string(), consequence: z.string() }),
    output: z.object({ requeued: z.boolean() }),
    preview: async ({ jobId }, _ctx: Ctx) => ({ revision: 'rev_3', jobId, consequence: 'Job goes back to the queue.' }),
    execute: async ({ jobId }, ctx: Ctx, permit) => {
      writes.push({ jobId, permit, tenant: ctx.tenant });
      return { requeued: true };
    },
  });

  const module = defineModule({
    id: '@arki/queue',
    version: '1.0.0',
    reads: { failedJobs },
    actions: { retryJob },
    signals: [defineSignal({ id: 'job.failed', summary: 'A job exhausted retries', payload: failedJob })],
    panels: [{ id: 'failed-jobs', renderer: 'arki.queue.failed-jobs', read: 'failedJobs', actions: ['retryJob'] }],
  });
  return { module, writes };
}

async function expectAdminError(promise: Promise<unknown>, code: AdminErrorCode): Promise<AdminError> {
  const error: unknown = await promise.then(
    () => null,
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(AdminError);
  if (!(error instanceof AdminError)) throw new Error('unreachable');
  expect(error.code).toBe(code);
  return error;
}

function expectDefinitionError(define: () => unknown, code: AdminErrorCode): void {
  expect(define).toThrow(AdminError);
  try {
    define();
  } catch (error) {
    if (error instanceof AdminError) expect(error.code).toBe(code);
  }
}

describe('describeModule — the JSON contract Foreman reads from every app', () => {
  it('round-trips through the wire: JSON text parses back into an identical, valid description', async () => {
    const { module } = buildModule();
    const description = await describeModule(module);

    const wireText = JSON.stringify(description);
    const overTheWire: unknown = JSON.parse(wireText);
    const parsed: ModuleDescription = moduleDescriptionSchema.parse(overTheWire);

    expect(parsed).toEqual(description);
    expect(parsed.reads.map(read => read.key)).toEqual(['failedJobs']);
    expect(parsed.actions[0]).toMatchObject({ id: 'queue.retryJob', risk: 'low', maxTargets: 1 });
    expect(parsed.panels).toEqual([
      { id: 'failed-jobs', renderer: 'arki.queue.failed-jobs', read: 'failedJobs', actions: ['retryJob'] },
    ]);
  });

  it('publishes JSON Schemas that accept and reject the same input as the Zod schema (Foreman builds forms from them)', async () => {
    const { module } = buildModule();
    const description = await describeModule(module);
    const [read] = description.reads;
    if (read === undefined) throw new Error('expected one read');

    const rebuilt = z.fromJSONSchema(read.input);
    const samples: unknown[] = [{}, { queue: 'mail' }, { limit: 10 }, { limit: 500 }, { limit: 'ten' }, { queue: 4 }];
    for (const sample of samples) {
      expect(rebuilt.safeParse(sample).success, JSON.stringify(sample)).toBe(
        module.reads.failedJobs.input.safeParse(sample).success,
      );
    }
    // `limit` has a default, so the input schema must not require it — callers may omit it.
    expect(read.input['required']).toBeUndefined();
  });

  it('keeps hashes when only a summary changes, so rewording never voids a pinned approval', async () => {
    const before = await describeModule(buildModule().module);
    const after = await describeModule(buildModule({ retrySummary: 'Requeue a failed job' }).module);
    expect(after.actions[0]?.schemaHash).toBe(before.actions[0]?.schemaHash);
  });

  it('changes the hash when the contract changes, so an approval pinned to a low-risk action cannot run a high-risk one', async () => {
    const low = await describeModule(buildModule({ retryRisk: 'low' }).module);
    const high = await describeModule(buildModule({ retryRisk: 'high' }).module);
    expect(high.actions[0]?.schemaHash).not.toBe(low.actions[0]?.schemaHash);
    expect(high.reads[0]?.schemaHash).toBe(low.reads[0]?.schemaHash);
  });
});

describe('schemaHash', () => {
  it('is SHA-256 over canonical JSON, independent of key order', async () => {
    const hash = await schemaHash({ b: [1, { d: null, c: true }], a: 'x' });
    expect(canonicalJson({ b: [1, { d: null, c: true }], a: 'x' })).toBe('{"a":"x","b":[1,{"c":true,"d":null}]}');
    expect(hash).toBe(`sha256:${createHash('sha256').update('{"a":"x","b":[1,{"c":true,"d":null}]}').digest('hex')}`);
    expect(await schemaHash({ a: 'x', b: [1, { c: true, d: null }] })).toBe(hash);
  });
});

describe('run / runPreview / runExecute — the dispatcher calls these, never load/preview/execute directly', () => {
  it('validates input and strips undeclared output keys, so an app cannot leak fields it did not declare', async () => {
    const { module } = buildModule();
    const jobs = await module.reads.failedJobs.run({ queue: 'mail' }, { tenant: 't1' });
    expect(jobs).toEqual([{ id: 'job_1', queue: 'mail', attempts: 3 }]);
    expect(JSON.stringify(jobs)).not.toContain('smtp-password');
  });

  it('rejects bad input with a coded error before any app code runs', async () => {
    const { module, writes } = buildModule();
    await expectAdminError(
      module.actions.retryJob.runExecute(
        { jobId: '' },
        { tenant: 't1' },
        { executionId: 'exe_1', expectedRevision: 'rev_3', approvedBy: 'usr_1' },
      ),
      ADMIN_ERROR_CODES.invalidInput,
    );
    expect(writes).toEqual([]);
  });

  it('hands the approved permit and context to execute', async () => {
    const { module, writes } = buildModule();
    const permit: Permit = { executionId: 'exe_1', expectedRevision: 'rev_3', approvedBy: 'usr_1' };
    await expect(module.actions.retryJob.runExecute({ jobId: 'job_1' }, { tenant: 't1' }, permit)).resolves.toEqual({
      requeued: true,
    });
    expect(writes).toEqual([{ jobId: 'job_1', permit, tenant: 't1' }]);
  });

  it('returns the preview revision that the approval pins', async () => {
    const { module } = buildModule();
    const preview = await module.actions.retryJob.runPreview({ jobId: 'job_1' }, { tenant: 't1' });
    expect(preview.revision).toBe('rev_3');
  });

  it('fails loud when app code returns data its own schema rejects', async () => {
    const broken = defineRead({
      id: 'queue.depth',
      summary: 'Queue depth',
      permission: 'queue:read',
      input: z.object({}),
      output: z.number().int(),
      load: async () => 1.5,
    });
    const error = await expectAdminError(broken.run({}, {}), ADMIN_ERROR_CODES.invalidOutput);
    expect(error.message).toContain('queue.depth');
  });
});

describe('definition checks — mistakes surface when the module loads, not when an operator clicks', () => {
  const input = z.object({});
  const output = z.object({ ok: z.boolean() });
  const load = async () => ({ ok: true });

  it('rejects malformed permissions and ids', () => {
    expectDefinitionError(
      () => defineRead({ id: 'queue.depth', summary: 'x', permission: 'Queue:', input, output, load }),
      ADMIN_ERROR_CODES.invalidDefinition,
    );
    expectDefinitionError(
      () => defineRead({ id: 'queue depth', summary: 'x', permission: 'queue:read', input, output, load }),
      ADMIN_ERROR_CODES.invalidDefinition,
    );
  });

  it('caps targets per proposal at five', () => {
    expectDefinitionError(
      () =>
        defineAction({
          id: 'queue.purge',
          summary: 'Purge',
          permission: 'queue:write',
          risk: 'high',
          maxTargets: 6,
          input,
          previewOutput: z.object({ revision: z.string() }),
          output,
          preview: async () => ({ revision: 'r' }),
          execute: load,
        }),
      ADMIN_ERROR_CODES.invalidDefinition,
    );
  });

  it('rejects schemas that cannot cross the wire as JSON Schema', () => {
    expectDefinitionError(
      () =>
        defineRead({
          id: 'queue.oldest',
          summary: 'Oldest job time',
          permission: 'queue:read',
          input,
          output: z.date(),
          load: async () => new Date(),
        }),
      ADMIN_ERROR_CODES.invalidDefinition,
    );
  });

  it('rejects duplicate ids, unknown panel references and bad versions', () => {
    const a = defineRead({ id: 'queue.depth', summary: 'x', permission: 'queue:read', input, output, load });
    const b = defineRead({ id: 'queue.depth', summary: 'y', permission: 'queue:read', input, output, load });
    expectDefinitionError(
      () => defineModule({ id: '@arki/queue', version: '1.0.0', reads: { a, b }, actions: {} }),
      ADMIN_ERROR_CODES.duplicateId,
    );
    const reads: Record<string, typeof a> = { a };
    expectDefinitionError(
      () =>
        defineModule({
          id: '@arki/queue',
          version: '1.0.0',
          reads,
          actions: {},
          panels: [{ id: 'depth', renderer: 'arki.queue.depth', read: 'missing', actions: [] }],
        }),
      ADMIN_ERROR_CODES.unknownReference,
    );
    expectDefinitionError(
      () => defineModule({ id: '@arki/queue', version: 'v1', reads: { a }, actions: {} }),
      ADMIN_ERROR_CODES.invalidDefinition,
    );
  });
});

describe('toDotAction — `dot explain` lists the same capabilities Foreman sees', () => {
  it('projects every read and action with binding "foreman"', () => {
    const { module } = buildModule();
    const actions = module.toDotActions();
    expect(actions.map(action => [action.id, action.binding, action.address])).toEqual([
      ['queue.failedJobs', 'foreman', 'read queue.failedJobs'],
      ['queue.retryJob', 'foreman', 'action queue.retryJob'],
    ]);
    expect(actions[1]?.meta).toMatchObject({ kind: 'action', permission: 'queue:write', risk: 'low', maxTargets: 1 });
    expect(actions[1]?.meta['previewOutput']).toEqual(module.actions.retryJob.jsonSchema.previewOutput);
  });
});
