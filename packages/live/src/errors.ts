/** Stable codes for every error `@arki/live` throws, with the fix in `remediation`. */
export const LIVE_ERROR_CODES = {
  /**
   * Bad meta, a path not in the manifest, a duplicate provider, bad options.
   *
   * @fix Fix the option or declaration named in the message. A procedure that calls `liveRead()` needs `live({ reads })` in its meta.
   * @verify bun run test -- src/dot.test.ts
   */
  config: 'ARKI_LIVE_E001',
  /**
   * Missing, disabled or incompatible triggers.
   *
   * @fix Apply the SQL from `liveMigration({ app, tables })` in a Drizzle custom migration, then enable the triggers.
   * @verify bun run test -- src/dot.test.ts
   */
  triggers: 'ARKI_LIVE_E002',
  /**
   * The Postgres listener is unavailable.
   *
   * @fix Check the listener's pool and the database connection. The hub is ready again after the next `ready` from the source.
   * @verify bun run test -- src/dot.test.ts
   */
  source: 'ARKI_LIVE_E003',
  /**
   * A malformed cursor, frame or payload.
   *
   * @fix Do not build cursors or frames by hand. Pass back the cursor the server gave you. A client without a streaming `fetch` body needs one, such as `expo/fetch` in React Native.
   * @verify bun run test -- src/client.test.ts
   */
  protocol: 'ARKI_LIVE_E004',
  /**
   * 401/403 on the stream.
   *
   * @fix Sign the user in again. The client stops on this code and does not retry.
   * @verify bun run test -- src/http.test.ts
   */
  auth: 'ARKI_LIVE_E005',
  /**
   * A bounded resource was reached.
   *
   * @fix Raise the limit that the message names, or reduce the load. `awaitTxId` and `waitForInvalidation` also fail with this code after their timeout.
   * @verify bun run test -- src/client.test.ts
   */
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
