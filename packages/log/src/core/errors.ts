/**
 * Coded errors for mistakes in logging setup. A log call itself never throws
 * these unless it is given a level that does not exist.
 */

export const LOG_ERROR_CODES = {
  alreadyConfigured: 'ARKI_LOG_E001',
  unknownChannel: 'ARKI_LOG_E002',
  invalidLevel: 'ARKI_LOG_E003',
  fakeActive: 'ARKI_LOG_E004',
  staleHandle: 'ARKI_LOG_E005',
} as const;

export type LogErrorCode = (typeof LOG_ERROR_CODES)[keyof typeof LOG_ERROR_CODES];

export class LogError extends Error {
  readonly code: LogErrorCode;
  readonly remediation: string;

  constructor(args: { readonly code: LogErrorCode; readonly message: string; readonly remediation: string }) {
    super(`${args.code}: ${args.message}`);
    this.name = 'LogError';
    this.code = args.code;
    this.remediation = args.remediation;
  }
}

/** `configure()` ran a second time on the same `Logging`. */
export function alreadyConfiguredError(): LogError {
  return new LogError({
    code: LOG_ERROR_CODES.alreadyConfigured,
    message: 'Logging is already configured.',
    remediation:
      'Call configure() once, at the app entry. To change the setup later, call reconfigure() on the handle it returned; for an isolated setup, use createLogging().',
  });
}

/** A category rule or `to()` names a channel that `configure({ channels })` does not define. */
export function unknownChannelError(name: string, known: readonly string[]): LogError {
  return new LogError({
    code: LOG_ERROR_CODES.unknownChannel,
    message: `Channel "${name}" is not defined.`,
    remediation: `Add it to configure({ channels }) or use one of: ${known.length > 0 ? known.join(', ') : '(none defined)'}.`,
  });
}

/** A level is neither one of the six names nor an integer from 1 to 24. */
export function invalidLevelError(level: unknown): LogError {
  return new LogError({
    code: LOG_ERROR_CODES.invalidLevel,
    message: `Level ${typeof level === 'string' ? `"${level}"` : String(level)} does not exist.`,
    remediation: 'Use trace, debug, info, warn, error or fatal, or an OpenTelemetry severity number from 1 to 24.',
  });
}

/** `fakeLog()` ran while another fake was active, or `configure()` ran while a fake owns the instance. */
export function fakeActiveError(): LogError {
  return new LogError({
    code: LOG_ERROR_CODES.fakeActive,
    message: 'A fakeLog() is active on this Logging.',
    remediation: 'Restore the active fake first (restore() or `using`). One fake at a time.',
  });
}

/** `reconfigure()` was called on a handle whose configuration is no longer the active one. */
export function staleHandleError(): LogError {
  return new LogError({
    code: LOG_ERROR_CODES.staleHandle,
    message: 'This logging handle no longer owns the configuration: it was closed, or configure() ran again.',
    remediation: 'Use the handle returned by the latest configure() call.',
  });
}
