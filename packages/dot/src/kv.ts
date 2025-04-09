import { KV } from '@arki/kv';

import { env } from './env';
import { APP_NAME } from './info';

/**
 * Initializes the shared KV client instance and tests the connection.
 * Logs a critical error and exits if connection fails.
 */
const initializeKV = async (): Promise<KV> => {
  try {
    console.log('Initializing KV connection...');
    const instance = new KV(env.KV_URL, APP_NAME);

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
