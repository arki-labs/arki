/**
 * Storage - Factory
 *
 * Creates storage instances based on configuration
 */

import { createLocalStorageAdapter } from './local-adapter';
import { createS3StorageAdapter } from './s3-adapter';
import type { StorageAdapter, StorageConfig } from './types';

/**
 * Create a storage instance based on the provided configuration
 *
 * Automatically selects the appropriate adapter (local or S3) based on
 * the provider specified in the config.
 *
 * @example
 * ```ts
 * // Local storage
 * const storage = createStorage({
 *   provider: 'local',
 *   basePath: '/var/data/uploads',
 *   baseUrl: 'https://cdn.example.com/uploads'
 * });
 *
 * // S3 storage
 * const storage = createStorage({
 *   provider: 's3',
 *   bucket: 'my-bucket',
 *   prefix: 'uploads',
 *   baseUrl: 'https://cdn.example.com'
 * });
 * ```
 */
export function createStorage(config: StorageConfig): StorageAdapter {
  switch (config.provider) {
    case 'local': {
      return createLocalStorageAdapter(config);
    }
    case 's3': {
      return createS3StorageAdapter(config);
    }
    default: {
      throw new Error(`Unknown storage provider: ${(config as StorageConfig).provider}`);
    }
  }
}
