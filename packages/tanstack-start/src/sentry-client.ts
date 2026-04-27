/**
 * Browser-side Sentry initialization for TanStack Start apps.
 *
 * Call once at the top of `src/entry-client.tsx`, BEFORE importing the
 * router. Order matters: Sentry instruments globals (fetch, history,
 * unhandled errors) when `init()` runs, and anything imported earlier
 * is missed.
 *
 * In dev with the Spotlight Vite plugin (`@arki/tanstack-start/vite-plugin-spotlight`),
 * `import.meta.env.VITE_ARKI_SPOTLIGHT_URL` is defined and the
 * `spotlightBrowserIntegration` is auto-added — every captured event
 * also flows to the local sidecar and shows up in the overlay.
 *
 * If `dsn` is omitted/falsy the function is a no-op. That lets apps
 * call `initSentryClient({ dsn: import.meta.env.VITE_SENTRY_DSN })`
 * unconditionally and have Sentry only activate when the env var is set.
 */
import type { Integration } from '@sentry/core';
import * as Sentry from '@sentry/react';

export type InitSentryClientOptions = {
  /**
   * Sentry DSN. When falsy, `initSentryClient` is a no-op. Typically set
   * via `import.meta.env.VITE_SENTRY_DSN`.
   */
  dsn?: string;
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
  /**
   * Forward events to a local Spotlight sidecar in dev. When `true`
   * (default), the helper auto-detects the sidecar URL from
   * `import.meta.env.VITE_ARKI_SPOTLIGHT_URL` (set by the Vite plugin).
   * Set to `false` to skip Spotlight even when the URL is present.
   */
  spotlight?: boolean;
};

const SPOTLIGHT_SIDECAR_URL = import.meta.env.VITE_ARKI_SPOTLIGHT_URL as string | undefined;

export function initSentryClient(options: InitSentryClientOptions): void {
  const {
    dsn,
    environment = import.meta.env.MODE,
    release,
    tracesSampleRate = import.meta.env.DEV ? 1.0 : 0.1,
    replaysSessionSampleRate = 0,
    replaysOnErrorSampleRate = 1.0,
    integrations: extraIntegrations = [],
    spotlight = true,
  } = options;

  if (!dsn) return;

  const integrations: Integration[] = [
    Sentry.browserTracingIntegration(),
    ...extraIntegrations,
  ];

  if (spotlight && SPOTLIGHT_SIDECAR_URL) {
    integrations.push(Sentry.spotlightBrowserIntegration({ sidecarUrl: SPOTLIGHT_SIDECAR_URL }));
  }

  Sentry.init({
    dsn,
    environment,
    release,
    integrations,
    tracesSampleRate,
    replaysSessionSampleRate,
    replaysOnErrorSampleRate,
    sendDefaultPii: false,
  });
}

export { Sentry };
