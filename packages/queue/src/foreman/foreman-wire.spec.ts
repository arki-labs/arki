/**
 * T(queue-foreman-wire): the queue module over the signed Foreman protocol. Why it matters: a stale
 * approval is the operator's cue to preview again, so it must answer 409 with its own code, not a 500.
 */
import { describe, expect, it } from 'vitest';

import type { ReceiptStore, StoredReceipt } from '@arki/admin/receipts';
import { createForemanClient, generateForemanKeyPair } from '@arki/admin/client';
import { withCoreModules } from '@arki/admin/core';
import { AdminModuleRefused, describeModule } from '@arki/admin/module';
import { createForemanHandler } from '@arki/admin/server';

import type { FailedJobRecord, FailedJobSource } from './index.ts';
import { QUEUE_FOREMAN_ERROR_CODES, queueForemanModule } from './index.ts';

const AUD = 'queue-test:prod';

function memoryReceipts(): ReceiptStore {
  const receipts = new Map<string, StoredReceipt>();
  return {
    claim(pending) {
      const held = receipts.get(pending.executionId);
      if (held !== undefined) return Promise.resolve({ claimed: false, receipt: held });
      receipts.set(pending.executionId, pending);
      return Promise.resolve({ claimed: true });
    },
    settle(settled) {
      receipts.set(settled.executionId, settled);
      return Promise.resolve();
    },
    get: executionId => Promise.resolve(receipts.get(executionId)),
  };
}

describe('T(queue-foreman-wire)', () => {
  it('a stale queue approval answers HTTP 409 with ARKI_QUEUE_E014, and an unknown queue answers 404 with E016', async () => {
    let record: FailedJobRecord = {
      id: 'job_1',
      name: 'send-mail',
      attempts: 3,
      error: null,
      failedAt: new Date(),
      revision: 'r1',
    };
    const source: FailedJobSource = {
      listFailed: () => Promise.resolve({ jobs: [record], total: 1 }),
      getFailed: () => Promise.resolve(record),
      retryFailed: () => Promise.resolve(true),
    };
    const module = queueForemanModule({ queues: { main: source } });
    const [readPair, executePair, appPair] = await Promise.all([
      generateForemanKeyPair(),
      generateForemanKeyPair(),
      generateForemanKeyPair(),
    ]);
    const described = await describeModule(module);
    const hashes = new Map(described.actions.map(action => [action.id, action.schemaHash]));
    const receipts = memoryReceipts();
    const seen = new Set<string>();
    const handler = createForemanHandler<Record<string, never>>({
      identity: { aud: AUD, privateKey: appPair.privateKey },
      keys: { read: { current: readPair.publicKey }, execute: { current: executePair.publicKey } },
      writes: 'on',
      nonces: {
        setIfNotExists: key => {
          const fresh = !seen.has(key);
          seen.add(key);
          return Promise.resolve(fresh);
        },
      },
      receipts,
      modules: withCoreModules<Record<string, never>>({
        app: { id: 'queue-test', environment: 'prod', version: '1.0.0' },
        writes: 'on',
        health: () => ({ status: 'ok', checks: [] }),
        receipts,
        modules: [module],
      }),
      context: () => ({}),
      app: { version: '1.0.0' },
    });
    const statuses: number[] = [];
    const client = createForemanClient({
      target: { aud: AUD, baseUrl: 'https://queue-test.test', appKey: appPair.publicKey },
      readKey: readPair.privateKey,
      executeKey: executePair.privateKey,
      fetch: async (input, init) => {
        const response = await handler(new Request(input, init));
        statuses.push(response.status);
        return response;
      },
    });
    const claim = (executionId: string, expectedRevision: string) => ({
      executionId,
      expectedRevision,
      approvedBy: 'usr_1',
      schemaHash: hashes.get('queue.retryJob') ?? '',
    });

    // The job failed again after the operator saw revision r1.
    record = { ...record, revision: 'r2' };
    await expect(
      client.execute(
        'queue.retryJob',
        { queue: 'main', jobId: 'job_1' },
        { scopes: ['queue:write'], permit: claim('exe_1', 'r1') },
      ),
    ).resolves.toMatchObject({
      code: AdminModuleRefused.code,
      data: { code: QUEUE_FOREMAN_ERROR_CODES.staleRevision, httpStatus: 409 },
    });
    expect(statuses.at(-1)).toBe(409);

    await expect(
      client.preview('queue.retryJob', { queue: 'nope', jobId: 'job_1' }, ['queue:write']),
    ).resolves.toMatchObject({
      code: AdminModuleRefused.code,
      data: { code: QUEUE_FOREMAN_ERROR_CODES.unknownQueue, httpStatus: 404 },
    });
    expect(statuses.at(-1)).toBe(404);
  });
});
