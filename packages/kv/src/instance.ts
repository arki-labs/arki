import { KV } from '@arki/kv';

import { env } from './env';

/**
 * Initializes the shared KV client instance and tests the connection.
 * Logs a critical error and exits if connection fails.
 */
const initializeKV = async (): Promise<KV | undefined> => {
  if (!env.KV_URL) {
    console.warn('KV_URL is not defined, skipping KV initialization.');
    return;
  }

  if (!env.KV_NAMESPACE) {
    console.warn('KV_NAMESPACE is not defined, skipping KV initialization.');
    return;
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
