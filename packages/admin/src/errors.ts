/**
 * Every failure `@arki/admin/module` raises on purpose is an {@link AdminError}
 * with a stable `code`. Match on the code, never on the message.
 */

/** Stable error codes of `@arki/admin`. */
export const ADMIN_ERROR_CODES = {
  /** A module, read, action or signal definition broke the contract (bad id, permission, version, schema). */
  invalidDefinition: 'ARKI_ADMIN_E001',
  /** Two reads/actions, two signals or two panels of one module share an id. */
  duplicateId: 'ARKI_ADMIN_E002',
  /** A panel names a read or action key the module does not define. */
  unknownReference: 'ARKI_ADMIN_E003',
  /** A caller sent input that does not match the read/action input schema. */
  invalidInput: 'ARKI_ADMIN_E004',
  /** The app's own `load`/`preview`/`execute` returned data that does not match its output schema. */
  invalidOutput: 'ARKI_ADMIN_E005',
  /** The runtime has no Web Crypto (`globalThis.crypto.subtle`), so `schemaHash` cannot run. */
  webCryptoUnavailable: 'ARKI_ADMIN_E006',
  /**
   * A protocol-2 request failed authentication: missing or bad signature, wrong key for the
   * operation, wrong audience, clock skew, body mismatch or replayed nonce. The app logs which
   * check failed; the wire carries only this code (HTTP 401).
   */
  unauthenticated: 'ARKI_ADMIN_E007',
  /** The signed scopes do not cover the read's or action's permission (HTTP 403). */
  scopeDenied: 'ARKI_ADMIN_E008',
  /** The app runs with `FOREMAN_WRITES=off`, so every execute is refused (HTTP 403). */
  writesDisabled: 'ARKI_ADMIN_E009',
  /** The approval pinned a different `schemaHash` than the action has now (HTTP 409). */
  staleApproval: 'ARKI_ADMIN_E010',
  /** No route, read or action with that id on this app (HTTP 404). */
  unknownCapability: 'ARKI_ADMIN_E011',
  /** A response did not prove it came from the expected target (`aud`), so the client rejected it. */
  targetMismatch: 'ARKI_ADMIN_E012',
  /** The other side does not speak the protocol version this side requires. */
  protocolUnsupported: 'ARKI_ADMIN_E013',
  /** Keys, audience or other dispatcher/client configuration is invalid. Raised at construction. */
  invalidConfig: 'ARKI_ADMIN_E014',
  /** The app's own read/preview/execute code threw (HTTP 500). Details stay in the app's log. */
  handlerFailed: 'ARKI_ADMIN_E015',
  /** The client could not reach the target (network error or timeout). Outcome unknown. */
  unreachable: 'ARKI_ADMIN_E016',
} as const;

/** The code of an {@link AdminError}. */
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[keyof typeof ADMIN_ERROR_CODES];

/** A coded failure of the Foreman module contract. */
export class AdminError extends Error {
  readonly code: AdminErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: AdminErrorCode, message: string, remediation: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'AdminError';
    this.code = code;
    this.remediation = remediation;
  }
}
