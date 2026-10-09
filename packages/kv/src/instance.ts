import { debugKV } from './debug.js';

import { KV } from './index.js';
import { env } from './env.js';

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
  debugKV('[instance] Initializing KV (env: %s)', env.NODE_ENV);

  // Skip KV initialization in development if not configured
  if (!env.KV_URL) {
    debugKV('[instance] Missing KV_URL configuration');
    if (env.NODE_ENV === 'production') {
      debugKV('[instance] CRITICAL: KV_URL required in production');
      console.error('CRITICAL: KV_URL must be defined in production.');
      process.exit(1);
    }
    debugKV('[instance] Running without KV in development mode');
    console.warn('⚠️  KV_URL not defined. Running without KV store (development mode).');
    return null;
  }

  const resolvedNamespace = namespace ?? env.KV_NAMESPACE;

  try {
    debugKV('[instance] Creating KV instance (namespace: %s)', resolvedNamespace ?? 'none');
    console.log('Initializing KV connection...');
    const instance = new KV(env.KV_URL, resolvedNamespace);

    // Test the connection with a simple operation
    // keyv might connect lazily, so a quick set/get ensures it's working.
    debugKV('[instance] Testing connection with set/get/delete cycle');
    const testKey = 'startup-test';
    await instance.set(testKey, 'ok', 5); // Set with short TTL
    const result = await instance.get(testKey);
    await instance.delete(testKey);

    if (result !== 'ok') {
      debugKV('[instance] Connection test failed: value mismatch (expected: "ok", got: %s)', result);
      throw new Error('KV connection test failed: Set/Get mismatch.');
    }

    debugKV('[instance] KV initialized and connection test passed');
    console.log('✅ KV connection successful.');
    return instance;
  } catch (error) {
    debugKV('[instance] Initialization failed: %s', error instanceof Error ? error.message : 'unknown error');
    if (env.NODE_ENV === 'production') {
      debugKV('[instance] CRITICAL: Production initialization failure');
      console.error('CRITICAL: Failed to initialize or connect to KV store.', error);
      process.exit(1);
    }
    debugKV('[instance] Running without KV in development mode after error');
    console.error('⚠️  Failed to connect to KV store. Running without KV (development mode).', error);
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
  debugKV('[instance] Creating KV synchronously (env: %s)', env.NODE_ENV);

  // Skip KV initialization in development if not configured
  if (!env.KV_URL) {
    debugKV('[instance] Missing KV_URL configuration');
    if (env.NODE_ENV === 'production') {
      debugKV('[instance] CRITICAL: KV_URL required in production');
      console.error('CRITICAL: KV_URL must be defined in production.');
      process.exit(1);
    }
    debugKV('[instance] Returning null in development mode (missing config)');
    return null;
  }

  const resolvedNamespace = namespace ?? env.KV_NAMESPACE;

  try {
    debugKV('[instance] Creating KV instance (namespace: %s, lazy connection)', resolvedNamespace ?? 'none');
    console.log('Creating KV instance (connection will be established lazily)...');
    const instance = new KV(env.KV_URL, resolvedNamespace);
    debugKV('[instance] KV instance created successfully');
    console.log('✅ KV instance created.');
    return instance;
  } catch (error) {
    debugKV('[instance] Creation failed: %s', error instanceof Error ? error.message : 'unknown error');
    if (env.NODE_ENV === 'production') {
      debugKV('[instance] CRITICAL: Production creation failure');
      console.error('CRITICAL: Failed to create KV instance.', error);
      process.exit(1);
    }
    debugKV('[instance] Returning null in development mode after error');
    console.error('⚠️  Failed to create KV instance. Running without KV (development mode).', error);
    return null;
  }
}

/**
 * @deprecated Use createKVInstance() or initializeKV() in your application singleton instead.
 * This export is kept for backward compatibility but will be removed in a future version.
 *
 * Direct usage of this export causes re-initialization on every module import,
 * especially problematic in Next.js development with HMR.
 */
export const kv = createKVInstance();
