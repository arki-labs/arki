/**
 * The expected outcomes of the signed Foreman protocol and of the Coolify API, as returned
 * `@arki/failure` failures. A client call, a dispatcher step or a Coolify call returns one of these
 * when the other side refuses, cannot be reached or answers outside the contract. Match on
 * `failure.code`, never on the message.
 *
 * {@link AdminError} stays for bugs the caller can fix in code: invalid keys, a wrong module
 * definition, a client without an execute key.
 *
 * On the wire the protocol keeps its stable `ARKI_ADMIN_E0NN` code in the error body
 * ({@link ADMIN_ERROR_CODES}); {@link wireCodeOf} and {@link adminFailureOfWire} translate.
 */
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import type { AdminErrorCode } from './errors';
import { ADMIN_ERROR_CODES } from './errors';

/** What went wrong, in one sentence. Never a secret, a key or a body. */
const detailData = z.object({ detail: z.string() });
const detailMessage = (data: { detail: string }) => data.detail;

/** The request failed authentication. The wire carries no reason; the app logs which check failed.
 * @fix Check the Foreman key pair, the target audience and both clocks; the app log names the failed check.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminUnauthenticated = /* @__PURE__ */ defineFailure('admin.unauthenticated', {
  status: 401,
  data: detailData,
  message: detailMessage,
  remediation: 'Check the Foreman key pair, the target audience and both clocks; the app log names the failed check.',
});
/** The signed scopes do not cover the permission of the read or action.
 * @fix Sign the request with a scope that covers the permission.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminScopeDenied = /* @__PURE__ */ defineFailure('admin.scope_denied', {
  status: 403,
  data: detailData,
  message: detailMessage,
  remediation: 'Sign the request with a scope that covers the permission.',
});
/** The app runs with `FOREMAN_WRITES=off`, so it refuses every execute.
 * @fix Set FOREMAN_WRITES=on on the app when writes should be allowed again.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminWritesDisabled = /* @__PURE__ */ defineFailure('admin.writes_disabled', {
  status: 403,
  data: detailData,
  message: detailMessage,
  remediation: 'Set FOREMAN_WRITES=on on the app when writes should be allowed again.',
});
/** The approval pinned a different action contract than the app runs now, or an execution id belongs to another request.
 * @fix Preview and approve again against the current manifest.
 * @verify bun run test -- src/protocol.test.ts src/receipts.test.ts
 */
export const AdminStaleApproval = /* @__PURE__ */ defineFailure('admin.stale_approval', {
  status: 409,
  data: detailData,
  message: detailMessage,
  remediation: 'Preview and approve again against the current manifest.',
});
/** No route, read or action with that id on this app, or no resource at that Coolify path.
 * @fix Use a read or action id from the app's manifest.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminUnknownCapability = /* @__PURE__ */ defineFailure('admin.unknown_capability', {
  status: 404,
  data: detailData,
  message: detailMessage,
  remediation: "Use a read or action id from the app's manifest.",
});
/** An execute was refused before it ran because no receipt could be recorded.
 * @fix Configure a healthy receipt store, then propose the action again.
 * @verify bun run test -- src/receipts.test.ts
 */
export const AdminReceiptsUnavailable = /* @__PURE__ */ defineFailure('admin.receipts_unavailable', {
  status: 403,
  data: detailData,
  message: detailMessage,
  remediation: 'Configure a healthy receipt store, then propose the action again.',
});
/** An execute with this execution id is still running, or stopped before it recorded an outcome.
 * @fix Do not send it again; read core.receipts.get for its outcome.
 * @verify bun run test -- src/receipts.test.ts
 */
export const AdminExecutionInProgress = /* @__PURE__ */ defineFailure('admin.execution_in_progress', {
  status: 409,
  data: detailData,
  message: detailMessage,
  remediation: 'Do not send it again. Read core.receipts.get for its outcome.',
});
/** The input does not match the schema of the read or action, or the request body is not `{"input": ...}`.
 * @fix Send input accepted by the read or action input schema.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminInvalidRequest = /* @__PURE__ */ defineFailure('admin.invalid_request', {
  status: 400,
  data: detailData,
  message: detailMessage,
  remediation: 'Send input accepted by the read or action input schema.',
});
/** The other side does not speak the protocol version this side requires, or Coolify cannot keep a variable runtime-only.
 * @fix Use client and server versions supporting the same admin protocol.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminProtocolUnsupported = /* @__PURE__ */ defineFailure('admin.protocol_unsupported', {
  status: 400,
  data: detailData,
  message: detailMessage,
  remediation: 'Use client and server versions supporting the same admin protocol.',
});
/** A response did not prove it came from the expected target, so the client refused it.
 * @fix Check the target's base URL and the identity key recorded at enrollment; do not act on the response.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminTargetMismatch = /* @__PURE__ */ defineFailure('admin.target_mismatch', {
  status: 502,
  data: detailData,
  message: detailMessage,
  remediation: "Check the target's base URL and the identity key recorded at enrollment; do not act on this response.",
});
/** The target (or Coolify) could not be reached, or answered a redirect or a server error. The outcome is unknown.
 * @fix Check the target is up and reachable; inspect execution receipts before repeating a write.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminUnreachable = /* @__PURE__ */ defineFailure('admin.unreachable', {
  status: 502,
  data: detailData,
  message: detailMessage,
  remediation: 'Treat the outcome as unknown; check the target is up and reachable.',
});
/** A response is outside the contract: a body that is not protocol JSON, or a shape that does not match its schema.
 * @fix Upgrade the app or Coolify to a matching version.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminInvalidOutput = /* @__PURE__ */ defineFailure('admin.invalid_output', {
  status: 502,
  data: detailData,
  message: detailMessage,
  remediation: 'Upgrade the app to a matching @arki/admin version, or check the installed Coolify version.',
});
/** The app's own read, preview or execute code failed. Details stay in the app's log.
 * @fix Inspect the private application log and repair the failing handler.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminHandlerFailed = /* @__PURE__ */ defineFailure('admin.handler_failed', {
  status: 500,
  data: detailData,
  message: detailMessage,
  remediation: 'Inspect the private application log and repair the failing handler.',
});
/** The app refused with an error its module declared (its own code and HTTP status).
 * @fix Handle the module's code; it is documented by the module that declared it.
 * @verify bun run test -- src/protocol.test.ts
 */
export const AdminModuleRefused = /* @__PURE__ */ defineFailure('admin.module_refused', {
  status: 422,
  data: z.object({ code: z.string(), httpStatus: z.number().int(), detail: z.string(), remediation: z.string() }),
  message: data => data.detail,
});

/** One protocol failure and the stable wire code it travels under. */
const PROTOCOL_FAILURES = [
  [AdminInvalidRequest, ADMIN_ERROR_CODES.invalidInput],
  [AdminInvalidOutput, ADMIN_ERROR_CODES.invalidOutput],
  [AdminUnauthenticated, ADMIN_ERROR_CODES.unauthenticated],
  [AdminScopeDenied, ADMIN_ERROR_CODES.scopeDenied],
  [AdminWritesDisabled, ADMIN_ERROR_CODES.writesDisabled],
  [AdminStaleApproval, ADMIN_ERROR_CODES.staleApproval],
  [AdminUnknownCapability, ADMIN_ERROR_CODES.unknownCapability],
  [AdminTargetMismatch, ADMIN_ERROR_CODES.targetMismatch],
  [AdminProtocolUnsupported, ADMIN_ERROR_CODES.protocolUnsupported],
  [AdminHandlerFailed, ADMIN_ERROR_CODES.handlerFailed],
  [AdminUnreachable, ADMIN_ERROR_CODES.unreachable],
  [AdminReceiptsUnavailable, ADMIN_ERROR_CODES.receiptsUnavailable],
  [AdminExecutionInProgress, ADMIN_ERROR_CODES.executionInProgress],
] as const;

/** Every failure the protocol and the Coolify clients return. */
export const ADMIN_FAILURES = [...PROTOCOL_FAILURES.map(([failure]) => failure), AdminModuleRefused] as const;
export type AdminFailure = ReturnType<(typeof ADMIN_FAILURES)[number]>;

/** The `ARKI_ADMIN_E0NN` code a protocol failure travels under, or `undefined` for any other failure. */
export function wireCodeOf(failureCode: string): AdminErrorCode | undefined {
  return PROTOCOL_FAILURES.find(([failure]) => failure.code === failureCode)?.[1];
}

/** The protocol failure for a wire code (`detail` is its text), or `undefined` when the code is not a protocol code. */
export function adminFailureOfWire(wireCode: string, detail: string) {
  const entry = PROTOCOL_FAILURES.find(([, code]) => code === wireCode);
  return entry === undefined ? undefined : entry[0]({ detail });
}
