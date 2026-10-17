/**
 * Stable error codes. Boot mistakes (`E001`–`E003`, `E007`) throw while the auth is built; `E008`
 * is a procedure whose contract does not declare its policy; the rest are request-time failures
 * that the transports turn into their wire shape.
 */
export const AUTH_ERROR_CODES = {
  /** Unknown method, missing provider credentials, unknown `user.fields` name, bad duration. */
  invalidConfig: 'ARKI_AUTH_E001',
  /** The secret is missing or shorter than `AUTH_SECRET_MIN_LENGTH` in production. */
  weakSecret: 'ARKI_AUTH_E002',
  /** A method sends mail and no mailer was given. */
  mailRequired: 'ARKI_AUTH_E003',
  /** The engine's user lacks a column the definition exposes. */
  principalShape: 'ARKI_AUTH_E004',
  /** A testing helper was called while `production` is true. */
  testingInProduction: 'ARKI_AUTH_E005',
  /** The mailer failed to send an auth mail. */
  mailFailed: 'ARKI_AUTH_E006',
  /** A feature is on without its tables (`workspaces`). */
  tableMissing: 'ARKI_AUTH_E007',
  /** A procedure checks a policy its contract meta does not declare (`.meta({ policy })`). A bug. */
  policyNotDeclared: 'ARKI_AUTH_E008',
  /** No principal, or a cookie and a bearer token on one request. */
  unauthenticated: 'ARKI_AUTH_E401',
  /** A `role()` or `verified` check refused the principal. */
  forbidden: 'ARKI_AUTH_E403',
  /** The rate limiter refused the request. */
  rateLimited: 'ARKI_AUTH_E429',
  /** The rate-limit store failed, so the request is refused rather than let through. */
  storeUnavailable: 'ARKI_AUTH_E503',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/** The HTTP status each code answers with. Boot codes are 500: they are bugs, never user input. */
const STATUS_BY_CODE: Readonly<Record<AuthErrorCode, number>> = {
  ARKI_AUTH_E001: 500,
  ARKI_AUTH_E002: 500,
  ARKI_AUTH_E003: 500,
  ARKI_AUTH_E004: 500,
  ARKI_AUTH_E005: 500,
  ARKI_AUTH_E006: 500,
  ARKI_AUTH_E007: 500,
  ARKI_AUTH_E008: 500,
  ARKI_AUTH_E401: 401,
  ARKI_AUTH_E403: 403,
  ARKI_AUTH_E429: 429,
  ARKI_AUTH_E503: 503,
};

/** An auth failure with a stable code and the HTTP status it answers with. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  /** Seconds before a rate-limited (`E429`) attempt may be retried, when the limiter says. */
  readonly retryAfter: number | undefined;

  constructor(code: AuthErrorCode, message: string, options?: ErrorOptions & { readonly retryAfter?: number }) {
    super(message, options);
    this.name = 'AuthError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryAfter = options?.retryAfter;
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
