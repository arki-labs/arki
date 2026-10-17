import { createLogging, memorySink, redact } from '../src/core/index.js';

// #region redact-checkout
const logging = createLogging();
export const sink = memorySink();

logging.configure({
  channels: { memory: sink },
  default: { level: 'info', channels: ['memory'] },
  processors: [redact(['password'])],
});

/** Logs a sign-in. The password never reaches the sink. */
export function signIn(userId: string, password: string): void {
  logging.getLogger('app:auth').info('user {userId} signed in', { userId, password });
}
// #endregion
