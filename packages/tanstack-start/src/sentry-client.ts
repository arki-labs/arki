/**
 * Browser-side Sentry initialization for TanStack Start apps.
 *
 * Call once at the top of `src/entry-client.tsx`, BEFORE importing the
 * router. Order matters: Sentry instruments globals (fetch, history,
 * unhandled errors) when `init()` runs, and anything imported earlier
 * is missed.
 *
 * Sentry is **opt-in via DSN**. When `dsn` is missing, empty, whitespace-only,
 * or causes `Sentry.init` to throw (e.g. malformed URL), `initSentryClient`
 * silently disables Sentry for the app. That lets every app call this
 * unconditionally — `initSentryClient({ dsn: import.meta.env.VITE_SENTRY_DSN })` —
 * with Sentry activating only when a valid DSN is actually set.
 */
import type { Integration } from '@sentry/core';
import * as Sentry from '@sentry/react';

import { registerSentryCapture } from './sentry-bridge';
import { sentryDataCollection } from './sentry-data-collection';

export type InitSentryClientOptions = {
  /**
   * Sentry DSN. When missing, empty, whitespace-only, or malformed,
   * `initSentryClient` is a silent no-op. Typically set via
   * `import.meta.env.VITE_SENTRY_DSN`.
   */
  dsn?: string | null;
  /**
   * Sentry environment tag (e.g. 'production', 'staging'). Defaults to
   * `import.meta.env.MODE`.
   */
  environment?: string;
  /**
   * App release identifier (e.g. git SHA). Optional but recommended in
   * production for correlating events to deploys.
   */
  release?: string;
  /**
   * Tracing sample rate in [0, 1]. Defaults to `1.0` in dev and `0.1`
   * in production.
   */
  tracesSampleRate?: number;
  /**
   * Session replay sample rate in [0, 1]. Defaults to `0`. Set to a small
   * value (e.g. `0.1`) in production if you want session replays.
   */
  replaysSessionSampleRate?: number;
  /**
   * Replay-on-error sample rate in [0, 1]. Defaults to `1.0` (always
   * record replays for errored sessions). Costs nothing if
   * `replaysSessionSampleRate` is also 0 — replays only kick in on error.
   */
  replaysOnErrorSampleRate?: number;
  /**
   * Extra integrations to merge with the defaults. Useful for adding
   * `replayIntegration()`, `feedbackIntegration()`, etc.
   */
  integrations?: Integration[];
};

export function initSentryClient(options: InitSentryClientOptions): void {
  const {
    dsn,
    environment = import.meta.env.MODE,
    release,
    tracesSampleRate = import.meta.env.DEV ? 1.0 : 0.1,
    replaysSessionSampleRate = 0,
    replaysOnErrorSampleRate = 1.0,
    integrations: extraIntegrations = [],
  } = options;

  const normalizedDsn = typeof dsn === 'string' ? dsn.trim() : '';
  if (!normalizedDsn) return;

  const integrations: Integration[] = [
    Sentry.browserTracingIntegration(),
    ...extraIntegrations,
  ];

  try {
    Sentry.init({
      dsn: normalizedDsn,
      environment,
      release,
      integrations,
      tracesSampleRate,
      replaysSessionSampleRate,
      replaysOnErrorSampleRate,
      dataCollection: sentryDataCollection,
    });
  } catch (error) {
    // Malformed DSN or other init failure — stay off rather than crash the app.
    // eslint-disable-next-line no-console
    console.warn('[arki/tanstack-start] Sentry disabled — init failed:', error);
    return;
  }

  registerSentryCapture((error, hint) => {
    Sentry.captureException(error, hint as Parameters<typeof Sentry.captureException>[1]);
  });
}

export { Sentry };
