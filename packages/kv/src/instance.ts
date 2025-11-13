import { KV } from '@arki/kv';

import { env } from './env';

/**
 * Initializes the shared KV client instance and tests the connection.
 * Returns null if connection fails or if env vars are missing (for development).
 * Returns null during build time to prevent build failures.
 */
const initializeKV = async (): Promise<KV | null> => {
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
};

export const kv = await initializeKV();
