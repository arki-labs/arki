import { KV } from '@arki/kv';

import { env } from './env';

/**
 * Initializes the shared KV client instance and tests the connection.
 * Throws an error and exits if connection fails or if required env vars are missing.
 */
const initializeKV = async (): Promise<KV> => {
  if (!env.KV_URL) {
    console.error('CRITICAL: KV_URL is not defined. KV store is required.');
    process.exit(1);
  }

  if (!env.KV_NAMESPACE) {
    console.error('CRITICAL: KV_NAMESPACE is not defined. KV store is required.');
    process.exit(1);
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

    console.log('KV connection successful.');
    return instance;
  } catch (error) {
    console.error('CRITICAL: Failed to initialize or connect to KV store.', error);
    // Exit the process to prevent the application from running in a broken state
    process.exit(1);
  }
};

export const kv = await initializeKV();
