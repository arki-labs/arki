/** Callback exceptions are defects; transaction-driver failures belong to the transaction owner. */
import { UnexpectedDefect } from '@arki/failure';

import { isJournalError } from './errors.js';

export function callbackDefect(cause: unknown): ReturnType<typeof UnexpectedDefect> {
  // Lease interruption keeps its fenced recovery path; other callback misuse is fatal by default.
  if (isJournalError(cause, 'LEASE_LOST')) throw cause;
  return UnexpectedDefect({ cause });
}
