/**
 * What Sentry may collect, shared by the browser and server init.
 *
 * Sentry 11 replaced `sendDefaultPii` with `dataCollection`, and every field
 * of it defaults to ON: user info (including the IP), cookies, headers,
 * request/response bodies, query strings, DB query parameters, queue job
 * arguments, AI prompts and local variables in stack frames. Leaving it unset
 * would send all of that. This turns each one off so an error report carries
 * the stack trace and nothing a user typed or owns.
 */
import type { DataCollection } from '@sentry/core';

export const sentryDataCollection: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};
