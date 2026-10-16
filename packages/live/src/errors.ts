/** Stable codes for every error `@arki/live` throws, with the fix in `remediation`. */
export const LIVE_ERROR_CODES = {
  /** Bad meta, a path not in the manifest, a duplicate provider, bad options. */
  config: 'ARKI_LIVE_E001',
  /** Missing, disabled or incompatible triggers. */
  triggers: 'ARKI_LIVE_E002',
  /** The Postgres listener is unavailable. */
  source: 'ARKI_LIVE_E003',
  /** A malformed cursor, frame or payload. */
  protocol: 'ARKI_LIVE_E004',
  /** 401/403 on the stream. */
  auth: 'ARKI_LIVE_E005',
  /** A bounded resource was reached. */
  limit: 'ARKI_LIVE_E006',
} as const;

export type LiveErrorCode = (typeof LIVE_ERROR_CODES)[keyof typeof LIVE_ERROR_CODES];

export type LiveError = Error & { readonly code: LiveErrorCode; readonly remediation: string };

/** @internal Builds a {@link LiveError}. */
export function liveError(code: LiveErrorCode, message: string, remediation: string): LiveError {
  return Object.assign(new Error(`[${code}] ${message}`), { name: 'LiveError', code, remediation });
}

/** @internal Whether `error` is a {@link LiveError} (any code, or the one given). */
export function isLiveError(error: unknown, code?: LiveErrorCode): error is LiveError {
  if (!(error instanceof Error) || !('code' in error) || !('remediation' in error)) return false;
  const codes: readonly unknown[] = Object.values(LIVE_ERROR_CODES);
  return code === undefined ? codes.includes(error.code) : error.code === code;
}
