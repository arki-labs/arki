
import { KV } from '.';
import { env } from './env';

/**
 * Initializes the shared KV client instance and tests the connection.
 * Returns null if connection fails or if env vars are missing (for development).
 * Returns null during build time to prevent build failures.
 *
 * @internal Use this function in application singletons, not at module level
 */
export async function initializeKV(): Promise<KV | null> {
  // Skip KV initialization during build time
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    console.log('Skipping KV initialization during build time');
    return null;
  }

  // Skip KV initialization in development if not configured
  if (!env.KV_URL || !env.KV_NAMESPACE) {
    if (env.NODE_ENV === 'production') {
      console.error('CRITICAL: KV_URL and KV_NAMESPACE must be defined in production.');
      process.exit(1);
    }
    console.warn('⚠️  KV_URL or KV_NAMESPACE not defined. Running without KV store (development mode).');
    return null;
  }

  try {
    console.log('Initializing KV connection...');
    const instance = new KV(env.KV_URL, env.KV_NAMESPACE);

    // Test the connection with a simple operation
    // keyv might connect lazily, so a quick set/get ensures it's working.
    const testKey = 'startup-test';
    await instance.set(testKey, 'ok', 5); // Set with short TTL
    const result = await instance.get(testKey);
    await instance.delete(testKey);

    if (result !== 'ok') {
      throw new Error('KV connection test failed: Set/Get mismatch.');
    }

    console.log('✅ KV connection successful.');
    return instance;
  } catch (error) {
    if (env.NODE_ENV === 'production') {
      console.error('CRITICAL: Failed to initialize or connect to KV store.', error);
      process.exit(1);
    }
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
 * @internal Use this in application singletons for synchronous initialization
 */
export function createKV(): KV | null {
  // Skip KV initialization during build time
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return null;
  }

  // Skip KV initialization in development if not configured
  if (!env.KV_URL || !env.KV_NAMESPACE) {
    if (env.NODE_ENV === 'production') {
      console.error('CRITICAL: KV_URL and KV_NAMESPACE must be defined in production.');
      process.exit(1);
    }
    return null;
  }

  try {
    console.log('Creating KV instance (connection will be established lazily)...');
    const instance = new KV(env.KV_URL, env.KV_NAMESPACE);
    console.log('✅ KV instance created.');
    return instance;
  } catch (error) {
    if (env.NODE_ENV === 'production') {
      console.error('CRITICAL: Failed to create KV instance.', error);
      process.exit(1);
    }
    console.error('⚠️  Failed to create KV instance. Running without KV (development mode).', error);
    return null;
  }
}

/**
 * @deprecated Use createKV() or initializeKV() in your application singleton instead.
 * This export is kept for backward compatibility but will be removed in a future version.
 *
 * Direct usage of this export causes re-initialization on every module import,
 * especially problematic in Next.js development with HMR.
 */
export const kv = createKV();
