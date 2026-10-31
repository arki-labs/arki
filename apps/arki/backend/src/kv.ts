import { z } from '@arki/contracts';
import { orThrow } from '@arki/failure';
import { KV } from '@arki/kv';

import { env } from './env';
import { APP_KEY } from './info';

/**
 * Initializes the shared KV client instance and tests the connection.
 * Logs a critical error and exits if connection fails.
 */
const initializeKV = async (): Promise<KV> => {
  if (!env.KV_URL) {
    console.error('CRITICAL: KV_URL is not set. Configure KV_URL in .env before starting.');
    process.exit(1);
  }

  try {
    console.log('Initializing KV connection...');
    const instance = new KV(env.KV_URL, APP_KEY);

    // Test the connection with a simple operation
    // keyv might connect lazily, so a quick set/get ensures it's working.
    const testKey = 'startup-test';
    await orThrow(instance.set(testKey, 'ok', 5)); // Set with short TTL
    const result = await orThrow(instance.get(testKey, z.literal('ok')));
    await orThrow(instance.delete(testKey));

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
