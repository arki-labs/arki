/**
 * JSON helpers behind the module contract: a validated JSON value type, a
 * canonical serialisation, and `schemaHash` — the fingerprint approvals pin.
 *
 * Isomorphic: hashing uses Web Crypto (`globalThis.crypto.subtle`), present in
 * Node, Bun, Deno and browsers.
 */
import { z } from '@arki/contracts';

import { ADMIN_ERROR_CODES, AdminError } from './errors.ts';

/** Any JSON value. Validates finite numbers and plain objects/arrays only. */
export const jsonValueSchema = z.json();

/** A JSON object — what JSON Schemas and manifest metadata are made of. */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonValue = z.output<typeof jsonValueSchema>;
export type JsonObject = z.output<typeof jsonObjectSchema>;

/**
 * Serialise a JSON value with object keys sorted at every level, so two
 * structurally equal values always produce the same string.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of {@link canonicalJson}, as `sha256:<64 hex chars>`. Key order in
 * the input does not change the hash; any other change does.
 */
export async function schemaHash(value: JsonValue): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalJson(value)));
}

/** SHA-256 of raw bytes, as `sha256:<64 hex chars>` — the same format as {@link schemaHash}. */
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await requireWebCrypto().subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/** The runtime's Web Crypto, or an `ARKI_ADMIN_E006` error when it has none. */
export function requireWebCrypto(): Crypto {
  const webCrypto = findWebCrypto();
  if (webCrypto === undefined) {
    throw new AdminError(
      ADMIN_ERROR_CODES.webCryptoUnavailable,
      'This runtime has no Web Crypto, so hashes and signatures cannot be computed.',
      'Run on Node 20+, Bun, Deno or a browser.',
    );
  }
  return webCrypto;
}

/** Typed as optional on purpose: Hermes and older runtimes have no `globalThis.crypto`. */
function findWebCrypto(): Crypto | undefined {
  return globalThis.crypto;
}
