/**
 * Foreman protocol 2 — the wire format the app-side dispatcher (`./server`)
 * and the Foreman-side client (`./client`) share.
 *
 * Requests carry a signed envelope in two headers:
 *  - `x-foreman-envelope`: base64url of the envelope's UTF-8 JSON bytes.
 *  - `x-foreman-signature`: base64url Ed25519 signature over
 *    `"arki-foreman/2 request\n" + those bytes`.
 * The app verifies the exact bytes it received, then parses them, so there is
 * no canonicalisation step to get wrong.
 *
 * Every response carries a proof signed by the app's own identity key:
 *  - `x-foreman-proof`: base64url JSON `{ v, aud, nonce, status, bodySha256 }`.
 *  - `x-foreman-proof-signature`: Ed25519 over `"arki-foreman/2 response\n" + proof`.
 * The proof echoes the request nonce, so a response cannot be replayed onto
 * another request or come from another target.
 *
 * Keys: Foreman holds two Ed25519 private keys per environment — read
 * (manifest, reads, previews) and execute (executes only). The app holds both
 * public keys plus its own identity private key. Public keys are base64url of
 * the 32 raw bytes; private keys are base64url of PKCS#8 (48 bytes).
 *
 * Isomorphic: Web Crypto only (`globalThis.crypto.subtle` with Ed25519).
 */
import { z } from '@arki/contracts';

import { ADMIN_ERROR_CODES, AdminError } from './errors.ts';
import { jsonValueSchema, requireWebCrypto } from './json.ts';
import { moduleDescriptionSchema } from './module.ts';

/** The protocol version this module speaks. Protocol 1 is `GET /api/fleet` with a Bearer token. */
export const FOREMAN_PROTOCOL_VERSION = 2;

/** Where an app mounts the protocol-2 dispatcher by default. */
export const FOREMAN_BASE_PATH = '/api/foreman';

/** Header names of protocol 2. */
export const FOREMAN_HEADERS = {
  protocol: 'x-foreman-protocol',
  envelope: 'x-foreman-envelope',
  signature: 'x-foreman-signature',
  proof: 'x-foreman-proof',
  proofSignature: 'x-foreman-proof-signature',
} as const;

/** Largest accepted difference between the envelope's `iat` and the app's clock, either direction. */
export const MAX_CLOCK_SKEW_MS = 60_000;

/** How long a seen nonce is remembered (RFC § 3.4: 5 min). Must exceed the skew window on both sides (2 × 60 s). */
export const NONCE_TTL_SECONDS = 300;

/** Paths of the protocol-2 routes under a base path. */
export const foremanPaths = {
  manifest: (basePath: string = FOREMAN_BASE_PATH) => `${basePath}/manifest`,
  read: (id: string, basePath: string = FOREMAN_BASE_PATH) => `${basePath}/reads/${id}`,
  preview: (id: string, basePath: string = FOREMAN_BASE_PATH) => `${basePath}/actions/${id}/preview`,
  execute: (id: string, basePath: string = FOREMAN_BASE_PATH) => `${basePath}/actions/${id}/execute`,
};

const REQUEST_CONTEXT = 'arki-foreman/2 request\n';
const RESPONSE_CONTEXT = 'arki-foreman/2 response\n';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SEGMENT_PATTERN = /^[a-z][\da-z-]*$/;
const AUDIENCE_PATTERN = /^[a-z][\da-z-]*:[a-z][\da-z-]*$/;
/** `area:verb` like a permission, or a wildcard tail such as `queue:*`. */
const SCOPE_PATTERN = /^[a-z][\da-z-]*(?::[a-z][\da-z-]*)*:(?:[a-z][\da-z-]*|\*)$/;
const SHA256_PATTERN = /^sha256:[\da-f]{64}$/;
const NONCE_PATTERN = /^[\w-]{22,128}$/;

/** The one environment vocabulary of Foreman targets, apps and audiences (RFC § 3.4). */
export const foremanEnvironmentSchema = z.enum(['prod', 'staging', 'dev']);
export type ForemanEnvironment = z.output<typeof foremanEnvironmentSchema>;

/** Target identity: `${appId}:${environment}`, e.g. `shop:prod`. The environment is `prod`, `staging` or `dev`. */
export const audienceSchema = z
  .string()
  .regex(AUDIENCE_PATTERN, 'Use "appId:environment" such as "shop:prod".')
  .refine(
    audience => foremanEnvironmentSchema.safeParse(audience.slice(audience.indexOf(':') + 1)).success,
    'The environment is prod, staging or dev, such as "shop:prod".',
  );

/** An Ed25519 public key: base64url of its 32 raw bytes. */
export const publicKeySchema = z.string().regex(/^[\w-]{43}$/, 'Use the base64url of a 32-byte Ed25519 public key.');

/** An Ed25519 private key: base64url of its 48-byte PKCS#8 encoding. */
export const privateKeySchema = z
  .string()
  .regex(/^[\w-]{64}$/, 'Use the base64url of a 48-byte PKCS#8 Ed25519 private key.');

/** A signed scope: a permission (`queue:write`) or a wildcard tail (`queue:*`). */
export const scopeSchema = z.string().regex(SCOPE_PATTERN, 'Use "area:verb" or "area:*".');

const sha256Schema = z.string().regex(SHA256_PATTERN);

/** The id Foreman gives one execution. It keys the app's receipt for that execution. */
export const executionIdSchema = z.string().min(1).max(128);

/** What an execute envelope carries from the approval. The dispatcher turns it into a `Permit`. */
export const permitClaimSchema = z.strictObject({
  executionId: executionIdSchema,
  /** The preview `revision` the approval pinned. */
  expectedRevision: z.string().min(1).max(256),
  approvedBy: z.string().min(1).max(256),
  /** The action's `schemaHash` when it was approved. Any contract change voids the approval. */
  schemaHash: sha256Schema,
});

const envelopeFields = {
  v: z.literal(FOREMAN_PROTOCOL_VERSION),
  aud: audienceSchema,
  /** Issued-at, whole seconds since the epoch. */
  iat: z.number().int().nonnegative(),
  nonce: z.string().regex(NONCE_PATTERN),
  method: z.enum(['GET', 'POST']),
  /** URL pathname plus search, exactly as the app receives it. */
  path: z
    .string()
    .regex(/^\/\S*$/)
    .max(1024),
  bodySha256: sha256Schema,
  scopes: z.array(scopeSchema).max(64),
};

/**
 * The signed request envelope. `use` names the key that signed it; the app
 * verifies against that key ring only and the route decides which `use` it
 * accepts, so a read-key signature can never authorize an execute.
 */
export const envelopeSchema = z.discriminatedUnion('use', [
  z.strictObject({ ...envelopeFields, use: z.literal('read') }),
  z.strictObject({ ...envelopeFields, use: z.literal('execute'), permit: permitClaimSchema }),
]);

/** The app's signed statement about one response. */
export const responseProofSchema = z.strictObject({
  v: z.literal(FOREMAN_PROTOCOL_VERSION),
  aud: audienceSchema,
  /** The request's nonce; empty when the request had none the app could read. */
  nonce: z.string().max(128),
  status: z.number().int().min(100).max(599),
  bodySha256: sha256Schema,
});

/** Request body of reads, previews and executes. */
export const requestBodySchema = z.strictObject({ input: jsonValueSchema });

/** Success response body. */
export const successBodySchema = z.strictObject({ data: jsonValueSchema });

/** Error response body. `code` is one of {@link ADMIN_ERROR_CODES}, or a module's own code. */
export const errorBodySchema = z.strictObject({
  error: z.strictObject({ code: z.string().min(1).max(64), message: z.string(), remediation: z.string() }),
});

/** Whether the app accepts executes (`FOREMAN_WRITES`). */
export const writesModeSchema = z.enum(['on', 'off']);

/** How a provider-backed capability is reachable. */
export const providerReadinessSchema = z.enum(['api', 'handoff', 'unsupported']);

/** `GET /api/foreman/manifest` — what an app reports about itself (RFC § 3.3). */
export const foremanManifestSchema = z.object({
  protocol: z.literal(FOREMAN_PROTOCOL_VERSION),
  app: z.object({
    id: z.string().regex(SEGMENT_PATTERN),
    version: z.string().min(1),
    commit: z.string().min(1).optional(),
    environment: foremanEnvironmentSchema,
  }),
  packages: z.record(z.string(), z.string()),
  modules: z.array(moduleDescriptionSchema),
  readiness: z.object({ writes: writesModeSchema, providers: z.record(z.string(), providerReadinessSchema) }),
});

export type Envelope = z.output<typeof envelopeSchema>;
/** Which key signed an envelope. */
export type KeyUse = Envelope['use'];
export type PermitClaim = z.output<typeof permitClaimSchema>;
export type ResponseProof = z.output<typeof responseProofSchema>;
export type WritesMode = z.output<typeof writesModeSchema>;
export type ProviderReadiness = z.output<typeof providerReadinessSchema>;
export type ForemanManifest = z.output<typeof foremanManifestSchema>;
export type ErrorBody = z.output<typeof errorBodySchema>;

/** Whether one signed scope covers a permission: equal, or a `prefix:*` wildcard over it. */
export function scopeCovers(scope: string, permission: string): boolean {
  if (scope === permission) return true;
  return scope.endsWith(':*') && permission.startsWith(scope.slice(0, -1));
}

// ---------------------------------------------------------------------------
// Bytes and keys
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** base64url (no padding) of bytes. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Bytes of a base64url string, or `undefined` when it is not valid base64url. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[\w-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
  return bytes;
}

/** Parse JSON bytes. `undefined` when they are not JSON. */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value;
  } catch {
    return undefined;
  }
}

/** A fresh 128-bit nonce, base64url. */
export function randomNonce(): string {
  return toBase64Url(requireWebCrypto().getRandomValues(new Uint8Array(16)));
}

function keyBytes(text: string, size: number, label: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64Url(text);
  if (bytes?.length !== size) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      `The ${label} is not ${String(size)} bytes of base64url.`,
      'Generate keys with generateForemanKeyPair() and copy them unchanged.',
    );
  }
  return bytes;
}

/** Import an Ed25519 public key for verifying. */
export async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return requireWebCrypto().subtle.importKey('raw', keyBytes(publicKey, 32, 'public key'), 'Ed25519', false, [
    'verify',
  ]);
}

/** Import an Ed25519 private key for signing. Non-extractable. */
export async function importPrivateKey(privateKey: string): Promise<CryptoKey> {
  return requireWebCrypto().subtle.importKey('pkcs8', keyBytes(privateKey, 48, 'private key'), 'Ed25519', false, [
    'sign',
  ]);
}

/** The canonical base64url of a public key, so two spellings of the same bytes compare equal. */
export function normalizePublicKey(publicKey: string): string {
  return toBase64Url(keyBytes(publicKey, 32, 'public key'));
}

/**
 * A new Ed25519 key pair in the protocol's string formats. Use it for the
 * Foreman read and execute keys and for each app's identity key.
 */
export async function generateForemanKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const subtle = requireWebCrypto().subtle;
  const pair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const [publicKey, privateKey] = await Promise.all([
    subtle.exportKey('raw', pair.publicKey),
    subtle.exportKey('pkcs8', pair.privateKey),
  ]);
  return { publicKey: toBase64Url(new Uint8Array(publicKey)), privateKey: toBase64Url(new Uint8Array(privateKey)) };
}

function withContext(context: string, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = utf8(context);
  const message = new Uint8Array(prefix.length + bytes.length);
  message.set(prefix);
  message.set(bytes, prefix.length);
  return message;
}

async function sign(key: CryptoKey, context: string, bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await requireWebCrypto().subtle.sign('Ed25519', key, withContext(context, bytes)));
}

async function verify(
  key: CryptoKey,
  context: string,
  signature: Uint8Array<ArrayBuffer>,
  bytes: Uint8Array,
): Promise<boolean> {
  return requireWebCrypto().subtle.verify('Ed25519', key, signature, withContext(context, bytes));
}

/** Sign request-envelope bytes. */
export function signEnvelope(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return sign(key, REQUEST_CONTEXT, bytes);
}

/** Whether any key of a ring signed these request-envelope bytes. */
export async function verifyEnvelope(
  keys: readonly CryptoKey[],
  signature: Uint8Array<ArrayBuffer>,
  bytes: Uint8Array,
): Promise<boolean> {
  for (const key of keys) {
    if (await verify(key, REQUEST_CONTEXT, signature, bytes)) return true;
  }
  return false;
}

/** Sign response-proof bytes with the app's identity key. */
export function signProof(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return sign(key, RESPONSE_CONTEXT, bytes);
}

/** Whether the app's identity key signed these response-proof bytes. */
export function verifyProof(key: CryptoKey, signature: Uint8Array<ArrayBuffer>, bytes: Uint8Array): Promise<boolean> {
  return verify(key, RESPONSE_CONTEXT, signature, bytes);
}
