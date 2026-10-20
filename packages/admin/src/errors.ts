/**
 * Every failure `@arki/admin/module` raises on purpose is an {@link AdminError}
 * with a stable `code`. Match on the code, never on the message.
 */

/** Stable error codes of `@arki/admin`. */
export const ADMIN_ERROR_CODES = {
  /** A module, read, action or signal definition broke the contract (bad id, permission, version, schema).
   * @fix Correct the reported module definition field: use valid ids, permissions, versions and schemas.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  invalidDefinition: 'ARKI_ADMIN_E001',
  /** Two reads/actions, two signals or two panels of one module share an id.
   * @fix Give each read, action, signal and panel a unique id within its namespace.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  duplicateId: 'ARKI_ADMIN_E002',
  /** A panel names a read or action key the module does not define.
   * @fix Reference a read or action key declared by the same module.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  unknownReference: 'ARKI_ADMIN_E003',
  /** A caller sent input that does not match the read/action input schema.
   * @fix Send input accepted by the read or action input schema.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  invalidInput: 'ARKI_ADMIN_E004',
  /** The app's own `load`/`preview`/`execute` returned data that does not match its output schema.
   * @fix Return output accepted by the declared load, preview or execute output schema.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  invalidOutput: 'ARKI_ADMIN_E005',
  /** The runtime has no Web Crypto (`globalThis.crypto.subtle`), so `schemaHash` cannot run.
   * @fix Run schemaHash in a runtime exposing globalThis.crypto.subtle.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  webCryptoUnavailable: 'ARKI_ADMIN_E006',
  /**
   * A protocol-2 request failed authentication: missing or bad signature, wrong key for the
   * operation, wrong audience, clock skew, body mismatch or replayed nonce. The app logs which
   * check failed; the wire carries only this code (HTTP 401).
   * @fix Check the private authentication log; correct the signing key, audience, clock and request body, and issue a fresh nonce.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  unauthenticated: 'ARKI_ADMIN_E007',
  /** The signed scopes do not cover the read's or action's permission (HTTP 403).
   * @fix Grant the signed request the declared capability permission using an authorized scope.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  scopeDenied: 'ARKI_ADMIN_E008',
  /** The app runs with `FOREMAN_WRITES=off`, so every execute is refused (HTTP 403).
   * @fix Enable FOREMAN_WRITES only for the intended target before executing an approved write.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  writesDisabled: 'ARKI_ADMIN_E009',
  /** The approval pinned a different `schemaHash` than the action has now (HTTP 409).
   * @fix Preview the current action schema and obtain fresh approval for its schemaHash.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  staleApproval: 'ARKI_ADMIN_E010',
  /** No route, read or action with that id on this app (HTTP 404).
   * @fix Refresh the target manifest and use an advertised route, read or action id.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  unknownCapability: 'ARKI_ADMIN_E011',
  /** A response did not prove it came from the expected target (`aud`), so the client rejected it.
   * @fix Correct the configured target audience and verify the response comes from that target.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  targetMismatch: 'ARKI_ADMIN_E012',
  /** The other side does not speak the protocol version this side requires.
   * @fix Use client and server versions supporting the same admin protocol.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  protocolUnsupported: 'ARKI_ADMIN_E013',
  /** Keys, audience or other dispatcher/client configuration is invalid. Raised at construction.
   * @fix Correct the dispatcher or client keys, audience and reported configuration fields before construction.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  invalidConfig: 'ARKI_ADMIN_E014',
  /** The app's own read/preview/execute code threw (HTTP 500). Details stay in the app's log.
   * @fix Inspect the private application log and repair the failing read, preview or execute handler.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  handlerFailed: 'ARKI_ADMIN_E015',
  /** The client could not reach the target (network error or timeout). Outcome unknown.
   * @fix Restore target connectivity and inspect execution receipts before repeating a write whose outcome is unknown.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  unreachable: 'ARKI_ADMIN_E016',
  /**
   * An execute was refused before it ran because no receipt could be recorded: writes are on
   * but no receipt store is configured, or the store could not take the claim (HTTP 403).
   * @fix Configure a healthy receipt store and restore claim persistence before executing writes.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  receiptsUnavailable: 'ARKI_ADMIN_E017',
  /** An execute with this execution id is still running, or stopped before it recorded an outcome (HTTP 409).
   * @fix Inspect the receipt for the original execution id; wait for completion or reconcile the interrupted outcome before another write.
   * @verify bun run test -- src/module.test.ts src/protocol.test.ts src/receipts.test.ts
   */
  executionInProgress: 'ARKI_ADMIN_E018',
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

/**
 * A coded refusal a module declares itself. `code` is the module's own (`ARKI_JOURNAL_E001`);
 * the dispatcher answers it with `status` and never learns what it means. Build one with {@link moduleError}.
 */
export class ModuleError extends Error {
  readonly code: string;
  /** The HTTP status of the answer: 400 to 599. */
  readonly status: number;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: string, status: number, message: string, remediation: string) {
    super(`${code}: ${message}`);
    this.name = 'ModuleError';
    this.code = code;
    this.status = status;
    this.remediation = remediation;
  }
}

/** A module's own coded failure. Server error messages are private at the dispatcher boundary. */
export function moduleError(code: string, status: number, message: string, remediation: string): ModuleError {
  if (code.trim() === '') {
    throw new AdminError(ADMIN_ERROR_CODES.invalidConfig, 'A module error needs a code.', 'Pass the module\'s own code.');
  }
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      `Module error ${code} has status ${String(status)}; use an HTTP error status, 400 to 599.`,
      'Use an HTTP error status from 400 to 599.',
    );
  }
  return new ModuleError(code, status, message, remediation);
}

export function isModuleError(error: unknown): error is ModuleError {
  return error instanceof ModuleError;
}
