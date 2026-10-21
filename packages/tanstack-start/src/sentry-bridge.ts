/**
 * Zero-dependency bridge that lets shared package code call
 * `captureException` without statically importing `@sentry/*`.
 *
 * The Sentry init helpers (`sentry-client.ts`, `sentry-server.ts`) push
 * `Sentry.captureException` into the bridge after `Sentry.init` runs. Any
 * call to `captureException` before registration is a silent no-op, which
 * matches Sentry's own behavior when the SDK hasn't been initialized.
 *
 * This module MUST NOT import from `@sentry/*` so that apps which never
 * opt into Sentry don't pull the SDK into their bundle.
 */

export type CaptureHint = {
  contexts?: Record<string, unknown>;
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
};

export type CaptureHandler = (error: unknown, hint?: CaptureHint) => void;

const REGISTRY_KEY = Symbol.for('@arki/tanstack-start.captureHandler');

type Registry = { handler: CaptureHandler | null };

function getRegistry(): Registry {
  const carrier = globalThis as unknown as Record<symbol, Registry | undefined>;
  let registry = carrier[REGISTRY_KEY];
  if (!registry) {
    registry = { handler: null };
    carrier[REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * Register a Sentry-compatible capture handler. Called by the opt-in
 * `initSentryClient` / `initSentryServer` helpers after `Sentry.init`.
 */
export function registerSentryCapture(handler: CaptureHandler): void {
  getRegistry().handler = handler;
}

/**
 * Forward an exception to the registered handler. No-op when Sentry has
 * not been initialized.
 */
export function captureException(error: unknown, hint?: CaptureHint): void {
  const { handler } = getRegistry();
  if (!handler) return;
  try {
    handler(error, hint);
  } catch {
    // Handler must never throw out of this codepath.
  }
}
