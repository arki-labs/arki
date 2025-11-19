import { KV } from '@arki/kv';

import { debugKV } from './debug.ts';

/**
 * Key-Value store functionality for the Dot framework.
 * Contains methods for setting up and interacting with the key-value store.
 */
export const kvFeatures = {
  /**
   * @internal Initializes the Key-Value store.
   * @param kvConfig The key-value store configuration with URL
   * @param appName The application name for namespacing
   */
  initKv(kvConfig: { url: string } | null, appName: string): KV | undefined {
    if (!kvConfig) {
      debugKV('[kvFeatures] No KV configuration provided, skipping KV initialization');
      return undefined;
    }
    debugKV('[kvFeatures] Initializing KV store for app: %s with URL: %s', appName, kvConfig.url);
    // URL is guaranteed to be resolved by withKv method
    const kv = new KV(kvConfig.url, appName);
    debugKV('[kvFeatures] KV store initialized successfully for app: %s', appName);
    return kv;
  },
};
