/** Canonical client-owned outcomes; route-owned failures stay on each contract. */
import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { defineFailure, InvalidInput, REVIVAL_FAILURES } from '@arki/failure';

/** Framework request setup can refuse before a route handler or deriver runs. */
export const HTTP_SERVER_FAILURES = ID_GENERATION_FAILURES;

/** A fetch attempt failed to reach its destination.
 * @fix Check connectivity and retry only repeatable requests.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const NetworkFailure = defineFailure('http.network_failure', {
  status: 503,
  message: 'The HTTP request could not reach the server.',
  remediation: 'Check connectivity before retrying a repeatable request.',
});
/** The request did not receive a response before its deadline.
 * @fix Retry only repeatable requests or increase the deadline.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const RequestTimeout = defineFailure('http.request_timeout', {
  status: 408,
  message: 'The HTTP request exceeded its deadline.',
  remediation: 'Retry only if the request is safe to repeat.',
});
/** The caller cancelled the request.
 * @fix Start a new request if the result is still needed.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const RequestCancelled = defineFailure('http.request_cancelled', {
  status: 499,
  message: 'The HTTP request was cancelled.',
});
/** A protected write has no valid idempotency key.
 * @fix Supply one key per logical request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const IdempotencyKeyRequired = defineFailure('http.idempotency_key_required', {
  status: 400,
  message: 'A valid idempotency key is required.',
  remediation: 'Send a unique Idempotency-Key and reuse it only for the same request.',
});
/** The key identifies a different request.
 * @fix Use a new key for the different request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const IdempotencyKeyReused = defineFailure('http.idempotency_key_reused', {
  status: 422,
  message: 'The idempotency key was used for a different request.',
  remediation: 'Use a new key for a different request.',
});
/** The original protected write is still running.
 * @fix Wait for Retry-After before retrying the same request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const IdempotencyInProgress = defineFailure('http.idempotency_in_progress', {
  status: 409,
  message: 'A request with this idempotency key is still running.',
  remediation: 'Wait and send the same request again.',
});

export const IDEMPOTENCY_FAILURES = [
  IdempotencyKeyRequired,
  IdempotencyKeyReused,
  IdempotencyInProgress,
  ...ID_GENERATION_FAILURES,
] as const;

export const HTTP_CLIENT_FAILURES = [
  InvalidInput,
  ...REVIVAL_FAILURES,
  ...HTTP_SERVER_FAILURES,
  NetworkFailure,
  RequestTimeout,
  RequestCancelled,
] as const;
export type HttpClientFailure = ReturnType<(typeof HTTP_CLIENT_FAILURES)[number]>;
