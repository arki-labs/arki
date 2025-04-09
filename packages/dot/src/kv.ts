import { KV } from '@arki/kv';

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
    if (!kvConfig) return undefined;
    // URL is guaranteed to be resolved by withKv method
    return new KV(kvConfig.url, appName);
  },
};
