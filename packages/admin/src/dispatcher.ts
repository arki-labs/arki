/**
 * The app side of Foreman protocol 2: one `Request -> Response` handler that
 * authenticates signed envelopes and dispatches to module reads and actions.
 *
 * Order of checks for every request:
 *  1. Route shape decides the key use: execute routes accept only the execute
 *     key ring, everything else only the read key ring.
 *  2. Signature over the exact envelope bytes, then envelope schema, `use`,
 *     `aud`, method + path, clock skew (60 s), body hash, and finally the nonce
 *     (`@arki/kv` `setIfNotExists`, 5 min TTL). Any failure is a 401 with the
 *     single code `ARKI_ADMIN_E007`; the specific reason goes to the app's log.
 *  3. Executes: `FOREMAN_WRITES=off` refuses (403 `E009`).
 *  4. Capability lookup (404 `E011`), scope check (403 `E008`), and for
 *     executes the pinned `schemaHash` (409 `E010`).
 *  5. The module's own validation: bad input 400 (`E004`), bad output 500 (`E005`).
 *
 * Every response — errors included — carries a proof signed by the app's
 * identity key, so the client can tell it reached the target it meant to.
 *
 * Framework agnostic and portable (Web Crypto only). Exposed through
 * `@arki/admin/server`. Configuration is passed in; this module never reads
 * `process.env`.
 */
import type { Clock } from '@arki/clock';
import { SystemClock } from '@arki/clock';
import { z } from '@arki/contracts';
import { getLogger } from '@arki/log';

import type { AdminErrorCode } from './errors';
import type { AnyAction, AnyRead, ForemanModule, Permit } from './module';
import type { Envelope, ErrorBody, ForemanManifest, KeyUse, ProviderReadiness, WritesMode } from './protocol';
import { ADMIN_ERROR_CODES, AdminError } from './errors';
import { sha256 } from './json';
import { describeModule } from './module';
import {
  audienceSchema,
  envelopeSchema,
  FOREMAN_BASE_PATH,
  FOREMAN_HEADERS,
  FOREMAN_PROTOCOL_VERSION,
  fromBase64Url,
  importPrivateKey,
  importPublicKey,
  MAX_CLOCK_SKEW_MS,
  NONCE_TTL_SECONDS,
  normalizePublicKey,
  parseJsonBytes,
  privateKeySchema,
  providerReadinessSchema,
  publicKeySchema,
  requestBodySchema,
  scopeCovers,
  signProof,
  toBase64Url,
  utf8,
  verifyEnvelope,
  writesModeSchema,
} from './protocol';

const logger = getLogger('arki:admin');

/**
 * Where seen nonces live. `KV` from `@arki/kv` satisfies it (`setIfNotExists`
 * is Redis `SET NX EX`, atomic across app instances). Must return `true` only
 * for the first caller of a key within the TTL.
 */
export type NonceStore = {
  setIfNotExists(key: string, value: number, expirationSeconds: number): Promise<boolean>;
};

/** Public keys for one use. `next` is the overlap key during rotation (`FOREMAN_*_KEY_NEXT`). */
export type PublicKeyRing = { current: string; next?: string };

export type CreateForemanHandlerOptions<TCtx> = {
  /**
   * This target's identity. `aud` is `${appId}:${environment}` and must match
   * every envelope; `privateKey` (PKCS#8 base64url, e.g. `FOREMAN_APP_KEY`)
   * signs every response so Foreman can check it reached this target.
   */
  identity: { aud: string; privateKey: string };
  /** Foreman's public keys: `FOREMAN_READ_KEY[_NEXT]` and `FOREMAN_EXECUTE_KEY[_NEXT]`. Must not overlap. */
  keys: { read: PublicKeyRing; execute: PublicKeyRing };
  /** `FOREMAN_WRITES`. `'off'` refuses every execute regardless of signature. Required: no silent default. */
  writes: WritesMode;
  /** Replay protection. Pass an `@arki/kv` `KV`. */
  nonces: NonceStore;
  /** The modules this app exposes. Read and action ids must be unique across them. */
  modules: readonly ForemanModule<TCtx>[];
  /** Builds the context reads and actions receive, after authentication. */
  context: (request: Request) => TCtx | Promise<TCtx>;
  /** Reported in the manifest. */
  app: { version: string; commit?: string };
  /** Installed `@arki/*` versions, reported in the manifest. */
  packages?: Record<string, string>;
  /** Provider readiness, reported in the manifest. */
  providers?: Record<string, ProviderReadiness>;
  /** Time source. Defaults to the system clock. */
  clock?: Clock;
  /** Public path the dispatcher is mounted at. Defaults to `/api/foreman`. */
  basePath?: string;
};

const configSchema = z.object({
  identity: z.object({ aud: audienceSchema, privateKey: privateKeySchema }),
  keys: z.object({
    read: z.object({ current: publicKeySchema, next: publicKeySchema.optional() }),
    execute: z.object({ current: publicKeySchema, next: publicKeySchema.optional() }),
  }),
  writes: writesModeSchema,
  app: z.object({ version: z.string().min(1), commit: z.string().min(1).optional() }),
  packages: z.record(z.string(), z.string()).optional(),
  providers: z.record(z.string(), providerReadinessSchema).optional(),
  basePath: z
    .string()
    .regex(/^(?:\/[\w.-]+)+$/, 'Use a path such as "/api/foreman" with no trailing slash.')
    .optional(),
});

type Route =
  | { kind: 'manifest' }
  | { kind: 'read'; id: string }
  | { kind: 'preview'; id: string }
  | { kind: 'execute'; id: string };

type Registry<TCtx> = {
  reads: Map<string, AnyRead<TCtx>>;
  actions: Map<string, AnyAction<TCtx>>;
};

const STATUS_BY_CODE: Partial<Record<AdminErrorCode, number>> = {
  [ADMIN_ERROR_CODES.invalidInput]: 400,
  [ADMIN_ERROR_CODES.protocolUnsupported]: 400,
  [ADMIN_ERROR_CODES.unauthenticated]: 401,
  [ADMIN_ERROR_CODES.scopeDenied]: 403,
  [ADMIN_ERROR_CODES.writesDisabled]: 403,
  [ADMIN_ERROR_CODES.unknownCapability]: 404,
  [ADMIN_ERROR_CODES.staleApproval]: 409,
};

/**
 * Build the protocol-2 handler. Mount it for every method under `basePath`
 * (e.g. a `/api/foreman/$` splat route). Keep `/api/fleet` (protocol 1) mounted
 * alongside until Foreman has negotiated protocol 2 with this target.
 *
 * Throws `ARKI_ADMIN_E014` for invalid keys or audience, and when a read key
 * equals an execute key (that would let a read signature execute).
 */
export function createForemanHandler<TCtx>(
  options: CreateForemanHandlerOptions<TCtx>,
): (request: Request) => Promise<Response> {
  const config = parseConfig(options);
  const registry = buildRegistry(options.modules);
  const clock = options.clock ?? new SystemClock();
  const basePath = config.basePath ?? FOREMAN_BASE_PATH;
  const [appId = '', environment = ''] = config.identity.aud.split(':');

  // Keys and descriptions are computed once, on first use (Web Crypto is async).
  async function importKeys(): Promise<{ identity: CryptoKey; read: CryptoKey[]; execute: CryptoKey[] }> {
    return {
      identity: await importPrivateKey(config.identity.privateKey),
      read: await Promise.all(ringOf(config.keys.read).map(key => importPublicKey(key))),
      execute: await Promise.all(ringOf(config.keys.execute).map(key => importPublicKey(key))),
    };
  }
  let keysPromise: ReturnType<typeof importKeys> | undefined;
  const keys = () => (keysPromise ??= importKeys());

  async function describe(): Promise<{ manifest: ForemanManifest; actionHashes: Map<string, string> }> {
    const modules = await Promise.all(options.modules.map(module => describeModule(module)));
    const actionHashes = new Map(
      modules.flatMap(module => module.actions.map(action => [action.id, action.schemaHash])),
    );
    const manifest: ForemanManifest = {
      protocol: FOREMAN_PROTOCOL_VERSION,
      app: { id: appId, version: config.app.version, commit: config.app.commit, environment },
      packages: config.packages ?? {},
      modules,
      readiness: { writes: config.writes, providers: config.providers ?? {} },
    };
    return { manifest, actionHashes };
  }
  let describedPromise: ReturnType<typeof describe> | undefined;
  const described = () => (describedPromise ??= describe());

  async function respond(status: number, body: unknown, nonce: string): Promise<Response> {
    const bytes = utf8(JSON.stringify(body));
    const proofBytes = utf8(
      JSON.stringify({
        v: FOREMAN_PROTOCOL_VERSION,
        aud: config.identity.aud,
        nonce,
        status,
        bodySha256: await sha256(bytes),
      }),
    );
    const { identity } = await keys();
    const signature = await signProof(identity, proofBytes);
    return new Response(bytes, {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        [FOREMAN_HEADERS.protocol]: String(FOREMAN_PROTOCOL_VERSION),
        [FOREMAN_HEADERS.proof]: toBase64Url(proofBytes),
        [FOREMAN_HEADERS.proofSignature]: toBase64Url(signature),
      },
    });
  }

  async function authenticate(
    request: Request,
    url: URL,
    use: KeyUse,
  ): Promise<{ envelope: Envelope; body: Uint8Array }> {
    const envelopeBytes = fromBase64Url(request.headers.get(FOREMAN_HEADERS.envelope) ?? '');
    const signature = fromBase64Url(request.headers.get(FOREMAN_HEADERS.signature) ?? '');
    if (!envelopeBytes?.length || !signature?.length)
      throw unauthenticated('missing or malformed signature headers', url);

    const { read, execute } = await keys();
    const ring = use === 'execute' ? execute : read;
    if (!(await verifyEnvelope(ring, signature, envelopeBytes))) {
      throw unauthenticated(`signature does not verify under the ${use} key ring`, url);
    }

    const raw = parseJsonBytes(envelopeBytes);
    const version = z.object({ v: z.number() }).safeParse(raw);
    if (version.success && version.data.v !== FOREMAN_PROTOCOL_VERSION) {
      throw new AdminError(
        ADMIN_ERROR_CODES.protocolUnsupported,
        `This app speaks Foreman protocol ${String(FOREMAN_PROTOCOL_VERSION)}, not ${String(version.data.v)}.`,
        `Send protocol ${String(FOREMAN_PROTOCOL_VERSION)} envelopes, or protocol 1 to /api/fleet.`,
      );
    }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) throw unauthenticated('envelope does not match the schema', url);
    const envelope = parsed.data;

    if (envelope.use !== use) throw unauthenticated(`envelope use "${envelope.use}" on a ${use} route`, url);
    if (envelope.aud !== config.identity.aud) throw unauthenticated(`wrong audience "${envelope.aud}"`, url);
    if (envelope.method !== request.method || envelope.path !== url.pathname + url.search) {
      throw unauthenticated('signed method or path differs from the request', url);
    }
    if (Math.abs(clock.now().getTime() - envelope.iat * 1000) > MAX_CLOCK_SKEW_MS) {
      throw unauthenticated('iat outside the 60 s clock-skew window', url);
    }

    const body = new Uint8Array(await request.arrayBuffer());
    if ((await sha256(body)) !== envelope.bodySha256) throw unauthenticated('body hash mismatch', url);

    const fresh = await options.nonces.setIfNotExists(
      `arki:admin:nonce:${envelope.aud}:${envelope.nonce}`,
      envelope.iat,
      NONCE_TTL_SECONDS,
    );
    if (!fresh) throw unauthenticated('replayed nonce', url);

    return { envelope, body };
  }

  async function dispatch(request: Request, url: URL, route: Route): Promise<unknown> {
    const { envelope, body } = await authenticate(request, url, route.kind === 'execute' ? 'execute' : 'read');
    if (route.kind === 'manifest') {
      const { manifest } = await described();
      return manifest;
    }

    if (route.kind === 'execute' && config.writes === 'off') {
      throw new AdminError(
        ADMIN_ERROR_CODES.writesDisabled,
        'This app runs with FOREMAN_WRITES=off, so it refuses every execute.',
        'Set FOREMAN_WRITES=on on the app when writes should be allowed again.',
      );
    }

    if (route.kind === 'read') {
      const read = registry.reads.get(route.id);
      if (read === undefined) throw unknownCapability(url);
      requireScope(envelope, read.permission);
      return read.run(parseInput(body), await options.context(request));
    }

    const action = registry.actions.get(route.id);
    if (action === undefined) throw unknownCapability(url);
    requireScope(envelope, action.permission);
    if (route.kind === 'preview') return action.runPreview(parseInput(body), await options.context(request));

    // `authenticate` already matched `use` to the route; this narrows the type to reach `permit`.
    if (envelope.use !== 'execute') throw unauthenticated('execute route without an execute envelope', url);
    const { permit: claim } = envelope;
    const { actionHashes } = await described();
    if (actionHashes.get(action.id) !== claim.schemaHash) {
      throw new AdminError(
        ADMIN_ERROR_CODES.staleApproval,
        `The approval pinned a different contract for "${action.id}" than this app runs now.`,
        'Preview and approve again against the current manifest.',
      );
    }
    const permit: Permit = {
      executionId: claim.executionId,
      expectedRevision: claim.expectedRevision,
      approvedBy: claim.approvedBy,
    };
    return action.runExecute(parseInput(body), await options.context(request), permit);
  }

  return async function foremanHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nonce = claimedNonce(request.headers.get(FOREMAN_HEADERS.envelope));
    try {
      const route = matchRoute(url.pathname, request.method, basePath);
      if (route === undefined) throw unknownCapability(url);
      const data = await dispatch(request, url, route);
      return await respond(200, { data }, nonce);
    } catch (error) {
      return respond(...errorResponse(error, url), nonce);
    }
  };
}

function parseConfig<TCtx>(options: CreateForemanHandlerOptions<TCtx>): z.output<typeof configSchema> {
  const result = configSchema.safeParse(options);
  if (!result.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      `The Foreman handler configuration is invalid:\n${z.prettifyError(result.error)}`,
      'Fix the fields named above; keys come from generateForemanKeyPair().',
      { cause: result.error },
    );
  }
  const read = new Set(ringOf(result.data.keys.read).map(key => normalizePublicKey(key)));
  if (ringOf(result.data.keys.execute).some(key => read.has(normalizePublicKey(key)))) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      'A Foreman read key is also configured as an execute key.',
      'Use two different key pairs: FOREMAN_READ_KEY must never equal FOREMAN_EXECUTE_KEY.',
    );
  }
  return result.data;
}

function requireScope(envelope: Envelope, permission: string): void {
  if (!envelope.scopes.some(scope => scopeCovers(scope, permission))) {
    throw new AdminError(
      ADMIN_ERROR_CODES.scopeDenied,
      `The signed scopes do not cover "${permission}".`,
      `Sign the request with a scope that covers "${permission}".`,
    );
  }
}

/** The `input` of a `{"input": ...}` JSON body. */
function parseInput(body: Uint8Array): unknown {
  const parsed = requestBodySchema.safeParse(parseJsonBytes(body));
  if (!parsed.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidInput,
      'The request body must be JSON of the form {"input": ...}.',
      'Send the input wrapped in {"input": ...}.',
    );
  }
  return parsed.data.input;
}

function ringOf(ring: PublicKeyRing): string[] {
  return ring.next === undefined ? [ring.current] : [ring.current, ring.next];
}

function buildRegistry<TCtx>(modules: readonly ForemanModule<TCtx>[]): Registry<TCtx> {
  const registry: Registry<TCtx> = { reads: new Map(), actions: new Map() };
  for (const module of modules) {
    for (const read of Object.values(module.reads)) addUnique(registry.reads, read.id, read, 'read');
    for (const action of Object.values(module.actions)) addUnique(registry.actions, action.id, action, 'action');
  }
  return registry;
}

function addUnique<T>(map: Map<string, T>, id: string, value: T, kind: string): void {
  if (map.has(id)) {
    throw new AdminError(
      ADMIN_ERROR_CODES.duplicateId,
      `Two modules define the ${kind} id "${id}".`,
      'Give every read and action its own id across all modules of an app.',
    );
  }
  map.set(id, value);
}

function matchRoute(pathname: string, method: string, basePath: string): Route | undefined {
  if (!pathname.startsWith(`${basePath}/`)) return undefined;
  const [first, second, third, ...rest] = pathname.slice(basePath.length + 1).split('/');
  if (rest.length > 0 || first === undefined) return undefined;
  if (method === 'GET' && first === 'manifest' && second === undefined) return { kind: 'manifest' };
  if (method !== 'POST' || second === undefined || second === '') return undefined;
  if (first === 'reads' && third === undefined) return { kind: 'read', id: second };
  if (first === 'actions' && third === 'preview') return { kind: 'preview', id: second };
  if (first === 'actions' && third === 'execute') return { kind: 'execute', id: second };
  return undefined;
}

/** The nonce a request claims, unverified — only echoed in the response proof. */
function claimedNonce(header: string | null): string {
  const bytes = header === null ? undefined : fromBase64Url(header);
  if (bytes === undefined) return '';
  const result = z.object({ nonce: z.string().max(128) }).safeParse(parseJsonBytes(bytes));
  return result.success ? result.data.nonce : '';
}

function unauthenticated(reason: string, url: URL): AdminError {
  logger.warn('Foreman request rejected on {path}: {reason}', { path: url.pathname, reason });
  return new AdminError(
    ADMIN_ERROR_CODES.unauthenticated,
    'The request failed authentication.',
    'Check the Foreman key pair, the target audience and both clocks; the app log names the failed check.',
  );
}

function unknownCapability(url: URL): AdminError {
  return new AdminError(
    ADMIN_ERROR_CODES.unknownCapability,
    `Nothing at ${url.pathname}.`,
    "Use a read or action id from the app's manifest.",
  );
}

/** Status and wire body for a failure. 5xx bodies never carry the app's internal message. */
function errorResponse(error: unknown, url: URL): [number, ErrorBody] {
  if (error instanceof AdminError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    if (status < 500) {
      const message = error.message.startsWith(`${error.code}: `)
        ? error.message.slice(error.code.length + 2)
        : error.message;
      return [status, { error: { code: error.code, message, remediation: error.remediation } }];
    }
    logger.error('Foreman request failed on {path}: {message}', { path: url.pathname, message: error.message });
    const message =
      error.code === ADMIN_ERROR_CODES.invalidOutput
        ? 'The app produced data that does not match its own contract.'
        : 'The app failed to handle the request.';
    return [status, { error: { code: error.code, message, remediation: error.remediation } }];
  }
  if (error instanceof Error) logger.error(error, { path: url.pathname });
  else logger.error('Foreman handler threw a non-Error on {path}', { path: url.pathname });
  return [
    500,
    {
      error: {
        code: ADMIN_ERROR_CODES.handlerFailed,
        message: 'The app failed to handle the request.',
        remediation: "Check the app's log for this request.",
      },
    },
  ];
}
