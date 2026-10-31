/**
 * The failures a TanStack Start server answers with, in the same wire envelope
 * `@arki/http` and `@arki/auth` use: `{ error: { code, message } }`.
 */
import type { Failure } from '@arki/failure';
import { defineFailure, isFailure } from '@arki/failure';

/**
 * A cron call without the right bearer secret. One answer for every cause, so a
 * caller cannot tell a missing header from a wrong scheme or a wrong secret.
 * @fix Send `Authorization: Bearer <the cron secret>`.
 * @verify bun run test -- src/mounts.test.ts
 */
export const CronUnauthenticated = /* @__PURE__ */ defineFailure('tanstack_start.unauthenticated', {
  status: 401,
  message: 'Sign in to continue.',
});

/**
 * A request crashed, or an identity lookup (`rpc`, `session`) threw instead of returning a failure.
 * The cause stays in the logs.
 * @fix Make identity callbacks return `null` or an `@arki/failure` failure for expected outcomes. Read the server log for the crash.
 * @verify bun run test -- src/mounts.test.ts
 */
export const RequestCrashed = /* @__PURE__ */ defineFailure('tanstack_start.internal', {
  status: 500,
  message: 'Internal Server Error',
});

/**
 * The application did not boot, so it cannot serve. Callers should retry later.
 * @fix Read the boot failure in the server log.
 * @verify bun run test -- src/start-server.test.ts
 */
export const ApplicationUnavailable = /* @__PURE__ */ defineFailure('tanstack_start.unavailable', {
  status: 503,
  message: 'Service temporarily unavailable',
});

/** The wire envelope of a failure: status, code and message only. Causes and data stay server-side. */
export function failureResponse(failure: Failure): Response {
  return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
}

/**
 * The answer for a value thrown while a request's identity is resolved. An `@arki/failure`
 * failure (such as an authentication refusal) answers with its own status and code;
 * anything else is a crash, masked as {@link RequestCrashed}.
 */
export function thrownResponse(thrown: unknown): Response {
  return failureResponse(isFailure(thrown) ? thrown : RequestCrashed());
}
