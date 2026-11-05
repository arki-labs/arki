// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`. A signed Foreman exchange runs in-process with no server and no
// database: a real Ed25519-signed client talks to the real handler through a fetch function.
// Entries: root and ./module, ./core, ./receipts, ./client, ./server (the signed exchange),
// ./http and ./env, ./panels, ./connections/coolify (pure helpers), ./pg (table definition),
// ./dot (loaded).

import { z } from 'zod';

import { isFailure } from '@arki/failure';

import { createForemanClient, generateForemanKeyPair } from '../dist/client.js';
import { parseWebhookHint, verifyWebhookSecret } from '../dist/connections/coolify/index.js';
import { withCoreModules } from '../dist/core.js';
import { foremanConfigFromEnv } from '../dist/env.js';
import { fleetSnapshotRoute } from '../dist/http.js';
import {
  ADMIN_ERROR_CODES,
  canonicalJson,
  defineAction,
  defineModule,
  defineRead,
  describeModule,
  redactSecrets,
  schemaHash,
} from '../dist/module.js';
import { boardOutputSchema } from '../dist/panels.js';
import { foremanStoreTable } from '../dist/pg.js';
import { kvReceiptStore } from '../dist/receipts.js';
import { createFleetHandler, createForemanHandler } from '../dist/server.js';

import '../dist/dot.js';
import '../dist/index.js';

const [readPair, executePair, appPair] = await Promise.all([
  generateForemanKeyPair(),
  generateForemanKeyPair(),
  generateForemanKeyPair(),
]);

const queueModule = defineModule({
  id: '@arki/queue',
  version: '1.0.0',
  reads: {
    failedJobs: defineRead({
      id: 'queue.failedJobs',
      summary: 'Failed jobs',
      permission: 'queue:read',
      input: z.object({ limit: z.number().int().default(10) }),
      output: z.array(z.object({ id: z.string() })),
      load: async ({ limit }) => [{ id: 'job_1' }].slice(0, limit),
    }),
  },
  actions: {
    retryJob: defineAction({
      id: 'queue.retryJob',
      summary: 'Retry one failed job',
      permission: 'queue:write',
      risk: 'low',
      input: z.object({ jobId: z.string().min(1) }),
      previewOutput: z.object({ revision: z.string(), jobId: z.string() }),
      output: z.object({ requeued: z.boolean() }),
      preview: async ({ jobId }) => ({ revision: 'rev_3', jobId }),
      execute: async () => ({ requeued: true }),
    }),
  },
});
const retryHash =
  (await describeModule(queueModule)).actions.find(action => action.id === 'queue.retryJob')?.schemaHash ?? '';

const store = new Map();
const kv = {
  get: async (key, schema) => {
    const value = store.get(key);
    if (value === undefined) return undefined;
    const parsed = schema['~standard'].validate(structuredClone(value));
    return (await parsed).value;
  },
  set: async (key, value) => void store.set(key, structuredClone(value)),
  setIfNotExists: async (key, value) => (store.has(key) ? false : (store.set(key, value), true)),
};
const nonces = new Set();
const receipts = kvReceiptStore(kv, { namespace: 'smoke:prod' });

const buildHandler = writes =>
  createForemanHandler({
    identity: { aud: 'smoke:prod', privateKey: appPair.privateKey },
    keys: { read: { current: readPair.publicKey }, execute: { current: executePair.publicKey } },
    writes,
    nonces: { setIfNotExists: async key => (nonces.has(key) ? false : (nonces.add(key), true)) },
    receipts,
    modules: withCoreModules({
      app: { id: 'smoke', environment: 'prod', version: '1.0.0' },
      writes,
      health: () => ({ status: 'ok', checks: [{ name: 'database', ok: true }] }),
      modules: [queueModule],
      receipts,
    }),
    context: () => ({}),
    app: { version: '1.0.0' },
  });

const clientFor = handler =>
  createForemanClient({
    target: { aud: 'smoke:prod', baseUrl: 'https://smoke.test', appKey: appPair.publicKey },
    readKey: readPair.privateKey,
    executeKey: executePair.privateKey,
    fetch: async (input, init) => handler(new Request(input, init)),
  });
const scopes = ['core:read', 'queue:*'];
const permit = { executionId: 'exe_1', expectedRevision: 'rev_3', approvedBy: 'usr_ada', schemaHash: retryHash };

const client = clientFor(buildHandler('on'));
const manifest = await client.manifest();
const health = await client.read('core.health.status', {}, scopes);
const failedJobs = await client.read('queue.failedJobs', { limit: 5 }, scopes);
const preview = await client.preview('queue.retryJob', { jobId: 'job_9' }, scopes);
const executed = await client.execute('queue.retryJob', { jobId: 'job_9' }, { scopes, permit });
const noScope = await client.read('queue.failedJobs', {}, ['core:read']);
const unknownRead = await client.read('queue.nothing', {}, scopes);
const writesOff = await clientFor(buildHandler('off')).execute(
  'queue.retryJob',
  { jobId: 'job_9' },
  { scopes, permit: { ...permit, executionId: 'exe_2' } },
);

const wrongKeyClient = createForemanClient({
  target: { aud: 'smoke:prod', baseUrl: 'https://smoke.test', appKey: appPair.publicKey },
  readKey: (await generateForemanKeyPair()).privateKey,
  fetch: async (input, init) => buildHandler('on')(new Request(input, init)),
});
const unauthenticated = await wrongKeyClient.manifest();

const fleet = createFleetHandler({
  token: 'secret-token',
  snapshot: () => ({ app: 'smoke', status: 'ok', checks: [], generatedAt: new Date().toISOString() }),
});
const fleetDenied = await fleet(new Request('https://smoke.test/fleet'));
const fleetNoToken = await createFleetHandler({ token: undefined, snapshot: () => ({}) })(
  new Request('https://smoke.test/fleet', { headers: { authorization: 'Bearer anything' } }),
);

const hint = parseWebhookHint({ event: 'deployment_finished', deployment_uuid: 'abcd-1234' }, new Date());
const badHint = parseWebhookHint('not an object', new Date());
const config = foremanConfigFromEnv(
  {
    FOREMAN_APP_ID: undefined,
    FOREMAN_APP_KEY: undefined,
    FOREMAN_READ_KEY: undefined,
    FOREMAN_EXECUTE_KEY: undefined,
  },
  'prod',
);

const checks = [
  [
    'manifest lists core and app modules',
    isFailure(manifest) ? manifest.code : manifest.modules.map(module => module.id).join(','),
    'core.health,core.manifest,core.receipts,@arki/queue',
  ],
  ['signed read answers', isFailure(health) ? health.code : health.status, 'ok'],
  ['signed read with input answers', isFailure(failedJobs) ? failedJobs.code : failedJobs[0]?.id, 'job_1'],
  ['preview returns the revision', isFailure(preview) ? preview.code : preview.revision, 'rev_3'],
  ['approved execute runs once', isFailure(executed) ? executed.code : executed.requeued, true],
  ['a read without the scope is refused', isFailure(noScope) ? noScope.code : 'answered', 'admin.scope_denied'],
  [
    'an unknown capability is refused',
    isFailure(unknownRead) ? unknownRead.code : 'answered',
    'admin.unknown_capability',
  ],
  ['execute with writes off is refused', isFailure(writesOff) ? writesOff.code : 'answered', 'admin.writes_disabled'],
  [
    'a request signed with the wrong key is unauthenticated',
    isFailure(unauthenticated) ? unauthenticated.code : 'answered',
    'admin.unauthenticated',
  ],
  ['fleet handler refuses a missing token', fleetDenied.status, 401],
  ['fleet handler with no configured token refuses everyone', fleetNoToken.status, 401],
  ['fleet snapshot route is declared', typeof fleetSnapshotRoute, 'object'],
  [
    'coolify hint names the deployment',
    isFailure(hint) ? hint.code : `${hint.kind}:${hint.resourceUuid}`,
    'deployment:abcd-1234',
  ],
  [
    'coolify refuses a body that is not an object',
    isFailure(badHint) ? badHint.code : 'answered',
    'admin.invalid_request',
  ],
  [
    'webhook secret compares in constant time',
    `${verifyWebhookSecret('a', 'a')}/${verifyWebhookSecret('a', 'b')}/${verifyWebhookSecret(null, 'b')}`,
    'true/false/false',
  ],
  [
    'redactSecrets hides a bearer token',
    redactSecrets('failed with Bearer abcdef1234567890abcdef').includes('abcdef1234567890abcdef'),
    false,
  ],
  ['canonical json sorts keys', canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}'],
  ['schema hash ignores key order', (await schemaHash({ a: 1, b: 2 })) === (await schemaHash({ b: 2, a: 1 })), true],
  ['schema hash is sha256-prefixed', (await schemaHash({ a: 1 })).startsWith('sha256:'), true],
  [
    'board panel schema accepts a card and refuses junk',
    boardOutputSchema.safeParse({ cards: [] }).success && !boardOutputSchema.safeParse({ cards: 5 }).success,
    true,
  ],
  ['no env means no foreman config', config, undefined],
  ['store table is defined', typeof foremanStoreTable(), 'object'],
  ['error codes are exported', typeof ADMIN_ERROR_CODES.invalidInput, 'string'],
  [
    'receipt store refuses a bad namespace by throwing its coded error',
    (() => {
      try {
        kvReceiptStore(kv, { namespace: 'nope' });
        return 'no error';
      } catch (error) {
        return error.code;
      }
    })(),
    ADMIN_ERROR_CODES.invalidConfig,
  ],
];

const engine =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== 'undefined') globalThis.process.exit(0);
