import { getLogger } from '@arki/log';

/** The package logger. Show its debug output with `DEBUG=arki:mail`. */
export const log = getLogger('arki:mail');

/** A caught value as a loggable field: errors as they are, anything else as an `Error` around its text. */
export const errorField = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
