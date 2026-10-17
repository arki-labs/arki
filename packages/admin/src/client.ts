/**
 * @arki/admin/client — the Foreman side of protocol 2.
 *
 * {@link createForemanClient} signs each call with the read or execute key and
 * checks every response's proof against the target's enrolled identity key:
 * the proof must be signed by that key, name the expected `aud`, echo this
 * request's nonce, and match the status and body bytes. Anything else is
 * `ARKI_ADMIN_E012` — the client never trusts a response it cannot tie to the
 * target it meant to call.
 *
 * Give the execute key only to the process that executes approved actions;
 * create read-only clients (no `executeKey`) everywhere else.
 *
 * Isomorphic (Web Crypto Ed25519). Protocol 1 (`/api/fleet`) stays in
 * `@arki/admin/server` as `fetchFleetSnapshot`; {@link ForemanClient.negotiate}
 * tells the caller which one a target speaks.
 */
import type { Clock } from '@arki/clock';
import { SystemClock } from '@arki/clock';
import { z } from '@arki/contracts';

import type { JsonValue } from './json';
import type { ForemanManifest, KeyUse, PermitClaim } from './protocol';
import { ADMIN_ERROR_CODES, AdminError, moduleError } from './errors';
import { sha256 } from './json';
import {
  audienceSchema,
  errorBodySchema,
  FOREMAN_BASE_PATH,
  FOREMAN_HEADERS,
  FOREMAN_PROTOCOL_VERSION,
  foremanManifestSchema,
  foremanPaths,
  fromBase64Url,
  importPrivateKey,
  importPublicKey,
  parseJsonBytes,
  privateKeySchema,
  publicKeySchema,
  randomNonce,
  responseProofSchema,
  scopeSchema,
  signEnvelope,
  successBodySchema,
  toBase64Url,
  utf8,
  verifyProof,
} from './protocol';

export type {
  Envelope,
  ForemanManifest,
  KeyUse,
  PermitClaim,
  ProviderReadiness,
  ResponseProof,
  WritesMode,
} from './protocol';
export {
  envelopeSchema,
  FOREMAN_BASE_PATH,
  FOREMAN_HEADERS,
  FOREMAN_PROTOCOL_VERSION,
  foremanManifestSchema,
  foremanPaths,
  generateForemanKeyPair,
  MAX_CLOCK_SKEW_MS,
  NONCE_TTL_SECONDS,
  permitClaimSchema,
  scopeCovers,
} from './protocol';

/** One enrolled target, as Foreman's registry stores it. */
export type ForemanTarget = {
  /** `${appId}:${environment}`. */
  aud: string;
  /** Origin Foreman calls, e.g. `https://shop.example.com`. */
  baseUrl: string;
  /** The app's identity public key, recorded at enrollment (`FOREMAN_APP_KEY`'s public half). */
  appKey: string;
  /** Path the app mounted the dispatcher at. Defaults to `/api/foreman`. */
  basePath?: string;
  /**
   * Whether {@link ForemanClient.negotiate} may report protocol 1 when the
   * target has no protocol-2 route. Leave off once a target speaks protocol 2,
   * so a 404 cannot downgrade it.
   */
  allowProtocol1?: boolean;
};

export type CreateForemanClientOptions = {
  target: ForemanTarget;
  /** Foreman's read private key for this environment (PKCS#8 base64url). */
  readKey: string;
  /** Foreman's execute private key. Only the execution worker passes it. */
  executeKey?: string;
  /** Time source for `iat`. Defaults to the system clock. */
  clock?: Clock;
  /** Override the global fetch (tests). */
  fetch?: typeof fetch;
  /** Per-request timeout; defaults to 5000 ms. */
  timeoutMs?: number;
};

/** Result of {@link ForemanClient.negotiate}. */
export type Negotiated = { protocol: 1 } | { protocol: 2; manifest: ForemanManifest };

/** What an execute call needs besides the input. */
export type ExecuteOptions = { scopes: readonly string[]; permit: PermitClaim };

export type ForemanClient = {
  /** Ask the target for its manifest; report protocol 1 only when the target allows it and has no protocol-2 route. */
  negotiate(): Promise<Negotiated>;
  /** The target's manifest. Requires protocol 2. */
  manifest(): Promise<ForemanManifest>;
  /** Run a read. `scopes` are the operator's signed scopes for this call. */
  read(id: string, input: JsonValue, scopes: readonly string[]): Promise<JsonValue>;
  /** Run an action's preview (read key). */
  preview(id: string, input: JsonValue, scopes: readonly string[]): Promise<JsonValue>;
  /** Run an approved action (execute key). */
  execute(id: string, input: JsonValue, options: ExecuteOptions): Promise<JsonValue>;
};

const optionsSchema = z.object({
  target: z.object({
    aud: audienceSchema,
    baseUrl: z.url(),
    appKey: publicKeySchema,
    basePath: z
      .string()
      .regex(/^(?:\/[\w.-]+)+$/)
      .optional(),
    allowProtocol1: z.boolean().optional(),
  }),
  readKey: privateKeySchema,
  executeKey: privateKeySchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/** With `redirect: 'manual'` a 3xx comes back as a response (or opaque, status 0); never follow it. */
const isRedirect = (response: Response): boolean =>
  response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);

const scopesSchema = z.array(scopeSchema).max(64);

/** What one signed request says, apart from the key that signs it. */
type RequestFields = {
  aud: string;
  method: 'GET' | 'POST';
  /** Pathname plus search, as the app will see it. */
  path: string;
  /** The exact body bytes that will be sent (empty for GET). */
  body: Uint8Array<ArrayBuffer>;
  scopes: readonly string[];
  /** Defaults to the system clock. */
  clock?: Clock;
} & ({ use: 'read' } | { use: 'execute'; permit: PermitClaim });

/** Everything needed to sign one request: the fields plus the read or execute private key (PKCS#8 base64url). */
export type SignRequestInput = RequestFields & { privateKey: string };

/** The headers a signed request carries, plus the nonce its response proof must echo. */
export type SignedRequest = { headers: Record<string, string>; nonce: string };

/**
 * Sign one request envelope. {@link createForemanClient} uses it for every
 * call; it is exported for callers that build requests themselves.
 */
export async function signRequest(input: SignRequestInput): Promise<SignedRequest> {
  return signWith(await importPrivateKey(input.privateKey), input);
}

async function signWith(key: CryptoKey, input: RequestFields): Promise<SignedRequest> {
  const nonce = randomNonce();
  const common = {
    v: FOREMAN_PROTOCOL_VERSION,
    aud: input.aud,
    iat: Math.floor((input.clock ?? new SystemClock()).now().getTime() / 1000),
    nonce,
    method: input.method,
    path: input.path,
    bodySha256: await sha256(input.body),
    scopes: [...input.scopes],
  };
  const envelope =
    input.use === 'execute' ? { ...common, use: input.use, permit: input.permit } : { ...common, use: input.use };
  const bytes = utf8(JSON.stringify(envelope));
  return {
    nonce,
    headers: {
      [FOREMAN_HEADERS.protocol]: String(FOREMAN_PROTOCOL_VERSION),
      [FOREMAN_HEADERS.envelope]: toBase64Url(bytes),
      [FOREMAN_HEADERS.signature]: toBase64Url(await signEnvelope(key, bytes)),
    },
  };
}

/** Build a client for one target. Throws `ARKI_ADMIN_E014` for invalid keys, audience or URL. */
export function createForemanClient(options: CreateForemanClientOptions): ForemanClient {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      `The Foreman client configuration is invalid:\n${z.prettifyError(parsed.error)}`,
      'Fix the fields named above; keys come from generateForemanKeyPair().',
      { cause: parsed.error },
    );
  }
  const { target, readKey, executeKey } = parsed.data;
  const basePath = target.basePath ?? FOREMAN_BASE_PATH;
  const [appId, environment] = target.aud.split(':');
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = parsed.data.timeoutMs ?? 5000;

  let readKeyPromise: Promise<CryptoKey> | undefined;
  let executeKeyPromise: Promise<CryptoKey> | undefined;
  let appKeyPromise: Promise<CryptoKey> | undefined;
  const signingKey = (use: KeyUse): Promise<CryptoKey> => {
    if (use === 'read') return (readKeyPromise ??= importPrivateKey(readKey));
    if (executeKey === undefined) {
      throw new AdminError(
        ADMIN_ERROR_CODES.invalidConfig,
        'This Foreman client holds no execute key.',
        'Execute only from the execution worker, which creates its client with executeKey.',
      );
    }
    return (executeKeyPromise ??= importPrivateKey(executeKey));
  };

  type Call = { use: 'read' } | { use: 'execute'; permit: PermitClaim };

  type Sent = { response: Response; bytes: Uint8Array<ArrayBuffer>; nonce: string };

  /** Sign and send one request. The response is not trusted until {@link verified} checks its proof. */
  async function send(
    call: Call,
    method: 'GET' | 'POST',
    path: string,
    payload: { input: JsonValue } | undefined,
    scopes: readonly string[],
  ): Promise<Sent> {
    const parsedScopes = scopesSchema.safeParse(scopes);
    if (!parsedScopes.success) {
      throw new AdminError(
        ADMIN_ERROR_CODES.invalidInput,
        `Invalid scopes:\n${z.prettifyError(parsedScopes.error)}`,
        'Use scopes such as "queue:read" or "queue:*".',
      );
    }
    const body = payload === undefined ? new Uint8Array(0) : utf8(JSON.stringify(payload));
    const signed = await signWith(await signingKey(call.use), {
      ...call,
      aud: target.aud,
      method,
      path,
      body,
      scopes: parsedScopes.data,
      clock: options.clock,
    });

    try {
      const response = await fetchImpl(new URL(path, target.baseUrl), {
        method,
        headers: payload === undefined ? signed.headers : { ...signed.headers, 'content-type': 'application/json' },
        body: payload === undefined ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      if (isRedirect(response)) {
        throw new AdminError(
          ADMIN_ERROR_CODES.unreachable,
          `${target.aud} answered with a redirect (HTTP ${String(response.status)}); Foreman does not follow redirects.`,
          'Enroll the final base URL of the target; a redirect is never followed.',
        );
      }
      return { response, bytes: new Uint8Array(await response.arrayBuffer()), nonce: signed.nonce };
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError(
        ADMIN_ERROR_CODES.unreachable,
        `Could not reach ${target.aud} at ${target.baseUrl}.`,
        'Treat the outcome as unknown; check the target is up and reachable from Foreman.',
        { cause: error },
      );
    }
  }

  /** Check the response proof; return the status and parsed body only when it proves the target. */
  async function verified({ response, bytes, nonce }: Sent): Promise<{ status: number; body: unknown }> {
    const proofBytes = fromBase64Url(response.headers.get(FOREMAN_HEADERS.proof) ?? '');
    const signature = fromBase64Url(response.headers.get(FOREMAN_HEADERS.proofSignature) ?? '');
    const appKey = await (appKeyPromise ??= importPublicKey(target.appKey));
    const signedByTarget =
      proofBytes !== undefined &&
      proofBytes.length > 0 &&
      signature !== undefined &&
      (await verifyProof(appKey, signature, proofBytes));
    const proof = signedByTarget ? responseProofSchema.safeParse(parseJsonBytes(proofBytes)) : undefined;
    const matches =
      proof?.success === true &&
      proof.data.aud === target.aud &&
      proof.data.nonce === nonce &&
      proof.data.status === response.status &&
      proof.data.bodySha256 === (await sha256(bytes));
    if (!matches) {
      throw new AdminError(
        ADMIN_ERROR_CODES.targetMismatch,
        `The response did not prove it came from ${target.aud}.`,
        "Check the target's base URL and the identity key recorded at enrollment; do not act on this response.",
      );
    }
    return { status: response.status, body: parseJsonBytes(bytes) };
  }

  /** The `data` of a verified success, or the app's coded error rethrown. */
  function unwrap(result: { status: number; body: unknown }): JsonValue {
    if (result.status >= 200 && result.status < 300) {
      const success = successBodySchema.safeParse(result.body);
      if (success.success) return success.data.data;
    } else {
      const failure = errorBodySchema.safeParse(result.body);
      if (failure.success) {
        const { code, message, remediation } = failure.data.error;
        const text = `${target.aud} answered HTTP ${String(result.status)}: ${message}`;
        const adminCode = Object.values(ADMIN_ERROR_CODES).find(known => known === code);
        if (adminCode !== undefined) throw new AdminError(adminCode, text, remediation);
        // A module's own code: keep it, with the status the app answered.
        throw moduleError(code, result.status, text, remediation);
      }
    }
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidOutput,
      `${target.aud} answered HTTP ${String(result.status)} with a body outside protocol ${String(FOREMAN_PROTOCOL_VERSION)}.`,
      'Upgrade the app to a matching @arki/admin version.',
    );
  }

  async function negotiate(): Promise<Negotiated> {
    const sent = await send({ use: 'read' }, 'GET', foremanPaths.manifest(basePath), undefined, []);
    // A target without the protocol-2 dispatcher answers a bare 404: no proof header at all.
    if (sent.response.status === 404 && !sent.response.headers.has(FOREMAN_HEADERS.proof)) {
      if (target.allowProtocol1 === true) return { protocol: 1 };
      throw new AdminError(
        ADMIN_ERROR_CODES.protocolUnsupported,
        `${target.aud} has no protocol ${String(FOREMAN_PROTOCOL_VERSION)} route.`,
        'Mount createForemanHandler on the app, or allow protocol 1 for this target while it migrates.',
      );
    }
    const manifest = foremanManifestSchema.safeParse(unwrap(await verified(sent)));
    if (!manifest.success) {
      throw new AdminError(
        ADMIN_ERROR_CODES.invalidOutput,
        `${target.aud} sent a manifest outside protocol ${String(FOREMAN_PROTOCOL_VERSION)}:\n${z.prettifyError(manifest.error)}`,
        'Upgrade the app to a matching @arki/admin version.',
      );
    }
    if (manifest.data.app.id !== appId || manifest.data.app.environment !== environment) {
      throw new AdminError(
        ADMIN_ERROR_CODES.targetMismatch,
        `The manifest names ${manifest.data.app.id}:${manifest.data.app.environment}, not ${target.aud}.`,
        "Check the app's FOREMAN audience and the target's enrollment.",
      );
    }
    return { protocol: 2, manifest: manifest.data };
  }

  return {
    negotiate,
    async manifest() {
      const negotiated = await negotiate();
      if (negotiated.protocol !== FOREMAN_PROTOCOL_VERSION) {
        throw new AdminError(
          ADMIN_ERROR_CODES.protocolUnsupported,
          `${target.aud} speaks only protocol 1.`,
          'Use fetchFleetSnapshot from @arki/admin/server for this target.',
        );
      }
      return negotiated.manifest;
    },
    async read(id, input, scopes) {
      return unwrap(
        await verified(await send({ use: 'read' }, 'POST', foremanPaths.read(id, basePath), { input }, scopes)),
      );
    },
    async preview(id, input, scopes) {
      const path = foremanPaths.preview(id, basePath);
      return unwrap(await verified(await send({ use: 'read' }, 'POST', path, { input }, scopes)));
    },
    async execute(id, input, { scopes, permit }) {
      const path = foremanPaths.execute(id, basePath);
      return unwrap(await verified(await send({ use: 'execute', permit }, 'POST', path, { input }, scopes)));
    },
  };
}
