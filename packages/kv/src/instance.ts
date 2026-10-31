/** Lazy-singleton helpers that build a `KV` from the environment. */
import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';

import { debugKV } from './debug.js';
import { env } from './env.js';
import { KV_INITIALIZATION_ERROR_CODES, KVInitializationError } from './errors.js';
import { KV } from './index.js';

/**
 * Initializes the shared KV client instance and tests the connection.
 * Returns null if env vars are missing (development only).
 *
 * @param namespace - The KV namespace (typically the app key).
 *   Falls back to the KV_NAMESPACE environment variable if not provided.
 * @internal Use this function in application singletons, not at module level.
 *   Lazy invocation from request handlers is required — calling at module load
 *   time will attempt a Redis connection during build/test.
 */
export async function initializeKV(namespace?: string): Promise<KV | null> {
  debugKV.debug('[instance] Initializing KV (env: {env})', { env: env.NODE_ENV });

  // Skip KV initialization in development if not configured
  if (!env.KV_URL) {
    debugKV.debug('[instance] Missing KV_URL configuration');
    if (env.NODE_ENV === 'production') {
      debugKV.debug('[instance] CRITICAL: KV_URL required in production');
      throw new KVInitializationError({
        code: KV_INITIALIZATION_ERROR_CODES.urlRequiredInProduction,
        message: 'KV_URL must be defined in production.',
        remediation: 'Set KV_URL in the production environment.',
      });
    }
    debugKV.debug('[instance] Running without KV in development mode');
    debugKV.warn('[instance] KV_URL not defined. Running without KV store (development mode).');
    return null;
  }

  const resolvedNamespace = namespace ?? env.KV_NAMESPACE;

  try {
    debugKV.debug('[instance] Creating KV instance (namespace: {namespace})', {
      namespace: resolvedNamespace ?? 'none',
    });
    const instance = new KV(env.KV_URL, resolvedNamespace, undefined, { allowUnverifiedTls: env.KV_ALLOW_UNVERIFIED_TLS });

    // Test the connection with a simple operation
    // keyv might connect lazily, so a quick set/get ensures it's working.
    debugKV.debug('[instance] Testing connection with set/get/delete cycle');
    const testKey = 'startup-test';
    const written = await instance.set(testKey, 'ok', 5); // Set with short TTL
    if (isFailure(written)) throw new Error(written.message);
    const result = await instance.get(testKey, z.literal('ok'));
    const deleted = await instance.delete(testKey);
    if (isFailure(result)) throw new Error(result.message);
    if (isFailure(deleted)) throw new Error(deleted.message);

    if (result !== 'ok') {
      debugKV.debug('[instance] Connection test failed: value mismatch (expected: "ok", got: {got})', {
        got: String(result),
      });
      throw new Error('KV connection test failed: Set/Get mismatch.');
    }

    debugKV.debug('[instance] KV initialized and connection test passed');
    return instance;
  } catch (error) {
    debugKV.debug('[instance] Initialization failed: {reason}', {
      reason: error instanceof Error ? error.message : 'unknown error',
    });
    if (env.NODE_ENV === 'production') {
      debugKV.debug('[instance] CRITICAL: Production initialization failure');
      throw new KVInitializationError({
        code: KV_INITIALIZATION_ERROR_CODES.connectionFailed,
        message: 'Failed to initialize or connect to KV store.',
        remediation: 'Check that KV_URL points to a reachable KV server.',
        cause: error,
      });
    }
    debugKV.debug('[instance] Running without KV in development mode after error');
    debugKV.error(error instanceof Error ? error : new Error(String(error)), {
      note: 'Failed to connect to KV store. Running without KV (development mode).',
    });
    return null;
  }
}

/**
 * Create KV instance synchronously without connection test
 *
 * Use this when you need a KV instance immediately and can tolerate
 * lazy connection establishment. The connection will be established
 * on first use.
 *
 * @param namespace - The KV namespace (typically the app key).
 *   Falls back to the KV_NAMESPACE environment variable if not provided.
 * @internal Use this in application singletons for synchronous initialization
 */
export function createKVInstance(namespace?: string): KV | null {
  debugKV.debug('[instance] Creating KV synchronously (env: {env})', { env: env.NODE_ENV });

  // Skip KV initialization in development if not configured
  if (!env.KV_URL) {
    debugKV.debug('[instance] Missing KV_URL configuration');
    if (env.NODE_ENV === 'production') {
      debugKV.debug('[instance] CRITICAL: KV_URL required in production');
      throw new KVInitializationError({
        code: KV_INITIALIZATION_ERROR_CODES.urlRequiredInProduction,
        message: 'KV_URL must be defined in production.',
        remediation: 'Set KV_URL in the production environment.',
      });
    }
    debugKV.debug('[instance] Returning null in development mode (missing config)');
    return null;
  }

  const resolvedNamespace = namespace ?? env.KV_NAMESPACE;

  try {
    debugKV.debug('[instance] Creating KV instance (namespace: {namespace}, lazy connection)', {
      namespace: resolvedNamespace ?? 'none',
    });
    const instance = new KV(env.KV_URL, resolvedNamespace, undefined, { allowUnverifiedTls: env.KV_ALLOW_UNVERIFIED_TLS });
    debugKV.debug('[instance] KV instance created successfully');
    return instance;
  } catch (error) {
    debugKV.debug('[instance] Creation failed: {reason}', {
      reason: error instanceof Error ? error.message : 'unknown error',
    });
    if (env.NODE_ENV === 'production') {
      debugKV.debug('[instance] CRITICAL: Production creation failure');
      throw new KVInitializationError({
        code: KV_INITIALIZATION_ERROR_CODES.creationFailed,
        message: 'Failed to create KV instance.',
        remediation: 'Check that KV_URL is a valid KV connection URL.',
        cause: error,
      });
    }
    debugKV.debug('[instance] Returning null in development mode after error');
    debugKV.error(error instanceof Error ? error : new Error(String(error)), {
      note: 'Failed to create KV instance. Running without KV (development mode).',
    });
    return null;
  }
}
