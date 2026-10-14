/**
 * T(admin-protocol) — Foreman protocol 2 end to end: the client signs, the
 * dispatcher authenticates and dispatches, the client verifies the target.
 *
 * Every rejection test sends a request that is valid in every way except the
 * one property under test, so removing that check would turn the rejection
 * into a success and fail the test.
 */
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { KV } from '@arki/kv';
import { MockClock } from '@arki/clock';
import { z } from '@arki/contracts';

import type { CreateForemanClientOptions, PermitClaim } from './client';
import type { CreateForemanHandlerOptions, NonceStore } from './dispatcher';
import type { AdminErrorCode, JsonValue, Permit } from './module';
import { createForemanClient, generateForemanKeyPair, signRequest } from './client';
import { createForemanHandler } from './dispatcher';
import { ADMIN_ERROR_CODES, AdminError, defineAction, defineModule, defineRead, describeModule } from './module';
import {
  errorBodySchema,
  FOREMAN_HEADERS,
  foremanPaths,
  importPrivateKey,
  randomNonce,
  signEnvelope,
  toBase64Url,
  utf8,
} from './protocol';
import { kvReceiptStore } from './receipts';
import { memoryKv } from './test-support';

type Ctx = { tenant: string };
type KeyPair = Awaited<ReturnType<typeof generateForemanKeyPair>>;

const AUD = 'novelette:production';
const BASE_URL = 'https://novelette.test';
const T0 = new Date('2026-10-14T12:00:00Z');
const READ_PATH = foremanPaths.read('queue.failedJobs');
const EXECUTE_PATH = foremanPaths.execute('queue.retryJob');

let readPair: KeyPair;
let executePair: KeyPair;
let appPair: KeyPair;
let impostorPair: KeyPair;
let retryHash: string;

beforeAll(async () => {
  [readPair, executePair, appPair, impostorPair] = await Promise.all([
    generateForemanKeyPair(),
    generateForemanKeyPair(),
    generateForemanKeyPair(),
    generateForemanKeyPair(),
  ]);
  const description = await describeModule(buildModule().module);
  retryHash = description.actions.find(action => action.id === 'queue.retryJob')?.schemaHash ?? '';
});

function buildModule() {
  const executed: Permit[] = [];
  const failedJobs = defineRead({
    id: 'queue.failedJobs',
    summary: 'Failed jobs',
    permission: 'queue:read',
    input: z.object({ limit: z.number().int().default(10) }),
    output: z.array(z.object({ id: z.string() })),
    load: async ({ limit }, ctx: Ctx) => [{ id: `${ctx.tenant}_job_1` }].slice(0, limit),
  });
  const brokenCount = defineRead({
    id: 'queue.brokenCount',
    summary: 'A read whose app code breaks its own output schema',
    permission: 'queue:read',
    input: z.object({}),
    output: z.object({ count: z.number().int() }),
    load: async (_input, _ctx: Ctx) => ({ count: 1.5 }),
  });
  const retryJob = defineAction({
    id: 'queue.retryJob',
    summary: 'Retry one failed job',
    permission: 'queue:write',
    risk: 'low',
    input: z.object({ jobId: z.string().min(1) }),
    previewOutput: z.object({ revision: z.string(), jobId: z.string() }),
    output: z.object({ requeued: z.boolean() }),
    preview: async ({ jobId }, _ctx: Ctx) => ({ revision: 'rev_3', jobId }),
    execute: async (_input, _ctx: Ctx, permit) => {
      executed.push(permit);
      return { requeued: true };
    },
  });
  const module = defineModule({
    id: '@arki/queue',
    version: '1.0.0',
    reads: { failedJobs, brokenCount },
    actions: { retryJob },
  });
  return { module, executed };
}

/** Nonce store with real TTL semantics on the test clock — what `KV.setIfNotExists` does in Redis. */
function memoryNonces(clock: MockClock): NonceStore {
  const expiries = new Map<string, number>();
  return {
    setIfNotExists: async (key, _value, expirationSeconds) => {
      const now = clock.now().getTime();
      const expiry = expiries.get(key);
      if (expiry !== undefined && expiry > now) return false;
      expiries.set(key, now + expirationSeconds * 1000);
      return true;
    },
  };
}

type SetupOptions = Partial<Pick<CreateForemanHandlerOptions<Ctx>, 'writes' | 'keys'>> & {
  aud?: string;
  identityKey?: string;
  client?: Partial<CreateForemanClientOptions>;
};

function setup(options: SetupOptions = {}) {
  const clock = new MockClock(T0);
  const { module, executed } = buildModule();
  const handler = createForemanHandler<Ctx>({
    identity: { aud: options.aud ?? AUD, privateKey: options.identityKey ?? appPair.privateKey },
    keys: options.keys ?? { read: { current: readPair.publicKey }, execute: { current: executePair.publicKey } },
    writes: options.writes ?? 'on',
    nonces: memoryNonces(clock),
    receipts: kvReceiptStore(memoryKv(clock), { namespace: 'novelette:production' }),
    modules: [module],
    context: () => ({ tenant: 'acme' }),
    app: { version: '1.2.3' },
    clock,
  });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init));
  const client = createForemanClient({
    target: { aud: AUD, baseUrl: BASE_URL, appKey: appPair.publicKey },
    readKey: readPair.privateKey,
    executeKey: executePair.privateKey,
    clock,
    fetch: fetchImpl,
    ...options.client,
  });
  return { clock, handler, client, executed };
}

function permitClaim(overrides: Partial<PermitClaim> = {}): PermitClaim {
  return {
    executionId: 'exe_1',
    expectedRevision: 'rev_3',
    approvedBy: 'usr_alex',
    schemaHash: retryHash,
    ...overrides,
  };
}

type RawRequest = {
  privateKey: string;
  path: string;
  input?: JsonValue;
  scopes?: readonly string[];
  aud?: string;
  signClock?: MockClock;
  /** Send these bytes instead of the signed body. */
  sentBody?: Uint8Array<ArrayBuffer>;
  /** Send to this path instead of the signed one. */
  sentPath?: string;
} & ({ use: 'read' } | { use: 'execute'; permit: PermitClaim });

/** Sign a request by hand, so a test can make exactly one property wrong. */
async function signedRequest(raw: RawRequest): Promise<Request> {
  const body = utf8(JSON.stringify({ input: raw.input ?? {} }));
  const common = {
    privateKey: raw.privateKey,
    aud: raw.aud ?? AUD,
    method: 'POST' as const,
    path: raw.path,
    body,
    scopes: raw.scopes ?? ['queue:*'],
    clock: raw.signClock ?? new MockClock(T0),
  };
  const signed = await signRequest(
    raw.use === 'execute' ? { ...common, use: 'execute', permit: raw.permit } : { ...common, use: 'read' },
  );
  return new Request(new URL(raw.sentPath ?? raw.path, BASE_URL), {
    method: 'POST',
    headers: { ...signed.headers, 'content-type': 'application/json' },
    body: raw.sentBody ?? body,
  });
}

async function errorCode(response: Response): Promise<AdminErrorCode> {
  return errorBodySchema.parse(await response.json()).error.code;
}

async function expectAdminError(promise: Promise<unknown>, code: AdminErrorCode): Promise<AdminError> {
  const error: unknown = await promise.then(
    () => null,
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(AdminError);
  if (!(error instanceof AdminError)) throw new Error('expected an AdminError');
  expect(error.code).toBe(code);
  return error;
}

describe('T(admin-protocol) happy paths', () => {
  it('round-trips a read: read key signs, the app answers, the client verifies the proof', async () => {
    const { client } = setup();
    await expect(client.read('queue.failedJobs', { limit: 5 }, ['queue:read'])).resolves.toEqual([
      { id: 'acme_job_1' },
    ]);
  });

  it('round-trips preview and execute: the approved permit reaches the action, schemaHash stays on the wire', async () => {
    const { client, executed } = setup();
    await expect(client.preview('queue.retryJob', { jobId: 'job_1' }, ['queue:write'])).resolves.toEqual({
      revision: 'rev_3',
      jobId: 'job_1',
    });
    await expect(
      client.execute('queue.retryJob', { jobId: 'job_1' }, { scopes: ['queue:write'], permit: permitClaim() }),
    ).resolves.toEqual({ requeued: true });
    expect(executed).toEqual([{ executionId: 'exe_1', expectedRevision: 'rev_3', approvedBy: 'usr_alex' }]);
  });

  it('negotiates protocol 2 and gets a manifest that names this target and its writes mode', async () => {
    const negotiated = await setup().client.negotiate();
    expect(negotiated.protocol).toBe(2);
    if (negotiated.protocol !== 2) return;
    expect(negotiated.manifest.app).toEqual({ id: 'novelette', version: '1.2.3', environment: 'production' });
    expect(negotiated.manifest.readiness.writes).toBe('on');
    expect(negotiated.manifest.modules[0]?.actions[0]?.schemaHash).toBe(retryHash);
  });

  it('accepts the rotation overlap key (`*_NEXT`) next to the current one', async () => {
    const next = await generateForemanKeyPair();
    const { handler } = setup({
      keys: {
        read: { current: readPair.publicKey, next: next.publicKey },
        execute: { current: executePair.publicKey },
      },
    });
    const response = await handler(await signedRequest({ privateKey: next.privateKey, use: 'read', path: READ_PATH }));
    expect(response.status).toBe(200);
  });
});

describe('T(admin-protocol) app-side rejections', () => {
  it('rejects a replayed request: the same signed envelope works once', async () => {
    const { handler } = setup();
    const first = await signedRequest({ privateKey: readPair.privateKey, use: 'read', path: READ_PATH });
    const replay = first.clone();
    const accepted = await handler(first);
    expect(accepted.status).toBe(200);
    const response = await handler(replay);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ADMIN_ERROR_CODES.unauthenticated);
  });

  it('rejects an envelope signed for another audience (staging keys cannot act on prod)', async () => {
    const { handler } = setup();
    const request = await signedRequest({
      privateKey: readPair.privateKey,
      use: 'read',
      path: READ_PATH,
      aud: 'novelette:staging',
    });
    const response = await handler(request);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ADMIN_ERROR_CODES.unauthenticated);
  });

  it.each([
    ['61 s old', -61_000, 401],
    ['61 s in the future', 61_000, 401],
    ['60 s old (edge of the window)', -60_000, 200],
  ])('clock skew: an envelope %s gets %i', async (_label, offsetMs, status) => {
    const { handler } = setup();
    const signClock = new MockClock(new Date(T0.getTime() + offsetMs));
    const response = await handler(
      await signedRequest({ privateKey: readPair.privateKey, use: 'read', path: READ_PATH, signClock }),
    );
    expect(response.status).toBe(status);
  });

  it('rejects scopes that do not cover the permission, and never runs the action', async () => {
    const { client, executed } = setup();
    await expectAdminError(
      client.execute('queue.retryJob', { jobId: 'job_1' }, { scopes: ['queue:read'], permit: permitClaim() }),
      ADMIN_ERROR_CODES.scopeDenied,
    );
    await expectAdminError(client.read('queue.failedJobs', {}, ['billing:*']), ADMIN_ERROR_CODES.scopeDenied);
    expect(executed).toEqual([]);
  });

  it('never lets the read key authorize an execute', async () => {
    const { handler, executed } = setup();
    const response = await handler(
      await signedRequest({
        privateKey: readPair.privateKey,
        use: 'execute',
        permit: permitClaim(),
        path: EXECUTE_PATH,
      }),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ADMIN_ERROR_CODES.unauthenticated);
    expect(executed).toEqual([]);
  });

  it('confines the execute key to executes: it cannot read', async () => {
    const { handler } = setup();
    const response = await handler(
      await signedRequest({ privateKey: executePair.privateKey, use: 'read', path: READ_PATH }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a body that differs from the signed body hash', async () => {
    const { handler, executed } = setup();
    const request = await signedRequest({
      privateKey: executePair.privateKey,
      use: 'execute',
      permit: permitClaim(),
      path: EXECUTE_PATH,
      input: { jobId: 'job_1' },
      sentBody: utf8(JSON.stringify({ input: { jobId: 'job_2' } })),
    });
    const response = await handler(request);
    expect(response.status).toBe(401);
    expect(executed).toEqual([]);
  });

  it('rejects a signature for another path', async () => {
    const { handler } = setup();
    const request = await signedRequest({
      privateKey: readPair.privateKey,
      use: 'read',
      path: READ_PATH,
      sentPath: foremanPaths.read('queue.brokenCount'),
    });
    const response = await handler(request);
    expect(response.status).toBe(401);
  });

  it('rejects missing signature headers, and hides unknown ids until the caller is authenticated', async () => {
    const { handler } = setup();
    const unsigned = await handler(new Request(new URL(foremanPaths.read('queue.nope'), BASE_URL), { method: 'POST' }));
    expect(unsigned.status).toBe(401);
    const signed = await handler(
      await signedRequest({ privateKey: readPair.privateKey, use: 'read', path: foremanPaths.read('queue.nope') }),
    );
    expect(signed.status).toBe(404);
    expect(await errorCode(signed)).toBe(ADMIN_ERROR_CODES.unknownCapability);
  });

  it('answers an envelope of another protocol version with E013', async () => {
    const { handler } = setup();
    const body = utf8(JSON.stringify({ input: {} }));
    const envelope = utf8(JSON.stringify({ v: 3, use: 'read', aud: AUD, nonce: randomNonce() }));
    const signature = await signEnvelope(await importPrivateKey(readPair.privateKey), envelope);
    const response = await handler(
      new Request(new URL(READ_PATH, BASE_URL), {
        method: 'POST',
        headers: {
          [FOREMAN_HEADERS.envelope]: toBase64Url(envelope),
          [FOREMAN_HEADERS.signature]: toBase64Url(signature),
        },
        body,
      }),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(ADMIN_ERROR_CODES.protocolUnsupported);
  });

  it('FOREMAN_WRITES=off refuses every valid execute; reads keep working and the manifest says so', async () => {
    const { client, executed } = setup({ writes: 'off' });
    await expectAdminError(
      client.execute('queue.retryJob', { jobId: 'job_1' }, { scopes: ['queue:write'], permit: permitClaim() }),
      ADMIN_ERROR_CODES.writesDisabled,
    );
    expect(executed).toEqual([]);
    await expect(client.read('queue.failedJobs', {}, ['queue:read'])).resolves.toHaveLength(1);
    const manifest = await client.manifest();
    expect(manifest.readiness.writes).toBe('off');
  });

  it('rejects an approval pinned to another schemaHash (the action contract changed since approval)', async () => {
    const { client, executed } = setup();
    const stale = permitClaim({ schemaHash: `sha256:${'0'.repeat(64)}` });
    await expectAdminError(
      client.execute('queue.retryJob', { jobId: 'job_1' }, { scopes: ['queue:write'], permit: stale }),
      ADMIN_ERROR_CODES.staleApproval,
    );
    expect(executed).toEqual([]);
  });

  it('maps bad input to 400 (E004) and bad app output to 500 (E005) without leaking the details', async () => {
    const { handler } = setup();
    const badInput = await handler(
      await signedRequest({ privateKey: readPair.privateKey, use: 'read', path: READ_PATH, input: { limit: 'ten' } }),
    );
    expect(badInput.status).toBe(400);
    expect(await errorCode(badInput)).toBe(ADMIN_ERROR_CODES.invalidInput);

    const badOutput = await handler(
      await signedRequest({
        privateKey: readPair.privateKey,
        use: 'read',
        path: foremanPaths.read('queue.brokenCount'),
      }),
    );
    expect(badOutput.status).toBe(500);
    const body = errorBodySchema.parse(await badOutput.json());
    expect(body.error.code).toBe(ADMIN_ERROR_CODES.invalidOutput);
    expect(body.error.message).not.toContain('count');
  });
});

describe('T(admin-protocol) client-side target identity', () => {
  it('rejects a response signed by another identity key (impostor at the target URL)', async () => {
    const { client } = setup({ identityKey: impostorPair.privateKey });
    await expectAdminError(client.read('queue.failedJobs', {}, ['queue:read']), ADMIN_ERROR_CODES.targetMismatch);
  });

  it('rejects a response that proves another audience, even under the enrolled key', async () => {
    const { client } = setup({ aud: 'novelette:staging' });
    await expectAdminError(client.read('queue.failedJobs', {}, ['queue:read']), ADMIN_ERROR_CODES.targetMismatch);
  });

  it('rejects a response whose body was changed in transit', async () => {
    const { handler } = setup();
    const { client } = setup({
      client: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await handler(new Request(input, init));
          return Response.json({ data: [{ id: 'forged' }] }, response);
        },
      },
    });
    await expectAdminError(client.read('queue.failedJobs', {}, ['queue:read']), ADMIN_ERROR_CODES.targetMismatch);
  });

  it('rejects a genuine response replayed onto another request (nonce binding)', async () => {
    const { handler } = setup();
    let captured: Response | undefined;
    const { client } = setup({
      client: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          captured ??= await handler(new Request(input, init));
          return captured.clone();
        },
      },
    });
    await expect(client.read('queue.failedJobs', {}, ['queue:read'])).resolves.toHaveLength(1);
    await expectAdminError(client.read('queue.failedJobs', {}, ['queue:read']), ADMIN_ERROR_CODES.targetMismatch);
  });
});

describe('T(admin-protocol) negotiation and configuration', () => {
  const legacyFetch = async () => new Response('Not Found', { status: 404 });

  it('falls back to protocol 1 only for a target that allows it', async () => {
    const allowed = createForemanClient({
      target: { aud: AUD, baseUrl: BASE_URL, appKey: appPair.publicKey, allowProtocol1: true },
      readKey: readPair.privateKey,
      fetch: legacyFetch,
    });
    await expect(allowed.negotiate()).resolves.toEqual({ protocol: 1 });

    const pinned = createForemanClient({
      target: { aud: AUD, baseUrl: BASE_URL, appKey: appPair.publicKey },
      readKey: readPair.privateKey,
      fetch: legacyFetch,
    });
    await expectAdminError(pinned.negotiate(), ADMIN_ERROR_CODES.protocolUnsupported);
  });

  it('a read-only client cannot execute', async () => {
    const { client } = setup({ client: { executeKey: undefined } });
    await expectAdminError(
      client.execute('queue.retryJob', { jobId: 'job_1' }, { scopes: ['queue:write'], permit: permitClaim() }),
      ADMIN_ERROR_CODES.invalidConfig,
    );
  });

  it('refuses a dispatcher whose read key is also an execute key', () => {
    expect(() =>
      setup({ keys: { read: { current: readPair.publicKey }, execute: { current: readPair.publicKey } } }),
    ).toThrow(expect.objectContaining({ code: ADMIN_ERROR_CODES.invalidConfig }));
  });

  it('an @arki/kv KV is a NonceStore', () => {
    expectTypeOf<KV>().toExtend<NonceStore>();
  });
});
