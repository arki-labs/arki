/**
 * Test fixture, not shipped: a Foreman handler on the admin dispatcher with fresh keys, so a test can
 * drive a module over the real signed protocol and read the HTTP status of each answer.
 */
import type { ForemanModule } from '@arki/admin/module';
import type { ReceiptStore, StoredReceipt } from '@arki/admin/receipts';
import { createForemanClient, generateForemanKeyPair } from '@arki/admin/client';
import { withCoreModules } from '@arki/admin/core';
import { describeModule } from '@arki/admin/module';
import { receiptAnswerSchema } from '@arki/admin/receipts';
import { createForemanHandler } from '@arki/admin/server';

const AUD = 'journal-test:prod';

export type NoContext = Record<string, never>;

/** A nonce store that remembers every key it saw. */
function memoryNonces() {
  const seen = new Set<string>();
  return {
    setIfNotExists(key: string): Promise<boolean> {
      if (seen.has(key)) return Promise.resolve(false);
      seen.add(key);
      return Promise.resolve(true);
    },
  };
}

/** A receipt store in memory, for tests that are not about receipts. */
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

export async function foremanHarness(
  module: ForemanModule<NoContext>,
  options: { receipts?: ReceiptStore; loseExecuteAnswers?: boolean } = {},
) {
  const [readPair, executePair, appPair] = await Promise.all([
    generateForemanKeyPair(),
    generateForemanKeyPair(),
    generateForemanKeyPair(),
  ]);
  const receipts = options.receipts ?? memoryReceipts();
  const description = await describeModule(module);
  const hashes = new Map(description.actions.map(action => [action.id, action.schemaHash]));
  const handler = createForemanHandler<NoContext>({
    identity: { aud: AUD, privateKey: appPair.privateKey },
    keys: { read: { current: readPair.publicKey }, execute: { current: executePair.publicKey } },
    writes: 'on',
    nonces: memoryNonces(),
    receipts,
    modules: withCoreModules<NoContext>({
      app: { id: 'journal-test', environment: 'prod', version: '1.0.0' },
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
    target: { aud: AUD, baseUrl: 'https://journal-test.test', appKey: appPair.publicKey },
    readKey: readPair.privateKey,
    executeKey: executePair.privateKey,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const response = await handler(request);
      statuses.push(response.status);
      if (options.loseExecuteAnswers === true && new URL(request.url).pathname.endsWith('/execute')) {
        throw new TypeError('socket hang up');
      }
      return response;
    },
  });
  return {
    client,
    /** The HTTP status of the latest answer. */
    lastStatus: () => statuses.at(-1),
    permit: (executionId: string, actionId: string, expectedRevision: string) => ({
      executionId,
      expectedRevision,
      approvedBy: 'usr_alex',
      schemaHash: hashes.get(actionId) ?? '',
    }),
    receiptOf: async (executionId: string) =>
      receiptAnswerSchema.parse(await client.read('core.receipts.get', { executionId }, ['core:read'])),
  };
}
