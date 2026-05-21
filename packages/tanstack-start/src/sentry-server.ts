/**
 * Server-side Sentry initialization for TanStack Start apps.
 *
 * Call once at the top of `src/entry-server.ts(x)` before any other
 * imports — Sentry's Node SDK relies on instrumenting modules at load
 * time. Importing the router or business logic before `initSentryServer`
 * means those modules won't be wrapped.
 *
 * `sentryGlobalRequestMiddleware`, `sentryGlobalFunctionMiddleware`, and
 * `wrapMiddlewaresWithSentry` from `@sentry/tanstackstart-react` are
 * re-exported for convenience — apps wire them into TanStack Start's
 * global middleware registry to instrument server functions and route
 * loaders.
 *
 * If `dsn` is omitted/falsy this is a no-op.
 */
import type { Integration } from '@sentry/core';
import * as Sentry from '@sentry/node';

import { registerSentryCapture } from './sentry-bridge';

export type InitSentryServerOptions = {
  dsn?: string;
  environment?: string;
  release?: string;
  /** Server-side tracing rate. Defaults to `1.0` in dev, `0.1` in prod. */
  tracesSampleRate?: number;
  /** Extra integrations merged with defaults. */
  integrations?: Integration[];
};

const isDev = process.env.NODE_ENV !== 'production';

export function initSentryServer(options: InitSentryServerOptions): void {
  const {
    dsn,
    environment = process.env.NODE_ENV ?? 'development',
    release,
    tracesSampleRate = isDev ? 1.0 : 0.1,
    integrations: extraIntegrations = [],
  } = options;

  if (!dsn) return;

  Sentry.init({
    dsn,
    environment,
    release,
    integrations: [...extraIntegrations],
    tracesSampleRate,
    sendDefaultPii: false,
  });

  registerSentryCapture((error, hint) => {
    Sentry.captureException(error, hint as Parameters<typeof Sentry.captureException>[1]);
  });
}

// Sentry@10 introduced middleware-based instrumentation for TanStack Start.
// These helpers are passed to TanStack Start's global middleware registry
// (`createMiddleware().server(...)`) to wrap server functions and route
// loaders. See https://docs.sentry.io/platforms/javascript/guides/tanstackstart-react/.
export {
  sentryGlobalFunctionMiddleware,
  sentryGlobalRequestMiddleware,
  wrapFetchWithSentry,
  wrapMiddlewaresWithSentry,
} from '@sentry/tanstackstart-react';
export { Sentry };
